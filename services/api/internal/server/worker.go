package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	database "github.com/alexeytozik/antolex-music/services/api/db"
	"github.com/alexeytozik/antolex-music/services/api/internal/config"
)

type mediaJob struct {
	ID                      int64
	Kind, TrackID, UploadID string
}

// RunWorker processes durable media_jobs until ctx is cancelled.
func RunWorker(ctx context.Context, cfg config.Config) error {
	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect postgres: %w", err)
	}
	defer db.Close()
	if err := database.Migrate(ctx, db); err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	storage, err := newSeedCatalog(cfg)
	if err != nil {
		return fmt.Errorf("configure R2: %w", err)
	}
	if storage == nil {
		return fmt.Errorf("R2 storage is not configured")
	}
	redisOptions, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("parse redis URL: %w", err)
	}
	redisClient := redis.NewClient(redisOptions)
	defer redisClient.Close()
	worker := &mediaWorker{db: db, storage: storage, redis: redisClient}
	if err := worker.failStaleJobs(ctx); err != nil {
		return err
	}
	lastUploadCleanup := time.Time{}

	for {
		if lastUploadCleanup.IsZero() || time.Since(lastUploadCleanup) >= time.Minute {
			if err := worker.cleanupExpiredUploads(ctx); err != nil {
				log.Printf(`{"level":"error","event":"expired_upload_cleanup_failed","error":%q}`, err.Error())
			}
			if err := worker.cleanupTerminalUploadHistory(ctx, time.Now().Add(-terminalUploadRetention)); err != nil {
				log.Printf(`{"level":"error","event":"terminal_upload_cleanup_failed","error":%q}`, err.Error())
			}
			lastUploadCleanup = time.Now()
		}
		job, err := worker.claim(ctx)
		if err != nil {
			return err
		}
		if job == nil {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(2 * time.Second):
				continue
			}
		}
		deleted, runErr := worker.run(ctx, *job)
		if runErr != nil {
			log.Printf(`{"level":"error","event":"media_job_failed","job_id":%d,"kind":%q,"track_id":%q,"error":%q}`, job.ID, job.Kind, job.TrackID, runErr.Error())
			if err := worker.fail(ctx, *job, runErr); err != nil {
				log.Printf("failed to record media job error: %v", err)
			}
			continue
		}
		if !deleted {
			if _, err := db.Exec(ctx, `UPDATE media_jobs SET status='succeeded',finished_at=NOW(),updated_at=NOW() WHERE id=$1`, job.ID); err != nil {
				return err
			}
		}
	}
}

type expiredUpload struct {
	ID, TrackID, ObjectKey, MultipartID string
	SizeBytes                           int64
}

const (
	terminalUploadRetention  = time.Hour
	terminalCleanupBatchSize = 500
)

func (w *mediaWorker) cleanupTerminalUploadHistory(ctx context.Context, cutoff time.Time) error {
	tx, err := w.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `
		WITH doomed AS (
			SELECT id FROM media_jobs
			WHERE status='succeeded' AND COALESCE(finished_at,updated_at) < $1
			ORDER BY COALESCE(finished_at,updated_at),id
			LIMIT $2
		)
		DELETE FROM media_jobs job USING doomed WHERE job.id=doomed.id
	`, cutoff, terminalCleanupBatchSize); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		WITH doomed AS (
			SELECT id FROM upload_sessions
			WHERE status IN ('ready','cancelled') AND updated_at < $1
			ORDER BY updated_at,id
			LIMIT $2
		)
		DELETE FROM upload_sessions upload USING doomed WHERE upload.id=doomed.id
	`, cutoff, terminalCleanupBatchSize); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (w *mediaWorker) cleanupExpiredUploads(ctx context.Context) error {
	rows, err := w.db.Query(ctx, `
		SELECT id::text,track_id::text,r2_object_key,multipart_upload_id,size_bytes
		FROM upload_sessions
		WHERE status IN ('uploading','paused') AND expires_at < NOW()
		ORDER BY expires_at,id LIMIT 25
	`)
	if err != nil {
		return err
	}
	items := make([]expiredUpload, 0, 25)
	for rows.Next() {
		var item expiredUpload
		if err := rows.Scan(&item.ID, &item.TrackID, &item.ObjectKey, &item.MultipartID, &item.SizeBytes); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	var firstErr error
	for _, item := range items {
		abortErr := w.storage.AbortMultipartUpload(ctx, item.ObjectKey, item.MultipartID)
		if abortErr == nil {
			if err := cancelUploadRecord(ctx, w.db, item.ID, item.TrackID); err != nil && firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !isNoSuchUploadError(abortErr) {
			if firstErr == nil {
				firstErr = fmt.Errorf("abort expired upload %s: %w", item.ID, abortErr)
			}
			continue
		}

		_, actualSize, headErr := w.storage.HeadObject(ctx, item.ObjectKey)
		switch {
		case headErr == nil && actualSize == item.SizeBytes:
			if err := queueUploadProcessing(ctx, w.db, item.ID, item.TrackID); err != nil && firstErr == nil {
				firstErr = fmt.Errorf("recover expired completed upload %s: %w", item.ID, err)
			}
		case headErr == nil:
			if err := markUploadError(ctx, w.db, item.ID, item.TrackID, fmt.Sprintf("completed object size mismatch: expected %d, got %d", item.SizeBytes, actualSize)); err != nil && firstErr == nil {
				firstErr = err
			}
		case isObjectNotFoundError(headErr):
			if err := cancelUploadRecord(ctx, w.db, item.ID, item.TrackID); err != nil && firstErr == nil {
				firstErr = err
			}
		default:
			if firstErr == nil {
				firstErr = fmt.Errorf("inspect expired upload %s: %w", item.ID, headErr)
			}
		}
	}
	return firstErr
}

func markUploadError(ctx context.Context, db *pgxpool.Pool, uploadID, trackID, message string) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `UPDATE upload_sessions SET status='error',error_message=$2,updated_at=NOW() WHERE id=$1 AND status IN ('uploading','paused')`, uploadID, message); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE library_tracks SET status='error',error_message=$2,updated_at=NOW() WHERE id=$1 AND status='uploading'`, trackID, message); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type mediaWorker struct {
	db      *pgxpool.Pool
	storage *seedCatalog
	redis   *redis.Client
}

