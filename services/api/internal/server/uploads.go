package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

const (
	uploadPartSize = int64(8 * 1024 * 1024)
	maxUploadSize  = int64(50 * 1024 * 1024)
	uploadPageSize = 50
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type createUploadRequest struct {
	FileName    string `json:"file_name"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
	SHA256Hex   string `json:"sha256_hex"`
	Title       string `json:"title"`
	Artist      string `json:"artist"`
	Album       string `json:"album"`
}

type uploadPartResponse struct {
	PartNumber int    `json:"part_number"`
	ETag       string `json:"etag"`
	SizeBytes  int64  `json:"size_bytes"`
}

type uploadResponse struct {
	ID            string               `json:"id"`
	FileName      string               `json:"file_name"`
	ContentType   string               `json:"content_type"`
	SizeBytes     int64                `json:"size_bytes"`
	SHA256        string               `json:"sha256"`
	Status        string               `json:"status"`
	PartSize      int64                `json:"part_size"`
	PartsTotal    int                  `json:"parts_total"`
	UploadedParts []uploadPartResponse `json:"uploaded_parts"`
	Track         *models.Track        `json:"track,omitempty"`
	Error         string               `json:"error,omitempty"`
	ExpiresAt     time.Time            `json:"expires_at"`
	CreatedAt     time.Time            `json:"created_at"`

	ObjectKey   string `json:"-"`
	MultipartID string `json:"-"`
	TrackID     string `json:"-"`
	OriginalKey string `json:"-"`
	PlaybackKey string `json:"-"`
	CoverKey    string `json:"-"`
	LegacyKey   string `json:"-"`
}

type uploadEnvelope struct {
	Upload uploadResponse `json:"upload"`
}
type uploadsEnvelope struct {
	Results    []uploadResponse `json:"results"`
	NextCursor string           `json:"next_cursor,omitempty"`
}
type presignedPartResponse struct {
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt time.Time         `json:"expires_at"`
}
type completeUploadRequest struct {
	Parts []uploadPartResponse `json:"parts"`
}
type uploadCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
}

func (s *Server) createUpload(c *fiber.Ctx) error {
	if s.seedCatalog == nil {
		return writeAPIError(c, fiber.StatusServiceUnavailable, "storage_unavailable", "R2 storage is not configured", nil)
	}
	var req createUploadRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	req.FileName = path.Base(strings.TrimSpace(req.FileName))
	req.ContentType = strings.TrimSpace(req.ContentType)
	if req.ContentType == "" || req.ContentType == "application/octet-stream" {
		req.ContentType = inferAudioContentType(req.FileName)
	}
	if req.SHA256 == "" {
		req.SHA256 = req.SHA256Hex
	}
	req.SHA256 = strings.ToLower(strings.TrimSpace(req.SHA256))
	if req.FileName == "." || req.FileName == "" || len(req.FileName) > 255 {
		return fiber.NewError(fiber.StatusBadRequest, "valid file_name is required")
	}
	if !isSupportedAudioUpload(req.FileName, req.ContentType) {
		return writeAPIError(c, fiber.StatusBadRequest, "unsupported_audio_format", "Supported formats are MP3, M4A, AAC, FLAC, OGG and WAV", nil)
	}
	if !validUploadSize(req.SizeBytes) {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_file_size", "File size must be between 1 byte and 50 MB", map[string]any{"max_size_bytes": maxUploadSize})
	}
	if !sha256Pattern.MatchString(req.SHA256) {
		return fiber.NewError(fiber.StatusBadRequest, "sha256 must be 64 lowercase hexadecimal characters")
	}

	ctx := c.UserContext()
	if duplicate, err := s.findDuplicateTrack(ctx, req.SHA256); err == nil {
		return writeAPIError(c, fiber.StatusConflict, "duplicate_track", "An identical audio file already exists", map[string]any{"track": duplicate})
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to check duplicate")
	}

	sessionID := uuid.New()
	trackID := uuid.New()
	ext := strings.ToLower(path.Ext(req.FileName))
	objectKey := fmt.Sprintf("incoming/%s/original%s", sessionID.String(), ext)
	multipartID, err := s.seedCatalog.CreateMultipartUpload(ctx, objectKey, req.ContentType)
	if err != nil {
		return writeAPIError(c, fiber.StatusBadGateway, "upload_init_failed", "Failed to start upload in storage", nil)
	}
	abort := true
	defer func() {
		if abort {
			_ = s.seedCatalog.AbortMultipartUpload(context.Background(), objectKey, multipartID)
		}
	}()

	title := strings.TrimSpace(req.Title)
	artist := strings.TrimSpace(req.Artist)
	if title == "" {
		title = inferTitleFromFilename(req.FileName)
	}
	if title == "" {
		title = "Untitled Track"
	}
	if artist == "" {
		artist = "Unknown Artist"
	}
	partsTotal := int(math.Ceil(float64(req.SizeBytes) / float64(uploadPartSize)))
	expiresAt := time.Now().Add(s.cfg.UploadSessionTTL)
	userID := c.Locals("userID").(string)
	externalID := "antolex-" + strings.ReplaceAll(trackID.String(), "-", "")[:20]

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create upload")
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	_, err = tx.Exec(ctx, `
		INSERT INTO library_tracks (
			id, external_track_id, title, artist, album, cover_url, source_page_url, object_key,
			content_type, size_bytes, uploaded_by_user_id, sha256, status
		) VALUES ($1,$2,$3,$4,$5,'',$6,$7,$8,$9,$10,$11,'uploading')
	`, trackID, externalID, title, artist, strings.TrimSpace(req.Album), fmt.Sprintf("r2://%s/%s", s.seedCatalog.bucket, objectKey), objectKey, req.ContentType, req.SizeBytes, userID, req.SHA256)
	if err == nil {
		_, err = tx.Exec(ctx, `
			INSERT INTO upload_sessions (
				id, user_id, track_id, file_name, content_type, size_bytes, sha256, title, artist, album,
				status, r2_object_key, multipart_upload_id, part_size, parts_total, expires_at
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'uploading',$11,$12,$13,$14,$15)
		`, sessionID, userID, trackID, req.FileName, req.ContentType, req.SizeBytes, req.SHA256,
			strings.TrimSpace(req.Title), strings.TrimSpace(req.Artist), strings.TrimSpace(req.Album),
			objectKey, multipartID, uploadPartSize, partsTotal, expiresAt)
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			if duplicate, findErr := s.findDuplicateTrack(ctx, req.SHA256); findErr == nil {
				return writeAPIError(c, fiber.StatusConflict, "duplicate_track", "An identical audio file already exists", map[string]any{"track": duplicate})
			}
		}
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create upload")
	}
	if err := tx.Commit(ctx); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create upload")
	}
	abort = false

	upload, err := s.loadUpload(ctx, sessionID.String(), userID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load upload")
	}
	return c.Status(fiber.StatusCreated).JSON(uploadEnvelope{Upload: upload})
}

func validUploadSize(sizeBytes int64) bool {
	return sizeBytes > 0 && sizeBytes <= maxUploadSize
}

func (s *Server) getUpload(c *fiber.Ctx) error {
	upload, err := s.loadUpload(c.UserContext(), c.Params("id"), c.Locals("userID").(string))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return writeAPIError(c, fiber.StatusNotFound, "upload_not_found", "Upload was not found", nil)
		}
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load upload")
	}
	if (upload.Status == "uploading" || upload.Status == "paused") && s.seedCatalog != nil {
		if parts, listErr := s.seedCatalog.ListUploadedParts(c.UserContext(), upload.ObjectKey, upload.MultipartID); listErr == nil {
			_ = s.saveUploadParts(c.UserContext(), upload.ID, parts)
			upload.UploadedParts = toUploadPartResponses(parts)
		}
	}
	return c.JSON(uploadEnvelope{Upload: upload})
}

func (s *Server) listUploads(c *fiber.Ctx) error {
	ctx := c.UserContext()
	userID := c.Locals("userID").(string)
	cursor := decodeUploadCursor(c.Query("cursor"))
	rows, err := s.db.Query(ctx, `
		SELECT id::text FROM upload_sessions
		WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2 OR (created_at = $2 AND id::text < $3))
		ORDER BY created_at DESC, id DESC LIMIT $4
	`, userID, cursorTime(cursor), cursor.ID, uploadPageSize+1)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to list uploads")
	}
	defer rows.Close()
	ids := make([]string, 0, uploadPageSize+1)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	hasNext := len(ids) > uploadPageSize
	if hasNext {
		ids = ids[:uploadPageSize]
	}
	results := make([]uploadResponse, 0, len(ids))
	for _, id := range ids {
		upload, err := s.loadUpload(ctx, id, userID)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "failed to list uploads")
		}
		results = append(results, upload)
	}
	response := uploadsEnvelope{Results: results}
	if hasNext && len(results) > 0 {
		response.NextCursor = encodeUploadCursor(results[len(results)-1])
	}
	return c.JSON(response)
}

func (s *Server) presignUploadPart(c *fiber.Ctx) error {
	if s.seedCatalog == nil {
		return writeAPIError(c, fiber.StatusServiceUnavailable, "storage_unavailable", "R2 storage is not configured", nil)
	}
	partNumber, err := strconv.Atoi(c.Params("number"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "part number must be an integer")
	}
	upload, err := s.loadUpload(c.UserContext(), c.Params("id"), c.Locals("userID").(string))
	if err != nil {
		return writeAPIError(c, fiber.StatusNotFound, "upload_not_found", "Upload was not found", nil)
	}
	if upload.Status != "uploading" && upload.Status != "paused" {
		return writeAPIError(c, fiber.StatusConflict, "upload_not_active", "Upload is not accepting parts", map[string]any{"status": upload.Status})
	}
	if time.Now().After(upload.ExpiresAt) {
		return writeAPIError(c, fiber.StatusGone, "upload_expired", "Upload session has expired", nil)
	}
	if partNumber < 1 || partNumber > upload.PartsTotal {
		return fiber.NewError(fiber.StatusBadRequest, "part number is outside the upload range")
	}
	partBytes, err := expectedUploadPartBytes(upload.SizeBytes, upload.PartSize, partNumber)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid upload part")
	}
	url, expiresAt, err := s.seedCatalog.PresignUploadPart(c.UserContext(), upload.ObjectKey, upload.MultipartID, partNumber, partBytes)
	if err != nil {
		return writeAPIError(c, fiber.StatusBadGateway, "part_sign_failed", "Failed to prepare upload part", nil)
	}
	return c.JSON(presignedPartResponse{URL: url, Method: "PUT", Headers: map[string]string{}, ExpiresAt: expiresAt})
}

func expectedUploadPartBytes(totalBytes, partSize int64, partNumber int) (int64, error) {
	if totalBytes <= 0 || partSize <= 0 || partNumber < 1 {
		return 0, fmt.Errorf("invalid upload dimensions")
	}
	partIndex := int64(partNumber - 1)
	if partIndex > (totalBytes-1)/partSize {
		return 0, fmt.Errorf("part number outside upload")
	}
	offset := partIndex * partSize
	remaining := totalBytes - offset
	if remaining < partSize {
		return remaining, nil
	}
	return partSize, nil
}

func (s *Server) completeUpload(c *fiber.Ctx) error {
	if s.seedCatalog == nil {
		return writeAPIError(c, fiber.StatusServiceUnavailable, "storage_unavailable", "R2 storage is not configured", nil)
	}
	ctx := c.UserContext()
	upload, err := s.loadUpload(ctx, c.Params("id"), c.Locals("userID").(string))
	if err != nil {
		return writeAPIError(c, fiber.StatusNotFound, "upload_not_found", "Upload was not found", nil)
	}
	if upload.Status == "ready" {
		return c.JSON(uploadEnvelope{Upload: upload})
	}
	if upload.Status == "processing" {
		if err := queueUploadProcessing(ctx, s.db, upload.ID, upload.TrackID); err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "failed to restore processing job")
		}
		return c.Status(fiber.StatusAccepted).JSON(uploadEnvelope{Upload: upload})
	}
	if upload.Status != "uploading" && upload.Status != "paused" {
		return writeAPIError(c, fiber.StatusConflict, "upload_not_completable", "Upload cannot be completed", map[string]any{"status": upload.Status})
	}
	var req completeUploadRequest
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
		}
	}
	parts := fromUploadPartResponses(req.Parts)
	if len(parts) == 0 && len(upload.UploadedParts) > 0 {
		parts = fromUploadPartResponses(upload.UploadedParts)
	}
	if len(parts) == 0 {
		parts, err = s.seedCatalog.ListUploadedParts(ctx, upload.ObjectKey, upload.MultipartID)
	}
	if err != nil {
		recovered, recoverErr := s.completedUploadExists(ctx, upload)
		if !recovered {
			return writeAPIError(c, fiber.StatusBadGateway, "parts_unavailable", "Failed to read uploaded parts", storageRecoveryDetails(recoverErr))
		}
		return s.queueCompletedUpload(c, upload, nil)
	}
	if err := validateCompletedParts(parts, upload.PartsTotal); err != nil {
		return writeAPIError(c, fiber.StatusBadRequest, "incomplete_upload", err.Error(), map[string]any{"parts_total": upload.PartsTotal, "parts_received": len(parts)})
	}
	if err := s.seedCatalog.CompleteMultipartUpload(ctx, upload.ObjectKey, upload.MultipartID, parts); err != nil {
		recovered, recoverErr := s.completedUploadExists(ctx, upload)
		if !recovered {
			return writeAPIError(c, fiber.StatusBadGateway, "upload_complete_failed", "Failed to complete upload in storage", storageRecoveryDetails(recoverErr))
		}
	}
	return s.queueCompletedUpload(c, upload, parts)
}

func (s *Server) queueCompletedUpload(c *fiber.Ctx, upload uploadResponse, parts []uploadedPart) error {
	ctx := c.UserContext()
	if len(parts) > 0 {
		if err := s.saveUploadParts(ctx, upload.ID, parts); err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "failed to record uploaded parts")
		}
	}
	if err := queueUploadProcessing(ctx, s.db, upload.ID, upload.TrackID); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to queue processing")
	}
	updated, err := s.loadUpload(ctx, upload.ID, c.Locals("userID").(string))
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load queued upload")
	}
	return c.Status(fiber.StatusAccepted).JSON(uploadEnvelope{Upload: updated})
}

func (s *Server) completedUploadExists(ctx context.Context, upload uploadResponse) (bool, error) {
	_, size, err := s.seedCatalog.HeadObject(ctx, upload.ObjectKey)
	if err != nil {
		return false, err
	}
	if size != upload.SizeBytes {
		return false, fmt.Errorf("completed object size mismatch: expected %d, got %d", upload.SizeBytes, size)
	}
	return true, nil
}

func storageRecoveryDetails(err error) map[string]any {
	if err == nil {
		return nil
	}
	return map[string]any{"recovery": "completed object was not found with the expected size"}
}

func queueUploadProcessing(ctx context.Context, db *pgxpool.Pool, uploadID, trackID string) error {
	if trackID == "" {
		return fmt.Errorf("upload has no track")
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// Keep the same lock order as worker publication: track, then upload.
	result, err := tx.Exec(ctx, `
		UPDATE library_tracks SET status='processing', error_message=NULL, updated_at=NOW()
		WHERE id=$1 AND status IN ('uploading','processing')
	`, trackID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		var uploadStatus, trackStatus string
		stateErr := tx.QueryRow(ctx, `
			SELECT upload.status,track.status
			FROM upload_sessions upload JOIN library_tracks track ON track.id=upload.track_id
			WHERE upload.id=$1 AND track.id=$2
		`, uploadID, trackID).Scan(&uploadStatus, &trackStatus)
		if stateErr == nil && uploadStatus == "ready" && trackStatus == "ready" {
			_ = tx.Rollback(ctx)
			return nil
		}
		return fmt.Errorf("track is no longer processable")
	}
	result, err = tx.Exec(ctx, `
		UPDATE upload_sessions SET status='processing', error_message=NULL, updated_at=NOW()
		WHERE id=$1 AND track_id=$2 AND status IN ('uploading','paused','processing')
	`, uploadID, trackID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("upload is no longer processable")
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media_jobs (kind, track_id, upload_id)
		VALUES ('process_upload',$1,$2) ON CONFLICT DO NOTHING
	`, trackID, uploadID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func cancelUploadRecord(ctx context.Context, db *pgxpool.Pool, uploadID, trackID string) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `UPDATE upload_sessions SET status='cancelled', track_id=NULL, updated_at=NOW() WHERE id=$1 AND status IN ('uploading','paused','error')`, uploadID); err != nil {
		return err
	}
	if trackID != "" {
		if _, err := tx.Exec(ctx, `DELETE FROM library_tracks WHERE id=$1 AND status IN ('uploading','error')`, trackID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Server) cancelUpload(c *fiber.Ctx) error {
	ctx := c.UserContext()
	upload, err := s.loadUpload(ctx, c.Params("id"), c.Locals("userID").(string))
	if err != nil {
		return writeAPIError(c, fiber.StatusNotFound, "upload_not_found", "Upload was not found", nil)
	}
	if upload.Status == "ready" || upload.Status == "processing" {
		return writeAPIError(c, fiber.StatusConflict, "upload_not_cancellable", "Processing or ready uploads cannot be cancelled", map[string]any{"status": upload.Status})
	}
	if upload.Status == "cancelled" {
		return c.SendStatus(fiber.StatusNoContent)
	}
	if s.seedCatalog == nil {
		return writeAPIError(c, fiber.StatusServiceUnavailable, "storage_unavailable", "R2 storage is not configured", nil)
	}
	if upload.Status == "uploading" || upload.Status == "paused" {
		if err := s.seedCatalog.AbortMultipartUpload(ctx, upload.ObjectKey, upload.MultipartID); err != nil {
			if !isNoSuchUploadError(err) {
				return writeAPIError(c, fiber.StatusBadGateway, "upload_cancel_failed", "Failed to cancel upload in storage", nil)
			}
			if deleteErr := s.seedCatalog.DeleteObject(ctx, upload.ObjectKey); deleteErr != nil && !isObjectNotFoundError(deleteErr) {
				return writeAPIError(c, fiber.StatusBadGateway, "upload_cancel_failed", "Failed to remove completed upload from storage", nil)
			}
		}
	} else if err := s.deleteFailedUploadObjects(ctx, upload); err != nil {
		return writeAPIError(c, fiber.StatusBadGateway, "upload_cancel_failed", "Failed to remove failed upload from storage", nil)
	}
	if err := cancelUploadRecord(ctx, s.db, upload.ID, upload.TrackID); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to record upload cancellation")
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) deleteFailedUploadObjects(ctx context.Context, upload uploadResponse) error {
	for _, key := range uploadCleanupObjectKeys(upload) {
		if err := s.seedCatalog.DeleteObject(ctx, key); err != nil && !isObjectNotFoundError(err) {
			return fmt.Errorf("delete upload object %s: %w", key, err)
		}
	}
	return nil
}

func uploadCleanupObjectKeys(upload uploadResponse) []string {
	seen := make(map[string]struct{}, 5)
	keys := make([]string, 0, 5)
	for _, key := range []string{upload.ObjectKey, upload.OriginalKey, upload.PlaybackKey, upload.CoverKey, upload.LegacyKey} {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	return keys
}

func (s *Server) retryUpload(c *fiber.Ctx) error {
	ctx := c.UserContext()
	upload, err := s.loadUpload(ctx, c.Params("id"), c.Locals("userID").(string))
	if err != nil {
		return writeAPIError(c, fiber.StatusNotFound, "upload_not_found", "Upload was not found", nil)
	}
	if upload.Status != "error" || upload.TrackID == "" {
		return writeAPIError(c, fiber.StatusConflict, "upload_not_retryable", "Only failed processing jobs can be retried", map[string]any{"status": upload.Status})
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `UPDATE upload_sessions SET status='processing', error_message=NULL, updated_at=NOW() WHERE id=$1`, upload.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE library_tracks SET status='processing', error_message=NULL, updated_at=NOW() WHERE id=$1`, upload.TrackID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO media_jobs (kind,track_id,upload_id,status) VALUES ('process_upload',$1,$2,'pending')`, upload.TrackID, upload.ID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	upload, _ = s.loadUpload(ctx, upload.ID, c.Locals("userID").(string))
	return c.Status(fiber.StatusAccepted).JSON(uploadEnvelope{Upload: upload})
}

func (s *Server) loadUpload(ctx context.Context, id, userID string) (uploadResponse, error) {
	var upload uploadResponse
	var track models.Track
	var trackID *string
	err := s.db.QueryRow(ctx, `
		SELECT upload.id::text, upload.file_name, upload.content_type, upload.size_bytes, upload.sha256,
		       upload.status, upload.part_size, upload.parts_total, COALESCE(upload.error_message,''),
		       upload.expires_at, upload.created_at, upload.r2_object_key, upload.multipart_upload_id,
		       upload.track_id::text,
		       COALESCE(track.original_object_key,''),COALESCE(track.playback_object_key,''),
		       COALESCE(track.cover_object_key,''),COALESCE(track.object_key,''),
		       COALESCE(track.id::text,''), COALESCE(track.external_track_id,''), COALESCE(track.title,''),
		       COALESCE(track.artist,''), COALESCE(track.album,''), COALESCE(track.status,''),
		       COALESCE(track.duration_seconds,0), COALESCE(track.created_at, upload.created_at)
		FROM upload_sessions upload LEFT JOIN library_tracks track ON track.id=upload.track_id
		WHERE upload.id=$1 AND upload.user_id=$2
	`, id, userID).Scan(
		&upload.ID, &upload.FileName, &upload.ContentType, &upload.SizeBytes, &upload.SHA256,
		&upload.Status, &upload.PartSize, &upload.PartsTotal, &upload.Error, &upload.ExpiresAt,
		&upload.CreatedAt, &upload.ObjectKey, &upload.MultipartID, &trackID,
		&upload.OriginalKey, &upload.PlaybackKey, &upload.CoverKey, &upload.LegacyKey,
		&track.ID, &track.ExternalID, &track.Title, &track.Artist, &track.Album, &track.Status,
		&track.DurationSeconds, &track.CreatedAt,
	)
	if err != nil {
		return uploadResponse{}, err
	}
	if trackID != nil {
		upload.TrackID = *trackID
	}
	if track.ID != "" {
		track.CoverURL = libraryTrackCoverURL(track)
		upload.Track = &track
	}
	rows, err := s.db.Query(ctx, `SELECT part_number,etag,size_bytes FROM upload_parts WHERE upload_id=$1 ORDER BY part_number`, upload.ID)
	if err != nil {
		return uploadResponse{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var part uploadPartResponse
		if err := rows.Scan(&part.PartNumber, &part.ETag, &part.SizeBytes); err != nil {
			return uploadResponse{}, err
		}
		upload.UploadedParts = append(upload.UploadedParts, part)
	}
	if upload.UploadedParts == nil {
		upload.UploadedParts = []uploadPartResponse{}
	}
	return upload, rows.Err()
}

func (s *Server) findDuplicateTrack(ctx context.Context, hash string) (models.Track, error) {
	var track models.Track
	err := s.db.QueryRow(ctx, `
		SELECT id::text,external_track_id,title,artist,album,status,duration_seconds,created_at
		FROM library_tracks WHERE sha256=$1
	`, hash).Scan(&track.ID, &track.ExternalID, &track.Title, &track.Artist, &track.Album, &track.Status, &track.DurationSeconds, &track.CreatedAt)
	if err == nil {
		track.CoverURL = libraryTrackCoverURL(track)
	}
	return track, err
}

func (s *Server) saveUploadParts(ctx context.Context, uploadID string, parts []uploadedPart) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	for _, part := range parts {
		if _, err := tx.Exec(ctx, `INSERT INTO upload_parts(upload_id,part_number,etag,size_bytes) VALUES($1,$2,$3,$4) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=EXCLUDED.etag,size_bytes=EXCLUDED.size_bytes`, uploadID, part.PartNumber, part.ETag, part.SizeBytes); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func validateCompletedParts(parts []uploadedPart, expected int) error {
	if len(parts) != expected {
		return fmt.Errorf("all upload parts are required")
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
	for i, part := range parts {
		if part.PartNumber != i+1 || strings.TrimSpace(part.ETag) == "" {
			return fmt.Errorf("upload parts are incomplete or invalid")
		}
	}
	return nil
}

func toUploadPartResponses(parts []uploadedPart) []uploadPartResponse {
	result := make([]uploadPartResponse, 0, len(parts))
	for _, p := range parts {
		result = append(result, uploadPartResponse{PartNumber: p.PartNumber, ETag: p.ETag, SizeBytes: p.SizeBytes})
	}
	return result
}
func fromUploadPartResponses(parts []uploadPartResponse) []uploadedPart {
	result := make([]uploadedPart, 0, len(parts))
	for _, p := range parts {
		result = append(result, uploadedPart{PartNumber: p.PartNumber, ETag: p.ETag, SizeBytes: p.SizeBytes})
	}
	return result
}
func encodeUploadCursor(upload uploadResponse) string {
	body, _ := json.Marshal(uploadCursor{CreatedAt: upload.CreatedAt, ID: upload.ID})
	return base64.RawURLEncoding.EncodeToString(body)
}
func decodeUploadCursor(raw string) uploadCursor {
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return uploadCursor{}
	}
	var result uploadCursor
	_ = json.Unmarshal(body, &result)
	return result
}
func cursorTime(cursor uploadCursor) any {
	if cursor.CreatedAt.IsZero() {
		return nil
	}
	return cursor.CreatedAt
}
