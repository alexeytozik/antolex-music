package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

const (
	adminUsersDefaultLimit = 50
	adminUsersMaxLimit     = 100
)

type adminUsersCursor struct {
	Timestamp time.Time `json:"ts"`
	ID        string    `json:"id"`
}

type adminUsersResponse struct {
	Results    []models.AdminUser `json:"results"`
	NextCursor string             `json:"next_cursor,omitempty"`
}

type updateAdminUserStatusRequest struct {
	Status string `json:"status"`
}

func (s *Server) isAdminEmail(email string) bool {
	normalized := normalizeEmail(email)
	for _, configured := range s.cfg.AdminEmails {
		if normalizeEmail(configured) == normalized {
			return true
		}
	}
	return false
}

func (s *Server) normalizedAdminEmails() []string {
	result := make([]string, 0, len(s.cfg.AdminEmails))
	seen := make(map[string]struct{}, len(s.cfg.AdminEmails))
	for _, configured := range s.cfg.AdminEmails {
		email := normalizeEmail(configured)
		if email == "" {
			continue
		}
		if _, exists := seen[email]; exists {
			continue
		}
		seen[email] = struct{}{}
		result = append(result, email)
	}
	return result
}

func (s *Server) applyUserAccess(user models.User) models.User {
	if s.isAdminEmail(user.Email) {
		user.AccessStatus = models.AccessStatusActive
		user.Active = true
		user.IsAdmin = true
		return user
	}
	if user.AccessStatus == "" {
		if user.Active {
			user.AccessStatus = models.AccessStatusActive
		} else {
			user.AccessStatus = models.AccessStatusBlocked
		}
	}
	user.Active = user.AccessStatus == models.AccessStatusActive
	user.IsAdmin = false
	return user
}

func (s *Server) activateConfiguredAdmins(ctx context.Context) error {
	if s.db == nil {
		return nil
	}
	emails := s.normalizedAdminEmails()
	if len(emails) == 0 {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		UPDATE users
		SET access_status = 'active', active = TRUE, updated_at = NOW()
		WHERE lower(email) = ANY($1::text[])
		  AND (access_status <> 'active' OR active = FALSE)
	`, emails)
	return err
}

func (s *Server) adminMiddleware(c *fiber.Ctx) error {
	user, ok := c.Locals("user").(models.User)
	if !ok || !user.IsAdmin {
		return writeAPIError(c, fiber.StatusForbidden, "admin_required", "Owner access is required", nil)
	}
	return c.Next()
}

func encodeAdminUsersCursor(user models.AdminUser) string {
	payload, err := json.Marshal(adminUsersCursor{Timestamp: user.CreatedAt, ID: user.ID})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeAdminUsersCursor(raw string) (adminUsersCursor, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return adminUsersCursor{}, err
	}
	var cursor adminUsersCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		return adminUsersCursor{}, err
	}
	if cursor.ID == "" || cursor.Timestamp.IsZero() {
		return adminUsersCursor{}, fmt.Errorf("incomplete cursor")
	}
	if _, err := uuid.Parse(cursor.ID); err != nil {
		return adminUsersCursor{}, fmt.Errorf("invalid cursor user id")
	}
	return cursor, nil
}

func (s *Server) listAdminUsers(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	ctx := c.UserContext()
	limit := c.QueryInt("limit", adminUsersDefaultLimit)
	if limit < 1 {
		limit = adminUsersDefaultLimit
	}
	if limit > adminUsersMaxLimit {
		limit = adminUsersMaxLimit
	}

	cursorRaw := strings.TrimSpace(c.Query("cursor"))
	cursor := adminUsersCursor{ID: uuid.Nil.String(), Timestamp: time.Unix(0, 0).UTC()}
	useCursor := false
	if cursorRaw != "" {
		decoded, err := decodeAdminUsersCursor(cursorRaw)
		if err != nil {
			return writeAPIError(c, fiber.StatusBadRequest, "invalid_cursor", "The users cursor is invalid", nil)
		}
		cursor = decoded
		useCursor = true
	}

	if s.db == nil {
		return c.JSON(adminUsersResponse{Results: []models.AdminUser{}})
	}
	rows, err := s.db.Query(ctx, `
		SELECT id::text, email, access_status, created_at, updated_at
		FROM users
		WHERE NOT $1
		   OR created_at < $2
		   OR (created_at = $2 AND id < $3::uuid)
		ORDER BY created_at DESC, id DESC
		LIMIT $4
	`, useCursor, cursor.Timestamp, cursor.ID, limit+1)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to list users")
	}
	defer rows.Close()

	users := make([]models.AdminUser, 0, limit+1)
	for rows.Next() {
		var user models.AdminUser
		if err := rows.Scan(&user.ID, &user.Email, &user.AccessStatus, &user.CreatedAt, &user.UpdatedAt); err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "failed to list users")
		}
		user.IsAdmin = s.isAdminEmail(user.Email)
		if user.IsAdmin {
			user.AccessStatus = models.AccessStatusActive
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to list users")
	}

	response := adminUsersResponse{Results: users}
	if len(users) > limit {
		response.Results = users[:limit]
		response.NextCursor = encodeAdminUsersCursor(response.Results[len(response.Results)-1])
	}
	return c.JSON(response)
}

func (s *Server) updateAdminUserStatus(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	ctx := c.UserContext()
	userID := strings.TrimSpace(c.Params("id"))
	if userID == "" {
		return writeAPIError(c, fiber.StatusBadRequest, "user_id_required", "A user id is required", nil)
	}

	var request updateAdminUserStatusRequest
	if err := c.BodyParser(&request); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	request.Status = strings.ToLower(strings.TrimSpace(request.Status))
	if request.Status != models.AccessStatusActive && request.Status != models.AccessStatusBlocked {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_access_status", "Status must be active or blocked", nil)
	}

	var email string
	if err := s.db.QueryRow(ctx, `SELECT email FROM users WHERE id::text = $1`, userID).Scan(&email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return writeAPIError(c, fiber.StatusNotFound, "user_not_found", "User was not found", nil)
		}
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load user")
	}
	if s.isAdminEmail(email) && request.Status != models.AccessStatusActive {
		return writeAPIError(c, fiber.StatusConflict, "admin_protected", "Configured owners cannot be blocked", nil)
	}

	var user models.AdminUser
	err := s.db.QueryRow(ctx, `
		UPDATE users
		SET access_status = $2,
		    active = ($2 = 'active'),
		    updated_at = NOW()
		WHERE id::text = $1
		RETURNING id::text, email, access_status, created_at, updated_at
	`, userID, request.Status).Scan(
		&user.ID, &user.Email, &user.AccessStatus, &user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return writeAPIError(c, fiber.StatusNotFound, "user_not_found", "User was not found", nil)
		}
		return fiber.NewError(fiber.StatusInternalServerError, "failed to update user")
	}
	user.IsAdmin = s.isAdminEmail(user.Email)
	return c.JSON(user)
}