func (w *mediaWorker) claim(ctx context.Context) (*mediaJob, error) {
	tx, err := w.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var job mediaJob
	err = tx.QueryRow(ctx, `
		SELECT id,kind,track_id::text,COALESCE(upload_id::text,'') FROM media_jobs
		WHERE status='pending' AND run_at<=NOW() ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1
	`).Scan(&job.ID, &job.Kind, &job.TrackID, &job.UploadID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE media_jobs SET status='running',attempts=attempts+1,started_at=NOW(),updated_at=NOW() WHERE id=$1`, job.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &job, nil
}

func (w *mediaWorker) run(ctx context.Context, job mediaJob) (bool, error) {
	switch job.Kind {
	case "process_upload":
		return false, w.processUpload(ctx, job)
	case "delete_track":
		return w.deleteTrack(ctx, job)
	default:
		return false, fmt.Errorf("unknown media job kind %q", job.Kind)
	}
}

func (w *mediaWorker) processUpload(ctx context.Context, job mediaJob) error {
	var incoming, fileName, expectedHash, explicitTitle, explicitArtist, explicitAlbum, previousOriginal string
	var expectedSize int64
	err := w.db.QueryRow(ctx, `
		SELECT upload.r2_object_key,upload.file_name,upload.sha256,
		       upload.title,upload.artist,upload.album,upload.size_bytes,
		       COALESCE(track.original_object_key,'')
		FROM upload_sessions upload
		JOIN library_tracks track ON track.id=upload.track_id
		WHERE upload.id=$1 AND upload.track_id=$2 AND upload.status='processing'
	`, job.UploadID, job.TrackID).Scan(&incoming, &fileName, &expectedHash, &explicitTitle, &explicitArtist, &explicitAlbum, &expectedSize, &previousOriginal)
	if err != nil {
		return fmt.Errorf("load upload: %w", err)
	}
	_, storedSize, err := w.storage.HeadObject(ctx, incoming)
	if err != nil {
		return fmt.Errorf("inspect incoming object: %w", err)
	}
	if storedSize != expectedSize {
		return fmt.Errorf("size mismatch before download: expected %d bytes, got %d", expectedSize, storedSize)
	}

	body, err := w.storage.DownloadObject(ctx, incoming)
	if err != nil {
		return fmt.Errorf("download incoming object: %w", err)
	}
	defer body.Close()
	ext := strings.ToLower(path.Ext(fileName))
	source, err := os.CreateTemp("", "antolex-source-*"+ext)
	if err != nil {
		return err
	}
	sourcePath := source.Name()
	defer os.Remove(sourcePath)
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(source, hasher), io.LimitReader(body, expectedSize+1))
	if copyErr != nil {
		source.Close()
		return fmt.Errorf("download upload: %w", copyErr)
	}
	if err := source.Close(); err != nil {
		return err
	}
	if written != expectedSize {
		return fmt.Errorf("size mismatch: expected %d bytes, got %d", expectedSize, written)
	}
	actualHash := hex.EncodeToString(hasher.Sum(nil))
	if actualHash != expectedHash {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s", expectedHash, actualHash)
	}

	metadata, err := probeAudioFileStrict(ctx, sourcePath)
	if err != nil {
		return err
	}
	fileArtist, fileTitle := inferTrackFieldsFromFilename(fileName)
	if metadata.Title == "" {
		metadata.Title = firstNonEmpty(explicitTitle, fileTitle, "Untitled Track")
	}
	if metadata.Artist == "" {
		metadata.Artist = firstNonEmpty(explicitArtist, fileArtist, "Unknown Artist")
	}
	if metadata.Album == "" {
		metadata.Album = strings.TrimSpace(explicitAlbum)
	}

	playback, err := os.CreateTemp("", "antolex-playback-*.m4a")
	if err != nil {
		return err
	}
	playbackPath := playback.Name()
	playback.Close()
	defer os.Remove(playbackPath)
	cmd := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-y", "-i", sourcePath, "-map", "0:a:0", "-vn", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "256k", "-movflags", "+faststart", "-map_metadata", "0", playbackPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("transcode audio: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if info, err := os.Stat(playbackPath); err != nil || info.Size() == 0 {
		return fmt.Errorf("transcoder produced an empty file")
	}

	playbackKey := fmt.Sprintf("playback/%s.m4a", job.TrackID)
	plannedCoverKey := fmt.Sprintf("covers/%s.jpg", job.TrackID)
	persistResult, err := w.db.Exec(ctx, `
		UPDATE library_tracks
		SET playback_object_key=$2,cover_object_key=$3,updated_at=NOW()
		WHERE id=$1 AND status='processing'
	`, job.TrackID, playbackKey, plannedCoverKey)
	if err != nil {
		return fmt.Errorf("persist derived object keys: %w", err)
	}
	if persistResult.RowsAffected() == 0 {
		return fmt.Errorf("track is no longer processing")
	}
	coverKey := ""
	if err := uploadLocalFile(ctx, w.storage, playbackKey, "audio/mp4", playbackPath); err != nil {
		return fmt.Errorf("store playback: %w", err)
	}
	coverPath, coverType, coverErr := extractAudioArtworkFromFile(ctx, sourcePath)
	if coverErr != nil {
		log.Printf(
			`{"level":"warn","event":"artwork_extraction_failed","recoverable":true,"job_id":%d,"track_id":%q,"upload_id":%q,"error":%q}`,
			job.ID,
			job.TrackID,
			job.UploadID,
			coverErr.Error(),
		)
	}
	if coverPath != "" {
		defer os.Remove(coverPath)
		coverKey = plannedCoverKey
		if err := uploadLocalFile(ctx, w.storage, coverKey, coverType, coverPath); err != nil {
			return fmt.Errorf("store cover: %w", err)
		}
	}

	tx, err := w.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var resultingStatus string
	err = tx.QueryRow(ctx, `
		UPDATE library_tracks SET title=$2,artist=$3,album=$4,duration_seconds=$5,
			original_object_key=NULL,playback_object_key=$6,cover_object_key=NULLIF($7,''),object_key=$6,
			cover_url='',status=CASE WHEN status='processing' THEN 'ready' ELSE status END,error_message=NULL,updated_at=NOW()
		WHERE id=$1 RETURNING status
	`, job.TrackID, metadata.Title, metadata.Artist, metadata.Album, metadata.DurationSeconds, playbackKey, coverKey).Scan(&resultingStatus)
	if err != nil {
		return err
	}
	if resultingStatus == "ready" {
		if _, err := tx.Exec(ctx, `UPDATE upload_sessions SET status='ready',error_message=NULL,updated_at=NOW() WHERE id=$1`, job.UploadID); err != nil {
			return err
		}
	}
	// Publish state and job acknowledgement atomically. Without this, a crash
	// after publishing could make startup recovery incorrectly mark a ready track failed.
	if _, err := tx.Exec(ctx, `UPDATE media_jobs SET status='succeeded',finished_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`, job.ID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	seenObsolete := make(map[string]struct{}, 2)
	for _, obsoleteKey := range []string{incoming, previousOriginal} {
		if obsoleteKey == "" || obsoleteKey == playbackKey || obsoleteKey == coverKey {
			continue
		}
		if _, seen := seenObsolete[obsoleteKey]; seen {
			continue
		}
		seenObsolete[obsoleteKey] = struct{}{}
		if err := w.storage.DeleteObject(ctx, obsoleteKey); err != nil && !isObjectNotFoundError(err) {
			log.Printf(
				`{"level":"warn","event":"obsolete_upload_object_cleanup_failed","track_id":%q,"upload_id":%q,"object_key":%q,"error":%q}`,
				job.TrackID,
				job.UploadID,
				obsoleteKey,
				err.Error(),
			)
		}
	}
	w.invalidateSearchCache(ctx)
	return nil
}

func (w *mediaWorker) deleteTrack(ctx context.Context, job mediaJob) (bool, error) {
	var original, playback, cover, legacy string
	err := w.db.QueryRow(ctx, `SELECT COALESCE(original_object_key,''),COALESCE(playback_object_key,''),COALESCE(cover_object_key,''),object_key FROM library_tracks WHERE id=$1 AND status='deleting'`, job.TrackID).Scan(&original, &playback, &cover, &legacy)
	if err != nil {
		return false, err
	}
	seen := map[string]bool{}
	for _, key := range []string{original, playback, cover, legacy} {
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		if err := w.storage.DeleteObject(ctx, key); err != nil && !isObjectNotFoundError(err) {
			return false, fmt.Errorf("delete %s: %w", key, err)
		}
	}
	if _, err := w.db.Exec(ctx, `DELETE FROM library_tracks WHERE id=$1 AND status='deleting'`, job.TrackID); err != nil {
		return false, err
	}
	w.invalidateSearchCache(ctx)
	return true, nil
}

func (w *mediaWorker) fail(ctx context.Context, job mediaJob, cause error) error {
	message := cause.Error()
	if len(message) > 2000 {
		message = message[:2000]
	}
	tx, err := w.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `UPDATE media_jobs SET status='failed',error_message=$2,finished_at=NOW(),updated_at=NOW() WHERE id=$1`, job.ID, message); err != nil {
		return err
	}
	if job.Kind == "process_upload" {
		if _, err := tx.Exec(ctx, `UPDATE library_tracks SET status=CASE WHEN status='deleting' THEN status ELSE 'error' END,error_message=$2,updated_at=NOW() WHERE id=$1`, job.TrackID, message); err != nil {
			return err
		}
		if job.UploadID != "" {
			if _, err := tx.Exec(ctx, `UPDATE upload_sessions SET status='error',error_message=$2,updated_at=NOW() WHERE id=$1`, job.UploadID, message); err != nil {
				return err
			}
		}
	} else {
		if _, err := tx.Exec(ctx, `UPDATE library_tracks SET status='error',error_message=$2,updated_at=NOW() WHERE id=$1`, job.TrackID, message); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (w *mediaWorker) failStaleJobs(ctx context.Context) error {
	tx, err := w.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `
		UPDATE media_jobs job
		SET status='succeeded',error_message=NULL,finished_at=NOW(),updated_at=NOW()
		FROM library_tracks track
		WHERE job.track_id=track.id AND job.status='running'
		  AND job.kind='process_upload' AND track.status='ready'
	`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE upload_sessions upload
		SET status='ready',error_message=NULL,updated_at=NOW()
		FROM media_jobs job
		WHERE job.upload_id=upload.id AND job.status='succeeded'
		  AND job.kind='process_upload' AND upload.status='processing'
	`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		CREATE TEMP TABLE stale_media_jobs (
			track_id UUID NOT NULL,
			upload_id UUID,
			kind TEXT NOT NULL
		) ON COMMIT DROP;
		WITH stale AS (
			UPDATE media_jobs
			SET status='failed',error_message='worker stopped during processing',finished_at=NOW(),updated_at=NOW()
			WHERE status='running'
			RETURNING track_id,upload_id,kind
		)
		INSERT INTO stale_media_jobs (track_id,upload_id,kind)
		SELECT track_id,upload_id,kind FROM stale
	`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE library_tracks track SET status='error',error_message='worker stopped during processing',updated_at=NOW()
		FROM stale_media_jobs stale
		WHERE track.id=stale.track_id
		  AND (stale.kind='delete_track' OR track.status<>'deleting')`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE upload_sessions upload SET status='error',error_message='worker stopped during processing',updated_at=NOW()
		FROM stale_media_jobs stale WHERE upload.id=stale.upload_id AND stale.kind='process_upload'`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func uploadLocalFile(ctx context.Context, storage *seedCatalog, key, contentType, filePath string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()
	return storage.UploadObject(ctx, key, contentType, file)
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func (w *mediaWorker) invalidateSearchCache(ctx context.Context) {
	if w.redis != nil {
		_ = w.redis.Incr(ctx, searchCacheVersionKey).Err()
	}
}
