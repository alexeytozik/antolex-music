package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	aws "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	database "github.com/alexeytozik/antolex-music/services/api/db"
	"github.com/alexeytozik/antolex-music/services/api/internal/config"
	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

func TestConcurrentTrackSHA256Constraint(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	userID := uuid.NewString()
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,role,active,access_status) VALUES($1,$2,'','uploader',TRUE,'active')`, userID, "duplicates@example.com"); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	const attempts = 16
	hash := strings.Repeat("a", 64)
	start := make(chan struct{})
	results := make(chan error, attempts)
	var group sync.WaitGroup
	for index := 0; index < attempts; index++ {
		index := index
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			_, err := db.Exec(ctx, `
				INSERT INTO library_tracks(
					id,external_track_id,title,artist,cover_url,object_key,content_type,size_bytes,
					uploaded_by_user_id,sha256,status
				) VALUES($1,$2,$3,'Artist','',$4,'audio/mpeg',1,$5,$6,'uploading')
			`, uuid.NewString(), fmt.Sprintf("duplicate-%d", index), fmt.Sprintf("Track %d", index), fmt.Sprintf("incoming/%d.mp3", index), userID, hash)
			results <- err
		}()
	}
	close(start)
	group.Wait()
	close(results)

	succeeded := 0
	conflicted := 0
	for err := range results {
		if err == nil {
			succeeded++
			continue
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			conflicted++
			continue
		}
		t.Fatalf("unexpected concurrent insert error: %v", err)
	}
	if succeeded != 1 || conflicted != attempts-1 {
		t.Fatalf("successful inserts=%d conflicts=%d; want 1 and %d", succeeded, conflicted, attempts-1)
	}

	var stored int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM library_tracks WHERE sha256=$1`, hash).Scan(&stored); err != nil {
		t.Fatalf("count duplicate hashes: %v", err)
	}
	if stored != 1 {
		t.Fatalf("stored duplicate hashes=%d; want 1", stored)
	}
}

