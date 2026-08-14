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
	"strconv"
	"strings"
	"sync"
	"testing"

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
	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

func TestConcurrentTrackSHA256Constraint(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	userID := uuid.NewString()
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,role,active) VALUES($1,$2,'','uploader',TRUE)`, userID, "duplicates@example.com"); err != nil {
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

func TestWorkerPublishesThenPermanentlyDeletesTrack(t *testing.T) {
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
	if got, ok := storage.get(playbackKey); !ok || len(got.body) == 0 || got.contentType != "audio/mp4" {
		t.Fatalf("playback object missing or invalid: exists=%v bytes=%d type=%q", ok, len(got.body), got.contentType)
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
	if storage.deleted(staleOriginalKey) != 1 || storage.deleted(playbackKey) != 1 {
		t.Fatalf("objects were not deleted exactly once: stale_original=%d playback=%d", storage.deleted(staleOriginalKey), storage.deleted(playbackKey))
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
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,role,active) VALUES($1,$2,'','uploader',TRUE)`, fixture.userID, email); err != nil {
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
		response.Header().Set("Content-Type", object.contentType)
		response.Header().Set("Content-Length", strconv.Itoa(len(object.body)))
		response.Header().Set("ETag", `"test-etag"`)
		response.WriteHeader(http.StatusOK)
	case http.MethodGet:
		object, ok := f.get(key)
		if !ok {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", object.contentType)
		response.Header().Set("Content-Length", strconv.Itoa(len(object.body)))
		response.Header().Set("ETag", `"test-etag"`)
		_, _ = response.Write(object.body)
	case http.MethodPut:
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
