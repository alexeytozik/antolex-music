package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/tozikron/tozikron-music/services/api/internal/config"
	"github.com/tozikron/tozikron-music/services/api/internal/models"
)

const searchCacheTTL = time.Hour

type Server struct {
	cfg                    config.Config
	db                     *pgxpool.Pool
	redis                  *redis.Client
	seedCatalog            *seedCatalog
	reconcileMu            sync.Mutex
	reconcileInFlight      bool
	lastLibraryReconcileAt time.Time
}

type likeTrackRequest struct {
	ExternalID      string `json:"external_id"`
	Title           string `json:"title"`
	Artist          string `json:"artist"`
	CoverURL        string `json:"cover_url"`
	SourcePageURL   string `json:"source_page_url"`
	DurationSeconds int    `json:"duration_seconds"`
}

func New(cfg config.Config) (*fiber.App, func(), error) {
	db, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		return nil, nil, fmt.Errorf("connect postgres: %w", err)
	}

	tmpServer := &Server{cfg: cfg, db: db}
	if err := ensureRuntimeSchema(context.Background(), tmpServer); err != nil {
		db.Close()
		return nil, nil, fmt.Errorf("ensure runtime schema: %w", err)
	}

	redisOptions, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		db.Close()
		return nil, nil, fmt.Errorf("parse redis url: %w", err)
	}
	redisClient := redis.NewClient(redisOptions)

	srv := &Server{
		cfg:   cfg,
		db:    db,
		redis: redisClient,
	}
	if catalog, err := newSeedCatalog(cfg); err == nil {
		srv.seedCatalog = catalog
	}

	app := newApp(srv)

	cleanup := func() {
		_ = redisClient.Close()
		db.Close()
	}

	return app, cleanup, nil
}

func newApp(s *Server) *fiber.App {
	app := fiber.New(fiber.Config{
		AppName:       "Tozikron Music API",
		BodyLimit:     128 * 1024 * 1024,
		CaseSensitive: true,
		ErrorHandler:  handleFiberError,
	})
	app.Use(cors.New(cors.Config{
		AllowOrigins: strings.Join(s.cfg.CORSOrigins, ","),
		AllowHeaders: "Origin, Content-Type, Accept, Authorization",
		AllowMethods: "GET,POST,DELETE,OPTIONS",
	}))

	api := app.Group("/api/v1")
	api.Get("/health", s.health)
	api.Post("/auth/request-code", s.requestCode)
	api.Post("/auth/verify-code", s.verifyCode)
	api.Get("/search", s.search)
	api.Get("/tracks/:externalID/cover", s.trackCover)
	api.Get("/tracks/:externalID/stream", s.resolveTrack)

	secured := api.Group("", s.jwtMiddleware)
	secured.Get("/me", s.me)
	secured.Get("/me/likes", s.listLikes)
	secured.Get("/me/likes/ids", s.listLikeIDs)
	secured.Post("/me/likes", s.addLike)
	secured.Delete("/me/likes/:externalID", s.removeLike)
	secured.Post("/me/library/uploads", s.uploadLibraryTrack)

	return app
}

func (s *Server) health(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status": "ok",
	})
}

func (s *Server) search(c *fiber.Ctx) error {
	ctx := c.UserContext()
	query := strings.TrimSpace(c.Query("q"))
	page := normalizePage(c.QueryInt("page", 1))
	cursor := strings.TrimSpace(c.Query("cursor"))

	s.triggerLibraryReconcileIfDue()

	cacheQuery := normalizeSearchQuery(query)
	if cacheQuery == "" {
		cacheQuery = "__all__"
	}
	cacheGeneration := s.currentSearchCacheGeneration(ctx)
	cacheKey := fmt.Sprintf(
		"%sgen:%d:%s:page:%d:cursor:%s",
		searchCacheNamespace,
		cacheGeneration,
		cacheQuery,
		page,
		cursor,
	)
	if cached, err := s.redis.Get(ctx, cacheKey).Result(); err == nil && cached != "" {
		var response models.SearchResponse
		if json.Unmarshal([]byte(cached), &response) == nil {
			response.Cached = true
			return c.JSON(response)
		}
	}

	libraryResults, pagination, err := s.searchLibraryTracks(ctx, query, page, cursor)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to search library tracks")
	}

	var response models.SearchResponse
	response = models.SearchResponse{
		Query:      query,
		Source:     "library",
		Cached:     false,
		Results:    sanitizeTracks(libraryResults),
		Pagination: pagination,
	}

	serialized, err := json.Marshal(response)
	if err == nil {
		_ = s.redis.Set(ctx, cacheKey, serialized, searchCacheTTL).Err()
	}

	return c.JSON(response)
}