func TestVerifiedEmailPreservesOwnerManagedAccess(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db, cfg: config.Config{AdminEmails: []string{"owner@example.com"}}}

	created, err := srv.upsertVerifiedUser(ctx, " New.Listener@Example.com ")
	if err != nil {
		t.Fatalf("create verified user: %v", err)
	}
	if created.ID == "" || created.Email != "new.listener@example.com" || created.Active || created.AccessStatus != models.AccessStatusPending || created.IsAdmin {
		t.Fatalf("unexpected created user: %+v", created)
	}

	if _, err := db.Exec(ctx, `UPDATE users SET active=TRUE,access_status='active' WHERE id=$1`, created.ID); err != nil {
		t.Fatalf("approve user: %v", err)
	}
	approved, err := srv.upsertVerifiedUser(ctx, "NEW.LISTENER@EXAMPLE.COM")
	if err != nil {
		t.Fatalf("verify approved user: %v", err)
	}
	if approved.ID != created.ID || !approved.Active || approved.AccessStatus != models.AccessStatusActive {
		t.Fatalf("unexpected approved user: %+v", approved)
	}

	if _, err := db.Exec(ctx, `UPDATE users SET active=FALSE,access_status='blocked' WHERE id=$1`, created.ID); err != nil {
		t.Fatalf("block user: %v", err)
	}
	blocked, err := srv.upsertVerifiedUser(ctx, "new.listener@example.com")
	if err != nil {
		t.Fatalf("verify blocked user: %v", err)
	}
	if blocked.ID != created.ID || blocked.Active || blocked.AccessStatus != models.AccessStatusBlocked {
		t.Fatalf("blocked user was reactivated: %+v", blocked)
	}

	owner, err := srv.upsertVerifiedUser(ctx, " OWNER@example.com ")
	if err != nil {
		t.Fatalf("create configured owner: %v", err)
	}
	if !owner.Active || owner.AccessStatus != models.AccessStatusActive || !owner.IsAdmin {
		t.Fatalf("configured owner was not activated: %+v", owner)
	}

	var count int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE email=$1`, "new.listener@example.com").Scan(&count); err != nil {
		t.Fatalf("count verified users: %v", err)
	}
	if count != 1 {
		t.Fatalf("verified user rows=%d; want 1", count)
	}
}

func TestUploadResumeCancelAndRetryLifecycle(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}

	paused := insertLifecycleUpload(t, db, "paused", strings.Repeat("b", 64))
	if err := srv.saveUploadParts(ctx, paused.uploadID, []uploadedPart{
		{PartNumber: 2, ETag: "second", SizeBytes: 23},
		{PartNumber: 1, ETag: "old-first", SizeBytes: uploadPartSize},
		{PartNumber: 1, ETag: "new-first", SizeBytes: uploadPartSize},
	}); err != nil {
		t.Fatalf("save resume parts: %v", err)
	}
	upload, err := srv.loadUpload(ctx, paused.uploadID, paused.userID)
	if err != nil {
		t.Fatalf("load paused upload: %v", err)
	}
	if upload.Status != "paused" || len(upload.UploadedParts) != 2 {
		t.Fatalf("resume state status=%q parts=%+v", upload.Status, upload.UploadedParts)
	}
	if upload.UploadedParts[0].PartNumber != 1 || upload.UploadedParts[0].ETag != "new-first" || upload.UploadedParts[1].PartNumber != 2 {
		t.Fatalf("resume parts were not ordered/upserted: %+v", upload.UploadedParts)
	}

	if err := cancelUploadRecord(ctx, db, paused.uploadID, paused.trackID); err != nil {
		t.Fatalf("cancel paused upload: %v", err)
	}
	var cancelledStatus string
	var cancelledTrackID *string
	if err := db.QueryRow(ctx, `SELECT status,track_id::text FROM upload_sessions WHERE id=$1`, paused.uploadID).Scan(&cancelledStatus, &cancelledTrackID); err != nil {
		t.Fatalf("load cancelled upload: %v", err)
	}
	if cancelledStatus != "cancelled" || cancelledTrackID != nil {
		t.Fatalf("cancelled upload status=%q track_id=%v", cancelledStatus, cancelledTrackID)
	}
	var trackCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM library_tracks WHERE id=$1`, paused.trackID).Scan(&trackCount); err != nil {
		t.Fatalf("count cancelled track: %v", err)
	}
	if trackCount != 0 {
		t.Fatalf("cancelled placeholder track still exists")
	}

	failed := insertLifecycleUpload(t, db, "error", strings.Repeat("c", 64))
	if _, err := db.Exec(ctx, `INSERT INTO media_jobs(kind,track_id,upload_id,status,error_message) VALUES('process_upload',$1,$2,'failed','probe failed')`, failed.trackID, failed.uploadID); err != nil {
		t.Fatalf("insert failed job: %v", err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: handleFiberError})
	app.Post("/uploads/:id/retry", func(c *fiber.Ctx) error {
		c.Locals("userID", failed.userID)
		return c.Next()
	}, srv.retryUpload)

	response, err := app.Test(httptest.NewRequest(http.MethodPost, "/uploads/"+failed.uploadID+"/retry", nil))
	if err != nil {
		t.Fatalf("retry request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("retry status=%d; want 202", response.StatusCode)
	}
	var uploadStatus, trackStatus string
	if err := db.QueryRow(ctx, `
		SELECT upload.status,track.status
		FROM upload_sessions upload JOIN library_tracks track ON track.id=upload.track_id
		WHERE upload.id=$1
	`, failed.uploadID).Scan(&uploadStatus, &trackStatus); err != nil {
		t.Fatalf("load retry state: %v", err)
	}
	if uploadStatus != "processing" || trackStatus != "processing" {
		t.Fatalf("retry states upload=%q track=%q; want processing", uploadStatus, trackStatus)
	}
	var pendingJobs int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM media_jobs WHERE track_id=$1 AND kind='process_upload' AND status='pending'`, failed.trackID).Scan(&pendingJobs); err != nil {
		t.Fatalf("count retry jobs: %v", err)
	}
	if pendingJobs != 1 {
		t.Fatalf("pending retry jobs=%d; want 1", pendingJobs)
	}

	second, err := app.Test(httptest.NewRequest(http.MethodPost, "/uploads/"+failed.uploadID+"/retry", nil))
	if err != nil {
		t.Fatalf("second retry request: %v", err)
	}
	defer second.Body.Close()
	if second.StatusCode != http.StatusConflict {
		t.Fatalf("second retry status=%d; want 409", second.StatusCode)
	}
	var payload models.ErrorResponse
	if err := json.NewDecoder(second.Body).Decode(&payload); err != nil {
		t.Fatalf("decode second retry: %v", err)
	}
	if payload.Error.Code != "upload_not_retryable" {
		t.Fatalf("second retry code=%q; want upload_not_retryable", payload.Error.Code)
	}
}

func TestListUploadsReturnsOnlyOperationalQueue(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}

	uploading := insertLifecycleUpload(t, db, "uploading", strings.Repeat("a", 64))
	paused := insertLifecycleUpload(t, db, "paused", strings.Repeat("b", 64))
	processing := insertLifecycleUpload(t, db, "processing", strings.Repeat("c", 64))
	failed := insertLifecycleUpload(t, db, "error", strings.Repeat("d", 64))
	ready := insertLifecycleUpload(t, db, "ready", strings.Repeat("e", 64))
	cancelled := insertLifecycleUpload(t, db, "paused", strings.Repeat("f", 64))
	if err := cancelUploadRecord(ctx, db, cancelled.uploadID, cancelled.trackID); err != nil {
		t.Fatalf("cancel fixture: %v", err)
	}
	for _, uploadID := range []string{paused.uploadID, processing.uploadID, failed.uploadID, ready.uploadID, cancelled.uploadID} {
		if _, err := db.Exec(ctx, `UPDATE upload_sessions SET user_id=$1 WHERE id=$2`, uploading.userID, uploadID); err != nil {
			t.Fatalf("move upload %s to test user: %v", uploadID, err)
		}
	}

	app := fiber.New(fiber.Config{ErrorHandler: handleFiberError})
	app.Get("/uploads", func(c *fiber.Ctx) error {
		c.Locals("userID", uploading.userID)
		return srv.listUploads(c)
	})
	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/uploads", nil))
	if err != nil {
		t.Fatalf("list uploads: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list uploads status=%d", response.StatusCode)
	}
	var payload uploadsEnvelope
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode upload queue: %v", err)
	}
	statuses := make(map[string]bool, len(payload.Results))
	for _, upload := range payload.Results {
		statuses[upload.Status] = true
	}
	for _, status := range []string{"uploading", "paused", "processing", "error"} {
		if !statuses[status] {
			t.Fatalf("operational status %q missing from %+v", status, statuses)
		}
	}
	if len(payload.Results) != 4 || statuses["ready"] || statuses["cancelled"] {
		t.Fatalf("queue contains terminal uploads: %+v", statuses)
	}
}

func TestTerminalUploadHistoryCleanupPreservesLibraryAndProblems(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	cutoff := time.Now().UTC().Add(-terminalUploadRetention)
	oldTime := cutoff.Add(-time.Hour)
	recentTime := cutoff.Add(30 * time.Minute)

	oldReady := insertLifecycleUpload(t, db, "ready", strings.Repeat("a", 64))
	recentReady := insertLifecycleUpload(t, db, "ready", strings.Repeat("b", 64))
	failed := insertLifecycleUpload(t, db, "error", strings.Repeat("c", 64))
	active := insertLifecycleUpload(t, db, "paused", strings.Repeat("d", 64))
	cancelled := insertLifecycleUpload(t, db, "paused", strings.Repeat("e", 64))
	if _, err := db.Exec(ctx, `INSERT INTO upload_parts(upload_id,part_number,etag,size_bytes) VALUES($1,1,'old-ready',1),($2,1,'cancelled',1)`, oldReady.uploadID, cancelled.uploadID); err != nil {
		t.Fatalf("insert terminal parts: %v", err)
	}
	if err := cancelUploadRecord(ctx, db, cancelled.uploadID, cancelled.trackID); err != nil {
		t.Fatalf("cancel fixture: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO track_likes(user_id,track_id) VALUES($1,$2)`, oldReady.userID, oldReady.trackID); err != nil {
		t.Fatalf("like ready track: %v", err)
	}
	var oldSucceededJob, recentSucceededJob, failedJob int64
	if err := db.QueryRow(ctx, `INSERT INTO media_jobs(kind,track_id,upload_id,status,finished_at,updated_at) VALUES('process_upload',$1,$2,'succeeded',$3,$3) RETURNING id`, oldReady.trackID, oldReady.uploadID, oldTime).Scan(&oldSucceededJob); err != nil {
		t.Fatalf("insert old succeeded job: %v", err)
	}
	if err := db.QueryRow(ctx, `INSERT INTO media_jobs(kind,track_id,upload_id,status,finished_at,updated_at) VALUES('process_upload',$1,$2,'succeeded',$3,$3) RETURNING id`, recentReady.trackID, recentReady.uploadID, recentTime).Scan(&recentSucceededJob); err != nil {
		t.Fatalf("insert recent succeeded job: %v", err)
	}
	if err := db.QueryRow(ctx, `INSERT INTO media_jobs(kind,track_id,upload_id,status,error_message,finished_at,updated_at) VALUES('process_upload',$1,$2,'failed','probe failed',$3,$3) RETURNING id`, failed.trackID, failed.uploadID, oldTime).Scan(&failedJob); err != nil {
		t.Fatalf("insert failed job: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE upload_sessions SET updated_at=$1 WHERE id IN ($2,$3,$4,$5)`, oldTime, oldReady.uploadID, cancelled.uploadID, failed.uploadID, active.uploadID); err != nil {
		t.Fatalf("age upload fixtures: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE upload_sessions SET updated_at=$1 WHERE id=$2`, recentTime, recentReady.uploadID); err != nil {
		t.Fatalf("set recent upload time: %v", err)
	}

	worker := &mediaWorker{db: db}
	if err := worker.cleanupTerminalUploadHistory(ctx, cutoff); err != nil {
		t.Fatalf("cleanup terminal upload history: %v", err)
	}

	assertRowCount := func(label, query string, want int, args ...any) {
		t.Helper()
		var got int
		if err := db.QueryRow(ctx, query, args...).Scan(&got); err != nil {
			t.Fatalf("count %s: %v", label, err)
		}
		if got != want {
			t.Fatalf("%s rows=%d; want %d", label, got, want)
		}
	}
	assertRowCount("old ready upload", `SELECT COUNT(*) FROM upload_sessions WHERE id=$1`, 0, oldReady.uploadID)
	assertRowCount("cancelled upload", `SELECT COUNT(*) FROM upload_sessions WHERE id=$1`, 0, cancelled.uploadID)
	assertRowCount("old terminal parts", `SELECT COUNT(*) FROM upload_parts WHERE upload_id IN ($1,$2)`, 0, oldReady.uploadID, cancelled.uploadID)
	assertRowCount("old succeeded job", `SELECT COUNT(*) FROM media_jobs WHERE id=$1`, 0, oldSucceededJob)
	assertRowCount("recent ready upload", `SELECT COUNT(*) FROM upload_sessions WHERE id=$1`, 1, recentReady.uploadID)
	assertRowCount("recent succeeded job", `SELECT COUNT(*) FROM media_jobs WHERE id=$1`, 1, recentSucceededJob)
	assertRowCount("failed upload", `SELECT COUNT(*) FROM upload_sessions WHERE id=$1`, 1, failed.uploadID)
	assertRowCount("failed job", `SELECT COUNT(*) FROM media_jobs WHERE id=$1`, 1, failedJob)
	assertRowCount("active upload", `SELECT COUNT(*) FROM upload_sessions WHERE id=$1`, 1, active.uploadID)
	assertRowCount("published track", `SELECT COUNT(*) FROM library_tracks WHERE id=$1 AND status='ready'`, 1, oldReady.trackID)
	assertRowCount("published like", `SELECT COUNT(*) FROM track_likes WHERE user_id=$1 AND track_id=$2`, 1, oldReady.userID, oldReady.trackID)
}

func TestHLSBackfillFailurePreservesReadyTrack(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	fixture := insertLifecycleUpload(t, db, "ready", strings.Repeat("9", 64))
	worker := &mediaWorker{db: db}

	var failedJobID int64
	if err := db.QueryRow(ctx, `
		INSERT INTO media_jobs(kind,track_id,status,attempts,started_at)
		VALUES('prepare_hls',$1,'running',1,NOW()) RETURNING id
	`, fixture.trackID).Scan(&failedJobID); err != nil {
		t.Fatalf("insert failed HLS job: %v", err)
	}
	if err := worker.fail(ctx, mediaJob{
		ID: failedJobID, Kind: "prepare_hls", TrackID: fixture.trackID,
	}, errors.New("packager failed")); err != nil {
		t.Fatalf("record HLS failure: %v", err)
	}
	assertReadyTrackWithoutError(t, ctx, db, fixture.trackID)
	var status, message string
	var retrySeconds float64
	if err := db.QueryRow(ctx, `
		SELECT status,error_message,EXTRACT(EPOCH FROM (run_at-NOW()))
		FROM media_jobs WHERE id=$1
	`, failedJobID).Scan(&status, &message, &retrySeconds); err != nil {
		t.Fatalf("load HLS retry: %v", err)
	}
	if status != "pending" || message != "packager failed" || retrySeconds < 25 || retrySeconds > 35 {
		t.Fatalf("first HLS retry status=%q message=%q delay=%.1fs", status, message, retrySeconds)
	}

	if _, err := db.Exec(ctx, `
		UPDATE media_jobs SET status='running',attempts=2,started_at=NOW(),run_at=NOW()
		WHERE id=$1
	`, failedJobID); err != nil {
		t.Fatalf("prepare stale HLS retry: %v", err)
	}
	if err := worker.failStaleJobs(ctx); err != nil {
		t.Fatalf("fail stale HLS job: %v", err)
	}
	assertReadyTrackWithoutError(t, ctx, db, fixture.trackID)
	if err := db.QueryRow(ctx, `
		SELECT status,error_message,EXTRACT(EPOCH FROM (run_at-NOW()))
		FROM media_jobs WHERE id=$1
	`, failedJobID).Scan(&status, &message, &retrySeconds); err != nil {
		t.Fatalf("load stale HLS retry: %v", err)
	}
	if status != "pending" || message != "worker stopped during processing" || retrySeconds < 55 || retrySeconds > 65 {
		t.Fatalf("stale HLS retry status=%q message=%q delay=%.1fs", status, message, retrySeconds)
	}

	if _, err := db.Exec(ctx, `
		UPDATE media_jobs SET status='running',attempts=$2,started_at=NOW(),run_at=NOW()
		WHERE id=$1
	`, failedJobID, hlsPreparationMaxAttempts); err != nil {
		t.Fatalf("prepare terminal HLS failure: %v", err)
	}
	if err := worker.fail(ctx, mediaJob{
		ID: failedJobID, Kind: "prepare_hls", TrackID: fixture.trackID,
	}, errors.New("permanent packaging failure")); err != nil {
		t.Fatalf("record terminal HLS failure: %v", err)
	}
	assertReadyTrackWithoutError(t, ctx, db, fixture.trackID)
	if err := db.QueryRow(ctx, `SELECT status,error_message FROM media_jobs WHERE id=$1`, failedJobID).Scan(&status, &message); err != nil {
		t.Fatalf("load terminal HLS failure: %v", err)
	}
	if status != "failed" || !strings.Contains(message, "stopped after 6 attempts") {
		t.Fatalf("terminal HLS status=%q message=%q", status, message)
	}
	readiness, err := (&Server{db: db}).libraryPlaybackReadiness(ctx)
	if err != nil {
		t.Fatalf("load terminal HLS readiness: %v", err)
	}
	if readiness.MissingTracks != 1 || readiness.TerminalFailures != 1 {
		t.Fatalf("terminal HLS readiness=%+v; want 1 missing/1 terminal", readiness)
	}
	blocked, err := (&Server{db: db}).libraryHasMissingPlaybackAssets(ctx)
	if err != nil || blocked {
		t.Fatalf("terminal-only HLS gate blocked=%v error=%v; want false", blocked, err)
	}
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "hls-ready-neighbor", title: "Ready Neighbor", artist: "Playback Test", createdAt: time.Now(),
	})
	var readyTrackID, terminalExternalID string
	if err := db.QueryRow(ctx, `SELECT id::text FROM library_tracks WHERE external_track_id='hls-ready-neighbor'`).Scan(&readyTrackID); err != nil {
		t.Fatalf("load ready HLS neighbor: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT external_track_id FROM library_tracks WHERE id=$1`, fixture.trackID).Scan(&terminalExternalID); err != nil {
		t.Fatalf("load terminal HLS external id: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO track_playback_assets(
			track_id,object_key,init_offset,init_length,segments,duration_ms,target_duration,status
		) VALUES($1,$2,0,64,'[{"offset":64,"length":128,"duration_ms":6000}]',6000,6,'ready')
	`, readyTrackID, "playback/"+readyTrackID+"/cmaf/ready.mp4"); err != nil {
		t.Fatalf("insert ready HLS neighbor asset: %v", err)
	}
	available, err := (&Server{db: db}).loadPlaybackTracksIgnoringMissing(ctx, []models.Track{
		{ExternalID: terminalExternalID},
		{ExternalID: "hls-ready-neighbor"},
	})
	if err != nil || len(available) != 1 || available[0].Track.ExternalID != "hls-ready-neighbor" {
		t.Fatalf("terminal-missing continuation available=%+v error=%v", available, err)
	}
	playbackServer := &Server{db: db}
	playbackApp := fiber.New()
	playbackApp.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", fixture.userID)
		return c.Next()
	})
	playbackApp.Post("/sessions", playbackServer.createPlaybackSession)
	playbackRequest, err := http.NewRequest(http.MethodPost, "/sessions", strings.NewReader(`{
		"source":{"kind":"search"},
		"initial_external_ids":["hls-ready-neighbor"],
		"current_external_id":"hls-ready-neighbor",
		"current_index":0,
		"position_seconds":0,
		"page":1,
		"has_more":false
	}`))
	if err != nil {
		t.Fatalf("create terminal-only gate request: %v", err)
	}
	playbackRequest.Header.Set("Content-Type", "application/json")
	playbackResponse, err := playbackApp.Test(playbackRequest, -1)
	if err != nil {
		t.Fatalf("terminal-only gate request: %v", err)
	}
	playbackResponse.Body.Close()
	if playbackResponse.StatusCode != http.StatusCreated {
		t.Fatalf("terminal-only gate status=%d; want 201", playbackResponse.StatusCode)
	}
	if err := worker.enqueueMissingHLSAssets(ctx); err != nil {
		t.Fatalf("enqueue after terminal HLS failure: %v", err)
	}
	var jobs, pending int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*),COUNT(*) FILTER (WHERE status='pending')
		FROM media_jobs WHERE track_id=$1 AND kind='prepare_hls'
	`, fixture.trackID).Scan(&jobs, &pending); err != nil {
		t.Fatalf("count terminal HLS jobs: %v", err)
	}
	if jobs != 1 || pending != 0 {
		t.Fatalf("terminal HLS jobs=%d pending=%d; want 1/0", jobs, pending)
	}
}

