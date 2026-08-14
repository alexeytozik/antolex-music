package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	database "github.com/alexeytozik/antolex-music/services/api/db"
	"github.com/alexeytozik/antolex-music/services/api/internal/config"
	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

const searchCacheTTL = time.Hour

type Server struct {
	cfg              config.Config
	db               *pgxpool.Pool
	redis            *redis.Client
	seedCatalog      *seedCatalog
	authUserResolver func(context.Context, string, string) (models.User, error)
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
	if cfg.AppEnv == "production" && (cfg.JWTSecret == "change-me" || len(cfg.JWTSecret) < 32) {
		return nil, nil, fmt.Errorf("JWT_SECRET must contain at least 32 characters in production")
	}
	db, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		return nil, nil, fmt.Errorf("connect postgres: %w", err)
	}

	if err := database.Migrate(context.Background(), db); err != nil {
		db.Close()
		return nil, nil, fmt.Errorf("migrate database: %w", err)
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
		AppName:       "ANTOLEX Music API",
		BodyLimit:     2 * 1024 * 1024,
		CaseSensitive: true,
		ErrorHandler:  handleFiberError,
	})
	app.Use(cors.New(cors.Config{
		AllowOrigins:     strings.Join(s.cfg.CORSOrigins, ","),
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization",
		AllowMethods:     "GET,POST,DELETE,OPTIONS",
		AllowCredentials: true,
	}))

	api := app.Group("/api/v1")
	api.Get("/health", s.health)
	api.Post("/auth/request-code", s.requestCode)
	api.Post("/auth/verify-code", s.verifyCode)
	api.Post("/auth/logout", s.logout)
	api.Post("/auth/exchange", s.legacyExchangeMiddleware, s.exchangeLegacyToken)

	secured := api.Group("", s.jwtMiddleware)
	secured.Get("/search", s.search)
	secured.Get("/shuffle", s.shuffle)
	secured.Get("/tracks/:externalID/cover", s.trackCover)
	secured.Get("/tracks/:externalID/stream", s.resolveTrack)
	secured.Get("/me", s.me)
	secured.Get("/me/likes", s.listLikes)
	secured.Get("/me/likes/ids", s.listLikeIDs)
	secured.Post("/me/likes", s.addLike)
	secured.Delete("/me/likes/:externalID", s.removeLike)
	uploads := secured.Group("/me/uploads")
	uploads.Post("", s.createUpload)
	uploads.Get("", s.listUploads)
	uploads.Get("/:id", s.getUpload)
	uploads.Post("/:id/parts/:number", s.presignUploadPart)
	uploads.Post("/:id/complete", s.completeUpload)
	uploads.Delete("/:id", s.cancelUpload)
	uploads.Post("/:id/retry", s.retryUpload)

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

	cacheQuery := normalizeSearchQuery(query)
	cacheQueryFingerprint := searchQueryFingerprint(cacheQuery)
	cacheGeneration := s.currentSearchCacheGeneration(ctx)
	cacheKey := fmt.Sprintf(
		"%sgen:%d:%s:page:%d:cursor:%s",
		searchCacheNamespace,
		cacheGeneration,
		cacheQueryFingerprint,
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

	track, objectKey, _, err := s.findLibraryTrackByExternalID(ctx, externalID)
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
			result, _ := s.db.Exec(ctx, `UPDATE library_tracks SET status='error', error_message='playback object is missing', updated_at=NOW() WHERE external_track_id=$1 AND status='ready'`, externalID)
			if result.RowsAffected() > 0 {
				_ = s.invalidateSearchCache(ctx)
			}
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
	if externalID == "" {
		return writeFallbackCoverSVG(c)
	}

	track, _, coverObjectKey, err := s.findLibraryTrackByExternalID(ctx, externalID)
	if err != nil {
		return writeFallbackCoverSVG(c)
	}
	return s.writeTrackCover(c, track, coverObjectKey)
}

func (s *Server) writeTrackCover(c *fiber.Ctx, track models.Track, coverObjectKey string) error {
	if s.seedCatalog == nil || strings.TrimSpace(coverObjectKey) == "" {
		return writeGeneratedTrackCoverSVG(c, track)
	}
	ctx := c.UserContext()
	if _, _, headErr := s.seedCatalog.HeadObject(ctx, coverObjectKey); headErr != nil {
		return writeGeneratedTrackCoverSVG(c, track)
	}

	coverURL, signErr := s.seedCatalog.PresignObjectKey(ctx, coverObjectKey)
	if signErr != nil {
		return writeGeneratedTrackCoverSVG(c, track)
	}

	return c.Redirect(coverURL, http.StatusTemporaryRedirect)
}

