package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"

	"github.com/tozikron/tozikron-music/services/api/internal/config"
	"github.com/tozikron/tozikron-music/services/api/internal/models"
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

	app := newApp(srv)

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

	app := newApp(srv)

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

	app := newApp(srv)

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
		ExternalID: "track-123",
		Title:      "Alpha Song",
		Artist:     "Zed Artist",
	}

	encoded := encodeTrackCursor(track)
	if encoded == "" {
		t.Fatalf("expected non-empty cursor")
	}

	decoded, err := decodeTrackCursor(encoded)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}

	if decoded.TitleKey != "alpha song" {
		t.Fatalf("unexpected title key: %q", decoded.TitleKey)
	}
	if decoded.ArtistKey != "zed artist" {
		t.Fatalf("unexpected artist key: %q", decoded.ArtistKey)
	}
	if decoded.ExternalID != "track-123" {
		t.Fatalf("unexpected external id: %q", decoded.ExternalID)
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