func (s *Server) resolveTrack(c *fiber.Ctx) error {
	ctx := c.UserContext()
	externalID := strings.TrimSpace(c.Params("externalID"))
	if externalID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "external id is required")
	}

	if s.seedCatalog == nil {
		return writeAPIError(
			c,
			fiber.StatusServiceUnavailable,
			"storage_unavailable",
			"R2 storage is not configured",
			nil,
		)
	}

	track, objectKey, err := s.findLibraryTrackByExternalID(ctx, externalID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, fiber.ErrNotFound) {
			return writeAPIError(
				c,
				fiber.StatusNotFound,
				"track_not_found",
				"The requested track could not be found in the local library",
				map[string]any{"external_id": externalID},
			)
		}
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load track")
	}

	if _, _, headErr := s.seedCatalog.HeadObject(ctx, objectKey); headErr != nil {
		if isObjectNotFoundError(headErr) {
			_, _, _ = s.deleteLibraryTracksByObjectKeys(ctx, []string{objectKey})
			_ = s.invalidateSearchCache(ctx)
			return writeAPIError(
				c,
				fiber.StatusNotFound,
				"track_not_found",
				"The requested track no longer exists in storage",
				map[string]any{"external_id": externalID},
			)
		}

		return writeAPIError(
			c,
			fiber.StatusBadGateway,
			"resolve_failed",
			"Failed to check track in R2",
			map[string]any{"external_id": externalID, "provider": "r2"},
		)
	}

	streamURL, signErr := s.seedCatalog.PresignObjectKey(ctx, objectKey)
	if signErr != nil {
		return writeAPIError(
			c,
			fiber.StatusBadGateway,
			"resolve_failed",
			"Failed to resolve track from R2",
			map[string]any{"external_id": externalID, "provider": "r2"},
		)
	}

	track.StreamURL = streamURL
	return c.JSON(track)
}

func (s *Server) trackCover(c *fiber.Ctx) error {
	ctx := c.UserContext()
	externalID := strings.TrimSpace(c.Params("externalID"))
	if externalID == "" || s.seedCatalog == nil {
		return writeFallbackCoverSVG(c)
	}

	_, objectKey, err := s.findLibraryTrackByExternalID(ctx, externalID)
	if err != nil {
		return writeFallbackCoverSVG(c)
	}

	coverObjectKey := libraryCoverObjectKey(objectKey)
	if _, _, headErr := s.seedCatalog.HeadObject(ctx, coverObjectKey); headErr != nil {
		return writeFallbackCoverSVG(c)
	}

	coverURL, signErr := s.seedCatalog.PresignObjectKey(ctx, coverObjectKey)
	if signErr != nil {
		return writeFallbackCoverSVG(c)
	}

	return c.Redirect(coverURL, http.StatusTemporaryRedirect)
}

func (s *Server) listLikes(c *fiber.Ctx) error {
	ctx := c.UserContext()
	s.triggerLibraryReconcileIfDue()
	user, err := s.ensureCurrentUser(ctx, c.Locals("userID").(string), c.Locals("email").(string))
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}
	page := normalizePage(c.QueryInt("page", 1))
	cursor := strings.TrimSpace(c.Query("cursor"))

	response, err := s.listLikedTracks(ctx, user.ID, page, cursor)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load liked songs")
	}

	return c.JSON(response)
}

func (s *Server) listLikeIDs(c *fiber.Ctx) error {
	ctx := c.UserContext()
	user, err := s.ensureCurrentUser(ctx, c.Locals("userID").(string), c.Locals("email").(string))
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}

	likedIDs, err := s.listLikedExternalIDs(ctx, user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load liked ids")
	}

	return c.JSON(likedIDs)
}

func (s *Server) addLike(c *fiber.Ctx) error {
	ctx := c.UserContext()
	user, err := s.ensureCurrentUser(ctx, c.Locals("userID").(string), c.Locals("email").(string))
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}

	var req likeTrackRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	if req.ExternalID == "" || req.Title == "" || req.Artist == "" || req.CoverURL == "" {
		return fiber.NewError(fiber.StatusBadRequest, "external_id, title, artist, and cover_url are required")
	}

	_, err = s.db.Exec(
		ctx,
		`INSERT INTO liked_songs (
			user_id,
			external_track_id,
			title,
			artist,
			cover_url,
			source_page_url,
			duration_seconds
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (user_id, external_track_id)
		DO UPDATE SET
			title = EXCLUDED.title,
			artist = EXCLUDED.artist,
			cover_url = EXCLUDED.cover_url,
			source_page_url = EXCLUDED.source_page_url,
			duration_seconds = EXCLUDED.duration_seconds,
			updated_at = NOW()`,
		user.ID,
		req.ExternalID,
		req.Title,
		req.Artist,
		req.CoverURL,
		req.SourcePageURL,
		req.DurationSeconds,
	)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to save liked song")
	}

	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) me(c *fiber.Ctx) error {
	ctx := c.UserContext()
	user, err := s.ensureCurrentUser(ctx, c.Locals("userID").(string), c.Locals("email").(string))
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}

	return c.JSON(user)
}

