package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alexeytozik/antolex-music/services/api/internal/config"
	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

func TestAdminHLSBackfillStatusAndRetry(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{
		db: db,
		cfg: config.Config{
			JWTSecret:   "admin-hls-test-secret-admin-hls-test",
			CookieName:  "antolex_session",
			SessionTTL:  time.Hour,
			AdminEmails: []string{"owner@example.com"},
			CORSOrigins: []string{"http://localhost:5173"},
		},
	}

	ownerID := insertAccessUser(t, db, "owner@example.com", models.AccessStatusActive, time.Now().UTC())
	listenerID := insertAccessUser(t, db, "listener@example.com", models.AccessStatusActive, time.Now().UTC())
	ownerToken := signAccessToken(t, srv, ownerID, "owner@example.com")
	listenerToken := signAccessToken(t, srv, listenerID, "listener@example.com")
	app := newApp(srv)

	readyTrackID := insertAdminHLSTrack(t, db, "ready-track", "Ready track", "ready")
	if _, err := db.Exec(ctx, `
		INSERT INTO track_playback_assets(
			track_id,object_key,init_offset,init_length,segments,
			duration_ms,target_duration,status
		) VALUES($1,$2,0,1,'[{"offset":1,"length":1,"duration_ms":1000}]',1000,1,'ready')
	`, readyTrackID, "playback/"+readyTrackID+"/cmaf/ready.mp4"); err != nil {
		t.Fatalf("insert ready HLS asset: %v", err)
	}
	// A historical terminal job must not make a track with a current asset look failed.
	if _, err := db.Exec(ctx, `
		INSERT INTO media_jobs(kind,track_id,status,attempts,error_message,finished_at)
		VALUES('prepare_hls',$1,'failed',$2,'old failure',NOW())
	`, readyTrackID, hlsPreparationMaxAttempts); err != nil {
		t.Fatalf("insert historical HLS failure: %v", err)
	}

	preparingTrackID := insertAdminHLSTrack(t, db, "preparing-track", "Preparing track", "ready")
	if _, err := db.Exec(ctx, `
		INSERT INTO media_jobs(kind,track_id,status,attempts)
		VALUES('prepare_hls',$1,'pending',2)
	`, preparingTrackID); err != nil {
		t.Fatalf("insert pending HLS job: %v", err)
	}

	failedTrackID := insertAdminHLSTrack(t, db, "failed-track", "Failed track", "ready")
	if _, err := db.Exec(ctx, `
		INSERT INTO media_jobs(kind,track_id,status,attempts,error_message,finished_at,updated_at)
		VALUES('prepare_hls',$1,'failed',$2,'HLS preparation stopped after 6 attempts: ffmpeg failed',NOW(),NOW())
	`, failedTrackID, hlsPreparationMaxAttempts); err != nil {
		t.Fatalf("insert terminal HLS job: %v", err)
	}

	insertAdminHLSTrack(t, db, "missing-track", "Missing track", "ready")
	insertAdminHLSTrack(t, db, "processing-track", "Processing track", "processing")

	status := requestAdminHLSBackfill(t, app, ownerToken)
	if status.Summary.ReadyTracks != 4 || status.Summary.HLSReady != 1 || status.Summary.Preparing != 1 || status.Summary.Failed != 1 || status.Summary.Missing != 1 || status.Summary.Complete {
		t.Fatalf("unexpected HLS summary: %+v", status.Summary)
	}
	if len(status.Failures) != 1 || status.Failures[0].TrackID != failedTrackID || status.Failures[0].Attempts != hlsPreparationMaxAttempts {
		t.Fatalf("unexpected HLS failures: %+v", status.Failures)
	}

	nonAdmin := httptest.NewRequest(http.MethodGet, "/api/v1/admin/hls-backfill", nil)
	nonAdmin.Header.Set("Authorization", "Bearer "+listenerToken)
	nonAdminResponse, err := app.Test(nonAdmin)
	if err != nil {
		t.Fatalf("non-admin HLS status: %v", err)
	}
	if nonAdminResponse.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin HLS status=%d; want 403", nonAdminResponse.StatusCode)
	}
	assertAccessError(t, nonAdminResponse, "admin_required")

	retryResponse := retryAdminHLSBackfillRequest(t, app, ownerToken, failedTrackID)
	if retryResponse.StatusCode != http.StatusAccepted {
		defer retryResponse.Body.Close()
		t.Fatalf("retry HLS status=%d; want 202", retryResponse.StatusCode)
	}
	if retryResponse.Header.Get(fiber.HeaderCacheControl) != "no-store" {
		t.Fatalf("retry HLS Cache-Control=%q; want no-store", retryResponse.Header.Get(fiber.HeaderCacheControl))
	}
	var retryPayload adminHLSRetryResponse
	if err := json.NewDecoder(retryResponse.Body).Decode(&retryPayload); err != nil {
		t.Fatalf("decode HLS retry: %v", err)
	}
	retryResponse.Body.Close()
	if retryPayload.TrackID != failedTrackID || retryPayload.Status != "pending" {
		t.Fatalf("unexpected HLS retry payload: %+v", retryPayload)
	}

	var activeJobs, attempts int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*),COALESCE(MIN(attempts),-1)
		FROM media_jobs
		WHERE track_id=$1 AND kind='prepare_hls' AND status IN ('pending','running')
	`, failedTrackID).Scan(&activeJobs, &attempts); err != nil {
		t.Fatalf("count active retry jobs: %v", err)
	}
	if activeJobs != 1 || attempts != 0 {
		t.Fatalf("active retry jobs=%d attempts=%d; want 1/0", activeJobs, attempts)
	}

	// Repeating Retry is idempotent and does not create a second active job.
	repeated := retryAdminHLSBackfillRequest(t, app, ownerToken, failedTrackID)
	if repeated.StatusCode != http.StatusAccepted {
		defer repeated.Body.Close()
		t.Fatalf("repeated retry HLS status=%d; want 202", repeated.StatusCode)
	}
	repeated.Body.Close()
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*) FROM media_jobs
		WHERE track_id=$1 AND kind='prepare_hls' AND status IN ('pending','running')
	`, failedTrackID).Scan(&activeJobs); err != nil {
		t.Fatalf("count repeated retry jobs: %v", err)
	}
	if activeJobs != 1 {
		t.Fatalf("active retry jobs after repeated Retry=%d; want 1", activeJobs)
	}

	status = requestAdminHLSBackfill(t, app, ownerToken)
	if status.Summary.Failed != 0 || status.Summary.Preparing != 2 || len(status.Failures) != 0 {
		t.Fatalf("stale terminal failure remained after Retry: %+v", status)
	}

	alreadyReady := retryAdminHLSBackfillRequest(t, app, ownerToken, readyTrackID)
	if alreadyReady.StatusCode != http.StatusConflict {
		defer alreadyReady.Body.Close()
		t.Fatalf("ready asset retry status=%d; want 409", alreadyReady.StatusCode)
	}
	assertAccessError(t, alreadyReady, "hls_asset_already_ready")

	invalid := retryAdminHLSBackfillRequest(t, app, ownerToken, "not-a-track-id")
	if invalid.StatusCode != http.StatusBadRequest {
		defer invalid.Body.Close()
		t.Fatalf("invalid HLS retry status=%d; want 400", invalid.StatusCode)
	}
	assertAccessError(t, invalid, "invalid_track_id")

	missing := retryAdminHLSBackfillRequest(t, app, ownerToken, uuid.NewString())
	if missing.StatusCode != http.StatusNotFound {
		defer missing.Body.Close()
		t.Fatalf("missing HLS retry status=%d; want 404", missing.StatusCode)
	}
	assertAccessError(t, missing, "hls_track_not_found")
}

