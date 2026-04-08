package server

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	aws "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/tozikron/tozikron-music/services/api/internal/models"
)

const (
	libraryUploadPrefix   = "library/"
	libraryCoverPrefix    = "library/covers/"
	searchCacheNamespace  = "search:v5:"
	searchCacheVersionKey = searchCacheNamespace + "generation"
	searchResultLimit     = 10
	libraryReconcileTTL   = 15 * time.Second
)

var nonSlugChars = regexp.MustCompile(`[^a-z0-9]+`)

type libraryUploadResponse struct {
	Track models.Track `json:"track"`
}

type trackCursor struct {
	TitleKey   string `json:"t"`
	ArtistKey  string `json:"a"`
	ExternalID string `json:"e"`
}

func normalizeSearchQuery(query string) string {
	return strings.TrimSpace(strings.ToLower(query))
}

func normalizePage(page int) int {
	if page < 1 {
		return 1
	}
	return page
}

func buildPagination(page int, totalCount int) models.Pagination {
	page = normalizePage(page)

	totalPages := 0
	if totalCount > 0 {
		totalPages = (totalCount + searchResultLimit - 1) / searchResultLimit
	}

	return models.Pagination{
		Page:       page,
		PageSize:   searchResultLimit,
		TotalCount: totalCount,
		TotalPages: totalPages,
		HasPrev:    page > 1 && totalPages > 0,
		HasNext:    totalPages > 0 && page < totalPages,
	}
}

func encodeTrackCursor(track models.Track) string {
	payload, err := json.Marshal(trackCursor{
		TitleKey:   strings.ToLower(track.Title),
		ArtistKey:  strings.ToLower(track.Artist),
		ExternalID: track.ExternalID,
	})
	if err != nil {
		return ""
	}

	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeTrackCursor(raw string) (trackCursor, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return trackCursor{}, err
	}

	var cursor trackCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		return trackCursor{}, err
	}

	if cursor.TitleKey == "" || cursor.ArtistKey == "" || cursor.ExternalID == "" {
		return trackCursor{}, fmt.Errorf("incomplete cursor")
	}

	return cursor, nil
}

func ensureRuntimeSchema(ctx context.Context, s *Server) error {
	_, err := s.db.Exec(ctx, `
		CREATE EXTENSION IF NOT EXISTS "pgcrypto";
		CREATE EXTENSION IF NOT EXISTS "pg_trgm";

		CREATE TABLE IF NOT EXISTS library_tracks (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			external_track_id TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			artist TEXT NOT NULL,
			cover_url TEXT NOT NULL,
			source_page_url TEXT,
			object_key TEXT NOT NULL UNIQUE,
			content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
			size_bytes BIGINT NOT NULL DEFAULT 0,
			duration_seconds INTEGER NOT NULL DEFAULT 0,
			uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_library_tracks_created_at
			ON library_tracks (created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_library_tracks_uploaded_by
			ON library_tracks (uploaded_by_user_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_library_tracks_search
			ON library_tracks
			USING gin ((lower(title || ' ' || artist || ' ' || COALESCE(source_page_url, ''))) gin_trgm_ops);

		CREATE INDEX IF NOT EXISTS idx_library_tracks_alpha
			ON library_tracks ((lower(title)), (lower(artist)), external_track_id);

		CREATE INDEX IF NOT EXISTS idx_liked_songs_user_alpha
			ON liked_songs (user_id, lower(title), lower(artist), external_track_id);
	`)
	return err
}

