package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	aws "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"

	"github.com/alexeytozik/antolex-music/services/api/internal/config"
	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

func TestSearchCachesResults(t *testing.T) {
	t.Parallel()

	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer redisClient.Close()

	srv := &Server{
		cfg: config.Config{
			CORSOrigins: []string{"http://localhost:5173"},
		},
		redis: redisClient,
	}

	app := fiber.New(fiber.Config{ErrorHandler: handleFiberError})
	app.Get("/api/v1/search", srv.search)

	first := performJSONRequest[models.SearchResponse](t, app, http.MethodGet, "/api/v1/search?q=lofi&page=1")
	second := performJSONRequest[models.SearchResponse](t, app, http.MethodGet, "/api/v1/search?q=lofi&page=1")

	if first.Cached {
		t.Fatalf("expected first search response to be uncached")
	}
	if !second.Cached {
		t.Fatalf("expected second search response to be cached")
	}
	if first.Source != "library" || second.Source != "library" {
		t.Fatalf("expected library source, got %q and %q", first.Source, second.Source)
	}
	if first.Page != 1 || first.PageSize != searchResultLimit {
		t.Fatalf("unexpected pagination in first response: page=%d page_size=%d", first.Page, first.PageSize)
	}
	if first.TotalCount != 0 || first.TotalPages != 0 || len(first.Results) != 0 {
		t.Fatalf("expected empty cached search response, got %+v", first)
	}
}

func TestSearchCacheDoesNotCollideWithLiteralAllQuery(t *testing.T) {
	t.Parallel()

	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer redisClient.Close()

	srv := &Server{
		cfg: config.Config{
			CORSOrigins: []string{"http://localhost:5173"},
		},
		redis: redisClient,
	}

	app := fiber.New(fiber.Config{ErrorHandler: handleFiberError})
	app.Get("/api/v1/search", srv.search)

	empty := performJSONRequest[models.SearchResponse](t, app, http.MethodGet, "/api/v1/search?page=1")
	literal := performJSONRequest[models.SearchResponse](t, app, http.MethodGet, "/api/v1/search?q=__all__&page=1")
	literalCached := performJSONRequest[models.SearchResponse](t, app, http.MethodGet, "/api/v1/search?q=__all__&page=1")

	if empty.Query != "" || empty.Cached {
		t.Fatalf("unexpected empty-query response: %+v", empty)
	}
	if literal.Query != "__all__" || literal.Cached {
		t.Fatalf("literal query collided with the empty-query cache entry: %+v", literal)
	}
	if literalCached.Query != "__all__" || !literalCached.Cached {
		t.Fatalf("literal query did not use its own cache entry: %+v", literalCached)
	}
}

func TestResolveTrackReturnsStorageUnavailableWithoutR2(t *testing.T) {
	t.Parallel()

	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer redisClient.Close()

	srv := &Server{
		cfg: config.Config{
			CORSOrigins: []string{"http://localhost:5173"},
		},
		redis: redisClient,
	}

	app := fiber.New(fiber.Config{ErrorHandler: handleFiberError})
	app.Get("/api/v1/tracks/:externalID/stream", srv.resolveTrack)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/tracks/track-missing-stream/stream", nil)
	res, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected status %d, got %d", http.StatusServiceUnavailable, res.StatusCode)
	}

	var payload models.ErrorResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("decode error response: %v", err)
	}

	if payload.Error.Code != "storage_unavailable" {
		t.Fatalf("expected storage_unavailable, got %s", payload.Error.Code)
	}
}

func TestResolveTrackReturnsTrackNotFoundWithoutLocalMatch(t *testing.T) {
	t.Parallel()

	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer redisClient.Close()

	srv := &Server{
		cfg: config.Config{
			CORSOrigins: []string{"http://localhost:5173"},
		},
		redis:       redisClient,
		seedCatalog: &seedCatalog{},
	}

	app := fiber.New(fiber.Config{ErrorHandler: handleFiberError})
	app.Get("/api/v1/tracks/:externalID/stream", srv.resolveTrack)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/tracks/unknown-track/stream", nil)
	res, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, res.StatusCode)
	}

	var payload models.ErrorResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("decode error response: %v", err)
	}

	if payload.Error.Code != "track_not_found" {
		t.Fatalf("expected track_not_found, got %s", payload.Error.Code)
	}
}