func insertAdminHLSTrack(t *testing.T, db *pgxpool.Pool, externalID, title, status string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := db.Exec(context.Background(), `
		INSERT INTO library_tracks(
			id,external_track_id,title,artist,cover_url,object_key,
			content_type,size_bytes,status,playback_object_key
		) VALUES($1,$2,$3,'Test artist','',$4,'audio/mp4',1024,$5,$4)
	`, id, externalID, title, "playback/"+id+"/source.m4a", status); err != nil {
		t.Fatalf("insert HLS admin track %s: %v", externalID, err)
	}
	return id
}

func requestAdminHLSBackfill(t *testing.T, app *fiber.App, token string) adminHLSBackfillResponse {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/hls-backfill", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("get admin HLS backfill: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get admin HLS backfill status=%d; want 200", response.StatusCode)
	}
	if response.Header.Get(fiber.HeaderCacheControl) != "no-store" {
		t.Fatalf("admin HLS Cache-Control=%q; want no-store", response.Header.Get(fiber.HeaderCacheControl))
	}
	var payload adminHLSBackfillResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode admin HLS backfill: %v", err)
	}
	return payload
}

func retryAdminHLSBackfillRequest(t *testing.T, app *fiber.App, token, trackID string) *http.Response {
	t.Helper()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/admin/hls-backfill/"+trackID+"/retry",
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("retry admin HLS backfill: %v", err)
	}
	return response
}