func (s *Server) searchLibraryTracks(
	ctx context.Context,
	query string,
	page int,
	cursorRaw string,
) ([]models.Track, models.Pagination, error) {
	page = normalizePage(page)
	if s.db == nil {
		return nil, buildPagination(page, 0), nil
	}

	var totalCount int
	normalized := normalizeSearchQuery(query)
	offset := (page - 1) * searchResultLimit
	cursor, cursorErr := decodeTrackCursor(cursorRaw)
	useCursor := cursorErr == nil

	var (
		rows pgx.Rows
		err  error
	)

	if normalized == "" {
		if err := s.db.QueryRow(
			ctx,
			`SELECT COUNT(*) FROM library_tracks`,
		).Scan(&totalCount); err != nil {
			return nil, buildPagination(page, 0), err
		}

		if useCursor {
			rows, err = s.db.Query(
				ctx,
				`SELECT external_track_id, title, artist, cover_url, COALESCE(source_page_url, ''), duration_seconds
				 FROM library_tracks
				 WHERE (
				 	lower(title) > $1 OR
				 	(lower(title) = $1 AND lower(artist) > $2) OR
				 	(lower(title) = $1 AND lower(artist) = $2 AND external_track_id > $3)
				 )
				 ORDER BY lower(title) ASC, lower(artist) ASC, external_track_id ASC
				 LIMIT $4`,
				cursor.TitleKey,
				cursor.ArtistKey,
				cursor.ExternalID,
				searchResultLimit+1,
			)
		} else {
			rows, err = s.db.Query(
				ctx,
				`SELECT external_track_id, title, artist, cover_url, COALESCE(source_page_url, ''), duration_seconds
				 FROM library_tracks
				 ORDER BY lower(title) ASC, lower(artist) ASC, external_track_id ASC
				 LIMIT $1 OFFSET $2`,
				searchResultLimit,
				offset,
			)
		}
	} else {
		searchTerm := "%" + normalized + "%"
		if err := s.db.QueryRow(
			ctx,
			`SELECT COUNT(*)
			 FROM library_tracks
			 WHERE lower(title || ' ' || artist || ' ' || COALESCE(source_page_url, '')) LIKE $1`,
			searchTerm,
		).Scan(&totalCount); err != nil {
			return nil, buildPagination(page, 0), err
		}

		if useCursor {
			rows, err = s.db.Query(
				ctx,
				`SELECT external_track_id, title, artist, cover_url, COALESCE(source_page_url, ''), duration_seconds
				 FROM library_tracks
				 WHERE lower(title || ' ' || artist || ' ' || COALESCE(source_page_url, '')) LIKE $1
				   AND (
				   	lower(title) > $2 OR
				   	(lower(title) = $2 AND lower(artist) > $3) OR
				   	(lower(title) = $2 AND lower(artist) = $3 AND external_track_id > $4)
				   )
				 ORDER BY lower(title) ASC, lower(artist) ASC, external_track_id ASC
				 LIMIT $5`,
				searchTerm,
				cursor.TitleKey,
				cursor.ArtistKey,
				cursor.ExternalID,
				searchResultLimit+1,
			)
		} else {
			rows, err = s.db.Query(
				ctx,
				`SELECT external_track_id, title, artist, cover_url, COALESCE(source_page_url, ''), duration_seconds
				 FROM library_tracks
				 WHERE lower(title || ' ' || artist || ' ' || COALESCE(source_page_url, '')) LIKE $1
				 ORDER BY lower(title) ASC, lower(artist) ASC, external_track_id ASC
				 LIMIT $2 OFFSET $3`,
				searchTerm,
				searchResultLimit,
				offset,
			)
		}
	}
	if err != nil {
		return nil, buildPagination(page, totalCount), err
	}
	defer rows.Close()

	tracks := make([]models.Track, 0, searchResultLimit+1)
	for rows.Next() {
		var track models.Track
		if err := rows.Scan(
			&track.ExternalID,
			&track.Title,
			&track.Artist,
			&track.CoverURL,
			&track.SourcePageURL,
			&track.DurationSeconds,
		); err != nil {
			return nil, buildPagination(page, totalCount), err
		}
		track.CoverURL = libraryTrackCoverURL(track.ExternalID)
		tracks = append(tracks, track)
	}

	pagination := buildPagination(page, totalCount)
	if len(tracks) > searchResultLimit {
		pagination.HasNext = true
		pagination.NextCursor = encodeTrackCursor(tracks[searchResultLimit-1])
		tracks = tracks[:searchResultLimit]
	} else if len(tracks) > 0 && pagination.HasNext {
		pagination.NextCursor = encodeTrackCursor(tracks[len(tracks)-1])
	}

	return tracks, pagination, nil
}

func (s *Server) findLibraryTrackByExternalID(ctx context.Context, externalID string) (models.Track, string, error) {
	if s.db == nil {
		return models.Track{}, "", fiber.ErrNotFound
	}

	var track models.Track
	var objectKey string
	err := s.db.QueryRow(
		ctx,
		`SELECT external_track_id, title, artist, cover_url, COALESCE(source_page_url, ''), duration_seconds, object_key
		 FROM library_tracks
		 WHERE external_track_id = $1`,
		externalID,
	).Scan(
		&track.ExternalID,
		&track.Title,
		&track.Artist,
		&track.CoverURL,
		&track.SourcePageURL,
		&track.DurationSeconds,
		&objectKey,
	)
	if err == nil {
		track.CoverURL = libraryTrackCoverURL(track.ExternalID)
	}
	return track, objectKey, err
}

