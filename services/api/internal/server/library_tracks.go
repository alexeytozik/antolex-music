package server

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

const (
	searchCacheNamespace  = "search:v8:"
	searchCacheVersionKey = searchCacheNamespace + "generation"
	searchResultLimit     = 20
	searchCursorVersion   = 2
	searchModePrimary     = "primary"
	searchModeFuzzy       = "fuzzy"
	fuzzySearchThreshold  = 0.6
)

var nonSlugChars = regexp.MustCompile(`[^a-z0-9]+`)

type trackCursor struct {
	Rank      float64   `json:"r,omitempty"`
	Timestamp time.Time `json:"ts"`
	ID        string    `json:"id"`
}

type searchCursor struct {
	Version          int       `json:"v"`
	Mode             string    `json:"m"`
	Tier             int       `json:"t"`
	Score            float64   `json:"s"`
	Timestamp        time.Time `json:"ts"`
	ID               string    `json:"id"`
	QueryFingerprint string    `json:"q"`
}

type rankedTrack struct {
	Track models.Track
	Tier  int
	Score float64
}

func normalizeSearchQuery(query string) string { return strings.TrimSpace(strings.ToLower(query)) }

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
		Page: page, PageSize: searchResultLimit, TotalCount: totalCount, TotalPages: totalPages,
		HasPrev: page > 1 && totalPages > 0, HasNext: page < totalPages,
	}
}

func encodeTrackCursor(track models.Track, rank ...float64) string {
	value := 0.0
	if len(rank) > 0 {
		value = rank[0]
	}
	payload, err := json.Marshal(trackCursor{Rank: value, Timestamp: track.CreatedAt, ID: track.ID})
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
	if cursor.ID == "" || cursor.Timestamp.IsZero() {
		return trackCursor{}, fmt.Errorf("incomplete cursor")
	}
	return cursor, nil
}

func searchQueryFingerprint(normalizedQuery string) string {
	digest := sha256.Sum256([]byte(normalizedQuery))
	return hex.EncodeToString(digest[:])
}

func encodeSearchCursor(item rankedTrack, mode, queryFingerprint string) string {
	payload, err := json.Marshal(searchCursor{
		Version:          searchCursorVersion,
		Mode:             mode,
		Tier:             item.Tier,
		Score:            item.Score,
		Timestamp:        item.Track.CreatedAt,
		ID:               item.Track.ID,
		QueryFingerprint: queryFingerprint,
	})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeSearchCursor(raw string) (searchCursor, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return searchCursor{}, err
	}
	var cursor searchCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		return searchCursor{}, err
	}
	if cursor.Version != searchCursorVersion ||
		(cursor.Mode != searchModePrimary && cursor.Mode != searchModeFuzzy) ||
		cursor.ID == "" || cursor.Timestamp.IsZero() || cursor.QueryFingerprint == "" {
		return searchCursor{}, fmt.Errorf("invalid search cursor")
	}
	return cursor, nil
}

func normalizeSearchInput(ctx context.Context, tx pgx.Tx, query string) (string, string, error) {
	var normalized, prefixQuery string
	err := tx.QueryRow(ctx, `
		WITH input AS (
			SELECT antolex_normalize_search_text($1) AS normalized
		), prefix AS (
			SELECT string_agg(quote_literal(lexeme) || ':*', ' & ' ORDER BY lexeme) AS value
			FROM input,
			     unnest(tsvector_to_array(to_tsvector('simple', input.normalized))) AS lexeme
		)
		SELECT input.normalized, COALESCE(prefix.value, '')
		FROM input CROSS JOIN prefix
	`, query).Scan(&normalized, &prefixQuery)
	return normalized, prefixQuery, err
}

func fuzzySearchEligible(normalizedQuery string) bool {
	withoutSpaces := strings.ReplaceAll(normalizedQuery, " ", "")
	return len([]rune(withoutSpaces)) >= 3
}