func TestHLSPreparationRetryDelayIsExponentialAndBounded(t *testing.T) {
	tests := []struct {
		attempts int
		want     time.Duration
	}{
		{attempts: 0, want: 30 * time.Second},
		{attempts: 1, want: 30 * time.Second},
		{attempts: 2, want: time.Minute},
		{attempts: 3, want: 2 * time.Minute},
		{attempts: 6, want: hlsRetryMaximumDelay},
		{attempts: 50, want: hlsRetryMaximumDelay},
	}
	for _, test := range tests {
		if got := hlsPreparationRetryDelay(test.attempts); got != test.want {
			t.Fatalf("attempts=%d delay=%s; want %s", test.attempts, got, test.want)
		}
	}
}

func TestUploadCMAFAssetVerifiesStoredObject(t *testing.T) {
	mediaPath := path.Join(t.TempDir(), "audio.mp4")
	media := []byte("verified-cmaf-object")
	if err := os.WriteFile(mediaPath, media, 0o600); err != nil {
		t.Fatalf("write CMAF fixture: %v", err)
	}
	packaged := packagedCMAF{
		MediaPath: mediaPath,
		Index: cmafPlaylistIndex{
			InitOffset: 0, InitLength: 4, DurationMS: 6000, TargetDuration: 6,
			Segments: []hlsSegment{{Offset: 4, Length: int64(len(media) - 4), DurationMS: 6000}},
		},
	}

	t.Run("matching size", func(t *testing.T) {
		storage := newFakeR2(t)
		worker := &mediaWorker{storage: storage.catalog}
		asset, err := worker.uploadCMAFAsset(context.Background(), uuid.NewString(), packaged)
		if err != nil {
			t.Fatalf("upload verified CMAF: %v", err)
		}
		if asset.ID == "" || asset.ObjectKey == "" || storage.objectCount() != 1 {
			t.Fatalf("verified CMAF asset=%+v objects=%d", asset, storage.objectCount())
		}
	})

	t.Run("size mismatch is deleted", func(t *testing.T) {
		storage := newFakeR2(t)
		storage.addToHeadSize(1)
		worker := &mediaWorker{storage: storage.catalog}
		_, err := worker.uploadCMAFAsset(context.Background(), uuid.NewString(), packaged)
		if err == nil || !strings.Contains(err.Error(), "size is") {
			t.Fatalf("size mismatch error=%v", err)
		}
		if storage.objectCount() != 0 {
			t.Fatalf("mismatched CMAF objects=%d; want 0", storage.objectCount())
		}
	})

	t.Run("HEAD failure is deleted", func(t *testing.T) {
		storage := newFakeR2(t)
		storage.failHeadsWithPrefix("playback/")
		worker := &mediaWorker{storage: storage.catalog}
		_, err := worker.uploadCMAFAsset(context.Background(), uuid.NewString(), packaged)
		if err == nil || !strings.Contains(err.Error(), "verify stored CMAF playback") {
			t.Fatalf("HEAD failure error=%v", err)
		}
		if storage.objectCount() != 0 {
			t.Fatalf("unverified CMAF objects=%d; want 0", storage.objectCount())
		}
	})
}