func TestTrackCursorRoundTrip(t *testing.T) {
	t.Parallel()

	track := models.Track{
		ID:         "8dba09c5-38f4-4783-8b8a-16a20c49bd0e",
		ExternalID: "track-123",
		Title:      "Alpha Song",
		Artist:     "Zed Artist",
		CreatedAt:  time.Date(2026, 8, 11, 12, 30, 0, 0, time.UTC),
	}

	encoded := encodeTrackCursor(track)
	if encoded == "" {
		t.Fatalf("expected non-empty cursor")
	}

	decoded, err := decodeTrackCursor(encoded)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}

	if decoded.ID != track.ID {
		t.Fatalf("unexpected id: %q", decoded.ID)
	}
	if !decoded.Timestamp.Equal(track.CreatedAt) {
		t.Fatalf("unexpected timestamp: %s", decoded.Timestamp)
	}
}

func TestSearchCursorRoundTrip(t *testing.T) {
	t.Parallel()

	item := rankedTrack{
		Track: models.Track{
			ID:        "8dba09c5-38f4-4783-8b8a-16a20c49bd0e",
			CreatedAt: time.Date(2026, 8, 11, 12, 30, 0, 123000, time.UTC),
		},
		Tier:  5,
		Score: 0.625,
	}
	fingerprint := searchQueryFingerprint("rammstein reise")
	encoded := encodeSearchCursor(item, searchModePrimary, fingerprint)
	if encoded == "" {
		t.Fatal("expected non-empty search cursor")
	}

	decoded, err := decodeSearchCursor(encoded)
	if err != nil {
		t.Fatalf("decode search cursor: %v", err)
	}
	if decoded.Version != searchCursorVersion || decoded.Mode != searchModePrimary {
		t.Fatalf("unexpected version/mode: %+v", decoded)
	}
	if decoded.Tier != item.Tier || decoded.Score != item.Score {
		t.Fatalf("unexpected rank: %+v", decoded)
	}
	if decoded.ID != item.Track.ID || !decoded.Timestamp.Equal(item.Track.CreatedAt) {
		t.Fatalf("unexpected track position: %+v", decoded)
	}
	if decoded.QueryFingerprint != fingerprint {
		t.Fatalf("unexpected query fingerprint: %q", decoded.QueryFingerprint)
	}
}

func TestSearchCursorRejectsLegacyTrackCursor(t *testing.T) {
	t.Parallel()

	legacy := encodeTrackCursor(models.Track{
		ID:        "8dba09c5-38f4-4783-8b8a-16a20c49bd0e",
		CreatedAt: time.Date(2026, 8, 11, 12, 30, 0, 0, time.UTC),
	}, 42)
	if _, err := decodeSearchCursor(legacy); err == nil {
		t.Fatal("expected legacy cursor to be rejected")
	}
}

func TestFuzzySearchEligibilityUsesCharactersNotBytes(t *testing.T) {
	t.Parallel()

	for query, want := range map[string]bool{
		"ab":    false,
		"аб":    false,
		"abc":   true,
		"а б в": true,
	} {
		if got := fuzzySearchEligible(query); got != want {
			t.Errorf("fuzzySearchEligible(%q)=%v; want %v", query, got, want)
		}
	}
}

func TestCatalogRequiresSession(t *testing.T) {
	t.Parallel()
	app := newApp(&Server{cfg: config.Config{CORSOrigins: []string{"http://localhost:5173"}, CookieName: "antolex_session"}})
	for _, target := range []string{"/api/v1/search", "/api/v1/shuffle", "/api/v1/tracks/example/cover", "/api/v1/tracks/example/stream"} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		res, err := app.Test(req)
		if err != nil {
			t.Fatalf("request %s failed: %v", target, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected %s to require auth, got %d", target, res.StatusCode)
		}
	}
}