func (s *Server) searchLibraryTracks(ctx context.Context, query string, page int, cursorRaw string) ([]models.Track, models.Pagination, error) {
	page = normalizePage(page)
	if s.db == nil {
		return []models.Track{}, buildPagination(page, 0), nil
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, buildPagination(page, 0), err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, fmt.Sprintf(`SET LOCAL pg_trgm.word_similarity_threshold = %g`, fuzzySearchThreshold)); err != nil {
		return nil, buildPagination(page, 0), err
	}

	normalized, prefixQuery, err := normalizeSearchInput(ctx, tx, query)
	if err != nil {
		return nil, buildPagination(page, 0), err
	}

	mode := searchModePrimary
	var totalCount int
	switch {
	case normalized == "":
		err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM library_tracks WHERE status = 'ready'`).Scan(&totalCount)
	case prefixQuery != "":
		err = tx.QueryRow(ctx, `
			SELECT COUNT(*)
			FROM library_tracks
			WHERE status = 'ready'
			  AND search_vector @@ to_tsquery('simple', $1)
		`, prefixQuery).Scan(&totalCount)
	}
	if err != nil {
		return nil, buildPagination(page, 0), err
	}

	if normalized != "" && totalCount == 0 && fuzzySearchEligible(normalized) {
		mode = searchModeFuzzy
		if err := tx.QueryRow(ctx, `
			SELECT COUNT(*)
			FROM library_tracks
			WHERE status = 'ready'
			  AND search_text %> $1
			  AND word_similarity($1, search_text) >= $2
		`, normalized, fuzzySearchThreshold).Scan(&totalCount); err != nil {
			return nil, buildPagination(page, 0), err
		}
	}

	queryFingerprint := searchQueryFingerprint(normalized)
	cursor, cursorErr := decodeSearchCursor(cursorRaw)
	useCursor := cursorRaw != "" && cursorErr == nil &&
		cursor.Mode == mode && cursor.QueryFingerprint == queryFingerprint
	if cursorRaw != "" && !useCursor {
		page = 1
	}
	offset := (page - 1) * searchResultLimit
	if useCursor {
		offset = 0
	}

	var rows pgx.Rows
	switch {
	case normalized == "":
		rows, err = tx.Query(ctx, `
			SELECT id::text, external_track_id, title, artist, album, duration_seconds, created_at,
			       0 AS tier, 0::double precision AS score
			FROM library_tracks
			WHERE status = 'ready'
			  AND (
			      NOT $1 OR
			      created_at < $2 OR
			      (created_at = $2 AND id::text < $3)
			  )
			ORDER BY created_at DESC, id DESC
			LIMIT $4 OFFSET $5
		`, useCursor, cursor.Timestamp, cursor.ID, searchResultLimit+1, offset)
	case mode == searchModePrimary && prefixQuery != "":
		rows, err = tx.Query(ctx, `
			WITH ranked AS (
				SELECT id::text, external_track_id, title, artist, album, duration_seconds, created_at,
				       CASE
				           WHEN antolex_normalize_search_text(title) = $1 THEN 1
				           WHEN starts_with(antolex_normalize_search_text(title), $1) THEN 2
				           WHEN antolex_normalize_search_text(artist) = $1 THEN 3
				           WHEN starts_with(antolex_normalize_search_text(artist), $1) THEN 4
				           ELSE 5
				       END AS tier,
				       ts_rank_cd(search_vector, to_tsquery('simple', $2), 32)::double precision AS score
				FROM library_tracks
				WHERE status = 'ready'
				  AND search_vector @@ to_tsquery('simple', $2)
			)
			SELECT id, external_track_id, title, artist, album, duration_seconds, created_at, tier, score
			FROM ranked
			WHERE NOT $3 OR
			      tier > $4 OR
			      (tier = $4 AND score < $5) OR
			      (tier = $4 AND score = $5 AND created_at < $6) OR
			      (tier = $4 AND score = $5 AND created_at = $6 AND id < $7)
			ORDER BY tier ASC, score DESC, created_at DESC, id DESC
			LIMIT $8 OFFSET $9
		`, normalized, prefixQuery, useCursor, cursor.Tier, cursor.Score, cursor.Timestamp, cursor.ID, searchResultLimit+1, offset)
	case mode == searchModeFuzzy:
		rows, err = tx.Query(ctx, `
			WITH ranked AS (
				SELECT id::text, external_track_id, title, artist, album, duration_seconds, created_at,
				       6 AS tier,
				       word_similarity($1, search_text)::double precision AS score
				FROM library_tracks
				WHERE status = 'ready'
				  AND search_text %> $1
				  AND word_similarity($1, search_text) >= $2
			)
			SELECT id, external_track_id, title, artist, album, duration_seconds, created_at, tier, score
			FROM ranked
			WHERE NOT $3 OR
			      tier > $4 OR
			      (tier = $4 AND score < $5) OR
			      (tier = $4 AND score = $5 AND created_at < $6) OR
			      (tier = $4 AND score = $5 AND created_at = $6 AND id < $7)
			ORDER BY tier ASC, score DESC, created_at DESC, id DESC
			LIMIT $8 OFFSET $9
		`, normalized, fuzzySearchThreshold, useCursor, cursor.Tier, cursor.Score, cursor.Timestamp, cursor.ID, searchResultLimit+1, offset)
	default:
		rows, err = tx.Query(ctx, `
			SELECT id::text, external_track_id, title, artist, album, duration_seconds, created_at,
			       0 AS tier, 0::double precision AS score
			FROM library_tracks
			WHERE FALSE
		`)
	}
	if err != nil {
		return nil, buildPagination(page, totalCount), err
	}

	results := make([]rankedTrack, 0, searchResultLimit+1)
	for rows.Next() {
		var item rankedTrack
		if err := rows.Scan(
			&item.Track.ID, &item.Track.ExternalID, &item.Track.Title, &item.Track.Artist,
			&item.Track.Album, &item.Track.DurationSeconds, &item.Track.CreatedAt, &item.Tier, &item.Score,
		); err != nil {
			rows.Close()
			return nil, buildPagination(page, totalCount), err
		}
		item.Track.Status = "ready"
		item.Track.CoverURL = libraryTrackCoverURL(item.Track)
		results = append(results, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, buildPagination(page, totalCount), err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, buildPagination(page, totalCount), err
	}

	pagination := buildPagination(page, totalCount)
	if len(results) > searchResultLimit {
		results = results[:searchResultLimit]
		pagination.HasNext = true
	}
	tracks := make([]models.Track, 0, len(results))
	for _, item := range results {
		tracks = append(tracks, item.Track)
	}
	if pagination.HasNext && len(results) > 0 {
		last := results[len(results)-1]
		pagination.NextCursor = encodeSearchCursor(last, mode, queryFingerprint)
	}
	return tracks, pagination, nil
}

func (s *Server) findLibraryTrackByExternalID(ctx context.Context, externalID string) (models.Track, string, string, error) {
	if s.db == nil {
		return models.Track{}, "", "", fiber.ErrNotFound
	}
	var track models.Track
	var playbackKey, coverKey string
	err := s.db.QueryRow(ctx, `
		SELECT id::text, external_track_id, title, artist, album, duration_seconds, created_at,
		       COALESCE(playback_object_key, object_key), COALESCE(cover_object_key, '')
		FROM library_tracks WHERE external_track_id = $1 AND status = 'ready'
	`, externalID).Scan(
		&track.ID, &track.ExternalID, &track.Title, &track.Artist, &track.Album,
		&track.DurationSeconds, &track.CreatedAt, &playbackKey, &coverKey,
	)
	if err == nil {
		track.Status = "ready"
		track.CoverURL = libraryTrackCoverURL(track)
		resolvedCoverKey := resolveCoverObjectKey(coverKey, playbackKey)
		if coverKey == "" && resolvedCoverKey != "" {
			coverKey = resolvedCoverKey
			_, _ = s.db.Exec(ctx, `
				UPDATE library_tracks SET cover_object_key=$2,updated_at=NOW()
				WHERE id=$1 AND COALESCE(cover_object_key,'')=''
			`, track.ID, coverKey)
		}
	}
	return track, playbackKey, coverKey, err
}

func (s *Server) listLikedTracks(ctx context.Context, userID string, page int, cursorRaw string) (models.LikesResponse, error) {
	page = normalizePage(page)
	if s.db == nil {
		return models.LikesResponse{Results: []models.Track{}, Pagination: buildPagination(page, 0)}, nil
	}
	var totalCount int
	if err := s.db.QueryRow(ctx, `SELECT COUNT(*) FROM track_likes WHERE user_id = $1`, userID).Scan(&totalCount); err != nil {
		return models.LikesResponse{}, err
	}
	cursor, cursorErr := decodeTrackCursor(cursorRaw)
	useCursor := cursorRaw != "" && cursorErr == nil
	offset := (page - 1) * searchResultLimit
	rows, err := s.db.Query(ctx, `
		SELECT track.id::text, track.external_track_id, track.title, track.artist, track.album,
		       track.duration_seconds, likes.liked_at
		FROM track_likes likes
		JOIN library_tracks track ON track.id = likes.track_id AND track.status = 'ready'
		WHERE likes.user_id = $1 AND (
			NOT $2 OR likes.liked_at < $3 OR (likes.liked_at = $3 AND track.id::text < $4)
		)
		ORDER BY likes.liked_at DESC, track.id DESC
		LIMIT $5 OFFSET $6
	`, userID, useCursor, cursor.Timestamp, cursor.ID, searchResultLimit+1, func() int {
		if useCursor {
			return 0
		}
		return offset
	}())
	if err != nil {
		return models.LikesResponse{}, err
	}
	defer rows.Close()
	tracks := make([]models.Track, 0, searchResultLimit+1)
	for rows.Next() {
		var track models.Track
		if err := rows.Scan(&track.ID, &track.ExternalID, &track.Title, &track.Artist, &track.Album, &track.DurationSeconds, &track.CreatedAt); err != nil {
			return models.LikesResponse{}, err
		}
		track.Status = "ready"
		track.CoverURL = libraryTrackCoverURL(track)
		tracks = append(tracks, track)
	}
	pagination := buildPagination(page, totalCount)
	if len(tracks) > searchResultLimit {
		tracks = tracks[:searchResultLimit]
		pagination.HasNext = true
	}
	if pagination.HasNext && len(tracks) > 0 {
		pagination.NextCursor = encodeTrackCursor(tracks[len(tracks)-1])
	}
	return models.LikesResponse{Results: tracks, Pagination: pagination}, rows.Err()
}

func (s *Server) listLikedExternalIDs(ctx context.Context, userID string) ([]string, error) {
	if s.db == nil {
		return []string{}, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT track.external_track_id FROM track_likes likes
		JOIN library_tracks track ON track.id = likes.track_id AND track.status = 'ready'
		WHERE likes.user_id = $1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, 64)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
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

func libraryExternalID(objectKey string) string {
	sum := sha1.Sum([]byte(objectKey))
	return "antolex-" + hex.EncodeToString(sum[:8])
}

func libraryTrackCoverURL(track models.Track) string {
	return fmt.Sprintf("/api/v1/tracks/%s/cover?v=%s", url.PathEscape(track.ExternalID), generatedTrackCoverVersion(track))
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

func isSupportedAudioUpload(fileName, contentType string) bool {
	switch strings.ToLower(path.Ext(fileName)) {
	case ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac":
		return true
	}
	return false
}

func legacyLibraryCoverObjectKey(objectKey string) string {
	sum := sha1.Sum([]byte(objectKey))
	return fmt.Sprintf("library/covers/%s.jpg", hex.EncodeToString(sum[:8]))
}

func resolveCoverObjectKey(storedKey, playbackKey string) string {
	if storedKey = strings.TrimSpace(storedKey); storedKey != "" {
		return storedKey
	}
	if strings.HasPrefix(playbackKey, "library/") && !strings.HasPrefix(playbackKey, "library/covers/") {
		return legacyLibraryCoverObjectKey(playbackKey)
	}
	return ""
}

var _ pgx.Rows