func (s *Server) removeLike(c *fiber.Ctx) error {
	ctx := c.UserContext()
	user, err := s.ensureCurrentUser(ctx, c.Locals("userID").(string), c.Locals("email").(string))
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}
	externalID := strings.TrimSpace(c.Params("externalID"))
	if externalID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "external id is required")
	}

	_, err = s.db.Exec(
		ctx,
		`DELETE FROM liked_songs WHERE user_id = $1 AND external_track_id = $2`,
		user.ID,
		externalID,
	)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to remove liked song")
	}

	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) ensureCurrentUser(ctx context.Context, userID string, email string) (models.User, error) {
	var user models.User
	err := s.db.QueryRow(
		ctx,
		`SELECT id::text, email, created_at
		 FROM users
		 WHERE id = $1`,
		userID,
	).Scan(&user.ID, &user.Email, &user.CreatedAt)
	if err == nil {
		return user, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return models.User{}, err
	}

	return s.upsertUserByEmail(ctx, email)
}

func (s *Server) jwtMiddleware(c *fiber.Ctx) error {
	header := c.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return fiber.NewError(fiber.StatusUnauthorized, "missing bearer token")
	}

	tokenString := strings.TrimPrefix(header, "Bearer ")
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		return []byte(s.cfg.JWTSecret), nil
	})
	if err != nil || !token.Valid {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid token")
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid token claims")
	}

	userID, _ := claims["sub"].(string)
	email, _ := claims["email"].(string)
	if userID == "" || email == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid token payload")
	}

	c.Locals("userID", userID)
	c.Locals("email", email)
	return c.Next()
}

func (s *Server) signToken(userID, email string) (string, time.Time, error) {
	expiresAt := time.Now().Add(s.cfg.SessionTTL)
	claims := jwt.MapClaims{
		"sub":   userID,
		"email": email,
		"exp":   expiresAt.Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(s.cfg.JWTSecret))
	if err != nil {
		return "", time.Time{}, err
	}

	return signed, expiresAt, nil
}

func handleFiberError(c *fiber.Ctx, err error) error {
	if err == nil {
		return nil
	}

	var fiberErr *fiber.Error
	if errors.As(err, &fiberErr) {
		return writeAPIError(c, fiberErr.Code, statusCodeToErrorCode(fiberErr.Code), fiberErr.Message, nil)
	}

	return writeAPIError(
		c,
		fiber.StatusInternalServerError,
		"internal_error",
		"Internal server error",
		nil,
	)
}

func writeAPIError(
	c *fiber.Ctx,
	status int,
	code string,
	message string,
	details map[string]any,
) error {
	return c.Status(status).JSON(models.ErrorResponse{
		Error: models.APIError{
			Code:    code,
			Message: message,
			Details: details,
		},
	})
}

func statusCodeToErrorCode(status int) string {
	switch status {
	case fiber.StatusBadRequest:
		return "bad_request"
	case fiber.StatusUnauthorized:
		return "unauthorized"
	case fiber.StatusForbidden:
		return "forbidden"
	case fiber.StatusNotFound:
		return "not_found"
	case fiber.StatusConflict:
		return "conflict"
	case fiber.StatusUnprocessableEntity:
		return "unprocessable_entity"
	case fiber.StatusBadGateway:
		return "bad_gateway"
	case fiber.StatusServiceUnavailable:
		return "service_unavailable"
	default:
		if status >= 500 {
			return "internal_error"
		}
		return "request_failed"
	}
}

func sanitizeTracks(tracks []models.Track) []models.Track {
	sanitized := make([]models.Track, 0, len(tracks))
	for _, track := range tracks {
		if strings.TrimSpace(track.ExternalID) == "" || strings.TrimSpace(track.Title) == "" {
			continue
		}
		sanitized = append(sanitized, track)
	}
	return sanitized
}

func writeFallbackCoverSVG(c *fiber.Ctx) error {
	c.Set(fiber.HeaderContentType, "image/svg+xml; charset=utf-8")
	c.Set(fiber.HeaderCacheControl, "public, max-age=300")

	return c.SendString(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="coverNoteGradient" x1="94" y1="72" x2="162" y2="174" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#27F0C2"/>
      <stop offset="1" stop-color="#14D6C8"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="42" fill="#14161B"/>
  <rect x="18" y="18" width="220" height="220" rx="34" fill="#181B22"/>
  <rect x="18.75" y="18.75" width="218.5" height="218.5" rx="33.25" stroke="#FFFFFF" stroke-opacity="0.05"/>
  <path d="M156 78C156 75.7909 154.209 74 152 74C151.616 74 151.233 74.0553 150.864 74.1643L111.864 85.6722C108.475 86.6727 106.154 89.7834 106.154 93.3174V144.233C101.231 141.835 95.0224 141.111 88.7626 142.532C77.3134 145.13 69.1051 154.503 70.3939 163.466C71.6827 172.429 81.9807 177.581 93.4299 174.983C103.733 172.645 111.415 164.943 111.832 157.027L112 157.033V112.933L148 102.314V130.233C143.077 127.835 136.869 127.111 130.609 128.532C119.16 131.13 110.951 140.503 112.24 149.466C113.529 158.429 123.827 163.581 135.276 160.983C145.579 158.645 153.261 150.943 153.679 143.027L153.846 143.033V78H156Z" fill="url(#coverNoteGradient)"/>
</svg>`)
}