func TestProcessUploadDoesNotPublishBeforeHLSAsset(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required for the media lifecycle integration test")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required for the media lifecycle integration test")
	}

	db := newLifecycleTestDB(t)
	ctx := context.Background()
	wav := testWAV()
	hashBytes := sha256.Sum256(wav)
	fixture := insertLifecycleUploadWithSize(t, db, "processing", hex.EncodeToString(hashBytes[:]), int64(len(wav)))
	var jobID int64
	if err := db.QueryRow(ctx, `
		INSERT INTO media_jobs(kind,track_id,upload_id,status,attempts,started_at)
		VALUES('process_upload',$1,$2,'running',1,NOW()) RETURNING id
	`, fixture.trackID, fixture.uploadID).Scan(&jobID); err != nil {
		t.Fatalf("insert process job: %v", err)
	}
	storage := newFakeR2(t)
	storage.put(fixture.incomingKey, "audio/wav", wav)
	storage.failPutsWithPrefix("playback/" + fixture.trackID + "/cmaf/")
	worker := &mediaWorker{db: db, storage: storage.catalog}
	job := mediaJob{ID: jobID, Kind: "process_upload", TrackID: fixture.trackID, UploadID: fixture.uploadID}
	err := worker.processUpload(ctx, job)
	if err == nil || !strings.Contains(err.Error(), "store CMAF playback") {
		t.Fatalf("process upload error=%v; want CMAF upload failure", err)
	}

	var trackStatus, uploadStatus string
	var readyAssets int
	if err := db.QueryRow(ctx, `
		SELECT track.status,upload.status,(
			SELECT COUNT(*) FROM track_playback_assets asset
			WHERE asset.track_id=track.id AND asset.status='ready' AND asset.retired_at IS NULL
		)
		FROM library_tracks track JOIN upload_sessions upload ON upload.track_id=track.id
		WHERE track.id=$1
	`, fixture.trackID).Scan(&trackStatus, &uploadStatus, &readyAssets); err != nil {
		t.Fatalf("load unpublished upload: %v", err)
	}
	if trackStatus != "processing" || uploadStatus != "processing" || readyAssets != 0 {
		t.Fatalf("premature publication track=%q upload=%q assets=%d", trackStatus, uploadStatus, readyAssets)
	}
	playbackKey := "playback/" + fixture.trackID + ".m4a"
	if _, ok := storage.get(playbackKey); !ok {
		t.Fatal("legacy M4A fallback was removed after CMAF failure")
	}
	if err := worker.fail(ctx, job, err); err != nil {
		t.Fatalf("record process failure: %v", err)
	}
	if err := db.QueryRow(ctx, `
		SELECT track.status,upload.status
		FROM library_tracks track JOIN upload_sessions upload ON upload.track_id=track.id
		WHERE track.id=$1
	`, fixture.trackID).Scan(&trackStatus, &uploadStatus); err != nil {
		t.Fatalf("load failed upload: %v", err)
	}
	if trackStatus != "error" || uploadStatus != "error" {
		t.Fatalf("failed process states track=%q upload=%q; want error/error", trackStatus, uploadStatus)
	}
}