func (s *Server) listLikedTracks(
	ctx context.Context,
	userID string,
	page int,
	cursorRaw string,
) (models.LikesResponse, error) {
	page = normalizePage(page)
	if s.db == nil {
		return models.LikesResponse{
			Results:    []models.Track{},
			Pagination: buildPagination(page, 0),
		}, nil
	}

	var totalCount int
	if err := s.db.QueryRow(
		ctx,
		`SELECT COUNT(*)
		 FROM liked_songs
		 WHERE user_id = $1`,
		userID,
	).Scan(&totalCount); err != nil {
		return models.LikesResponse{}, err
	}

	offset := (page - 1) * searchResultLimit
	cursor, cursorErr := decodeTrackCursor(cursorRaw)
	useCursor := cursorErr == nil

	var rows pgx.Rows
	var err error
	if useCursor {
		rows, err = s.db.Query(
			ctx,
			`SELECT external_track_id, title, artist, cover_url, COALESCE(source_page_url, ''), duration_seconds
			 FROM liked_songs
			 WHERE user_id = $1
			   AND (
			   	lower(title) > $2 OR
			   	(lower(title) = $2 AND lower(artist) > $3) OR
			   	(lower(title) = $2 AND lower(artist) = $3 AND external_track_id > $4)
			   )
			 ORDER BY lower(title) ASC, lower(artist) ASC, external_track_id ASC
			 LIMIT $5`,
			userID,
			cursor.TitleKey,
			cursor.ArtistKey,
			cursor.ExternalID,
			searchResultLimit+1,
		)
	} else {
		rows, err = s.db.Query(
			ctx,
			`SELECT external_track_id, title, artist, cover_url, COALESCE(source_page_url, ''), duration_seconds
			 FROM liked_songs
			 WHERE user_id = $1
			 ORDER BY lower(title) ASC, lower(artist) ASC, external_track_id ASC
			 LIMIT $2 OFFSET $3`,
			userID,
			searchResultLimit,
			offset,
		)
	}
	if err != nil {
		return models.LikesResponse{}, err
	}
	defer rows.Close()

	tracks := make([]models.Track, 0, searchResultLimit+1)
	for rows.Next() {
		var track models.Track
		if err := rows.Scan(
			&track.ExternalID,
			&track.Title,
			&track.Artist,
			&track.CoverURL,
			&track.SourcePageURL,
			&track.DurationSeconds,
		); err != nil {
			return models.LikesResponse{}, err
		}
		if isLibraryTrackExternalID(track.ExternalID) {
			track.CoverURL = libraryTrackCoverURL(track.ExternalID)
		}
		tracks = append(tracks, track)
	}

	pagination := buildPagination(page, totalCount)
	if len(tracks) > searchResultLimit {
		pagination.HasNext = true
		pagination.NextCursor = encodeTrackCursor(tracks[searchResultLimit-1])
		tracks = tracks[:searchResultLimit]
	} else if len(tracks) > 0 && pagination.HasNext {
		pagination.NextCursor = encodeTrackCursor(tracks[len(tracks)-1])
	}

	return models.LikesResponse{
		Results:    tracks,
		Pagination: pagination,
	}, nil
}