func (s *Server) listLikes(c *fiber.Ctx) error {
	ctx := c.UserContext()
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

	if strings.TrimSpace(req.ExternalID) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "external_id is required")
	}

	result, err := s.db.Exec(
		ctx,
		`INSERT INTO track_likes (user_id, track_id, liked_at)
		 SELECT $1, id, NOW() FROM library_tracks
		 WHERE external_track_id = $2 AND status = 'ready'
		 ON CONFLICT (user_id, track_id) DO UPDATE SET liked_at = EXCLUDED.liked_at`,
		user.ID,
		req.ExternalID,
	)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to save liked song")
	}
	if result.RowsAffected() == 0 {
		return writeAPIError(c, fiber.StatusNotFound, "track_not_found", "Track is not available", nil)
	}

	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) me(c *fiber.Ctx) error {
	user, ok := c.Locals("user").(models.User)
	if !ok {
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
		`DELETE FROM track_likes likes
		 USING library_tracks track
		 WHERE likes.user_id = $1 AND likes.track_id = track.id AND track.external_track_id = $2`,
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
		`SELECT id::text, email, active, created_at
		 FROM users
		 WHERE id = $1 AND lower(email) = lower($2) AND active = TRUE`,
		userID, email,
	).Scan(&user.ID, &user.Email, &user.Active, &user.CreatedAt)
	if err == nil {
		return user, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return models.User{}, err
	}

	return models.User{}, pgx.ErrNoRows
}

func (s *Server) jwtMiddleware(c *fiber.Ctx) error {
	return s.authenticateRequest(c, false)
}

func (s *Server) legacyExchangeMiddleware(c *fiber.Ctx) error {
	return s.authenticateRequest(c, true)
}

func (s *Server) authenticateRequest(c *fiber.Ctx, allowLegacyExchange bool) error {
	header := c.Get("Authorization")
	tokenString := strings.TrimSpace(c.Cookies(s.cfg.CookieName))
	bearerAuth := strings.HasPrefix(header, "Bearer ")
	if bearerAuth {
		tokenString = strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	}
	if tokenString == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "missing session")
	}
	claims, err := s.parseSessionClaims(tokenString, allowLegacyExchange && bearerAuth)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid token")
	}

	userID, _ := claims["sub"].(string)
	email, _ := claims["email"].(string)
	if userID == "" || email == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid token payload")
	}

	c.Locals("userID", userID)
	c.Locals("email", email)
	user, err := s.resolveAuthenticatedUser(c.UserContext(), userID, email)
	if err != nil || !user.Active {
		return fiber.NewError(fiber.StatusUnauthorized, "user is not allowed")
	}
	c.Locals("user", user)
	return c.Next()
}

func (s *Server) resolveAuthenticatedUser(ctx context.Context, userID, email string) (models.User, error) {
	if s.authUserResolver != nil {
		return s.authUserResolver(ctx, userID, email)
	}
	return s.ensureCurrentUser(ctx, userID, email)
}

func (s *Server) parseSessionClaims(tokenString string, allowLegacy bool) (jwt.MapClaims, error) {
	secrets := []string{s.cfg.JWTSecret}
	if allowLegacy && s.cfg.LegacyJWTSecret != "" && s.cfg.LegacyJWTSecret != s.cfg.JWTSecret {
		secrets = append(secrets, s.cfg.LegacyJWTSecret)
	}
	var lastErr error
	for _, secret := range secrets {
		token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
			if token.Method.Alg() != jwt.SigningMethodHS256.Alg() {
				return nil, fmt.Errorf("unexpected signing method")
			}
			return []byte(secret), nil
		})
		if err != nil || !token.Valid {
			lastErr = err
			continue
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			lastErr = fmt.Errorf("invalid token claims")
			continue
		}
		return claims, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("invalid token")
	}
	return nil, lastErr
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

	return c.SendString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">ANTOLEX Music cover placeholder</title>
  <desc id="desc">Abstract mint waveform on a dark album cover</desc>
  <defs>
    <linearGradient id="mint" x1="116" y1="101" x2="400" y2="411" gradientUnits="userSpaceOnUse">
      <stop stop-color="#71FFD2"/><stop offset="1" stop-color="#18CFA8"/>
    </linearGradient>
    <radialGradient id="surface" cx="0" cy="0" r="1" gradientTransform="translate(166 118) rotate(52) scale(512)" gradientUnits="userSpaceOnUse">
      <stop stop-color="#173C32"/><stop offset=".55" stop-color="#0C1B17"/><stop offset="1" stop-color="#070C0B"/>
    </radialGradient>
    <filter id="glow" x="52" y="76" width="408" height="364" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="16"/></filter>
  </defs>
  <rect width="512" height="512" rx="72" fill="url(#surface)"/>
  <circle cx="256" cy="256" r="174" fill="none" stroke="#CFFFF0" stroke-opacity=".07" stroke-width="2"/>
  <circle cx="256" cy="256" r="132" fill="none" stroke="#CFFFF0" stroke-opacity=".06" stroke-width="2"/>
  <path d="M104 272c38 0 38-70 76-70s38 140 76 140 38-188 76-188 38 118 76 118" fill="none" stroke="#22DDB0" stroke-opacity=".2" stroke-width="34" stroke-linecap="round" filter="url(#glow)"/>
  <path d="M104 272c38 0 38-70 76-70s38 140 76 140 38-188 76-188 38 118 76 118" fill="none" stroke="url(#mint)" stroke-width="22" stroke-linecap="round"/>
  <circle cx="104" cy="272" r="11" fill="#71FFD2"/><circle cx="408" cy="272" r="11" fill="#18CFA8"/>
</svg>`)
}
