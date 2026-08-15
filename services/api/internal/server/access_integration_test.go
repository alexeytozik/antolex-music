package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/alexeytozik/antolex-music/services/api/internal/config"
	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

func TestVerifyCodeRequiresOwnerApprovalAndPreservesBlockedAccess(t *testing.T) {
	db := newLifecycleTestDB(t)
	cache := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })

	srv := &Server{
		db:    db,
		redis: redisClient,
		cfg: config.Config{
			JWTSecret:    "access-test-secret-access-test-secret",
			CookieName:   "antolex_session",
			SessionTTL:   time.Hour,
			AuthCodeTTL:  10 * time.Minute,
			AdminEmails:  []string{"owner@example.com"},
			CORSOrigins:  []string{"http://localhost:5173"},
			CookieSecure: false,
		},
	}
	app := newApp(srv)

	pendingResponse := verifyAccessCode(t, app, srv, "new@example.com", "123456")
	if pendingResponse.StatusCode != http.StatusForbidden {
		t.Fatalf("pending verify status=%d; want 403", pendingResponse.StatusCode)
	}
	if pendingResponse.Header.Get("Set-Cookie") != "" {
		t.Fatalf("pending verification issued a session cookie: %s", pendingResponse.Header.Get("Set-Cookie"))
	}
	assertAccessError(t, pendingResponse, "access_pending")
	assertStoredAccess(t, db, "new@example.com", models.AccessStatusPending, false)

	if _, err := db.Exec(context.Background(), `
		UPDATE users SET access_status='active',active=TRUE WHERE email='new@example.com'
	`); err != nil {
		t.Fatalf("approve pending user: %v", err)
	}
	approvedResponse := verifyAccessCode(t, app, srv, "new@example.com", "234567")
	if approvedResponse.StatusCode != http.StatusOK {
		t.Fatalf("approved verify status=%d; want 200", approvedResponse.StatusCode)
	}
	if !strings.Contains(approvedResponse.Header.Get("Set-Cookie"), srv.cfg.CookieName+"=") {
		t.Fatalf("approved verification did not issue a session: %s", approvedResponse.Header.Get("Set-Cookie"))
	}
	approvedResponse.Body.Close()

	blockedID := insertAccessUser(t, db, "blocked@example.com", models.AccessStatusBlocked, time.Now().UTC())
	blockedResponse := verifyAccessCode(t, app, srv, "blocked@example.com", "345678")
	if blockedResponse.StatusCode != http.StatusForbidden {
		t.Fatalf("blocked verify status=%d; want 403", blockedResponse.StatusCode)
	}
	if blockedResponse.Header.Get("Set-Cookie") != "" {
		t.Fatalf("blocked verification issued a session cookie: %s", blockedResponse.Header.Get("Set-Cookie"))
	}
	assertAccessError(t, blockedResponse, "access_blocked")
	assertStoredAccess(t, db, "blocked@example.com", models.AccessStatusBlocked, false)
	_ = blockedID

	ownerResponse := verifyAccessCode(t, app, srv, "OWNER@example.com", "456789")
	if ownerResponse.StatusCode != http.StatusOK {
		t.Fatalf("owner verify status=%d; want 200", ownerResponse.StatusCode)
	}
	defer ownerResponse.Body.Close()
	var ownerSession authResponse
	if err := json.NewDecoder(ownerResponse.Body).Decode(&ownerSession); err != nil {
		t.Fatalf("decode owner session: %v", err)
	}
	if !ownerSession.User.IsAdmin || ownerSession.User.AccessStatus != models.AccessStatusActive {
		t.Fatalf("unexpected owner session: %+v", ownerSession.User)
	}
}