func (s *Server) listLikedExternalIDs(ctx context.Context, userID string) ([]string, error) {
	if s.db == nil {
		return []string{}, nil
	}

	rows, err := s.db.Query(
		ctx,
		`SELECT external_track_id
		 FROM liked_songs
		 WHERE user_id = $1`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	likedIDs := make([]string, 0, 64)
	for rows.Next() {
		var externalID string
		if err := rows.Scan(&externalID); err != nil {
			return nil, err
		}
		likedIDs = append(likedIDs, externalID)
	}

	return likedIDs, nil
}

func (s *Server) deleteLibraryTracksByObjectKeys(ctx context.Context, objectKeys []string) (int, []string, error) {
	if s.db == nil || len(objectKeys) == 0 {
		return 0, nil, nil
	}

	rows, err := s.db.Query(
		ctx,
		`DELETE FROM library_tracks
		 WHERE object_key = ANY($1)
		 RETURNING external_track_id`,
		objectKeys,
	)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()

	removedExternalIDs := make([]string, 0, len(objectKeys))
	for rows.Next() {
		var externalID string
		if err := rows.Scan(&externalID); err != nil {
			return 0, nil, err
		}
		removedExternalIDs = append(removedExternalIDs, externalID)
	}

	if len(removedExternalIDs) > 0 {
		if _, err := s.db.Exec(
			ctx,
			`DELETE FROM liked_songs
			 WHERE external_track_id = ANY($1)`,
			removedExternalIDs,
		); err != nil {
			return 0, nil, err
		}
	}

	return len(removedExternalIDs), removedExternalIDs, nil
}

func (s *Server) pruneMissingLibraryTracks(
	ctx context.Context,
	existingObjectKeys map[string]struct{},
) (int, []string, error) {
	if s.db == nil {
		return 0, nil, nil
	}

	rows, err := s.db.Query(ctx, `SELECT object_key FROM library_tracks`)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()

	missingKeys := make([]string, 0, 32)
	for rows.Next() {
		var objectKey string
		if err := rows.Scan(&objectKey); err != nil {
			return 0, nil, err
		}
		if _, exists := existingObjectKeys[objectKey]; !exists {
			missingKeys = append(missingKeys, objectKey)
		}
	}

	return s.deleteLibraryTracksByObjectKeys(ctx, missingKeys)
}

func (s *Server) reconcileLibraryWithStorageIfDue(ctx context.Context) ([]models.Track, int, []string, error) {
	if s.seedCatalog == nil {
		return nil, 0, nil, nil
	}

	s.reconcileMu.Lock()
	defer s.reconcileMu.Unlock()

	if !s.lastLibraryReconcileAt.IsZero() && time.Since(s.lastLibraryReconcileAt) < libraryReconcileTTL {
		return nil, 0, nil, nil
	}
	s.lastLibraryReconcileAt = time.Now()

	return s.reconcileLibraryWithStorage(ctx)
}

func (s *Server) triggerLibraryReconcileIfDue() {
	if s.seedCatalog == nil {
		return
	}

	s.reconcileMu.Lock()
	if s.reconcileInFlight {
		s.reconcileMu.Unlock()
		return
	}
	if !s.lastLibraryReconcileAt.IsZero() && time.Since(s.lastLibraryReconcileAt) < libraryReconcileTTL {
		s.reconcileMu.Unlock()
		return
	}
	s.reconcileInFlight = true
	s.lastLibraryReconcileAt = time.Now()
	s.reconcileMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		_, _, _, _ = s.reconcileLibraryWithStorage(ctx)

		s.reconcileMu.Lock()
		s.reconcileInFlight = false
		s.reconcileMu.Unlock()
	}()
}

func (s *Server) reconcileLibraryWithStorage(
	ctx context.Context,
) ([]models.Track, int, []string, error) {
	if s.seedCatalog == nil {
		return nil, 0, nil, nil
	}

	objects, err := s.seedCatalog.ListObjects(ctx, libraryUploadPrefix)
	if err != nil {
		return nil, 0, nil, err
	}

	imported := make([]models.Track, 0)
	existingObjectKeys := make(map[string]struct{}, len(objects))
	for _, object := range objects {
		key := aws.ToString(object.Key)
		if key == "" || strings.HasSuffix(key, "/") || !isSupportedAudioUpload(key, "") {
			continue
		}
		existingObjectKeys[key] = struct{}{}

		externalID := libraryExternalID(key)
		contentType, sizeBytes, err := s.seedCatalog.HeadObject(ctx, key)
		if err != nil {
			continue
		}
		localPath, cleanup, metadata, err := s.seedCatalog.DownloadObjectMetadata(ctx, key)
		if cleanup != nil {
			defer cleanup()
		}
		if err != nil {
			continue
		}
		if localPath != "" {
			metadata = deriveTrackMetadata(ctx, localPath, path.Base(key), "", "", 0)
		}

		_ = s.syncTrackCoverFromAudioFile(ctx, key, localPath)
		coverURL := libraryTrackCoverURL(externalID)
		sourcePageURL := fmt.Sprintf("r2://%s/%s", s.seedCatalog.bucket, key)
		_, err = s.db.Exec(
			ctx,
			`INSERT INTO library_tracks (
				external_track_id,
				title,
				artist,
				cover_url,
				source_page_url,
				object_key,
				content_type,
				size_bytes,
				duration_seconds,
				uploaded_by_user_id
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (object_key)
			DO UPDATE SET
				external_track_id = EXCLUDED.external_track_id,
				title = EXCLUDED.title,
				artist = EXCLUDED.artist,
				cover_url = EXCLUDED.cover_url,
				source_page_url = EXCLUDED.source_page_url,
				content_type = EXCLUDED.content_type,
				size_bytes = EXCLUDED.size_bytes,
				duration_seconds = EXCLUDED.duration_seconds,
				updated_at = NOW()`,
			externalID,
			metadata.Title,
			metadata.Artist,
			coverURL,
			sourcePageURL,
			key,
			contentType,
			sizeBytes,
			metadata.DurationSeconds,
			nil,
		)
		if err != nil {
			return nil, 0, nil, err
		}

		imported = append(imported, models.Track{
			ExternalID:      externalID,
			Title:           metadata.Title,
			Artist:          metadata.Artist,
			CoverURL:        coverURL,
			SourcePageURL:   sourcePageURL,
			DurationSeconds: metadata.DurationSeconds,
		})
	}

	removedCount, removedExternalIDs, err := s.pruneMissingLibraryTracks(ctx, existingObjectKeys)
	if err != nil {
		return nil, 0, nil, err
	}

	if len(imported) > 0 || removedCount > 0 {
		_ = s.invalidateSearchCache(ctx)
	}

	return imported, removedCount, removedExternalIDs, nil
}

