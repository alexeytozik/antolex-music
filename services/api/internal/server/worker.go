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

	"github.com/google/uuid"
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
	if err := worker.enqueueMissingHLSAssets(ctx); err != nil {
		return fmt.Errorf("enqueue missing HLS assets: %w", err)
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
			if err := cleanupExpiredPlaybackSessions(ctx, worker.db); err != nil {
				log.Printf(`{"level":"error","event":"expired_playback_session_cleanup_failed","error":%q}`, err.Error())
			}
			if err := worker.cleanupRetiredHLSAssets(ctx, time.Now().Add(-retiredHLSAssetRetention)); err != nil {
				log.Printf(`{"level":"error","event":"retired_hls_asset_cleanup_failed","error":%q}`, err.Error())
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
	terminalUploadRetention   = time.Hour
	terminalCleanupBatchSize  = 500
	retiredHLSAssetRetention  = 24 * time.Hour
	hlsPreparationMaxAttempts = 6
	hlsRetryInitialDelay      = 30 * time.Second
	hlsRetryMaximumDelay      = 15 * time.Minute
)

func hlsPreparationRetryDelay(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	delay := hlsRetryInitialDelay
	for current := 1; current < attempts && delay < hlsRetryMaximumDelay; current++ {
		delay = min(delay*2, hlsRetryMaximumDelay)
	}
	return delay
}

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

// enqueueMissingHLSAssets is deliberately safe to run after every worker
// restart. The partial unique media_jobs index prevents duplicate active jobs;
// terminal failures stay terminal instead of resetting their bounded retry
// budget on every process restart.
func (w *mediaWorker) enqueueMissingHLSAssets(ctx context.Context) error {
	_, err := w.db.Exec(ctx, `
		INSERT INTO media_jobs (kind,track_id,status)
		SELECT 'prepare_hls',track.id,'pending'
		FROM library_tracks track
		WHERE track.status='ready'
		  AND NOT EXISTS (
			SELECT 1 FROM track_playback_assets asset
			WHERE asset.track_id=track.id
			  AND asset.status='ready'
			  AND asset.retired_at IS NULL
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM media_jobs job
			WHERE job.track_id=track.id
			  AND job.kind='prepare_hls'
			  AND (
				job.status IN ('pending','running')
				OR (job.status='failed' AND job.attempts >= $1)
			  )
		  )
		ORDER BY track.created_at,track.id
		ON CONFLICT DO NOTHING
	`, hlsPreparationMaxAttempts)
	return err
}

func (w *mediaWorker) cleanupRetiredHLSAssets(ctx context.Context, cutoff time.Time) error {
	rows, err := w.db.Query(ctx, `
		SELECT asset.id::text,asset.object_key
		FROM track_playback_assets asset
		WHERE (asset.track_id IS NULL OR asset.retired_at < $1)
		  AND NOT EXISTS (
			SELECT 1 FROM playback_session_items item
			WHERE item.hls_asset_id=asset.id
		  )
		ORDER BY COALESCE(asset.retired_at,asset.updated_at),asset.id
		LIMIT 25
	`, cutoff)
	if err != nil {
		return err
	}
	type obsoleteAsset struct {
		ID, ObjectKey string
	}
	assets := make([]obsoleteAsset, 0, 25)
	for rows.Next() {
		var asset obsoleteAsset
		if err := rows.Scan(&asset.ID, &asset.ObjectKey); err != nil {
			rows.Close()
			return err
		}
		assets = append(assets, asset)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, asset := range assets {
		if err := w.storage.DeleteObject(ctx, asset.ObjectKey); err != nil && !isObjectNotFoundError(err) {
			return fmt.Errorf("delete retired HLS asset %s: %w", asset.ID, err)
		}
		if _, err := w.db.Exec(ctx, `
			DELETE FROM track_playback_assets asset
			WHERE asset.id=$1
			  AND (asset.track_id IS NULL OR asset.retired_at < $2)
			  AND NOT EXISTS (
				SELECT 1 FROM playback_session_items item
				WHERE item.hls_asset_id=asset.id
			  )
		`, asset.ID, cutoff); err != nil {
			return err
		}
	}
	return nil
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
		WHERE status='pending' AND run_at<=NOW()
		ORDER BY CASE WHEN kind='prepare_hls' THEN 1 ELSE 0 END,run_at,id
		FOR UPDATE SKIP LOCKED LIMIT 1
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
	case "prepare_hls":
		return false, w.prepareHLSAsset(ctx, job)
	case "delete_track":
		return w.deleteTrack(ctx, job)
	default:
		return false, fmt.Errorf("unknown media job kind %q", job.Kind)
	}
}

type uploadedCMAFAsset struct {
	ID        string
	ObjectKey string
	Index     cmafPlaylistIndex
	Segments  []byte
}

func (w *mediaWorker) uploadCMAFAsset(
	ctx context.Context,
	trackID string,
	packaged packagedCMAF,
) (uploadedCMAFAsset, error) {
	mediaInfo, err := os.Stat(packaged.MediaPath)
	if err != nil {
		return uploadedCMAFAsset{}, fmt.Errorf("inspect CMAF upload: %w", err)
	}
	if mediaInfo.Size() <= 0 {
		return uploadedCMAFAsset{}, fmt.Errorf("CMAF upload is empty")
	}
	if packaged.Index.TargetDuration < 1 || packaged.Index.TargetDuration > playbackManifestTargetDuration {
		return uploadedCMAFAsset{}, fmt.Errorf(
			"CMAF target duration %d exceeds the stable manifest target %d",
			packaged.Index.TargetDuration,
			playbackManifestTargetDuration,
		)
	}
	for _, segment := range packaged.Index.Segments {
		if segment.DurationMS <= 0 || int((segment.DurationMS+999)/1000) > playbackManifestTargetDuration {
			return uploadedCMAFAsset{}, fmt.Errorf(
				"CMAF segment duration %dms exceeds the stable manifest target",
				segment.DurationMS,
			)
		}
	}
	segments, err := packaged.Index.segmentsJSON()
	if err != nil {
		return uploadedCMAFAsset{}, err
	}
	assetID := uuid.NewString()
	objectKey := fmt.Sprintf("playback/%s/cmaf/%s.mp4", trackID, assetID)
	if err := uploadLocalFile(ctx, w.storage, objectKey, "audio/mp4", packaged.MediaPath); err != nil {
		return uploadedCMAFAsset{}, fmt.Errorf("store CMAF playback: %w", err)
	}
	_, storedSize, headErr := w.storage.HeadObject(ctx, objectKey)
	if headErr != nil || storedSize != mediaInfo.Size() {
		cleanupErr := w.storage.DeleteObject(ctx, objectKey)
		if headErr != nil {
			return uploadedCMAFAsset{}, errors.Join(
				fmt.Errorf("verify stored CMAF playback: %w", headErr),
				cleanupErr,
			)
		}
		return uploadedCMAFAsset{}, errors.Join(
			fmt.Errorf("verify stored CMAF playback: size is %d bytes, want %d", storedSize, mediaInfo.Size()),
			cleanupErr,
		)
	}
	return uploadedCMAFAsset{
		ID:        assetID,
		ObjectKey: objectKey,
		Index:     packaged.Index,
		Segments:  segments,
	}, nil
}

func persistReadyCMAFAsset(
	ctx context.Context,
	tx pgx.Tx,
	trackID string,
	asset uploadedCMAFAsset,
	replaceCurrent bool,
) error {
	if replaceCurrent {
		if _, err := tx.Exec(ctx, `
			UPDATE track_playback_assets
			SET retired_at=NOW(),updated_at=NOW()
			WHERE track_id=$1 AND status='ready' AND retired_at IS NULL
		`, trackID); err != nil {
			return err
		}
	} else {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM track_playback_assets
				WHERE track_id=$1 AND status='ready' AND retired_at IS NULL
			)
		`, trackID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return pgx.ErrNoRows
		}
	}

	_, err := tx.Exec(ctx, `
		INSERT INTO track_playback_assets (
			id,track_id,object_key,init_offset,init_length,segments,
			duration_ms,target_duration,status,error_message
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready',NULL)
	`,
		asset.ID,
		trackID,
		asset.ObjectKey,
		asset.Index.InitOffset,
		asset.Index.InitLength,
		asset.Segments,
		asset.Index.DurationMS,
		asset.Index.TargetDuration,
	)
	return err
}

func (w *mediaWorker) prepareHLSAsset(ctx context.Context, job mediaJob) error {
	var playbackKey string
	err := w.db.QueryRow(ctx, `
		SELECT COALESCE(NULLIF(track.playback_object_key,''),track.object_key)
		FROM library_tracks track
		WHERE track.id=$1 AND track.status='ready'
		  AND NOT EXISTS (
			SELECT 1 FROM track_playback_assets asset
			WHERE asset.track_id=track.id
			  AND asset.status='ready'
			  AND asset.retired_at IS NULL
		  )
	`, job.TrackID).Scan(&playbackKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load playback for HLS backfill: %w", err)
	}

	body, err := w.storage.DownloadObject(ctx, playbackKey)
	if err != nil {
		return fmt.Errorf("download playback for HLS backfill: %w", err)
	}
	tempPath, _, copyErr := writeReaderToTempAudioFile(body, path.Base(playbackKey))
	closeErr := body.Close()
	if copyErr != nil {
		return copyErr
	}
	defer os.Remove(tempPath)
	if closeErr != nil {
		return fmt.Errorf("close HLS backfill source: %w", closeErr)
	}

	packaged, err := packageCMAF(ctx, tempPath)
	if err != nil {
		return err
	}
	defer packaged.Cleanup()
	uploaded, err := w.uploadCMAFAsset(ctx, job.TrackID, packaged)
	if err != nil {
		return err
	}
	published := false
	defer func() {
		if !published {
			_ = w.storage.DeleteObject(context.Background(), uploaded.ObjectKey)
		}
	}()

	tx, err := w.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM library_tracks WHERE id=$1 FOR UPDATE`, job.TrackID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if status != "ready" {
		return nil
	}
	if err := persistReadyCMAFAsset(ctx, tx, job.TrackID, uploaded, false); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	published = true
	return nil
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
	cmd := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-y", "-i", sourcePath, "-map", "0:a:0", "-vn", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-map_metadata", "0", playbackPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("transcode audio: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if info, err := os.Stat(playbackPath); err != nil || info.Size() == 0 {
		return fmt.Errorf("transcoder produced an empty file")
	}
	packaged, err := packageCMAF(ctx, playbackPath)
	if err != nil {
		return err
	}
	defer packaged.Cleanup()

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
	uploadedHLS, err := w.uploadCMAFAsset(ctx, job.TrackID, packaged)
	if err != nil {
		return err
	}
	hlsPublished := false
	defer func() {
		if !hlsPublished {
			_ = w.storage.DeleteObject(context.Background(), uploadedHLS.ObjectKey)
		}
	}()
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
	var lockedStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM library_tracks WHERE id=$1 FOR UPDATE`, job.TrackID).Scan(&lockedStatus); err != nil {
		return err
	}
	if lockedStatus != "processing" {
		return fmt.Errorf("track is no longer processing")
	}
	if err := persistReadyCMAFAsset(ctx, tx, job.TrackID, uploadedHLS, true); err != nil {
		return fmt.Errorf("publish HLS asset: %w", err)
	}
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
	hlsPublished = true
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
	tx, err := w.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var original, playback, cover, legacy string
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(original_object_key,''),COALESCE(playback_object_key,''),
		       COALESCE(cover_object_key,''),object_key
		FROM library_tracks
		WHERE id=$1 AND status='deleting'
		FOR UPDATE
	`, job.TrackID).Scan(&original, &playback, &cover, &legacy)
	if err != nil {
		return false, err
	}
	type playbackAssetDeletion struct {
		ID        string
		ObjectKey string
	}
	rows, err := tx.Query(ctx, `
		SELECT asset.id::text,asset.object_key
		FROM track_playback_assets asset
		WHERE asset.track_id=$1
		ORDER BY asset.created_at,asset.id
		FOR UPDATE OF asset
	`, job.TrackID)
	if err != nil {
		return false, err
	}
	assets := make([]playbackAssetDeletion, 0)
	for rows.Next() {
		var asset playbackAssetDeletion
		if err := rows.Scan(&asset.ID, &asset.ObjectKey); err != nil {
			rows.Close()
			return false, err
		}
		assets = append(assets, asset)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	rows.Close()

	assetIDs := make([]string, 0, len(assets))
	for _, asset := range assets {
		assetIDs = append(assetIDs, asset.ID)
	}
	referencedIDs := make(map[string]struct{}, len(assets))
	if len(assetIDs) > 0 {
		// This is deliberately a separate statement after FOR UPDATE. If a
		// concurrent playback-session insert already held an FK key-share lock,
		// the lock above waited for it; this new READ COMMITTED snapshot now sees
		// the committed reference. Later inserts remain blocked until commit.
		rows, err = tx.Query(ctx, `
			SELECT DISTINCT hls_asset_id::text
			FROM playback_session_items
			WHERE hls_asset_id=ANY($1::uuid[])
		`, assetIDs)
		if err != nil {
			return false, err
		}
		for rows.Next() {
			var assetID string
			if err := rows.Scan(&assetID); err != nil {
				rows.Close()
				return false, err
			}
			referencedIDs[assetID] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return false, err
		}
		rows.Close()
	}

	protectedKeys := make(map[string]struct{}, len(referencedIDs))
	deletableAssetIDs := make([]string, 0, len(assets))
	for _, asset := range assets {
		if _, referenced := referencedIDs[asset.ID]; referenced {
			protectedKeys[asset.ObjectKey] = struct{}{}
			continue
		}
		deletableAssetIDs = append(deletableAssetIDs, asset.ID)
	}
	seen := map[string]bool{}
	keys := []string{original, playback, cover, legacy}
	for _, asset := range assets {
		if _, referenced := referencedIDs[asset.ID]; !referenced {
			keys = append(keys, asset.ObjectKey)
		}
	}
	for _, key := range keys {
		if key == "" || seen[key] {
			continue
		}
		if _, protected := protectedKeys[key]; protected {
			continue
		}
		seen[key] = true
		if err := w.storage.DeleteObject(ctx, key); err != nil && !isObjectNotFoundError(err) {
			return false, fmt.Errorf("delete %s: %w", key, err)
		}
	}
	if len(deletableAssetIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			DELETE FROM track_playback_assets
			WHERE id=ANY($1::uuid[])
		`, deletableAssetIDs); err != nil {
			return false, err
		}
	}
	result, err := tx.Exec(ctx, `DELETE FROM library_tracks WHERE id=$1 AND status='deleting'`, job.TrackID)
	if err != nil {
		return false, err
	}
	if result.RowsAffected() == 0 {
		return false, fmt.Errorf("track is no longer deleting")
	}
	if err := tx.Commit(ctx); err != nil {
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
	if job.Kind == "prepare_hls" {
		var attempts int
		if err := tx.QueryRow(ctx, `SELECT attempts FROM media_jobs WHERE id=$1 FOR UPDATE`, job.ID).Scan(&attempts); err != nil {
			return err
		}
		if attempts < hlsPreparationMaxAttempts {
			delay := hlsPreparationRetryDelay(attempts)
			if _, err := tx.Exec(ctx, `
				UPDATE media_jobs SET
					status='pending',error_message=$2,
					run_at=NOW()+($3 * INTERVAL '1 second'),
					started_at=NULL,finished_at=NULL,updated_at=NOW()
				WHERE id=$1
			`, job.ID, message, int64(delay/time.Second)); err != nil {
				return err
			}
		} else {
			terminalMessage := fmt.Sprintf("HLS preparation stopped after %d attempts: %s", attempts, message)
			if len(terminalMessage) > 2000 {
				terminalMessage = terminalMessage[:2000]
			}
			if _, err := tx.Exec(ctx, `
				UPDATE media_jobs SET
					status='failed',error_message=$2,finished_at=NOW(),updated_at=NOW()
				WHERE id=$1
			`, job.ID, terminalMessage); err != nil {
				return err
			}
		}
		// HLS backfill is additive. Keep the existing ready M4A visible while
		// transient failures retry and after a terminal packaging failure.
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE media_jobs SET status='failed',error_message=$2,finished_at=NOW(),updated_at=NOW() WHERE id=$1`, job.ID, message); err != nil {
		return err
	}
	switch job.Kind {
	case "process_upload":
		if _, err := tx.Exec(ctx, `UPDATE library_tracks SET status=CASE WHEN status='deleting' THEN status ELSE 'error' END,error_message=$2,updated_at=NOW() WHERE id=$1`, job.TrackID, message); err != nil {
			return err
		}
		if job.UploadID != "" {
			if _, err := tx.Exec(ctx, `UPDATE upload_sessions SET status='error',error_message=$2,updated_at=NOW() WHERE id=$1`, job.UploadID, message); err != nil {
				return err
			}
		}
	case "delete_track":
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
		) ON COMMIT DROP
	`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		WITH stale AS (
			UPDATE media_jobs
			SET status=CASE
					WHEN kind='prepare_hls' AND attempts < $1 THEN 'pending'
					ELSE 'failed'
				END,
				error_message=CASE
					WHEN kind='prepare_hls' AND attempts >= $1
						THEN format('HLS preparation stopped after %s attempts: worker stopped during processing',attempts)
					ELSE 'worker stopped during processing'
				END,
				run_at=CASE
					WHEN kind='prepare_hls' AND attempts < $1
						THEN NOW() + (
							LEAST($3::double precision,$2::double precision * power(2,GREATEST(attempts-1,0)))
							* INTERVAL '1 second'
						)
					ELSE run_at
				END,
				started_at=NULL,
				finished_at=CASE
					WHEN kind='prepare_hls' AND attempts < $1 THEN NULL
					ELSE NOW()
				END,
				updated_at=NOW()
			WHERE status='running'
			RETURNING track_id,upload_id,kind
		)
		INSERT INTO stale_media_jobs (track_id,upload_id,kind)
		SELECT track_id,upload_id,kind FROM stale
	`, hlsPreparationMaxAttempts, int64(hlsRetryInitialDelay/time.Second), int64(hlsRetryMaximumDelay/time.Second)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE library_tracks track SET status='error',error_message='worker stopped during processing',updated_at=NOW()
		FROM stale_media_jobs stale
		WHERE track.id=stale.track_id
		  AND (
			stale.kind='delete_track'
			OR (stale.kind='process_upload' AND track.status<>'deleting')
		  )`); err != nil {
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