func TestAdminUsersPaginationUpdatesAndImmediateBlocking(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	baseTime := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	srv := &Server{
		db: db,
		cfg: config.Config{
			JWTSecret:   "admin-test-secret-admin-test-secret",
			CookieName:  "antolex_session",
			SessionTTL:  time.Hour,
			AdminEmails: []string{"owner@example.com"},
			CORSOrigins: []string{"http://localhost:5173"},
		},
	}

	ownerID := insertAccessUser(t, db, "owner@example.com", models.AccessStatusActive, baseTime.Add(-4*time.Minute))
	pendingID := insertAccessUser(t, db, "pending@example.com", models.AccessStatusPending, baseTime.Add(-3*time.Minute))
	activeID := insertAccessUser(t, db, "active@example.com", models.AccessStatusActive, baseTime.Add(-2*time.Minute))
	insertAccessUser(t, db, "blocked@example.com", models.AccessStatusBlocked, baseTime.Add(-time.Minute))

	ownerToken := signAccessToken(t, srv, ownerID, "owner@example.com")
	activeToken := signAccessToken(t, srv, activeID, "active@example.com")
	app := newApp(srv)

	first := requestAdminUsers(t, app, ownerToken, "/api/v1/admin/users?limit=2")
	if len(first.Results) != 2 || first.NextCursor == "" {
		t.Fatalf("unexpected first users page: %+v", first)
	}
	second := requestAdminUsers(t, app, ownerToken, "/api/v1/admin/users?limit=2&cursor="+first.NextCursor)
	if len(second.Results) != 2 || second.NextCursor != "" {
		t.Fatalf("unexpected second users page: %+v", second)
	}
	seen := make(map[string]models.AdminUser, 4)
	for _, user := range append(first.Results, second.Results...) {
		if _, exists := seen[user.ID]; exists {
			t.Fatalf("user %s repeated across cursor pages", user.ID)
		}
		seen[user.ID] = user
	}
	if len(seen) != 4 || !seen[ownerID].IsAdmin || seen[ownerID].AccessStatus != models.AccessStatusActive {
		t.Fatalf("unexpected paginated users: %+v", seen)
	}
	invalidCursorRequest := httptest.NewRequest(http.MethodGet, "/api/v1/admin/users?cursor=not-a-cursor", nil)
	invalidCursorRequest.Header.Set("Authorization", "Bearer "+ownerToken)
	invalidCursorResponse, err := app.Test(invalidCursorRequest)
	if err != nil {
		t.Fatalf("invalid cursor request: %v", err)
	}
	if invalidCursorResponse.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid cursor status=%d; want 400", invalidCursorResponse.StatusCode)
	}
	assertAccessError(t, invalidCursorResponse, "invalid_cursor")

	updated := patchAdminUser(t, app, ownerToken, pendingID, models.AccessStatusActive, http.StatusOK)
	if updated.AccessStatus != models.AccessStatusActive || updated.IsAdmin {
		t.Fatalf("unexpected approved user: %+v", updated)
	}
	assertStoredAccess(t, db, "pending@example.com", models.AccessStatusActive, true)
	invalidStatusResponse := patchAdminUserResponse(t, app, ownerToken, pendingID, models.AccessStatusPending)
	if invalidStatusResponse.StatusCode != http.StatusBadRequest {
		t.Fatalf("pending patch status=%d; want 400", invalidStatusResponse.StatusCode)
	}
	assertAccessError(t, invalidStatusResponse, "invalid_access_status")

	protectedResponse := patchAdminUserResponse(t, app, ownerToken, ownerID, models.AccessStatusBlocked)
	if protectedResponse.StatusCode != http.StatusConflict {
		t.Fatalf("block owner status=%d; want 409", protectedResponse.StatusCode)
	}
	assertAccessError(t, protectedResponse, "admin_protected")
	assertStoredAccess(t, db, "owner@example.com", models.AccessStatusActive, true)

	blocked := patchAdminUser(t, app, ownerToken, activeID, models.AccessStatusBlocked, http.StatusOK)
	if blocked.AccessStatus != models.AccessStatusBlocked {
		t.Fatalf("unexpected blocked user response: %+v", blocked)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	request.Header.Set("Authorization", "Bearer "+activeToken)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("request with blocked session: %v", err)
	}
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("blocked session status=%d; want 403", response.StatusCode)
	}
	clearedCookie := response.Header.Get("Set-Cookie")
	if !strings.Contains(clearedCookie, srv.cfg.CookieName+"=;") || !strings.Contains(strings.ToLower(clearedCookie), "expires=thu, 01 jan 1970") {
		t.Fatalf("blocked session cookie was not cleared: %s", response.Header.Get("Set-Cookie"))
	}
	assertAccessError(t, response, "access_blocked")

	nonAdminRequest := httptest.NewRequest(http.MethodGet, "/api/v1/admin/users", nil)
	nonAdminRequest.Header.Set("Authorization", "Bearer "+signAccessToken(t, srv, pendingID, "pending@example.com"))
	nonAdminResponse, err := app.Test(nonAdminRequest)
	if err != nil {
		t.Fatalf("non-admin users request: %v", err)
	}
	if nonAdminResponse.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin users status=%d; want 403", nonAdminResponse.StatusCode)
	}
	assertAccessError(t, nonAdminResponse, "admin_required")

	if _, err := db.Exec(ctx, `UPDATE users SET access_status='blocked',active=FALSE WHERE id=$1`, ownerID); err != nil {
		t.Fatalf("force owner blocked state: %v", err)
	}
	if err := srv.activateConfiguredAdmins(ctx); err != nil {
		t.Fatalf("activate configured admins: %v", err)
	}
	assertStoredAccess(t, db, "owner@example.com", models.AccessStatusActive, true)
}