func (s *Server) uploadLibraryTrack(c *fiber.Ctx) error {
	if s.seedCatalog == nil {
		return writeAPIError(
			c,
			fiber.StatusServiceUnavailable,
			"storage_unavailable",
			"R2 storage is not configured",
			nil,
		)
	}

	ctx := c.UserContext()
	user, err := s.ensureCurrentUser(ctx, c.Locals("userID").(string), c.Locals("email").(string))
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}

	fileHeader, err := c.FormFile("file")
	if err != nil || fileHeader == nil {
		return fiber.NewError(fiber.StatusBadRequest, "audio file is required")
	}

	contentType := strings.TrimSpace(fileHeader.Header.Get("Content-Type"))
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = inferAudioContentType(fileHeader.Filename)
	}
	if !isSupportedAudioUpload(fileHeader.Filename, contentType) {
		return fiber.NewError(fiber.StatusBadRequest, "unsupported audio format")
	}

	file, err := fileHeader.Open()
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "failed to open upload")
	}
	defer file.Close()

	tempFilePath, tempFileSize, err := writeReaderToTempAudioFile(file, fileHeader.Filename)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "failed to read upload")
	}
	defer os.Remove(tempFilePath)

	title := strings.TrimSpace(c.FormValue("title"))
	artist := strings.TrimSpace(c.FormValue("artist"))

	durationSeconds, err := parseOptionalDuration(c.FormValue("duration_seconds"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "duration_seconds must be a non-negative integer")
	}

	metadata := deriveTrackMetadata(ctx, tempFilePath, fileHeader.Filename, title, artist, durationSeconds)
	objectKey := buildLibraryObjectKey(fileHeader.Filename)
	externalID := libraryExternalID(objectKey)
	coverURL := libraryTrackCoverURL(externalID)
	sourcePageURL := fmt.Sprintf("r2://%s/%s", s.seedCatalog.bucket, objectKey)

	tempFile, err := os.Open(tempFilePath)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to prepare upload")
	}
	defer tempFile.Close()

	if err := s.seedCatalog.UploadObject(ctx, objectKey, contentType, tempFile); err != nil {
		return writeAPIError(
			c,
			fiber.StatusBadGateway,
			"upload_failed",
			"Failed to upload track to storage",
			map[string]any{"file_name": fileHeader.Filename},
		)
	}

	_ = s.syncTrackCoverFromAudioFile(ctx, objectKey, tempFilePath)

	_, err = s.db.Exec(
		ctx,
		`INSERT INTO library_tracks (
			external_track_id,
			title,
			artist,
			cover_url,
			source_page_url,
			object_key,
			content_type,
			size_bytes,
			duration_seconds,
			uploaded_by_user_id
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (external_track_id)
		DO UPDATE SET
			title = EXCLUDED.title,
			artist = EXCLUDED.artist,
			cover_url = EXCLUDED.cover_url,
			source_page_url = EXCLUDED.source_page_url,
			object_key = EXCLUDED.object_key,
			content_type = EXCLUDED.content_type,
			size_bytes = EXCLUDED.size_bytes,
			duration_seconds = EXCLUDED.duration_seconds,
			uploaded_by_user_id = EXCLUDED.uploaded_by_user_id,
			updated_at = NOW()`,
		externalID,
		metadata.Title,
		metadata.Artist,
		coverURL,
		sourcePageURL,
		objectKey,
		contentType,
		tempFileSize,
		metadata.DurationSeconds,
		user.ID,
	)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to save uploaded track")
	}

	_ = s.invalidateSearchCache(ctx)

	streamURL, err := s.seedCatalog.PresignObjectKey(ctx, objectKey)
	if err != nil {
		return writeAPIError(
			c,
			fiber.StatusBadGateway,
			"resolve_failed",
			"Track uploaded, but playback URL could not be prepared",
			map[string]any{"external_id": externalID},
		)
	}

	track := models.Track{
		ExternalID:      externalID,
		Title:           metadata.Title,
		Artist:          metadata.Artist,
		CoverURL:        coverURL,
		SourcePageURL:   sourcePageURL,
		StreamURL:       streamURL,
		DurationSeconds: metadata.DurationSeconds,
	}

	return c.Status(fiber.StatusCreated).JSON(libraryUploadResponse{Track: track})
}