func TestRemovedManagementRoutesStayHiddenAndAdminRoutesRequireOwner(t *testing.T) {
	t.Parallel()

	user := models.User{
		ID:     "31b86bb0-9ee4-4d65-8b98-a1c9c6aaf429",
		Email:  "user@example.com",
		Active: true,
	}
	srv := &Server{
		cfg: config.Config{
			JWTSecret:   "test-secret-test-secret-test-secret",
			SessionTTL:  time.Hour,
			CORSOrigins: []string{"http://localhost:5173"},
		},
		authUserResolver: func(context.Context, string, string) (models.User, error) {
			return user, nil
		},
	}
	token, _, err := srv.signToken(user.ID, user.Email)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	app := newApp(srv)

	for _, route := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/tracks/errors"},
		{method: http.MethodPatch, path: "/api/v1/tracks/example"},
		{method: http.MethodDelete, path: "/api/v1/tracks/example"},
		{method: http.MethodGet, path: "/api/v1/access/users"},
		{method: http.MethodPatch, path: "/api/v1/access/users"},
	} {
		req := httptest.NewRequest(route.method, route.path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, requestErr := app.Test(req)
		if requestErr != nil {
			t.Fatalf("%s %s failed: %v", route.method, route.path, requestErr)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s %s status = %d; want 404", route.method, route.path, res.StatusCode)
		}
	}

	for _, route := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/admin/users"},
		{method: http.MethodPatch, path: "/api/v1/admin/users/31b86bb0-9ee4-4d65-8b98-a1c9c6aaf429"},
	} {
		req := httptest.NewRequest(route.method, route.path, strings.NewReader(`{"status":"active"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		res, requestErr := app.Test(req)
		if requestErr != nil {
			t.Fatalf("%s %s failed: %v", route.method, route.path, requestErr)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s status = %d; want 403", route.method, route.path, res.StatusCode)
		}
	}
}

func TestCreateUploadRejectsFileAbove50MiB(t *testing.T) {
	t.Parallel()

	srv := &Server{seedCatalog: &seedCatalog{}}
	app := fiber.New(fiber.Config{ErrorHandler: handleFiberError})
	app.Post("/api/v1/me/uploads", srv.createUpload)

	body := fmt.Sprintf(`{
		"file_name":"too-large.flac",
		"content_type":"audio/flac",
		"size_bytes":%d,
		"sha256":"%s"
	}`, maxUploadSize+1, strings.Repeat("a", 64))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/me/uploads", strings.NewReader(body))
	req.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	res, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, res.StatusCode)
	}
	var payload models.ErrorResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if payload.Error.Code != "invalid_file_size" {
		t.Fatalf("expected invalid_file_size, got %q", payload.Error.Code)
	}
	if got := int64(payload.Error.Details["max_size_bytes"].(float64)); got != maxUploadSize {
		t.Fatalf("max_size_bytes=%d; want %d", got, maxUploadSize)
	}
}

func TestUploadSizeBoundaryIs50MiB(t *testing.T) {
	t.Parallel()

	if !validUploadSize(50 * 1024 * 1024) {
		t.Fatalf("expected exactly 50 MiB to be accepted")
	}
	if validUploadSize(50*1024*1024 + 1) {
		t.Fatalf("expected a file one byte above 50 MiB to be rejected")
	}
}

func TestValidateCompletedParts(t *testing.T) {
	t.Parallel()
	parts := []uploadedPart{{PartNumber: 2, ETag: `"two"`}, {PartNumber: 1, ETag: `"one"`}}
	if err := validateCompletedParts(parts, 2); err != nil {
		t.Fatalf("expected complete parts to pass: %v", err)
	}
	if parts[0].PartNumber != 1 {
		t.Fatalf("expected parts to be ordered")
	}
	if err := validateCompletedParts(parts[:1], 2); err == nil {
		t.Fatalf("expected incomplete parts to fail")
	}
}

func TestExpectedUploadPartBytes(t *testing.T) {
	t.Parallel()
	const partSize = int64(8 * 1024 * 1024)
	tests := []struct {
		total int64
		part  int
		want  int64
	}{
		{total: partSize, part: 1, want: partSize},
		{total: partSize + 123, part: 1, want: partSize},
		{total: partSize + 123, part: 2, want: 123},
		{total: 1, part: 1, want: 1},
	}
	for _, test := range tests {
		got, err := expectedUploadPartBytes(test.total, partSize, test.part)
		if err != nil || got != test.want {
			t.Fatalf("total=%d part=%d: got %d, %v; want %d", test.total, test.part, got, err, test.want)
		}
	}
	for _, invalid := range []struct {
		total int64
		part  int
	}{{0, 1}, {partSize, 0}, {partSize, 2}} {
		if _, err := expectedUploadPartBytes(invalid.total, partSize, invalid.part); err == nil {
			t.Fatalf("expected total=%d part=%d to fail", invalid.total, invalid.part)
		}
	}
}

func TestPresignedUploadPartBindsContentLength(t *testing.T) {
	t.Parallel()
	client := s3.NewFromConfig(aws.Config{
		Region:      "auto",
		Credentials: aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider("test-key", "test-secret", "")),
	}, func(options *s3.Options) {
		options.BaseEndpoint = aws.String("https://r2.example.test")
		options.UsePathStyle = true
	})
	catalog := &seedCatalog{bucket: "music", client: client, presigner: s3.NewPresignClient(client)}
	signed, _, err := catalog.PresignUploadPart(context.Background(), "incoming/id/file.mp3", "upload-id", 1, 12345)
	if err != nil {
		t.Fatalf("presign upload part: %v", err)
	}
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatalf("parse signed URL: %v", err)
	}
	if !strings.Contains(parsed.Query().Get("X-Amz-SignedHeaders"), "content-length") {
		t.Fatalf("content-length is not bound in signed headers: %s", parsed.Query().Get("X-Amz-SignedHeaders"))
	}
}

func TestUploadCleanupObjectKeysAreCompleteAndUnique(t *testing.T) {
	t.Parallel()
	upload := uploadResponse{
		ObjectKey: "incoming/id/original.mp3", OriginalKey: "originals/id/track.mp3",
		PlaybackKey: "playback/id.m4a", CoverKey: "covers/id.jpg",
		LegacyKey: "incoming/id/original.mp3",
	}
	got := uploadCleanupObjectKeys(upload)
	want := []string{"incoming/id/original.mp3", "originals/id/track.mp3", "playback/id.m4a", "covers/id.jpg"}
	if len(got) != len(want) {
		t.Fatalf("cleanup keys = %v; want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("cleanup keys = %v; want %v", got, want)
		}
	}
}

func TestCurrentAndLegacyJWTSecrets(t *testing.T) {
	t.Parallel()
	srv := &Server{cfg: config.Config{JWTSecret: "current-secret", LegacyJWTSecret: "legacy-secret"}}
	sign := func(secret string) string {
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub": "user-id", "email": "user@example.com", "exp": time.Now().Add(time.Hour).Unix(),
		})
		signed, err := token.SignedString([]byte(secret))
		if err != nil {
			t.Fatalf("sign token: %v", err)
		}
		return signed
	}
	if _, err := srv.parseSessionClaims(sign("current-secret"), false); err != nil {
		t.Fatalf("current cookie token rejected: %v", err)
	}
	legacy := sign("legacy-secret")
	if _, err := srv.parseSessionClaims(legacy, false); err == nil {
		t.Fatalf("legacy token must not be accepted from cookie")
	}
	if _, err := srv.parseSessionClaims(legacy, true); err != nil {
		t.Fatalf("legacy bearer token rejected: %v", err)
	}
}

func TestLegacyBearerOnlyWorksOnExchange(t *testing.T) {
	t.Parallel()
	user := models.User{ID: "31b86bb0-9ee4-4d65-8b98-a1c9c6aaf429", Email: "user@example.com", Active: true}
	srv := &Server{
		cfg: config.Config{
			JWTSecret: "current-secret-current-secret-123", LegacyJWTSecret: "legacy-secret",
			CookieName: "antolex_session", SessionTTL: time.Hour,
			CORSOrigins: []string{"http://localhost:5173"},
		},
		authUserResolver: func(context.Context, string, string) (models.User, error) { return user, nil },
	}
	legacyToken := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": user.ID, "email": user.Email, "exp": time.Now().Add(time.Hour).Unix(),
	})
	signed, err := legacyToken.SignedString([]byte(srv.cfg.LegacyJWTSecret))
	if err != nil {
		t.Fatalf("sign legacy token: %v", err)
	}
	app := newApp(srv)

	exchange := httptest.NewRequest(http.MethodPost, "/api/v1/auth/exchange", nil)
	exchange.Header.Set("Authorization", "Bearer "+signed)
	exchangeResponse, err := app.Test(exchange)
	if err != nil {
		t.Fatalf("exchange request: %v", err)
	}
	exchangeResponse.Body.Close()
	if exchangeResponse.StatusCode != http.StatusOK {
		t.Fatalf("legacy exchange status = %d; want 200", exchangeResponse.StatusCode)
	}
	if exchangeResponse.Header.Get("Set-Cookie") == "" {
		t.Fatalf("legacy exchange did not issue current cookie")
	}

	me := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	me.Header.Set("Authorization", "Bearer "+signed)
	meResponse, err := app.Test(me)
	if err != nil {
		t.Fatalf("me request: %v", err)
	}
	meResponse.Body.Close()
	if meResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("legacy bearer /me status = %d; want 401", meResponse.StatusCode)
	}
}

func TestLegacyCoverResolutionPreservesNewKeys(t *testing.T) {
	t.Parallel()
	legacyObject := "library/Redrum - Murad.m4a"
	legacyWant := "library/covers/2bc7e574f4b49f61.jpg"
	if got := resolveCoverObjectKey("", legacyObject); got != legacyWant {
		t.Fatalf("legacy cover key = %q; want %q", got, legacyWant)
	}
	newKey := "covers/31b86bb0-9ee4-4d65-8b98-a1c9c6aaf429.jpg"
	if got := resolveCoverObjectKey(newKey, "playback/track.m4a"); got != newKey {
		t.Fatalf("new cover key changed to %q", got)
	}
	if got := resolveCoverObjectKey("", "playback/track.m4a"); got != "" {
		t.Fatalf("new track without artwork got legacy fallback %q", got)
	}
}

func TestFallbackCoverUsesAntolexWaveform(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	app.Get("/cover.svg", writeFallbackCoverSVG)
	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/cover.svg", nil))
	if err != nil {
		t.Fatalf("fallback request: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read fallback: %v", err)
	}
	text := string(body)
	if !strings.Contains(text, "ANTOLEX Music cover placeholder") || !strings.Contains(text, "Abstract mint waveform") {
		t.Fatalf("fallback is not the branded waveform SVG")
	}
	if strings.Contains(text, "coverNoteGradient") {
		t.Fatalf("legacy note artwork is still present")
	}
}

func TestAuthCodeIsConsumedExactlyOnceConcurrently(t *testing.T) {
	t.Parallel()
	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer redisClient.Close()
	srv := &Server{cfg: config.Config{JWTSecret: "test-secret", AuthCodeTTL: time.Minute}, redis: redisClient}
	email := "user@example.com"
	hash := srv.hashAuthCode(email, "123456")
	if err := redisClient.Set(context.Background(), authCodeKey(email), hash, time.Minute).Err(); err != nil {
		t.Fatalf("store code: %v", err)
	}

	const workers = 20
	start := make(chan struct{})
	results := make(chan authCodeCheckResult, workers)
	errorsCh := make(chan error, workers)
	var group sync.WaitGroup
	for range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			result, err := srv.consumeAuthCode(context.Background(), email, hash)
			results <- result
			errorsCh <- err
		}()
	}
	close(start)
	group.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatalf("consume code: %v", err)
		}
	}
	consumed := 0
	for result := range results {
		if result == authCodeConsumed {
			consumed++
		}
	}
	if consumed != 1 {
		t.Fatalf("code consumed %d times; want exactly 1", consumed)
	}
}

func TestAuthCodeLocksAtomicallyOnFifthMismatch(t *testing.T) {
	t.Parallel()
	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer redisClient.Close()
	srv := &Server{cfg: config.Config{AuthCodeTTL: time.Minute}, redis: redisClient}
	email := "user@example.com"
	if err := redisClient.Set(context.Background(), authCodeKey(email), "correct", time.Minute).Err(); err != nil {
		t.Fatalf("store code: %v", err)
	}
	for attempt := 1; attempt <= 5; attempt++ {
		result, err := srv.consumeAuthCode(context.Background(), email, "wrong")
		if err != nil {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
		want := authCodeMismatch
		if attempt == 5 {
			want = authCodeLocked
		}
		if result != want {
			t.Fatalf("attempt %d result=%d; want %d", attempt, result, want)
		}
	}
	if redisClient.Exists(context.Background(), authCodeKey(email)).Val() != 0 {
		t.Fatalf("code still exists after fifth mismatch")
	}
}

func TestRequestCodeAcceptsUnregisteredEmail(t *testing.T) {
	t.Parallel()
	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer redisClient.Close()

	srv := &Server{
		cfg: config.Config{
			AppEnv:      "development",
			JWTSecret:   "test-secret",
			AuthCodeTTL: time.Minute,
		},
		redis: redisClient,
	}
	app := fiber.New()
	app.Post("/auth/request-code", srv.requestCode)
	req := httptest.NewRequest(http.MethodPost, "/auth/request-code", strings.NewReader(`{"email":"New.User@Example.com"}`))
	req.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(req)
	if err != nil {
		t.Fatalf("request code: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusNoContent {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if redisClient.Exists(context.Background(), authCodeKey("new.user@example.com")).Val() != 1 {
		t.Fatalf("verification code was not stored for the unregistered email")
	}
}

func TestSupportedAudioUploadUsesAllowlistedExtensions(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"track.mp3", "track.m4a", "track.aac", "track.flac", "track.ogg", "track.wav"} {
		if !isSupportedAudioUpload(name, "") {
			t.Fatalf("expected %s to be supported", name)
		}
	}
	if isSupportedAudioUpload("malware.exe", "audio/mpeg") {
		t.Fatalf("content type alone must not bypass the extension allowlist")
	}
}

func TestParseSMTPFrom(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input, envelope, header string
	}{
		{"music@example.com", "music@example.com", `"ANTOLEX Music" <music@example.com>`},
		{"ANTOLEX Music <music@example.com>", "music@example.com", `"ANTOLEX Music" <music@example.com>`},
		{"Sender <music@example.com>", "music@example.com", `"Sender" <music@example.com>`},
	}
	for _, test := range tests {
		envelope, header, err := parseSMTPFrom(test.input)
		if err != nil {
			t.Fatalf("parse %q: %v", test.input, err)
		}
		if envelope != test.envelope || header != test.header {
			t.Fatalf("parse %q = envelope %q header %q", test.input, envelope, header)
		}
	}
	if _, _, err := parseSMTPFrom("not an address"); err == nil {
		t.Fatalf("expected invalid SMTP_FROM to fail")
	}
}

func TestNoSuchUploadClassification(t *testing.T) {
	t.Parallel()
	missing := &smithy.GenericAPIError{Code: "NoSuchUpload", Message: "gone"}
	if !isNoSuchUploadError(fmt.Errorf("wrapped: %w", missing)) {
		t.Fatalf("expected wrapped NoSuchUpload to be classified")
	}
	if isNoSuchUploadError(errors.New("network failure")) {
		t.Fatalf("network errors must not be treated as successful aborts")
	}
}

func performJSONRequest[T any](t *testing.T, app *fiber.App, method string, path string) T {
	t.Helper()

	req := httptest.NewRequest(method, path, nil)
	res, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()

	var payload T
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}

	return payload
}
