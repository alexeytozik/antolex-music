package server

import (
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const adminHLSFailureLimit = 100

type adminHLSBackfillSummary struct {
	ReadyTracks int  `json:"ready_tracks"`
	HLSReady    int  `json:"hls_ready"`
	Preparing   int  `json:"preparing"`
	Failed      int  `json:"failed"`
	Missing     int  `json:"missing"`
	Complete    bool `json:"complete"`
}

type adminHLSBackfillFailure struct {
	TrackID    string    `json:"track_id"`
	ExternalID string    `json:"external_id"`
	Title      string    `json:"title"`
	Artist     string    `json:"artist"`
	Attempts   int       `json:"attempts"`
	Error      string    `json:"error"`
	FailedAt   time.Time `json:"failed_at"`
}

type adminHLSBackfillResponse struct {
	Summary  adminHLSBackfillSummary   `json:"summary"`
	Failures []adminHLSBackfillFailure `json:"failures"`
}

type adminHLSRetryResponse struct {
	TrackID string `json:"track_id"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func (s *Server) getAdminHLSBackfill(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	if s.db == nil {
		return writeAPIError(
			c,
			fiber.StatusServiceUnavailable,
			"hls_backfill_unavailable",
			"HLS preparation status is temporarily unavailable. Try again in a moment.",
			nil,
		)
	}

	ctx := c.UserContext()
	var response adminHLSBackfillResponse
	response.Failures = make([]adminHLSBackfillFailure, 0)
	if err := s.db.QueryRow(ctx, `
		WITH current_assets AS (
			SELECT asset.track_id
			FROM track_playback_assets asset
			WHERE asset.status='ready' AND asset.retired_at IS NULL
		),job_state AS (
			SELECT
				job.track_id,
				BOOL_OR(job.status IN ('pending','running')) AS preparing,
				BOOL_OR(job.status='failed' AND job.attempts >= $1) AS terminal_failure
			FROM media_jobs job
			WHERE job.kind='prepare_hls'
			  AND (
				job.status IN ('pending','running')
				OR (job.status='failed' AND job.attempts >= $1)
			  )
			GROUP BY job.track_id
		)
		SELECT
			COUNT(*),
			COUNT(*) FILTER (WHERE asset.track_id IS NOT NULL),
			COUNT(*) FILTER (WHERE asset.track_id IS NULL AND COALESCE(job.preparing,FALSE)),
			COUNT(*) FILTER (WHERE asset.track_id IS NULL AND NOT COALESCE(job.preparing,FALSE) AND COALESCE(job.terminal_failure,FALSE)),
			COUNT(*) FILTER (WHERE asset.track_id IS NULL AND NOT COALESCE(job.preparing,FALSE) AND NOT COALESCE(job.terminal_failure,FALSE))
		FROM library_tracks track
		LEFT JOIN current_assets asset ON asset.track_id=track.id
		LEFT JOIN job_state job ON job.track_id=track.id
		WHERE track.status='ready'
	`, hlsPreparationMaxAttempts).Scan(
		&response.Summary.ReadyTracks,
		&response.Summary.HLSReady,
		&response.Summary.Preparing,
		&response.Summary.Failed,
		&response.Summary.Missing,
	); err != nil {
		return writeAPIError(
			c,
			fiber.StatusInternalServerError,
			"hls_backfill_load_failed",
			"We couldn’t load HLS preparation status. Try again.",
			nil,
		)
	}
	response.Summary.Complete = response.Summary.ReadyTracks == response.Summary.HLSReady

	rows, err := s.db.Query(ctx, `
		WITH current_assets AS (
			SELECT asset.track_id
			FROM track_playback_assets asset
			WHERE asset.status='ready' AND asset.retired_at IS NULL
		),active_jobs AS (
			SELECT job.track_id
			FROM media_jobs job
			WHERE job.kind='prepare_hls' AND job.status IN ('pending','running')
		),failed_jobs AS (
			SELECT DISTINCT ON (job.track_id)
				job.track_id,job.attempts,job.error_message,
				COALESCE(job.finished_at,job.updated_at) AS failed_at
			FROM media_jobs job
			WHERE job.kind='prepare_hls'
			  AND job.status='failed'
			  AND job.attempts >= $1
			ORDER BY job.track_id,job.updated_at DESC,job.id DESC
		)
		SELECT
			track.id::text,
			track.external_track_id,
			track.title,
			track.artist,
			failed.attempts,
			COALESCE(NULLIF(failed.error_message,''),'HLS preparation failed'),
			failed.failed_at
		FROM failed_jobs failed
		JOIN library_tracks track ON track.id=failed.track_id
		LEFT JOIN current_assets asset ON asset.track_id=track.id
		LEFT JOIN active_jobs active ON active.track_id=track.id
		WHERE track.status='ready'
		  AND asset.track_id IS NULL
		  AND active.track_id IS NULL
		ORDER BY failed.failed_at DESC,track.id DESC
		LIMIT $2
	`, hlsPreparationMaxAttempts, adminHLSFailureLimit)
	if err != nil {
		return writeAPIError(
			c,
			fiber.StatusInternalServerError,
			"hls_backfill_load_failed",
			"We couldn’t load failed HLS preparations. Try again.",
			nil,
		)
	}
	defer rows.Close()
	for rows.Next() {
		var failure adminHLSBackfillFailure
		if err := rows.Scan(
			&failure.TrackID,
			&failure.ExternalID,
			&failure.Title,
			&failure.Artist,
			&failure.Attempts,
			&failure.Error,
			&failure.FailedAt,
		); err != nil {
			return writeAPIError(
				c,
				fiber.StatusInternalServerError,
				"hls_backfill_load_failed",
				"We couldn’t read failed HLS preparations. Try again.",
				nil,
			)
		}
		response.Failures = append(response.Failures, failure)
	}
	if err := rows.Err(); err != nil {
		return writeAPIError(
			c,
			fiber.StatusInternalServerError,
			"hls_backfill_load_failed",
			"We couldn’t read failed HLS preparations. Try again.",
			nil,
		)
	}

	return c.JSON(response)
}

func (s *Server) retryAdminHLSBackfill(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	if s.db == nil {
		return writeAPIError(
			c,
			fiber.StatusServiceUnavailable,
			"hls_backfill_unavailable",
			"HLS preparation is temporarily unavailable. Try again in a moment.",
			nil,
		)
	}

	rawTrackID := strings.TrimSpace(c.Params("trackID"))
	trackID, err := uuid.Parse(rawTrackID)
	if err != nil {
		return writeAPIError(
			c,
			fiber.StatusBadRequest,
			"invalid_track_id",
			"This track identifier is invalid. Refresh the page and try again.",
			nil,
		)
	}

	ctx := c.UserContext()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return writeAPIError(c, fiber.StatusInternalServerError, "hls_retry_failed", "We couldn’t queue this track yet. Try again.", nil)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var trackStatus string
	if err := tx.QueryRow(ctx, `
		SELECT status FROM library_tracks WHERE id=$1 FOR UPDATE
	`, trackID).Scan(&trackStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return writeAPIError(c, fiber.StatusNotFound, "hls_track_not_found", "This track is no longer available.", nil)
		}
		return writeAPIError(c, fiber.StatusInternalServerError, "hls_retry_failed", "We couldn’t queue this track yet. Try again.", nil)
	}
	if trackStatus != "ready" {
		return writeAPIError(
			c,
			fiber.StatusConflict,
			"hls_track_not_ready",
			"This track is not ready for background playback preparation yet.",
			map[string]any{"status": trackStatus},
		)
	}

	var assetReady bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM track_playback_assets
			WHERE track_id=$1 AND status='ready' AND retired_at IS NULL
		)
	`, trackID).Scan(&assetReady); err != nil {
		return writeAPIError(c, fiber.StatusInternalServerError, "hls_retry_failed", "We couldn’t queue this track yet. Try again.", nil)
	}
	if assetReady {
		return writeAPIError(
			c,
			fiber.StatusConflict,
			"hls_asset_already_ready",
			"This track is already ready for continuous background playback.",
			nil,
		)
	}

	var activeStatus string
	err = tx.QueryRow(ctx, `
		SELECT status FROM media_jobs
		WHERE track_id=$1 AND kind='prepare_hls' AND status IN ('pending','running')
		ORDER BY id DESC LIMIT 1
	`, trackID).Scan(&activeStatus)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return writeAPIError(c, fiber.StatusInternalServerError, "hls_retry_failed", "We couldn’t queue this track yet. Try again.", nil)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
			INSERT INTO media_jobs(kind,track_id,status,attempts,run_at)
			VALUES('prepare_hls',$1,'pending',0,NOW())
			ON CONFLICT DO NOTHING
			RETURNING status
		`, trackID).Scan(&activeStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			err = tx.QueryRow(ctx, `
				SELECT status FROM media_jobs
				WHERE track_id=$1 AND kind='prepare_hls' AND status IN ('pending','running')
				ORDER BY id DESC LIMIT 1
			`, trackID).Scan(&activeStatus)
		}
		if err != nil {
			return writeAPIError(c, fiber.StatusInternalServerError, "hls_retry_failed", "We couldn’t queue this track yet. Try again.", nil)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return writeAPIError(c, fiber.StatusInternalServerError, "hls_retry_failed", "We couldn’t queue this track yet. Try again.", nil)
	}

	return c.Status(fiber.StatusAccepted).JSON(adminHLSRetryResponse{
		TrackID: trackID.String(),
		Status:  activeStatus,
		Message: "HLS preparation is queued. You can refresh this status in a moment.",
	})
}