func (s *Server) invalidateSearchCache(ctx context.Context) error {
	if s.redis == nil {
		return nil
	}
	return s.redis.Incr(ctx, searchCacheVersionKey).Err()
}

func (s *Server) currentSearchCacheGeneration(ctx context.Context) int64 {
	if s.redis == nil {
		return 0
	}

	value, err := s.redis.Get(ctx, searchCacheVersionKey).Int64()
	if err == nil {
		return value
	}
	if err == redis.Nil {
		return 0
	}
	return 0
}

func parseOptionalDuration(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}

	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 0 {
		return 0, fmt.Errorf("invalid duration")
	}
	return seconds, nil
}

func buildLibraryObjectKey(fileName string) string {
	ext := strings.ToLower(path.Ext(fileName))
	base := strings.TrimSuffix(path.Base(fileName), ext)
	slug := slugify(base)
	if slug == "" {
		slug = "track"
	}

	return fmt.Sprintf(
		"%s%s-%d%s",
		libraryUploadPrefix,
		slug,
		time.Now().UnixNano(),
		ext,
	)
}

func libraryExternalID(objectKey string) string {
	sum := sha1.Sum([]byte(objectKey))
	return "r2-lib-" + hex.EncodeToString(sum[:8])
}

func libraryCoverObjectKey(objectKey string) string {
	sum := sha1.Sum([]byte(objectKey))
	return fmt.Sprintf("%s%s.jpg", libraryCoverPrefix, hex.EncodeToString(sum[:8]))
}

func libraryTrackCoverURL(externalID string) string {
	return fmt.Sprintf("/api/v1/tracks/%s/cover", url.PathEscape(externalID))
}

func isLibraryTrackExternalID(externalID string) bool {
	return strings.HasPrefix(strings.TrimSpace(externalID), "r2-lib-")
}

func slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = nonSlugChars.ReplaceAllString(value, "-")
	return strings.Trim(value, "-")
}

func inferTitleFromFilename(fileName string) string {
	_, title := inferTrackFieldsFromFilename(fileName)
	return title
}

func inferTitleFromObjectKey(objectKey string) string {
	return inferTitleFromFilename(path.Base(objectKey))
}

func (s *Server) syncTrackCoverFromAudioFile(ctx context.Context, objectKey string, audioFilePath string) error {
	if s.seedCatalog == nil || strings.TrimSpace(audioFilePath) == "" {
		return nil
	}

	coverPath, coverContentType, err := extractAudioArtworkFromFile(ctx, audioFilePath)
	if err != nil {
		return nil
	}

	coverObjectKey := libraryCoverObjectKey(objectKey)

	if coverPath == "" {
		_ = s.seedCatalog.DeleteObject(ctx, coverObjectKey)
		return nil
	}
	defer os.Remove(coverPath)

	coverFile, err := os.Open(coverPath)
	if err != nil {
		return nil
	}
	defer coverFile.Close()

	return s.seedCatalog.UploadObject(ctx, coverObjectKey, coverContentType, coverFile)
}

func inferAudioContentType(fileName string) string {
	switch strings.ToLower(path.Ext(fileName)) {
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".flac":
		return "audio/flac"
	case ".ogg":
		return "audio/ogg"
	case ".m4a":
		return "audio/mp4"
	case ".aac":
		return "audio/aac"
	default:
		return "application/octet-stream"
	}
}

func isSupportedAudioUpload(fileName string, contentType string) bool {
	contentType = strings.ToLower(strings.TrimSpace(contentType))
	if strings.HasPrefix(contentType, "audio/") {
		return true
	}

	switch strings.ToLower(path.Ext(fileName)) {
	case ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac":
		return true
	default:
		return false
	}
}