func TestEnqueueMissingHLSAssetsIsIdempotentAndRetriesFailedJobs(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	fixture := insertLifecycleUpload(t, db, "ready", strings.Repeat("7", 64))
	worker := &mediaWorker{db: db}

	if err := worker.enqueueMissingHLSAssets(ctx); err != nil {
		t.Fatalf("enqueue missing HLS asset: %v", err)
	}
	if err := worker.enqueueMissingHLSAssets(ctx); err != nil {
		t.Fatalf("repeat enqueue missing HLS asset: %v", err)
	}
	var pendingJobs int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*) FROM media_jobs
		WHERE track_id=$1 AND kind='prepare_hls' AND status='pending'
	`, fixture.trackID).Scan(&pendingJobs); err != nil {
		t.Fatalf("count idempotent HLS jobs: %v", err)
	}
	if pendingJobs != 1 {
		t.Fatalf("pending HLS jobs=%d; want 1", pendingJobs)
	}
	if _, err := db.Exec(ctx, `
		UPDATE media_jobs SET status='failed',finished_at=NOW(),updated_at=NOW()
		WHERE track_id=$1 AND kind='prepare_hls' AND status='pending'
	`, fixture.trackID); err != nil {
		t.Fatalf("fail initial HLS job: %v", err)
	}
	if err := worker.enqueueMissingHLSAssets(ctx); err != nil {
		t.Fatalf("reenqueue failed HLS asset: %v", err)
	}
	var failedJobs int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE status='failed'),COUNT(*) FILTER (WHERE status='pending')
		FROM media_jobs WHERE track_id=$1 AND kind='prepare_hls'
	`, fixture.trackID).Scan(&failedJobs, &pendingJobs); err != nil {
		t.Fatalf("count retried HLS jobs: %v", err)
	}
	if failedJobs != 1 || pendingJobs != 1 {
		t.Fatalf("retried HLS jobs failed=%d pending=%d; want 1/1", failedJobs, pendingJobs)
	}
}

func assertReadyTrackWithoutError(t *testing.T, ctx context.Context, db *pgxpool.Pool, trackID string) {
	t.Helper()
	var status string
	var errorMessage *string
	if err := db.QueryRow(ctx, `SELECT status,error_message FROM library_tracks WHERE id=$1`, trackID).Scan(&status, &errorMessage); err != nil {
		t.Fatalf("load track after HLS failure: %v", err)
	}
	if status != "ready" || errorMessage != nil {
		t.Fatalf("track after HLS failure status=%q error=%v; want ready without error", status, errorMessage)
	}
}

func TestWorkerPublishesThenPermanentlyDeletesTrack(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required for the media lifecycle integration test")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required for the media lifecycle integration test")
	}

	db := newLifecycleTestDB(t)
	ctx := context.Background()
	wav := testMultichannelWAV(t)
	hashBytes := sha256.Sum256(wav)
	fixture := insertLifecycleUploadWithSize(t, db, "processing", hex.EncodeToString(hashBytes[:]), int64(len(wav)))
	var processJobID int64
	if err := db.QueryRow(ctx, `
		INSERT INTO media_jobs(kind,track_id,upload_id,status,attempts,started_at)
		VALUES('process_upload',$1,$2,'running',1,NOW()) RETURNING id
	`, fixture.trackID, fixture.uploadID).Scan(&processJobID); err != nil {
		t.Fatalf("insert process job: %v", err)
	}

	storage := newFakeR2(t)
	storage.put(fixture.incomingKey, "audio/wav", wav)
	staleOriginalKey := "originals/" + fixture.trackID + "/stale.wav"
	storage.put(staleOriginalKey, "audio/wav", wav)
	if _, err := db.Exec(ctx, `UPDATE library_tracks SET original_object_key=$2 WHERE id=$1`, fixture.trackID, staleOriginalKey); err != nil {
		t.Fatalf("set stale original key: %v", err)
	}
	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer redisClient.Close()
	worker := &mediaWorker{db: db, storage: storage.catalog, redis: redisClient}
	job := mediaJob{ID: processJobID, Kind: "process_upload", TrackID: fixture.trackID, UploadID: fixture.uploadID}
	if err := worker.processUpload(ctx, job); err != nil {
		t.Fatalf("process upload: %v", err)
	}

	var title, artist, trackStatus, uploadStatus, originalKey, playbackKey, objectKey, coverKey, jobStatus string
	var duration int
	if err := db.QueryRow(ctx, `
		SELECT track.title,track.artist,track.status,upload.status,
		       COALESCE(track.original_object_key,''),COALESCE(track.playback_object_key,''),
		       track.object_key,COALESCE(track.cover_object_key,''),track.duration_seconds,job.status
		FROM library_tracks track
		JOIN upload_sessions upload ON upload.track_id=track.id
		JOIN media_jobs job ON job.upload_id=upload.id AND job.kind='process_upload'
		WHERE track.id=$1
	`, fixture.trackID).Scan(&title, &artist, &trackStatus, &uploadStatus, &originalKey, &playbackKey, &objectKey, &coverKey, &duration, &jobStatus); err != nil {
		t.Fatalf("load published state: %v", err)
	}
	if title != "Explicit Song" || artist != "Explicit Artist" {
		t.Fatalf("published metadata title=%q artist=%q", title, artist)
	}
	if trackStatus != "ready" || uploadStatus != "ready" || jobStatus != "succeeded" {
		t.Fatalf("published states track=%q upload=%q job=%q", trackStatus, uploadStatus, jobStatus)
	}
	if originalKey != "" || playbackKey == "" || objectKey != playbackKey || coverKey != "" || duration <= 0 {
		t.Fatalf("published keys/duration original=%q playback=%q object=%q cover=%q duration=%d", originalKey, playbackKey, objectKey, coverKey, duration)
	}
	if _, ok := storage.get(staleOriginalKey); ok {
		t.Fatalf("obsolete original object was retained")
	}
	playbackObject, playbackExists := storage.get(playbackKey)
	if !playbackExists || len(playbackObject.body) == 0 || playbackObject.contentType != "audio/mp4" {
		t.Fatalf("playback object missing or invalid: exists=%v bytes=%d type=%q", playbackExists, len(playbackObject.body), playbackObject.contentType)
	}
	playbackProbePath := path.Join(t.TempDir(), "playback.m4a")
	if err := os.WriteFile(playbackProbePath, playbackObject.body, 0o600); err != nil {
		t.Fatalf("write playback probe fixture: %v", err)
	}
	playbackStream := probeTestAudioStream(t, playbackProbePath)
	if playbackStream["sample_rate"] != "48000" || playbackStream["channels"] != "2" {
		t.Fatalf("playback stream was not normalized for CMAF: %v", playbackStream)
	}
	var hlsAssetID, hlsObjectKey string
	var hlsSegments []byte
	var hlsDurationMS int64
	var hlsTargetDuration int
	if err := db.QueryRow(ctx, `
		SELECT id::text,object_key,segments,duration_ms,target_duration
		FROM track_playback_assets
		WHERE track_id=$1 AND status='ready' AND retired_at IS NULL
	`, fixture.trackID).Scan(&hlsAssetID, &hlsObjectKey, &hlsSegments, &hlsDurationMS, &hlsTargetDuration); err != nil {
		t.Fatalf("load published HLS asset: %v", err)
	}
	if hlsAssetID == "" || hlsDurationMS <= 0 || hlsTargetDuration < 1 {
		t.Fatalf("invalid HLS metadata id=%q duration=%d target=%d", hlsAssetID, hlsDurationMS, hlsTargetDuration)
	}
	if segments, err := parsePlaybackSegments(hlsSegments); err != nil || len(segments) == 0 {
		t.Fatalf("invalid HLS segment index: segments=%d error=%v", len(segments), err)
	}
	if got, ok := storage.get(hlsObjectKey); !ok || len(got.body) == 0 || got.contentType != "audio/mp4" {
		t.Fatalf("HLS object missing or invalid: exists=%v bytes=%d type=%q", ok, len(got.body), got.contentType)
	}
	if _, ok := storage.get(fixture.incomingKey); ok {
		t.Fatalf("incoming object still exists after publication")
	}

	if _, err := db.Exec(ctx, `INSERT INTO track_likes(user_id,track_id) VALUES($1,$2)`, fixture.userID, fixture.trackID); err != nil {
		t.Fatalf("like published track: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE library_tracks SET status='deleting' WHERE id=$1`, fixture.trackID); err != nil {
		t.Fatalf("mark deleting: %v", err)
	}
	var deleteJobID int64
	if err := db.QueryRow(ctx, `
		INSERT INTO media_jobs(kind,track_id,status,attempts,started_at)
		VALUES('delete_track',$1,'running',1,NOW()) RETURNING id
	`, fixture.trackID).Scan(&deleteJobID); err != nil {
		t.Fatalf("insert delete job: %v", err)
	}
	deleted, err := worker.deleteTrack(ctx, mediaJob{ID: deleteJobID, Kind: "delete_track", TrackID: fixture.trackID})
	if err != nil {
		t.Fatalf("delete track: %v", err)
	}
	if !deleted {
		t.Fatalf("delete worker did not report final deletion")
	}
	var tracks, likes int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM library_tracks WHERE id=$1`, fixture.trackID).Scan(&tracks); err != nil {
		t.Fatalf("count deleted track: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM track_likes WHERE track_id=$1`, fixture.trackID).Scan(&likes); err != nil {
		t.Fatalf("count deleted likes: %v", err)
	}
	if tracks != 0 || likes != 0 {
		t.Fatalf("permanent deletion left tracks=%d likes=%d", tracks, likes)
	}
	if _, ok := storage.get(playbackKey); ok {
		t.Fatalf("playback object still exists after deletion")
	}
	if _, ok := storage.get(hlsObjectKey); ok {
		t.Fatalf("HLS object still exists after deletion")
	}
	if storage.deleted(staleOriginalKey) != 1 || storage.deleted(playbackKey) != 1 || storage.deleted(hlsObjectKey) != 1 {
		t.Fatalf(
			"objects were not deleted exactly once: stale_original=%d playback=%d hls=%d",
			storage.deleted(staleOriginalKey), storage.deleted(playbackKey), storage.deleted(hlsObjectKey),
		)
	}
}

