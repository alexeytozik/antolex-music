package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

const (
	playbackSessionTTL             = 24 * time.Hour
	playbackInitialTrackLimit      = 100
	playbackSourcePageLimit        = 5000
	playbackContinuationPageLimit  = 1024
	playbackMinimumFutureDuration  = 2 * time.Hour
	playbackManifestTailSegmentNum = 12
	playbackManifestTargetDuration = 7
)

var errPlaybackContinuationChanged = errors.New("playback continuation changed")

type createPlaybackSessionRequest struct {
	Source             playbackSessionSource `json:"source"`
	InitialExternalIDs []string              `json:"initial_external_ids"`
	CurrentExternalID  string                `json:"current_external_id"`
	CurrentIndex       int                   `json:"current_index"`
	PositionSeconds    float64               `json:"position_seconds"`
	Cursor             string                `json:"cursor"`
	Page               int                   `json:"page"`
	HasMore            bool                  `json:"has_more"`
}

type playbackSessionSource struct {
	Kind              string `json:"kind"`
	Query             string `json:"query,omitempty"`
	ExcludeExternalID string `json:"exclude_external_id,omitempty"`
}

type playbackSourceState struct {
	Cursor            string `json:"cursor,omitempty"`
	Page              int    `json:"page"`
	HasMore           bool   `json:"has_more"`
	ExcludeExternalID string `json:"exclude_external_id,omitempty"`
	Cycle             int    `json:"cycle,omitempty"`
}

type playbackSegment struct {
	Offset     int64 `json:"offset"`
	Length     int64 `json:"length"`
	DurationMS int64 `json:"duration_ms"`
}

type playbackAsset struct {
	ID             string
	ObjectKey      string
	InitOffset     int64
	InitLength     int64
	DurationMS     int64
	TargetDuration int
	Segments       []playbackSegment
}

type playbackSeedTrack struct {
	Track models.Track
	Asset playbackAsset
}

type playbackSessionItem struct {
	Ordinal            int           `json:"ordinal"`
	Track              models.Track  `json:"track"`
	TimelineStartMS    int64         `json:"timeline_start_ms"`
	DurationMS         int64         `json:"duration_ms"`
	FirstMediaSequence int64         `json:"-"`
	SegmentCount       int           `json:"-"`
	Asset              playbackAsset `json:"-"`
}

type playbackSessionResponse struct {
	ID                 string                `json:"id"`
	Revision           int64                 `json:"revision"`
	ManifestURL        string                `json:"manifest_url"`
	ExpiresAt          time.Time             `json:"expires_at"`
	StartOffsetSeconds float64               `json:"start_offset_seconds"`
	Items              []playbackSessionItem `json:"items"`
	HasMore            bool                  `json:"has_more"`
}

type playbackSessionRecord struct {
	ID                       string
	UserID                   string
	SourceKind               string
	SourceQuery              string
	SourceState              playbackSourceState
	Status                   string
	Revision                 int64
	StartPositionMS          int64
	LastFetchedMediaSequence int64
	ExpiresAt                time.Time
	CreatedAt                time.Time
}

func (s *Server) createPlaybackSession(c *fiber.Ctx) error {
	if s.db == nil {
		return writeAPIError(c, fiber.StatusServiceUnavailable, "playback_unavailable", "Playback sessions are temporarily unavailable", nil)
	}
	userID, ok := c.Locals("userID").(string)
	if !ok || strings.TrimSpace(userID) == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}

	var request createPlaybackSessionRequest
	if err := c.BodyParser(&request); err != nil {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_playback_session", "We could not read the playback queue", nil)
	}
	if err := validateCreatePlaybackSessionRequest(&request); err != nil {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_playback_session", err.Error(), nil)
	}

	readiness, err := s.libraryPlaybackReadiness(c.UserContext())
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to check HLS readiness")
	}
	if readiness.RetryableTracks() > 0 {
		return writeAPIError(
			c,
			fiber.StatusServiceUnavailable,
			"hls_backfill_incomplete",
			"Background playback is still being prepared. The regular player remains available.",
			map[string]any{
				"missing_tracks":    readiness.MissingTracks,
				"terminal_failures": readiness.TerminalFailures,
			},
		)
	}

	seed, err := s.loadPlaybackSeedTracks(c.UserContext(), request.InitialExternalIDs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return writeAPIError(
				c,
				fiber.StatusServiceUnavailable,
				"hls_track_unavailable",
				"One or more queued tracks need the regular player on this device.",
				nil,
			)
		}
		return fiber.NewError(fiber.StatusInternalServerError, "failed to prepare playback queue")
	}

	state := playbackSourceState{
		Cursor:            strings.TrimSpace(request.Cursor),
		Page:              request.Page,
		HasMore:           request.HasMore,
		ExcludeExternalID: strings.TrimSpace(request.Source.ExcludeExternalID),
	}
	response, err := s.insertPlaybackSession(c.UserContext(), userID, request, state, seed)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create playback session")
	}

	if state.HasMore || request.Source.Kind == "shuffle" {
		if err := s.ensurePlaybackHorizon(c.UserContext(), response.ID, userID); err != nil {
			_, _ = s.db.Exec(c.UserContext(), `DELETE FROM playback_sessions WHERE id=$1 AND user_id=$2`, response.ID, userID)
			return fiber.NewError(fiber.StatusBadGateway, "failed to continue playback queue")
		}
		response, err = s.loadPlaybackSessionResponse(c.UserContext(), response.ID, userID)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "failed to load playback session")
		}
	}

	return c.Status(fiber.StatusCreated).JSON(response)
}

func validateCreatePlaybackSessionRequest(request *createPlaybackSessionRequest) error {
	request.Source.Kind = strings.TrimSpace(strings.ToLower(request.Source.Kind))
	request.Source.Query = strings.TrimSpace(request.Source.Query)
	request.Source.ExcludeExternalID = strings.TrimSpace(request.Source.ExcludeExternalID)
	request.CurrentExternalID = strings.TrimSpace(request.CurrentExternalID)
	if request.Page < 1 {
		request.Page = 1
	}
	if request.Page > playbackSourcePageLimit {
		return fmt.Errorf("The playback source position is too large")
	}
	if request.Source.Kind != "search" && request.Source.Kind != "likes" && request.Source.Kind != "shuffle" {
		return fmt.Errorf("Choose a valid playback source")
	}
	if len(request.InitialExternalIDs) == 0 || len(request.InitialExternalIDs) > playbackInitialTrackLimit {
		return fmt.Errorf("The initial queue must contain between 1 and %d tracks", playbackInitialTrackLimit)
	}
	if request.CurrentIndex < 0 || request.CurrentIndex >= len(request.InitialExternalIDs) {
		return fmt.Errorf("The current queue position is invalid")
	}
	if !isFiniteNonNegative(request.PositionSeconds) {
		return fmt.Errorf("The playback position is invalid")
	}
	seen := make(map[string]struct{}, len(request.InitialExternalIDs))
	for index, externalID := range request.InitialExternalIDs {
		externalID = strings.TrimSpace(externalID)
		if externalID == "" {
			return fmt.Errorf("The queue contains an invalid track")
		}
		if _, exists := seen[externalID]; exists {
			return fmt.Errorf("The initial queue contains the same track more than once")
		}
		seen[externalID] = struct{}{}
		request.InitialExternalIDs[index] = externalID
	}
	if request.CurrentExternalID == "" || request.InitialExternalIDs[request.CurrentIndex] != request.CurrentExternalID {
		return fmt.Errorf("The current track does not match the queue position")
	}
	return nil
}

func isFiniteNonNegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

type playbackReadiness struct {
	MissingTracks    int
	TerminalFailures int
}

func (readiness playbackReadiness) RetryableTracks() int {
	return max(0, readiness.MissingTracks-readiness.TerminalFailures)
}

func (s *Server) libraryPlaybackReadiness(ctx context.Context) (playbackReadiness, error) {
	var readiness playbackReadiness
	err := s.db.QueryRow(ctx, `
		WITH missing AS (
			SELECT track.id
			FROM library_tracks track
			WHERE track.status='ready'
			  AND NOT EXISTS (
				SELECT 1 FROM track_playback_assets asset
				WHERE asset.track_id=track.id AND asset.status='ready' AND asset.retired_at IS NULL
			  )
		)
		SELECT COUNT(*),COUNT(*) FILTER (WHERE
			EXISTS (
				SELECT 1 FROM media_jobs job
				WHERE job.track_id=missing.id AND job.kind='prepare_hls'
				  AND job.status='failed' AND job.attempts >= $1
			)
			AND NOT EXISTS (
				SELECT 1 FROM media_jobs job
				WHERE job.track_id=missing.id AND job.kind='prepare_hls'
				  AND job.status IN ('pending','running')
			)
		)
		FROM missing
	`, hlsPreparationMaxAttempts).Scan(&readiness.MissingTracks, &readiness.TerminalFailures)
	return readiness, err
}

func (s *Server) libraryHasMissingPlaybackAssets(ctx context.Context) (bool, error) {
	readiness, err := s.libraryPlaybackReadiness(ctx)
	return readiness.RetryableTracks() > 0, err
}

func parsePlaybackSegments(raw []byte) ([]playbackSegment, error) {
	var segments []playbackSegment
	if err := json.Unmarshal(raw, &segments); err != nil {
		return nil, err
	}
	if len(segments) == 0 {
		return nil, fmt.Errorf("playback asset has no segments")
	}
	for _, segment := range segments {
		if segment.Offset < 0 || segment.Length <= 0 || segment.DurationMS <= 0 {
			return nil, fmt.Errorf("playback asset contains an invalid segment")
		}
	}
	return segments, nil
}

func (s *Server) loadPlaybackSeedTracks(ctx context.Context, externalIDs []string) ([]playbackSeedTrack, error) {
	tracks, err := s.loadAvailablePlaybackSeedTracks(ctx, externalIDs)
	if err != nil {
		return nil, err
	}
	if len(tracks) != len(externalIDs) {
		return nil, pgx.ErrNoRows
	}
	return tracks, nil
}