func verifyAccessCode(t *testing.T, app *fiber.App, srv *Server, email, code string) *http.Response {
	t.Helper()
	if err := srv.redis.Set(context.Background(), authCodeKey(email), srv.hashAuthCode(email, code), 10*time.Minute).Err(); err != nil {
		t.Fatalf("store auth code: %v", err)
	}
	body := fmt.Sprintf(`{"email":%q,"code":%q}`, email, code)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify-code", strings.NewReader(body))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("verify %s: %v", email, err)
	}
	return response
}

func assertAccessError(t *testing.T, response *http.Response, code string) {
	t.Helper()
	defer response.Body.Close()
	var payload models.ErrorResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode access error: %v", err)
	}
	if payload.Error.Code != code {
		t.Fatalf("access error code=%q; want %q", payload.Error.Code, code)
	}
}

func insertAccessUser(t *testing.T, db *pgxpool.Pool, email, accessStatus string, createdAt time.Time) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := db.Exec(context.Background(), `
		INSERT INTO users(id,email,password_hash,active,access_status,created_at,updated_at)
		VALUES($1,$2,'',$3,$4,$5,$5)
	`, id, normalizeEmail(email), accessStatus == models.AccessStatusActive, accessStatus, createdAt); err != nil {
		t.Fatalf("insert access user %s: %v", email, err)
	}
	return id
}

func assertStoredAccess(t *testing.T, db *pgxpool.Pool, email, wantStatus string, wantActive bool) {
	t.Helper()
	var status string
	var active bool
	if err := db.QueryRow(context.Background(), `SELECT access_status,active FROM users WHERE email=$1`, normalizeEmail(email)).Scan(&status, &active); err != nil {
		t.Fatalf("load access for %s: %v", email, err)
	}
	if status != wantStatus || active != wantActive {
		t.Fatalf("stored access for %s=%q/%v; want %q/%v", email, status, active, wantStatus, wantActive)
	}
}

func signAccessToken(t *testing.T, srv *Server, userID, email string) string {
	t.Helper()
	token, _, err := srv.signToken(userID, email)
	if err != nil {
		t.Fatalf("sign access token: %v", err)
	}
	return token
}

func requestAdminUsers(t *testing.T, app *fiber.App, token, path string) adminUsersResponse {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("list admin users: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list admin users status=%d; want 200", response.StatusCode)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("admin users Cache-Control=%q; want no-store", response.Header.Get("Cache-Control"))
	}
	var payload adminUsersResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode admin users: %v", err)
	}
	return payload
}

func patchAdminUser(t *testing.T, app *fiber.App, token, userID, status string, wantStatus int) models.AdminUser {
	t.Helper()
	response := patchAdminUserResponse(t, app, token, userID, status)
	defer response.Body.Close()
	if response.StatusCode != wantStatus {
		t.Fatalf("patch user status=%d; want %d", response.StatusCode, wantStatus)
	}
	var user models.AdminUser
	if err := json.NewDecoder(response.Body).Decode(&user); err != nil {
		t.Fatalf("decode patched user: %v", err)
	}
	return user
}

func patchAdminUserResponse(t *testing.T, app *fiber.App, token, userID, status string) *http.Response {
	t.Helper()
	body := fmt.Sprintf(`{"status":%q}`, status)
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/users/"+userID, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("patch admin user: %v", err)
	}
	return response
}