func TestDeleteTrackRetainsHLSAssetUntilPlaybackSessionExpires(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	fixture := insertLifecycleUpload(t, db, "ready", strings.Repeat("8", 64))
	playbackKey := "playback/" + fixture.trackID + ".m4a"
	hlsObjectKey := "playback/" + fixture.trackID + "/cmaf/session-retained.mp4"
	hlsAssetID := uuid.NewString()
	sessionID := uuid.NewString()
	if _, err := db.Exec(ctx, `
		UPDATE library_tracks SET object_key=$2,playback_object_key=$2,status='deleting'
		WHERE id=$1
	`, fixture.trackID, playbackKey); err != nil {
		t.Fatalf("prepare deleting track: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO track_playback_assets(
			id,track_id,object_key,init_offset,init_length,segments,duration_ms,target_duration,status
		) VALUES($1,$2,$3,0,100,'[{"offset":100,"length":900,"duration_ms":6000}]',6000,6,'ready')
	`, hlsAssetID, fixture.trackID, hlsObjectKey); err != nil {
		t.Fatalf("insert HLS asset: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO playback_sessions(
			id,user_id,source_kind,source_state,status,created_at,last_accessed_at,expires_at
		) VALUES($1,$2,'search','{}','active',NOW()-INTERVAL '3 hours',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour')
	`, sessionID, fixture.userID); err != nil {
		t.Fatalf("insert expired playback session: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO playback_session_items(
			session_id,ordinal,track_id,hls_asset_id,track_snapshot,first_media_sequence,
			segment_count,timeline_start_ms,duration_ms
		) VALUES($1,0,$2,$3,'{}',0,1,0,6000)
	`, sessionID, fixture.trackID, hlsAssetID); err != nil {
		t.Fatalf("insert playback session item: %v", err)
	}
	var deleteJobID int64
	if err := db.QueryRow(ctx, `
		INSERT INTO media_jobs(kind,track_id,status,attempts,started_at)
		VALUES('delete_track',$1,'running',1,NOW()) RETURNING id
	`, fixture.trackID).Scan(&deleteJobID); err != nil {
		t.Fatalf("insert delete job: %v", err)
	}
	storage := newFakeR2(t)
	storage.put(playbackKey, "audio/mp4", []byte("legacy playback"))
	storage.put(hlsObjectKey, "audio/mp4", make([]byte, 1000))
	worker := &mediaWorker{db: db, storage: storage.catalog}
	deleted, err := worker.deleteTrack(ctx, mediaJob{ID: deleteJobID, Kind: "delete_track", TrackID: fixture.trackID})
	if err != nil || !deleted {
		t.Fatalf("delete track: deleted=%v error=%v", deleted, err)
	}
	if _, ok := storage.get(playbackKey); ok {
		t.Fatal("legacy playback object remains after track deletion")
	}
	if _, ok := storage.get(hlsObjectKey); !ok {
		t.Fatal("active playback session lost its HLS object")
	}
	var assetTrackID, itemTrackID *string
	if err := db.QueryRow(ctx, `
		SELECT asset.track_id::text,item.track_id::text
		FROM track_playback_assets asset
		JOIN playback_session_items item ON item.hls_asset_id=asset.id
		WHERE asset.id=$1
	`, hlsAssetID).Scan(&assetTrackID, &itemTrackID); err != nil {
		t.Fatalf("load retained HLS references: %v", err)
	}
	if assetTrackID != nil || itemTrackID != nil {
		t.Fatalf("deleted track references remain asset=%v item=%v", assetTrackID, itemTrackID)
	}
	if err := worker.cleanupRetiredHLSAssets(ctx, time.Now()); err != nil {
		t.Fatalf("cleanup referenced HLS asset: %v", err)
	}
	if _, ok := storage.get(hlsObjectKey); !ok {
		t.Fatal("referenced HLS object was cleaned before its session")
	}
	if err := cleanupExpiredPlaybackSessions(ctx, db); err != nil {
		t.Fatalf("cleanup expired playback session: %v", err)
	}
	if err := worker.cleanupRetiredHLSAssets(ctx, time.Now()); err != nil {
		t.Fatalf("cleanup unreferenced HLS asset: %v", err)
	}
	if _, ok := storage.get(hlsObjectKey); ok {
		t.Fatal("orphaned HLS object remains after session cleanup")
	}
	var assetCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM track_playback_assets WHERE id=$1`, hlsAssetID).Scan(&assetCount); err != nil {
		t.Fatalf("count cleaned HLS asset: %v", err)
	}
	if assetCount != 0 {
		t.Fatalf("orphaned HLS asset rows=%d; want 0", assetCount)
	}
}