func (s *Server) loadAvailablePlaybackSeedTracks(ctx context.Context, externalIDs []string) ([]playbackSeedTrack, error) {
	rows, err := s.db.Query(ctx, `
		SELECT track.id::text,track.external_track_id,track.title,track.artist,track.album,
		       track.duration_seconds,track.created_at,asset.id::text,asset.object_key,
		       asset.init_offset,asset.init_length,asset.duration_ms,asset.target_duration,
		       asset.segments
		FROM unnest($1::text[]) WITH ORDINALITY requested(external_id,position)
		JOIN library_tracks track ON track.external_track_id=requested.external_id AND track.status='ready'
		JOIN track_playback_assets asset ON asset.track_id=track.id
		  AND asset.status='ready' AND asset.retired_at IS NULL
		ORDER BY requested.position
	`, externalIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tracks := make([]playbackSeedTrack, 0, len(externalIDs))
	for rows.Next() {
		var item playbackSeedTrack
		var segmentsJSON []byte
		if err := rows.Scan(
			&item.Track.ID, &item.Track.ExternalID, &item.Track.Title, &item.Track.Artist,
			&item.Track.Album, &item.Track.DurationSeconds, &item.Track.CreatedAt,
			&item.Asset.ID, &item.Asset.ObjectKey, &item.Asset.InitOffset, &item.Asset.InitLength,
			&item.Asset.DurationMS, &item.Asset.TargetDuration, &segmentsJSON,
		); err != nil {
			return nil, err
		}
		segments, err := parsePlaybackSegments(segmentsJSON)
		if err != nil {
			return nil, err
		}
		item.Asset.Segments = segments
		item.Track.Status = "ready"
		item.Track.CoverURL = libraryTrackCoverURL(item.Track)
		tracks = append(tracks, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tracks, nil
}

func (s *Server) insertPlaybackSession(
	ctx context.Context,
	userID string,
	request createPlaybackSessionRequest,
	state playbackSourceState,
	seed []playbackSeedTrack,
) (playbackSessionResponse, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return playbackSessionResponse{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Serialize creation for this listener, then keep at most two older
	// sessions before inserting the new one. This makes the three-session
	// bound deterministic even when several tabs start playback together.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, userID); err != nil {
		return playbackSessionResponse{}, err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM playback_sessions
		WHERE id IN (
			SELECT id FROM playback_sessions
			WHERE user_id=$1 AND status='active' AND expires_at>NOW()
			ORDER BY last_accessed_at DESC,id DESC
			OFFSET 2
		)
	`, userID); err != nil {
		return playbackSessionResponse{}, err
	}

	stateJSON, err := json.Marshal(state)
	if err != nil {
		return playbackSessionResponse{}, err
	}
	startOffsetMS := int64(0)
	for index := 0; index < request.CurrentIndex; index++ {
		startOffsetMS += seed[index].Asset.DurationMS
	}
	currentDuration := seed[request.CurrentIndex].Asset.DurationMS
	requestedPositionMS := int64(math.Round(request.PositionSeconds * 1000))
	requestedPositionMS = min(max(requestedPositionMS, 0), currentDuration)
	startOffsetMS += requestedPositionMS

	var sessionID string
	var revision int64
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO playback_sessions (
			user_id,source_kind,source_query,source_state,status,revision,start_position_ms,
			last_accessed_at,expires_at
		) VALUES ($1,$2,$3,$4,'active',0,$5,NOW(),NOW()+($6 * INTERVAL '1 second'))
		RETURNING id::text,revision,expires_at
	`, userID, request.Source.Kind, request.Source.Query, stateJSON, startOffsetMS, int64(playbackSessionTTL/time.Second)).Scan(
		&sessionID, &revision, &expiresAt,
	)
	if err != nil {
		return playbackSessionResponse{}, err
	}

	timelineMS := int64(0)
	mediaSequence := int64(0)
	items := make([]playbackSessionItem, 0, len(seed))
	cycleNo := 0
	if request.Source.Kind == "shuffle" {
		cycleNo = state.Cycle
	}
	for ordinal, item := range seed {
		snapshotJSON, err := json.Marshal(item.Track)
		if err != nil {
			return playbackSessionResponse{}, err
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO playback_session_items (
				session_id,ordinal,cycle_no,track_id,hls_asset_id,track_snapshot,first_media_sequence,
				segment_count,timeline_start_ms,duration_ms
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		`, sessionID, ordinal, cycleNo, item.Track.ID, item.Asset.ID, snapshotJSON, mediaSequence,
			len(item.Asset.Segments), timelineMS, item.Asset.DurationMS)
		if err != nil {
			return playbackSessionResponse{}, err
		}
		items = append(items, playbackSessionItem{
			Ordinal: ordinal, Track: item.Track, TimelineStartMS: timelineMS,
			DurationMS: item.Asset.DurationMS, FirstMediaSequence: mediaSequence,
			SegmentCount: len(item.Asset.Segments), Asset: item.Asset,
		})
		timelineMS += item.Asset.DurationMS
		mediaSequence += int64(len(item.Asset.Segments))
	}
	if err := tx.Commit(ctx); err != nil {
		return playbackSessionResponse{}, err
	}

	return playbackSessionResponse{
		ID: sessionID, Revision: revision,
		ManifestURL: playbackManifestURL(sessionID, revision), ExpiresAt: expiresAt,
		StartOffsetSeconds: float64(startOffsetMS) / 1000, Items: items,
		HasMore: state.HasMore || request.Source.Kind == "shuffle",
	}, nil
}

func playbackManifestURL(sessionID string, revision int64) string {
	return fmt.Sprintf("/api/v1/me/playback-sessions/%s/index.m3u8?revision=%d", sessionID, revision)
}

func (s *Server) getPlaybackSession(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}
	response, err := s.loadPlaybackSessionResponse(c.UserContext(), c.Params("id"), userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return writeAPIError(c, fiber.StatusNotFound, "playback_session_not_found", "Playback session was not found", nil)
	}
	if errors.Is(err, errPlaybackSessionExpired) {
		return writeAPIError(c, fiber.StatusGone, "playback_session_expired", "Playback session has expired", nil)
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load playback session")
	}
	return c.JSON(response)
}

var errPlaybackSessionExpired = errors.New("playback session expired")

func (s *Server) loadPlaybackSessionResponse(ctx context.Context, sessionID, userID string) (playbackSessionResponse, error) {
	record, items, err := s.loadPlaybackSession(ctx, sessionID, userID, false)
	if err != nil {
		return playbackSessionResponse{}, err
	}
	return playbackSessionResponse{
		ID: record.ID, Revision: record.Revision,
		ManifestURL: playbackManifestURL(record.ID, record.Revision), ExpiresAt: record.ExpiresAt,
		StartOffsetSeconds: float64(record.StartPositionMS) / 1000,
		Items:              items, HasMore: record.SourceState.HasMore || record.SourceKind == "shuffle",
	}, nil
}

func (s *Server) loadPlaybackSession(
	ctx context.Context,
	sessionID string,
	userID string,
	includeAssets bool,
) (playbackSessionRecord, []playbackSessionItem, error) {
	record, err := s.loadPlaybackSessionRecord(ctx, sessionID, userID)
	if err != nil {
		return playbackSessionRecord{}, nil, err
	}
	items, err := s.loadPlaybackSessionItems(ctx, sessionID, includeAssets, 0, -1)
	if err != nil {
		return playbackSessionRecord{}, nil, err
	}
	return record, items, nil
}

func (s *Server) loadPlaybackSessionRecord(
	ctx context.Context,
	sessionID string,
	userID string,
) (playbackSessionRecord, error) {
	if _, err := uuid.Parse(sessionID); err != nil {
		return playbackSessionRecord{}, pgx.ErrNoRows
	}
	var record playbackSessionRecord
	var stateJSON []byte
	err := s.db.QueryRow(ctx, `
		SELECT id::text,user_id::text,source_kind,source_query,source_state,status,revision,
		       start_position_ms,last_fetched_media_sequence,expires_at,created_at
		FROM playback_sessions WHERE id=$1 AND user_id=$2
	`, sessionID, userID).Scan(
		&record.ID, &record.UserID, &record.SourceKind, &record.SourceQuery, &stateJSON,
		&record.Status, &record.Revision, &record.StartPositionMS,
		&record.LastFetchedMediaSequence, &record.ExpiresAt, &record.CreatedAt,
	)
	if err != nil {
		return playbackSessionRecord{}, err
	}
	if record.Status == "expired" || time.Now().After(record.ExpiresAt) {
		_, _ = s.db.Exec(ctx, `UPDATE playback_sessions SET status='expired' WHERE id=$1 AND status='active'`, sessionID)
		return playbackSessionRecord{}, errPlaybackSessionExpired
	}
	if err := json.Unmarshal(stateJSON, &record.SourceState); err != nil {
		return playbackSessionRecord{}, err
	}
	return record, nil
}

func (s *Server) loadPlaybackSessionItems(
	ctx context.Context,
	sessionID string,
	includeAssets bool,
	minimumOrdinal int,
	maximumOrdinal int,
) ([]playbackSessionItem, error) {
	columns := `item.ordinal,item.track_snapshot,item.first_media_sequence,item.segment_count,
	            item.timeline_start_ms,item.duration_ms`
	join := ""
	if includeAssets {
		columns += `,asset.id::text,asset.object_key,asset.init_offset,asset.init_length,
		             asset.duration_ms,asset.target_duration,asset.segments`
		join = `JOIN track_playback_assets asset ON asset.id=item.hls_asset_id AND asset.status='ready'`
	}
	ordinalFilter := "item.ordinal >= $2"
	arguments := []any{sessionID, minimumOrdinal}
	if maximumOrdinal >= 0 {
		ordinalFilter += " AND item.ordinal <= $3"
		arguments = append(arguments, maximumOrdinal)
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT %s FROM playback_session_items item %s
		WHERE item.session_id=$1 AND %s ORDER BY item.ordinal
	`, columns, join, ordinalFilter), arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]playbackSessionItem, 0, 32)
	for rows.Next() {
		var item playbackSessionItem
		var trackJSON []byte
		if includeAssets {
			var segmentsJSON []byte
			if err := rows.Scan(
				&item.Ordinal, &trackJSON, &item.FirstMediaSequence, &item.SegmentCount,
				&item.TimelineStartMS, &item.DurationMS, &item.Asset.ID, &item.Asset.ObjectKey,
				&item.Asset.InitOffset, &item.Asset.InitLength, &item.Asset.DurationMS,
				&item.Asset.TargetDuration, &segmentsJSON,
			); err != nil {
				return nil, err
			}
			segments, err := parsePlaybackSegments(segmentsJSON)
			if err != nil {
				return nil, err
			}
			item.Asset.Segments = segments
		} else if err := rows.Scan(
			&item.Ordinal, &trackJSON, &item.FirstMediaSequence, &item.SegmentCount,
			&item.TimelineStartMS, &item.DurationMS,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(trackJSON, &item.Track); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// loadPlaybackManifestItems avoids decoding every historical asset on a
// delta refresh. A long-running shuffle session can contain thousands of
// tracks, while an HLS delta normally needs only the small suffix after the
// last safely fetched media sequence.
func (s *Server) loadPlaybackManifestItems(
	ctx context.Context,
	sessionID string,
	delta bool,
	maxSafeSkip int,
) ([]playbackSessionItem, error) {
	if !delta || maxSafeSkip <= 0 {
		return s.loadPlaybackSessionItems(ctx, sessionID, true, 0, -1)
	}

	var lastOrdinal int
	var totalSegments int
	err := s.db.QueryRow(ctx, `
		SELECT ordinal,(first_media_sequence+segment_count)::integer
		FROM playback_session_items
		WHERE session_id=$1
		ORDER BY ordinal DESC
		LIMIT 1
	`, sessionID).Scan(&lastOrdinal, &totalSegments)
	if err != nil {
		return nil, err
	}

	const tailTrackBatchSize = 16
	minimumRetainedDurationMS := int64(6 * playbackManifestTargetDuration * 1000)
	retainedCount := 0
	retainedDurationMS := int64(0)
	for maximumOrdinal := lastOrdinal; maximumOrdinal >= 0; {
		minimumOrdinal := max(0, maximumOrdinal-tailTrackBatchSize+1)
		items, err := s.loadPlaybackSessionItems(
			ctx,
			sessionID,
			true,
			minimumOrdinal,
			maximumOrdinal,
		)
		if err != nil {
			return nil, err
		}
		for itemIndex := len(items) - 1; itemIndex >= 0; itemIndex-- {
			segments := items[itemIndex].Asset.Segments
			for segmentIndex := len(segments) - 1; segmentIndex >= 0; segmentIndex-- {
				if retainedCount >= playbackManifestTailSegmentNum && retainedDurationMS >= minimumRetainedDurationMS {
					break
				}
				retainedCount++
				retainedDurationMS += segments[segmentIndex].DurationMS
			}
			if retainedCount >= playbackManifestTailSegmentNum && retainedDurationMS >= minimumRetainedDurationMS {
				break
			}
		}
		if retainedCount >= playbackManifestTailSegmentNum && retainedDurationMS >= minimumRetainedDurationMS {
			break
		}
		if minimumOrdinal == 0 {
			return s.loadPlaybackSessionItems(ctx, sessionID, true, 0, -1)
		}
		maximumOrdinal = minimumOrdinal - 1
	}

	skippableCount := max(0, totalSegments-retainedCount)
	skipCount := min(skippableCount, maxSafeSkip)
	if skipCount <= 0 {
		return s.loadPlaybackSessionItems(ctx, sessionID, true, 0, -1)
	}

	var firstOrdinal int
	var firstSequence int64
	var firstSegmentCount int
	err = s.db.QueryRow(ctx, `
		SELECT ordinal,first_media_sequence,segment_count
		FROM playback_session_items
		WHERE session_id=$1 AND first_media_sequence <= $2
		ORDER BY first_media_sequence DESC
		LIMIT 1
	`, sessionID, skipCount).Scan(&firstOrdinal, &firstSequence, &firstSegmentCount)
	if err != nil {
		return nil, err
	}
	if int64(skipCount) >= firstSequence+int64(firstSegmentCount) {
		firstOrdinal++
	}
	return s.loadPlaybackSessionItems(ctx, sessionID, true, firstOrdinal, -1)
}

func (s *Server) loadPlaybackAssetItem(
	ctx context.Context,
	sessionID string,
	userID string,
	ordinal int,
) (playbackSessionRecord, playbackSessionItem, error) {
	if _, err := uuid.Parse(sessionID); err != nil {
		return playbackSessionRecord{}, playbackSessionItem{}, pgx.ErrNoRows
	}
	var record playbackSessionRecord
	var item playbackSessionItem
	var segmentsJSON []byte
	err := s.db.QueryRow(ctx, `
		SELECT session.id::text,session.user_id::text,session.status,session.revision,
		       session.expires_at,item.ordinal,item.first_media_sequence,item.segment_count,
		       item.timeline_start_ms,item.duration_ms,
		       asset.id::text,asset.object_key,asset.init_offset,asset.init_length,
		       asset.duration_ms,asset.target_duration,asset.segments
		FROM playback_sessions session
		JOIN playback_session_items item ON item.session_id=session.id AND item.ordinal=$3
		JOIN track_playback_assets asset ON asset.id=item.hls_asset_id AND asset.status='ready'
		WHERE session.id=$1 AND session.user_id=$2
	`, sessionID, userID, ordinal).Scan(
		&record.ID, &record.UserID, &record.Status, &record.Revision, &record.ExpiresAt,
		&item.Ordinal, &item.FirstMediaSequence, &item.SegmentCount,
		&item.TimelineStartMS, &item.DurationMS,
		&item.Asset.ID, &item.Asset.ObjectKey, &item.Asset.InitOffset, &item.Asset.InitLength,
		&item.Asset.DurationMS, &item.Asset.TargetDuration, &segmentsJSON,
	)
	if err != nil {
		return playbackSessionRecord{}, playbackSessionItem{}, err
	}
	if record.Status == "expired" || time.Now().After(record.ExpiresAt) {
		_, _ = s.db.Exec(ctx, `UPDATE playback_sessions SET status='expired' WHERE id=$1 AND status='active'`, sessionID)
		return playbackSessionRecord{}, playbackSessionItem{}, errPlaybackSessionExpired
	}
	segments, err := parsePlaybackSegments(segmentsJSON)
	if err != nil {
		return playbackSessionRecord{}, playbackSessionItem{}, err
	}
	if len(segments) != item.SegmentCount {
		return playbackSessionRecord{}, playbackSessionItem{}, fmt.Errorf("segment metadata mismatch for item %d", item.Ordinal)
	}
	item.Asset.Segments = segments
	return record, item, nil
}

func (s *Server) deletePlaybackSession(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}
	result, err := s.db.Exec(c.UserContext(), `DELETE FROM playback_sessions WHERE id=$1 AND user_id=$2`, c.Params("id"), userID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to close playback session")
	}
	if result.RowsAffected() == 0 {
		return writeAPIError(c, fiber.StatusNotFound, "playback_session_not_found", "Playback session was not found", nil)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) playbackManifest(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}
	sessionID := c.Params("id")
	if err := s.ensurePlaybackHorizon(c.UserContext(), sessionID, userID); err != nil && !errors.Is(err, errPlaybackSessionExpired) {
		return fiber.NewError(fiber.StatusBadGateway, "failed to continue playback queue")
	}
	record, err := s.loadPlaybackSessionRecord(c.UserContext(), sessionID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return writeAPIError(c, fiber.StatusNotFound, "playback_session_not_found", "Playback session was not found", nil)
	}
	if errors.Is(err, errPlaybackSessionExpired) {
		return writeAPIError(c, fiber.StatusGone, "playback_session_expired", "Playback session has expired", nil)
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load playback manifest")
	}
	if rawRevision := strings.TrimSpace(c.Query("revision")); rawRevision != "" {
		revision, parseErr := strconv.ParseInt(rawRevision, 10, 64)
		if parseErr != nil || revision != record.Revision {
			return writeAPIError(c, fiber.StatusGone, "playback_revision_expired", "This playback revision is no longer active", nil)
		}
	}

	deltaRequested := isHLSDeltaRequest(c.Query("_HLS_skip"))
	maxSafeSkip := int(max(int64(0), record.LastFetchedMediaSequence+1))
	if rawMSN := strings.TrimSpace(c.Query("_HLS_msn")); rawMSN != "" {
		if msn, parseErr := strconv.ParseInt(rawMSN, 10, 64); parseErr == nil && msn >= 0 {
			if msn < int64(maxSafeSkip) {
				maxSafeSkip = int(msn)
			}
		}
	}
	items, err := s.loadPlaybackManifestItems(
		c.UserContext(),
		sessionID,
		deltaRequested && playbackSessionIsEventActive(record),
		maxSafeSkip,
	)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load playback manifest")
	}
	manifest, err := renderPlaybackManifest(record, items, deltaRequested, maxSafeSkip)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to render playback manifest")
	}
	_, _ = s.db.Exec(c.UserContext(), `
		UPDATE playback_sessions SET last_accessed_at=NOW(),expires_at=NOW()+($3 * INTERVAL '1 second')
		WHERE id=$1 AND user_id=$2 AND status='active'
	`, sessionID, userID, int64(playbackSessionTTL/time.Second))
	c.Set(fiber.HeaderContentType, "application/vnd.apple.mpegurl")
	c.Set(fiber.HeaderCacheControl, "private, no-store")
	c.Set(fiber.HeaderVary, "Cookie")
	return c.SendString(manifest)
}

func isHLSDeltaRequest(value string) bool {
	return value == "YES" || value == "v2"
}

func playbackSessionIsEventActive(record playbackSessionRecord) bool {
	return record.SourceState.HasMore || record.SourceKind == "shuffle"
}

func renderPlaybackManifest(
	record playbackSessionRecord,
	items []playbackSessionItem,
	delta bool,
	maxSafeSkip int,
) (string, error) {
	if len(items) == 0 {
		return "", fmt.Errorf("playback session has no items")
	}
	targetDuration := playbackManifestTargetDuration
	totalSegments := int(items[len(items)-1].FirstMediaSequence) + items[len(items)-1].SegmentCount
	for _, item := range items {
		if item.Asset.TargetDuration < 1 || item.Asset.TargetDuration > targetDuration {
			return "", fmt.Errorf("asset target duration is unsupported for item %d", item.Ordinal)
		}
		if len(item.Asset.Segments) != item.SegmentCount {
			return "", fmt.Errorf("segment metadata mismatch for item %d", item.Ordinal)
		}
		for _, segment := range item.Asset.Segments {
			rounded := int(math.Ceil(float64(segment.DurationMS) / 1000))
			if rounded > targetDuration {
				return "", fmt.Errorf("segment duration is unsupported for item %d", item.Ordinal)
			}
		}
	}

	isEventActive := playbackSessionIsEventActive(record)
	// CAN-SKIP-UNTIL is the duration of the playlist tail which remains after
	// a delta update (the Skip Boundary measured from the live edge), not the
	// duration of the removed prefix. Keep at least twelve segments and at
	// least six target durations so every advertised delta is spec-compliant.
	retainedCount := 0
	retainedDurationMS := int64(0)
	minimumRetainedDurationMS := int64(6 * targetDuration * 1000)
	if isEventActive {
		for itemIndex := len(items) - 1; itemIndex >= 0; itemIndex-- {
			segments := items[itemIndex].Asset.Segments
			for segmentIndex := len(segments) - 1; segmentIndex >= 0; segmentIndex-- {
				if retainedCount >= playbackManifestTailSegmentNum && retainedDurationMS >= minimumRetainedDurationMS {
					break
				}
				retainedCount++
				retainedDurationMS += segments[segmentIndex].DurationMS
			}
			if retainedCount >= playbackManifestTailSegmentNum && retainedDurationMS >= minimumRetainedDurationMS {
				break
			}
		}
	}
	skippableCount := max(0, totalSegments-retainedCount)
	canSkip := isEventActive && skippableCount > 0 && retainedDurationMS >= minimumRetainedDurationMS
	skipCount := 0
	if delta && canSkip {
		skipCount = min(skippableCount, max(0, maxSafeSkip))
	}
	var manifest strings.Builder
	manifest.Grow(max(1024, (totalSegments-skipCount)*128))
	manifest.WriteString("#EXTM3U\n#EXT-X-VERSION:10\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	fmt.Fprintf(&manifest, "#EXT-X-TARGETDURATION:%d\n", targetDuration)
	manifest.WriteString("#EXT-X-PLAYLIST-TYPE:EVENT\n")
	// EXT-X-SKIP counts from the parent playlist's media sequence. It does not
	// advance MEDIA-SEQUENCE or DISCONTINUITY-SEQUENCE by itself.
	manifest.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n")
	manifest.WriteString("#EXT-X-DISCONTINUITY-SEQUENCE:0\n")
	if canSkip {
		canSkipSeconds := float64(retainedDurationMS) / 1000
		fmt.Fprintf(&manifest, "#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=%.3f\n", canSkipSeconds)
	}
	if skipCount > 0 {
		fmt.Fprintf(&manifest, "#EXT-X-SKIP:SKIPPED-SEGMENTS=%d\n", skipCount)
	}
	fmt.Fprintf(&manifest, "#EXT-X-START:TIME-OFFSET=%.3f,PRECISE=YES\n", float64(record.StartPositionMS)/1000)

	emittedSegments := 0
	firstEmitted := true
	for _, item := range items {
		assetURI := fmt.Sprintf("assets/%d/%d.mp4", record.Revision, item.Ordinal)
		itemStartIndex := 0
		if skipCount > int(item.FirstMediaSequence) {
			itemStartIndex = min(item.SegmentCount, skipCount-int(item.FirstMediaSequence))
		}
		if itemStartIndex >= item.SegmentCount {
			continue
		}
		if !firstEmitted {
			manifest.WriteString("#EXT-X-DISCONTINUITY\n")
		}
		firstEmitted = false
		fmt.Fprintf(&manifest, "#EXT-X-MAP:URI=\"%s\",BYTERANGE=\"%d@%d\"\n", assetURI, item.Asset.InitLength, item.Asset.InitOffset)
		for _, segment := range item.Asset.Segments[itemStartIndex:] {
			fmt.Fprintf(&manifest, "#EXTINF:%.3f,\n", float64(segment.DurationMS)/1000)
			fmt.Fprintf(&manifest, "#EXT-X-BYTERANGE:%d@%d\n%s\n", segment.Length, segment.Offset, assetURI)
			emittedSegments++
		}
	}
	if emittedSegments == 0 {
		return "", fmt.Errorf("playback manifest has no media segments")
	}
	if !isEventActive {
		manifest.WriteString("#EXT-X-ENDLIST\n")
	}
	return manifest.String(), nil
}

func (s *Server) ensurePlaybackHorizon(ctx context.Context, sessionID, userID string) error {
	for attempt := 0; attempt < playbackContinuationPageLimit; attempt++ {
		record, err := s.loadPlaybackSessionRecord(ctx, sessionID, userID)
		if err != nil {
			return err
		}
		needsContinuation, err := s.playbackNeedsContinuationFromDB(ctx, record)
		if err != nil {
			return err
		}
		if !needsContinuation {
			return nil
		}
		tracks, nextState, err := s.fetchPlaybackContinuation(ctx, record)
		if err != nil {
			return err
		}
		if len(tracks) == 0 && !nextState.HasMore && record.SourceKind != "shuffle" {
			return s.updatePlaybackSourceState(ctx, record, nextState)
		}
		if len(tracks) == 0 && record.SourceKind == "shuffle" {
			if err := s.updatePlaybackSourceState(ctx, record, nextState); err != nil {
				if errors.Is(err, errPlaybackContinuationChanged) {
					continue
				}
				return err
			}
			if !nextState.HasMore {
				return nil
			}
			continue
		}
		seed, err := s.loadPlaybackTracksIgnoringMissing(ctx, tracks)
		if err != nil {
			return err
		}
		if err := s.appendPlaybackContinuation(ctx, record, nextState, seed); err != nil {
			if errors.Is(err, errPlaybackContinuationChanged) {
				continue
			}
			return err
		}
	}
	return fmt.Errorf("playback continuation exceeded the safety limit")
}

func (s *Server) playbackNeedsContinuationFromDB(
	ctx context.Context,
	record playbackSessionRecord,
) (bool, error) {
	if !record.SourceState.HasMore && record.SourceKind != "shuffle" {
		return false, nil
	}

	var lastEndMS int64
	err := s.db.QueryRow(ctx, `
		SELECT timeline_start_ms+duration_ms
		FROM playback_session_items
		WHERE session_id=$1
		ORDER BY ordinal DESC
		LIMIT 1
	`, record.ID).Scan(&lastEndMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}

	referenceMS := record.StartPositionMS
	if record.LastFetchedMediaSequence >= 0 {
		var timelineStartMS int64
		var firstMediaSequence int64
		var segmentsJSON []byte
		err = s.db.QueryRow(ctx, `
			SELECT item.timeline_start_ms,item.first_media_sequence,asset.segments
			FROM playback_session_items item
			JOIN track_playback_assets asset ON asset.id=item.hls_asset_id AND asset.status='ready'
			WHERE item.session_id=$1 AND item.first_media_sequence <= $2
			ORDER BY item.first_media_sequence DESC
			LIMIT 1
		`, record.ID, record.LastFetchedMediaSequence).Scan(
			&timelineStartMS,
			&firstMediaSequence,
			&segmentsJSON,
		)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		if err == nil {
			segments, parseErr := parsePlaybackSegments(segmentsJSON)
			if parseErr != nil {
				return false, parseErr
			}
			lastFetchedIndex := int(record.LastFetchedMediaSequence - firstMediaSequence)
			if lastFetchedIndex >= 0 && lastFetchedIndex < len(segments) {
				referenceMS = timelineStartMS
				for index := 0; index <= lastFetchedIndex; index++ {
					referenceMS += segments[index].DurationMS
				}
			}
		}
	}
	return time.Duration(max(int64(0), lastEndMS-referenceMS))*time.Millisecond < playbackMinimumFutureDuration, nil
}

func playbackNeedsContinuation(record playbackSessionRecord, items []playbackSessionItem) bool {
	if len(items) == 0 {
		return record.SourceState.HasMore || record.SourceKind == "shuffle"
	}
	if !record.SourceState.HasMore && record.SourceKind != "shuffle" {
		return false
	}
	lastEnd := items[len(items)-1].TimelineStartMS + items[len(items)-1].DurationMS
	referenceMS := record.StartPositionMS
	if record.LastFetchedMediaSequence >= 0 {
		for _, item := range items {
			if record.LastFetchedMediaSequence >= item.FirstMediaSequence &&
				record.LastFetchedMediaSequence < item.FirstMediaSequence+int64(item.SegmentCount) {
				referenceMS = item.TimelineStartMS
				lastFetchedIndex := int(record.LastFetchedMediaSequence - item.FirstMediaSequence)
				for index := 0; index <= lastFetchedIndex; index++ {
					referenceMS += item.Asset.Segments[index].DurationMS
				}
				break
			}
		}
	}
	return time.Duration(max(int64(0), lastEnd-referenceMS))*time.Millisecond < playbackMinimumFutureDuration
}

func (s *Server) fetchPlaybackContinuation(ctx context.Context, record playbackSessionRecord) ([]models.Track, playbackSourceState, error) {
	state := record.SourceState
	nextPage := max(1, state.Page+1)
	switch record.SourceKind {
	case "search":
		if !state.HasMore {
			return nil, state, nil
		}
		tracks, pagination, err := s.searchLibraryTracks(ctx, record.SourceQuery, nextPage, state.Cursor)
		if err != nil {
			return nil, state, err
		}
		state.Page = nextPage
		state.Cursor = pagination.NextCursor
		state.HasMore = pagination.HasNext && pagination.NextCursor != ""
		return tracks, state, nil
	case "likes":
		if !state.HasMore {
			return nil, state, nil
		}
		response, err := s.listLikedTracks(ctx, record.UserID, nextPage, state.Cursor)
		if err != nil {
			return nil, state, err
		}
		state.Page = nextPage
		state.Cursor = response.NextCursor
		state.HasMore = response.HasNext && response.NextCursor != ""
		return response.Results, state, nil
	case "shuffle":
		var cursor shuffleCursor
		if state.Cursor == "" {
			anchor, err := s.chooseShuffleAnchor(ctx)
			if errors.Is(err, pgx.ErrNoRows) {
				state.HasMore = false
				return nil, state, nil
			}
			if err != nil {
				return nil, state, err
			}
			cursor = shuffleCursor{Version: shuffleCursorVersion, Anchor: anchor, Excluded: state.ExcludeExternalID}
		} else {
			decoded, err := s.decodeShuffleCursor(state.Cursor)
			if err != nil {
				state.Cursor = ""
				state.HasMore = true
				return nil, state, nil
			}
			cursor = decoded
		}
		tracks, next, err := s.listShuffleTracks(ctx, cursor, shufflePageSize)
		if err != nil {
			return nil, state, err
		}
		state.Page = nextPage
		if next == nil {
			state.Cursor = ""
			state.HasMore = true
			state.Cycle++
			// Exclusion only belongs to the first cycle; keeping it would make
			// the track that started shuffle disappear from every later cycle.
			state.ExcludeExternalID = ""
		} else {
			state.Cursor, err = s.encodeShuffleCursor(*next)
			if err != nil {
				return nil, state, err
			}
			state.HasMore = true
		}
		return tracks, state, nil
	default:
		return nil, state, fmt.Errorf("unsupported playback source %q", record.SourceKind)
	}
}

func (s *Server) loadPlaybackTracksIgnoringMissing(ctx context.Context, tracks []models.Track) ([]playbackSeedTrack, error) {
	if len(tracks) == 0 {
		return []playbackSeedTrack{}, nil
	}
	ids := make([]string, 0, len(tracks))
	for _, track := range tracks {
		ids = append(ids, track.ExternalID)
	}
	return s.loadAvailablePlaybackSeedTracks(ctx, ids)
}

func samePlaybackSourcePosition(left, right playbackSourceState) bool {
	return left.Cursor == right.Cursor && left.Page == right.Page &&
		left.HasMore == right.HasMore && left.Cycle == right.Cycle &&
		left.ExcludeExternalID == right.ExcludeExternalID
}

func (s *Server) appendPlaybackContinuation(
	ctx context.Context,
	expected playbackSessionRecord,
	nextState playbackSourceState,
	seed []playbackSeedTrack,
) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var stateJSON []byte
	if err := tx.QueryRow(ctx, `SELECT source_state FROM playback_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, expected.ID, expected.UserID).Scan(&stateJSON); err != nil {
		return err
	}
	var currentState playbackSourceState
	if err := json.Unmarshal(stateJSON, &currentState); err != nil {
		return err
	}
	if !samePlaybackSourcePosition(currentState, expected.SourceState) {
		return errPlaybackContinuationChanged
	}

	var nextOrdinal int
	var timelineMS, mediaSequence int64
	err = tx.QueryRow(ctx, `
		SELECT ordinal+1,timeline_start_ms+duration_ms,first_media_sequence+segment_count
		FROM playback_session_items
		WHERE session_id=$1
		ORDER BY ordinal DESC
		LIMIT 1
	`, expected.ID).Scan(&nextOrdinal, &timelineMS, &mediaSequence)
	if errors.Is(err, pgx.ErrNoRows) {
		nextOrdinal = 0
		timelineMS = 0
		mediaSequence = 0
		err = nil
	}
	if err != nil {
		return err
	}
	existing := make(map[string]struct{}, len(seed))
	if expected.SourceKind != "shuffle" {
		seedTrackIDs := make([]string, 0, len(seed))
		for _, item := range seed {
			seedTrackIDs = append(seedTrackIDs, item.Track.ID)
		}
		if len(seedTrackIDs) > 0 {
			rows, err := tx.Query(ctx, `
				SELECT track_id::text
				FROM playback_session_items
				WHERE session_id=$1 AND track_id=ANY($2::uuid[])
			`, expected.ID, seedTrackIDs)
			if err != nil {
				return err
			}
			for rows.Next() {
				var trackID string
				if err := rows.Scan(&trackID); err != nil {
					rows.Close()
					return err
				}
				existing[trackID] = struct{}{}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return err
			}
			rows.Close()
		}
	}

	for _, item := range seed {
		if _, duplicate := existing[item.Track.ID]; duplicate {
			continue
		}
		if expected.SourceKind != "shuffle" {
			existing[item.Track.ID] = struct{}{}
		}
		snapshotJSON, err := json.Marshal(item.Track)
		if err != nil {
			return err
		}
		cycleNo := 0
		if expected.SourceKind == "shuffle" {
			// A page that exhausts shuffle still belongs to the old cycle. The
			// increment in nextState only applies to the following fetch.
			cycleNo = expected.SourceState.Cycle
		}
		var insertedOrdinal int
		row := tx.QueryRow(ctx, `
			INSERT INTO playback_session_items (
				session_id,ordinal,cycle_no,track_id,hls_asset_id,track_snapshot,first_media_sequence,
				segment_count,timeline_start_ms,duration_ms
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (session_id,cycle_no,track_id) DO NOTHING
			RETURNING ordinal
		`, expected.ID, nextOrdinal, cycleNo, item.Track.ID, item.Asset.ID, snapshotJSON,
			mediaSequence, len(item.Asset.Segments), timelineMS, item.Asset.DurationMS)
		err = row.Scan(&insertedOrdinal)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		nextOrdinal++
		timelineMS += item.Asset.DurationMS
		mediaSequence += int64(len(item.Asset.Segments))
	}
	stateJSON, err = json.Marshal(nextState)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE playback_sessions SET source_state=$2,last_accessed_at=NOW(),expires_at=NOW()+($3 * INTERVAL '1 second')
		WHERE id=$1
	`, expected.ID, stateJSON, int64(playbackSessionTTL/time.Second)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Server) updatePlaybackSourceState(ctx context.Context, expected playbackSessionRecord, state playbackSourceState) error {
	return s.appendPlaybackContinuation(ctx, expected, state, nil)
}

type parsedByteRange struct {
	Start int64
	End   int64
}

func parseSingleByteRange(raw string, size int64) (parsedByteRange, int, error) {
	if size <= 0 {
		return parsedByteRange{}, 0, fmt.Errorf("asset is empty")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return parsedByteRange{Start: 0, End: size - 1}, http.StatusOK, nil
	}
	if !strings.HasPrefix(raw, "bytes=") || strings.Contains(raw, ",") {
		return parsedByteRange{}, 0, fmt.Errorf("unsupported byte range")
	}
	parts := strings.Split(strings.TrimPrefix(raw, "bytes="), "-")
	if len(parts) != 2 {
		return parsedByteRange{}, 0, fmt.Errorf("invalid byte range")
	}
	if parts[0] == "" {
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || suffix <= 0 {
			return parsedByteRange{}, 0, fmt.Errorf("invalid suffix byte range")
		}
		suffix = min(suffix, size)
		return parsedByteRange{Start: size - suffix, End: size - 1}, http.StatusPartialContent, nil
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return parsedByteRange{}, 0, fmt.Errorf("invalid byte range start")
	}
	end := size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return parsedByteRange{}, 0, fmt.Errorf("invalid byte range end")
		}
		end = min(end, size-1)
	}
	return parsedByteRange{Start: start, End: end}, http.StatusPartialContent, nil
}

func playbackAssetSize(asset playbackAsset) int64 {
	size := asset.InitOffset + asset.InitLength
	for _, segment := range asset.Segments {
		size = max(size, segment.Offset+segment.Length)
	}
	return size
}

func (s *Server) playbackAsset(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}
	sessionID := c.Params("id")
	revision, err := strconv.ParseInt(c.Params("revision"), 10, 64)
	if err != nil {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_playback_revision", "Playback revision is invalid", nil)
	}
	ordinal, err := strconv.Atoi(c.Params("ordinal"))
	if err != nil || ordinal < 0 {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_playback_item", "Playback item is invalid", nil)
	}

	record, item, err := s.loadPlaybackAssetItem(c.UserContext(), sessionID, userID, ordinal)
	if errors.Is(err, pgx.ErrNoRows) {
		return writeAPIError(c, fiber.StatusNotFound, "playback_session_not_found", "Playback session was not found", nil)
	}
	if errors.Is(err, errPlaybackSessionExpired) {
		return writeAPIError(c, fiber.StatusGone, "playback_session_expired", "Playback session has expired", nil)
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load playback asset")
	}
	if revision != record.Revision {
		return writeAPIError(c, fiber.StatusGone, "playback_revision_expired", "This playback revision is no longer active", nil)
	}
	assetSize := playbackAssetSize(item.Asset)
	byteRange, status, rangeErr := parseSingleByteRange(c.Get(fiber.HeaderRange), assetSize)
	if rangeErr != nil {
		c.Set(fiber.HeaderContentRange, fmt.Sprintf("bytes */%d", assetSize))
		return writeAPIError(c, fiber.StatusRequestedRangeNotSatisfiable, "invalid_range", "The requested media range is not available", nil)
	}
	contentLength := byteRange.End - byteRange.Start + 1
	if s.seedCatalog == nil {
		return writeAPIError(c, fiber.StatusServiceUnavailable, "storage_unavailable", "R2 storage is not configured", nil)
	}
	var body io.ReadCloser
	var metadata rangedObjectMetadata
	if c.Method() != fiber.MethodHead {
		body, metadata, err = s.seedCatalog.DownloadObjectRange(
			c.UserContext(), item.Asset.ObjectKey,
			fmt.Sprintf("bytes=%d-%d", byteRange.Start, byteRange.End),
		)
		if err != nil {
			return writeAPIError(c, fiber.StatusBadGateway, "playback_asset_unavailable", "The playback asset could not be loaded", nil)
		}
	}
	c.Set(fiber.HeaderAcceptRanges, "bytes")
	c.Set(fiber.HeaderContentType, "audio/mp4")
	c.Set(fiber.HeaderContentLength, strconv.FormatInt(contentLength, 10))
	c.Set(fiber.HeaderCacheControl, "private, max-age=60")
	if status == http.StatusPartialContent {
		c.Set(fiber.HeaderContentRange, fmt.Sprintf("bytes %d-%d/%d", byteRange.Start, byteRange.End, assetSize))
	}
	if metadata.ContentType != "" {
		c.Set(fiber.HeaderContentType, metadata.ContentType)
	}
	if metadata.ETag != "" {
		c.Set(fiber.HeaderETag, metadata.ETag)
	}
	c.Status(status)
	if c.Method() == fiber.MethodHead {
		return nil
	}
	maxSequence := item.FirstMediaSequence - 1
	for index, segment := range item.Asset.Segments {
		segmentEnd := segment.Offset + segment.Length - 1
		if byteRange.Start <= segmentEnd && byteRange.End >= segment.Offset {
			maxSequence = max(maxSequence, item.FirstMediaSequence+int64(index))
		}
	}
	_, _ = s.db.Exec(c.UserContext(), `
		UPDATE playback_sessions SET
			last_fetched_media_sequence=GREATEST(last_fetched_media_sequence,$3),
			last_accessed_at=NOW(),expires_at=NOW()+($4 * INTERVAL '1 second')
		WHERE id=$1 AND user_id=$2 AND revision=$5
	`, sessionID, userID, maxSequence, int64(playbackSessionTTL/time.Second), revision)
	c.Context().Response.SetBodyStream(body, int(contentLength))
	return nil
}

func cleanupExpiredPlaybackSessions(ctx context.Context, db *pgxpool.Pool) error {
	_, err := db.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM playback_sessions
			WHERE expires_at < NOW()
			ORDER BY expires_at,id LIMIT 500
		)
		DELETE FROM playback_sessions session USING expired WHERE session.id=expired.id
	`)
	return err
}
