package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"

	"github.com/alexeytozik/antolex-music/services/api/internal/config"
	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

func TestAuthRequestValidationUsesStableErrorCodes(t *testing.T) {
	t.Parallel()

	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })

	srv := &Server{
		cfg:   config.Config{AppEnv: "development", JWTSecret: "test-secret", AuthCodeTTL: time.Minute},
		redis: redisClient,
	}
	app := newAuthErrorTestApp(srv)

	tests := []struct {
		name, endpoint, body, code string
	}{
		{"malformed request", "/auth/request-code", `{`, "invalid_request_body"},
		{"invalid email", "/auth/request-code", `{"email":"not-an-email"}`, "invalid_email"},
		{"malformed verify request", "/auth/verify-code", `{`, "invalid_request_body"},
		{"invalid verify email", "/auth/verify-code", `{"email":"not-an-email","code":"123456"}`, "invalid_email"},
		{"incomplete code", "/auth/verify-code", `{"email":"person@example.com","code":"123"}`, "invalid_code_format"},
		{"non-numeric code", "/auth/verify-code", `{"email":"person@example.com","code":"abcdef"}`, "invalid_code_format"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performAuthErrorRequest(t, app, test.endpoint, test.body)
			defer response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("status=%d; want 400", response.StatusCode)
			}
			payload := decodeAuthError(t, response)
			if payload.Error.Code != test.code {
				t.Fatalf("code=%q; want %q", payload.Error.Code, test.code)
			}
		})
	}
}

func TestAuthCodeRateLimitIncludesRoundedRetryMetadata(t *testing.T) {
	t.Parallel()

	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })

	srv := &Server{
		cfg:   config.Config{AppEnv: "development", JWTSecret: "test-secret", AuthCodeTTL: time.Minute},
		redis: redisClient,
	}
	app := newAuthErrorTestApp(srv)
	body := `{"email":"person@example.com"}`

	first := performAuthErrorRequest(t, app, "/auth/request-code", body)
	first.Body.Close()
	if first.StatusCode != http.StatusNoContent {
		t.Fatalf("first status=%d; want 204", first.StatusCode)
	}
	cache.FastForward(500 * time.Millisecond)

	second := performAuthErrorRequest(t, app, "/auth/request-code", body)
	defer second.Body.Close()
	if second.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second status=%d; want 429", second.StatusCode)
	}
	payload := decodeAuthError(t, second)
	if payload.Error.Code != "code_rate_limited" {
		t.Fatalf("code=%q; want code_rate_limited", payload.Error.Code)
	}
	seconds, ok := payload.Error.Details["retry_after_seconds"].(float64)
	if !ok || seconds != 60 {
		t.Fatalf("retry_after_seconds=%v; want 60", payload.Error.Details["retry_after_seconds"])
	}
	if second.Header.Get(fiber.HeaderRetryAfter) != "60" {
		t.Fatalf("Retry-After=%q; want 60", second.Header.Get(fiber.HeaderRetryAfter))
	}
}

func TestInvalidOrExpiredCodeDoesNotEchoEmail(t *testing.T) {
	t.Parallel()

	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })

	srv := &Server{
		cfg:   config.Config{JWTSecret: "test-secret", AuthCodeTTL: time.Minute},
		redis: redisClient,
	}
	app := newAuthErrorTestApp(srv)
	response := performAuthErrorRequest(t, app, "/auth/verify-code", `{"email":"private@example.com","code":"123456"}`)
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d; want 401", response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if strings.Contains(string(body), "private@example.com") {
		t.Fatalf("response echoed the submitted email: %s", body)
	}
	var payload models.ErrorResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Error.Code != "invalid_code" {
		t.Fatalf("code=%q; want invalid_code", payload.Error.Code)
	}
}

func TestLockedAuthCodeExplainsWhenANewCodeCanBeRequested(t *testing.T) {
	t.Parallel()

	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })

	srv := &Server{
		cfg:   config.Config{JWTSecret: "test-secret", AuthCodeTTL: time.Minute},
		redis: redisClient,
	}
	app := newAuthErrorTestApp(srv)
	email := "person@example.com"
	if err := redisClient.Set(context.Background(), authCodeKey(email), srv.hashAuthCode(email, "123456"), time.Minute).Err(); err != nil {
		t.Fatalf("store auth code: %v", err)
	}
	if err := redisClient.Set(context.Background(), authCooldownKey(email), "1", 37*time.Second).Err(); err != nil {
		t.Fatalf("store cooldown: %v", err)
	}

	for attempt := 1; attempt <= 5; attempt++ {
		response := performAuthErrorRequest(t, app, "/auth/verify-code", `{"email":"person@example.com","code":"654321"}`)
		if attempt < 5 {
			if response.StatusCode != http.StatusUnauthorized {
				response.Body.Close()
				t.Fatalf("attempt %d status=%d; want 401", attempt, response.StatusCode)
			}
			response.Body.Close()
			continue
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("attempt %d status=%d; want 429", attempt, response.StatusCode)
		}
		payload := decodeAuthError(t, response)
		if payload.Error.Code != "too_many_code_attempts" {
			t.Fatalf("code=%q; want too_many_code_attempts", payload.Error.Code)
		}
		if payload.Error.Details["request_new_code"] != true {
			t.Fatalf("request_new_code=%v; want true", payload.Error.Details["request_new_code"])
		}
		if payload.Error.Details["retry_after_seconds"] != float64(37) {
			t.Fatalf("retry_after_seconds=%v; want 37", payload.Error.Details["retry_after_seconds"])
		}
		if response.Header.Get(fiber.HeaderRetryAfter) != "37" {
			t.Fatalf("Retry-After=%q; want 37", response.Header.Get(fiber.HeaderRetryAfter))
		}
	}
}

func newAuthErrorTestApp(srv *Server) *fiber.App {
	app := fiber.New(fiber.Config{ErrorHandler: handleFiberError})
	app.Post("/auth/request-code", srv.requestCode)
	app.Post("/auth/verify-code", srv.verifyCode)
	return app
}

func performAuthErrorRequest(t *testing.T, app *fiber.App, endpoint, body string) *http.Response {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, endpoint, strings.NewReader(body))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("request %s: %v", endpoint, err)
	}
	return response
}

func decodeAuthError(t *testing.T, response *http.Response) models.ErrorResponse {
	t.Helper()
	var payload models.ErrorResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	return payload
}