func TestDeleteTrackWaitsForConcurrentPlaybackSessionReference(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	fixture := insertLifecycleUpload(t, db, "ready", strings.Repeat("6", 64))
	hlsObjectKey := "playback/" + fixture.trackID + "/cmaf/concurrent-session.mp4"
	hlsAssetID := uuid.NewString()
	sessionID := uuid.NewString()
	if _, err := db.Exec(ctx, `UPDATE library_tracks SET status='deleting' WHERE id=$1`, fixture.trackID); err != nil {
		t.Fatalf("prepare concurrent track deletion: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO track_playback_assets(
			id,track_id,object_key,init_offset,init_length,segments,duration_ms,target_duration,status
		) VALUES($1,$2,$3,0,100,'[{"offset":100,"length":900,"duration_ms":6000}]',6000,6,'ready')
	`, hlsAssetID, fixture.trackID, hlsObjectKey); err != nil {
		t.Fatalf("insert concurrent HLS asset: %v", err)
	}

	sessionTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatalf("begin concurrent session: %v", err)
	}
	defer sessionTx.Rollback(ctx) //nolint:errcheck
	if _, err := sessionTx.Exec(ctx, `
		INSERT INTO playback_sessions(id,user_id,source_kind,source_state,status)
		VALUES($1,$2,'search','{}','active')
	`, sessionID, fixture.userID); err != nil {
		t.Fatalf("insert concurrent playback session: %v", err)
	}
	if _, err := sessionTx.Exec(ctx, `
		INSERT INTO playback_session_items(
			session_id,ordinal,track_id,hls_asset_id,track_snapshot,first_media_sequence,
			segment_count,timeline_start_ms,duration_ms
		) VALUES($1,0,$2,$3,'{}',0,1,0,6000)
	`, sessionID, fixture.trackID, hlsAssetID); err != nil {
		t.Fatalf("insert concurrent playback item: %v", err)
	}

	storage := newFakeR2(t)
	storage.put(hlsObjectKey, "audio/mp4", make([]byte, 1000))
	worker := &mediaWorker{db: db, storage: storage.catalog}
	type deleteResult struct {
		deleted bool
		err     error
	}
	deleteDone := make(chan deleteResult, 1)
	go func() {
		deleted, err := worker.deleteTrack(ctx, mediaJob{Kind: "delete_track", TrackID: fixture.trackID})
		deleteDone <- deleteResult{deleted: deleted, err: err}
	}()

	select {
	case result := <-deleteDone:
		t.Fatalf("delete did not wait for uncommitted playback reference: %+v", result)
	case <-time.After(100 * time.Millisecond):
	}
	if err := sessionTx.Commit(ctx); err != nil {
		t.Fatalf("commit concurrent playback session: %v", err)
	}
	result := <-deleteDone
	if result.err != nil || !result.deleted {
		t.Fatalf("concurrent delete result: deleted=%v error=%v", result.deleted, result.err)
	}
	if _, ok := storage.get(hlsObjectKey); !ok {
		t.Fatal("concurrently referenced HLS object was deleted")
	}
	var assetTrackID, itemTrackID *string
	if err := db.QueryRow(ctx, `
		SELECT asset.track_id::text,item.track_id::text
		FROM track_playback_assets asset
		JOIN playback_session_items item ON item.hls_asset_id=asset.id
		WHERE asset.id=$1
	`, hlsAssetID).Scan(&assetTrackID, &itemTrackID); err != nil {
		t.Fatalf("load concurrent retained references: %v", err)
	}
	if assetTrackID != nil || itemTrackID != nil {
		t.Fatalf("concurrent deleted track references remain asset=%v item=%v", assetTrackID, itemTrackID)
	}
}

type lifecycleUploadFixture struct {
	userID, trackID, uploadID, incomingKey string
}

func insertLifecycleUpload(t *testing.T, db *pgxpool.Pool, status, hash string) lifecycleUploadFixture {
	t.Helper()
	return insertLifecycleUploadWithSize(t, db, status, hash, uploadPartSize+23)
}

func insertLifecycleUploadWithSize(t *testing.T, db *pgxpool.Pool, status, hash string, size int64) lifecycleUploadFixture {
	t.Helper()
	ctx := context.Background()
	fixture := lifecycleUploadFixture{
		userID: uuid.NewString(), trackID: uuid.NewString(), uploadID: uuid.NewString(),
	}
	fixture.incomingKey = "incoming/" + fixture.uploadID + "/original.wav"
	email := fixture.userID + "@example.com"
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,role,active,access_status) VALUES($1,$2,'','uploader',TRUE,'active')`, fixture.userID, email); err != nil {
		t.Fatalf("insert lifecycle user: %v", err)
	}
	trackStatus := status
	if status == "paused" {
		trackStatus = "uploading"
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO library_tracks(
			id,external_track_id,title,artist,album,cover_url,object_key,content_type,size_bytes,
			uploaded_by_user_id,sha256,status,error_message
		) VALUES($1,$2,'Pending Song','Pending Artist','','',$3,'audio/wav',$4,$5,$6,$7,$8)
	`, fixture.trackID, "antolex-"+strings.ReplaceAll(fixture.trackID, "-", "")[:20], fixture.incomingKey, size, fixture.userID, hash, trackStatus, errorForStatus(status)); err != nil {
		t.Fatalf("insert lifecycle track: %v", err)
	}
	partsTotal := int((size + uploadPartSize - 1) / uploadPartSize)
	if _, err := db.Exec(ctx, `
		INSERT INTO upload_sessions(
			id,user_id,track_id,file_name,content_type,size_bytes,sha256,title,artist,album,status,
			r2_object_key,multipart_upload_id,part_size,parts_total,error_message,expires_at
		) VALUES($1,$2,$3,'Test Artist - Test Song.wav','audio/wav',$4,$5,'Explicit Song','Explicit Artist','Explicit Album',$6,$7,$8,$9,$10,$11,NOW()+INTERVAL '1 day')
	`, fixture.uploadID, fixture.userID, fixture.trackID, size, hash, status, fixture.incomingKey, "multipart-"+fixture.uploadID, uploadPartSize, partsTotal, errorForStatus(status)); err != nil {
		t.Fatalf("insert lifecycle upload: %v", err)
	}
	return fixture
}

func errorForStatus(status string) any {
	if status == "error" {
		return "probe failed"
	}
	return nil
}

func newLifecycleTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	rawURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if rawURL == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL lifecycle integration tests")
	}
	ctx := context.Background()
	adminConfig, err := pgxpool.ParseConfig(rawURL)
	if err != nil {
		t.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}
	admin, err := pgxpool.NewWithConfig(ctx, adminConfig)
	if err != nil {
		t.Fatalf("connect TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(admin.Close)
	if err := admin.Ping(ctx); err != nil {
		t.Fatalf("ping TEST_DATABASE_URL: %v", err)
	}

	schema := "antolex_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatalf("create isolated test schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("drop isolated test schema: %v", err)
		}
	})

	testConfig, err := pgxpool.ParseConfig(rawURL)
	if err != nil {
		t.Fatalf("parse isolated database config: %v", err)
	}
	if testConfig.ConnConfig.RuntimeParams == nil {
		testConfig.ConnConfig.RuntimeParams = make(map[string]string)
	}
	testConfig.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	db, err := pgxpool.NewWithConfig(ctx, testConfig)
	if err != nil {
		t.Fatalf("connect isolated test schema: %v", err)
	}
	t.Cleanup(db.Close)
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatalf("migrate isolated test schema: %v", err)
	}
	return db
}

type fakeR2Object struct {
	contentType string
	body        []byte
}

type fakeR2 struct {
	mu          sync.Mutex
	objects     map[string]fakeR2Object
	deleteCount map[string]int
	failPut     string
	failHead    string
	headSizeAdd int
	catalog     *seedCatalog
}

func newFakeR2(t *testing.T) *fakeR2 {
	t.Helper()
	storage := &fakeR2{objects: make(map[string]fakeR2Object), deleteCount: make(map[string]int)}
	server := httptest.NewServer(http.HandlerFunc(storage.serveHTTP))
	t.Cleanup(server.Close)
	client := s3.NewFromConfig(aws.Config{
		Region: "auto",
		Credentials: aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider(
			"test-access-key", "test-secret-key", "",
		)),
		HTTPClient: server.Client(),
	}, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(server.URL)
		options.UsePathStyle = true
	})
	storage.catalog = &seedCatalog{bucket: "music", client: client, presigner: s3.NewPresignClient(client)}
	return storage
}

func (f *fakeR2) serveHTTP(response http.ResponseWriter, request *http.Request) {
	trimmed := strings.TrimPrefix(request.URL.Path, "/")
	bucket, key, found := strings.Cut(trimmed, "/")
	if !found || bucket != "music" || key == "" {
		http.NotFound(response, request)
		return
	}

	switch request.Method {
	case http.MethodHead:
		object, ok := f.get(key)
		if !ok {
			http.NotFound(response, request)
			return
		}
		f.mu.Lock()
		failHead := f.failHead != "" && strings.HasPrefix(key, f.failHead)
		headSizeAdd := f.headSizeAdd
		f.mu.Unlock()
		if failHead {
			http.Error(response, "injected object head failure", http.StatusServiceUnavailable)
			return
		}
		response.Header().Set("Content-Type", object.contentType)
		response.Header().Set("Content-Length", strconv.Itoa(len(object.body)+headSizeAdd))
		response.Header().Set("ETag", `"test-etag"`)
		response.WriteHeader(http.StatusOK)
	case http.MethodGet:
		object, ok := f.get(key)
		if !ok {
			http.NotFound(response, request)
			return
		}
		body := object.body
		status := http.StatusOK
		if requestedRange := strings.TrimSpace(request.Header.Get("Range")); requestedRange != "" {
			parsed, parsedStatus, err := parseSingleByteRange(requestedRange, int64(len(object.body)))
			if err != nil {
				response.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", len(object.body)))
				response.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			status = parsedStatus
			body = object.body[parsed.Start : parsed.End+1]
			response.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", parsed.Start, parsed.End, len(object.body)))
		}
		response.Header().Set("Content-Type", object.contentType)
		response.Header().Set("Content-Length", strconv.Itoa(len(body)))
		response.Header().Set("Accept-Ranges", "bytes")
		response.Header().Set("ETag", `"test-etag"`)
		response.WriteHeader(status)
		_, _ = response.Write(body)
	case http.MethodPut:
		f.mu.Lock()
		failPut := f.failPut != "" && strings.HasPrefix(key, f.failPut)
		f.mu.Unlock()
		if failPut {
			http.Error(response, "injected object upload failure", http.StatusServiceUnavailable)
			return
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			http.Error(response, err.Error(), http.StatusBadRequest)
			return
		}
		f.put(key, request.Header.Get("Content-Type"), body)
		response.Header().Set("ETag", `"test-etag"`)
		response.WriteHeader(http.StatusOK)
	case http.MethodDelete:
		f.mu.Lock()
		f.deleteCount[key]++
		delete(f.objects, key)
		f.mu.Unlock()
		response.WriteHeader(http.StatusNoContent)
	default:
		response.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (f *fakeR2) failPutsWithPrefix(prefix string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failPut = prefix
}

func (f *fakeR2) failHeadsWithPrefix(prefix string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failHead = prefix
}

func (f *fakeR2) addToHeadSize(delta int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.headSizeAdd = delta
}

func (f *fakeR2) put(key, contentType string, body []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = fakeR2Object{contentType: contentType, body: bytes.Clone(body)}
}

func (f *fakeR2) get(key string) (fakeR2Object, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.objects[key]
	object.body = bytes.Clone(object.body)
	return object, ok
}

func (f *fakeR2) deleted(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deleteCount[key]
}

func (f *fakeR2) objectCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.objects)
}

func testWAV() []byte {
	const (
		sampleRate    = uint32(44100)
		channels      = uint16(1)
		bitsPerSample = uint16(16)
		samples       = sampleRate
	)
	dataSize := uint32(samples) * uint32(channels) * uint32(bitsPerSample/8)
	buffer := bytes.NewBuffer(make([]byte, 0, 44+dataSize))
	buffer.WriteString("RIFF")
	_ = binary.Write(buffer, binary.LittleEndian, uint32(36)+dataSize)
	buffer.WriteString("WAVEfmt ")
	_ = binary.Write(buffer, binary.LittleEndian, uint32(16))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(1))
	_ = binary.Write(buffer, binary.LittleEndian, channels)
	_ = binary.Write(buffer, binary.LittleEndian, sampleRate)
	_ = binary.Write(buffer, binary.LittleEndian, sampleRate*uint32(channels)*uint32(bitsPerSample/8))
	_ = binary.Write(buffer, binary.LittleEndian, channels*(bitsPerSample/8))
	_ = binary.Write(buffer, binary.LittleEndian, bitsPerSample)
	buffer.WriteString("data")
	_ = binary.Write(buffer, binary.LittleEndian, dataSize)
	buffer.Write(make([]byte, dataSize))
	return buffer.Bytes()
}

func testMultichannelWAV(t *testing.T) []byte {
	t.Helper()
	filePath := path.Join(t.TempDir(), "source-5.1-32khz.wav")
	command := exec.Command(
		"ffmpeg",
		"-v", "error",
		"-y",
		"-f", "lavfi",
		"-i", "anullsrc=r=32000:cl=5.1",
		"-t", "1",
		"-c:a", "pcm_s16le",
		filePath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create 5.1/32 kHz fixture: %v: %s", err, output)
	}
	body, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read 5.1/32 kHz fixture: %v", err)
	}
	return body
}
