package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

type requestCodeRequest struct {
	Email string `json:"email"`
}

type verifyCodeRequest struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

type authResponse struct {
	User             models.User `json:"user"`
	SessionExpiresAt string      `json:"session_expires_at"`
}

const authResendDelay = 60 * time.Second

type authCodeCheckResult int64

const (
	authCodeMissing  authCodeCheckResult = 0
	authCodeConsumed authCodeCheckResult = 1
	authCodeLocked   authCodeCheckResult = 2
	authCodeMismatch authCodeCheckResult = -1
)

var consumeAuthCodeScript = redis.NewScript(`
local stored = redis.call('GET', KEYS[1])
if not stored then
  return 0
end
if stored == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 1
end
local attempts = redis.call('INCR', KEYS[2])
if attempts == 1 then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl > 0 then
    redis.call('PEXPIRE', KEYS[2], ttl)
  else
    redis.call('PEXPIRE', KEYS[2], ARGV[2])
  end
end
if attempts >= tonumber(ARGV[3]) then
  redis.call('DEL', KEYS[1])
  return 2
end
return -1
`)

func authCodeKey(email string) string {
	return "auth-code:" + strings.ToLower(strings.TrimSpace(email))
}

func authCooldownKey(email string) string {
	return "auth-code-cooldown:" + normalizeEmail(email)
}

func authAttemptsKey(email string) string { return "auth-code-attempts:" + normalizeEmail(email) }

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func isValidEmail(value string) bool {
	_, err := mail.ParseAddress(value)
	return err == nil
}

func isValidAuthCode(value string) bool {
	if len(value) != 6 {
		return false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func retryAfterSeconds(ttl time.Duration) int {
	if ttl <= 0 {
		return 0
	}
	return int((ttl + time.Second - 1) / time.Second)
}

func writeAuthRateLimit(
	c *fiber.Ctx,
	code string,
	message string,
	ttl time.Duration,
	details map[string]any,
) error {
	if details == nil {
		details = make(map[string]any)
	}
	seconds := retryAfterSeconds(ttl)
	details["retry_after_seconds"] = seconds
	if seconds > 0 {
		c.Set(fiber.HeaderRetryAfter, strconv.Itoa(seconds))
	}
	return writeAPIError(c, fiber.StatusTooManyRequests, code, message, details)
}

func writeAuthUnavailable(c *fiber.Ctx) error {
	return writeAPIError(
		c,
		fiber.StatusServiceUnavailable,
		"auth_unavailable",
		"Sign-in is temporarily unavailable. Try again in a moment.",
		nil,
	)
}

func writeAccessPending(c *fiber.Ctx) error {
	return writeAPIError(
		c,
		fiber.StatusForbidden,
		"access_pending",
		"Your email is verified. Access now needs approval from the site owner. After approval, request a new sign-in code.",
		map[string]any{"approval_required": true},
	)
}

func writeAccessBlocked(c *fiber.Ctx) error {
	return writeAPIError(
		c,
		fiber.StatusForbidden,
		"access_blocked",
		"Access for this account has been blocked by the site owner.",
		nil,
	)
}

func generateAuthCode() (string, error) {
	max := big.NewInt(1000000)
	value, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("%06d", value.Int64()), nil
}

func (s *Server) hashAuthCode(email, code string) string {
	sum := sha256.Sum256([]byte(normalizeEmail(email) + ":" + code + ":" + s.cfg.JWTSecret))
	return hex.EncodeToString(sum[:])
}

func (s *Server) requestCode(c *fiber.Ctx) error {
	ctx := c.UserContext()

	var req requestCodeRequest
	if err := c.BodyParser(&req); err != nil {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_request_body", "We could not read this request. Refresh the page and try again.", nil)
	}

	email := normalizeEmail(req.Email)
	if !isValidEmail(email) {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_email", "Enter a valid email address.", nil)
	}
	reserved, err := s.redis.SetNX(ctx, authCooldownKey(email), "1", authResendDelay).Result()
	if err != nil {
		return writeAuthUnavailable(c)
	}
	if !reserved {
		ttl := s.redis.PTTL(ctx, authCooldownKey(email)).Val()
		if ttl <= 0 {
			ttl = time.Second
		}
		return writeAuthRateLimit(c, "code_rate_limited", "A code was requested recently. Try again when the timer ends.", ttl, nil)
	}

	code, err := generateAuthCode()
	if err != nil {
		_ = s.redis.Del(ctx, authCooldownKey(email)).Err()
		return writeAuthUnavailable(c)
	}

	if err := s.redis.Set(ctx, authCodeKey(email), s.hashAuthCode(email, code), s.cfg.AuthCodeTTL).Err(); err != nil {
		_ = s.redis.Del(ctx, authCooldownKey(email)).Err()
		return writeAuthUnavailable(c)
	}
	_ = s.redis.Del(ctx, authAttemptsKey(email)).Err()

	if err := s.sendAuthCodeEmail(email, code); err != nil {
		_ = s.redis.Del(ctx, authCodeKey(email)).Err()
		_ = s.redis.Del(ctx, authCooldownKey(email)).Err()
		return writeAPIError(
			c,
			fiber.StatusServiceUnavailable,
			"email_unavailable",
			"We could not send the code right now. Try again in a moment.",
			nil,
		)
	}

	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) verifyCode(c *fiber.Ctx) error {
	ctx := c.UserContext()

	var req verifyCodeRequest
	if err := c.BodyParser(&req); err != nil {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_request_body", "We could not read this request. Refresh the page and try again.", nil)
	}

	email := normalizeEmail(req.Email)
	code := strings.TrimSpace(req.Code)
	if !isValidEmail(email) {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_email", "Enter a valid email address.", nil)
	}
	if !isValidAuthCode(code) {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_code_format", "Enter the complete 6-digit code.", nil)
	}

	result, err := s.consumeAuthCode(ctx, email, s.hashAuthCode(email, code))
	if err != nil {
		return writeAuthUnavailable(c)
	}
	if result == authCodeLocked {
		return writeAuthRateLimit(
			c,
			"too_many_code_attempts",
			"Too many incorrect attempts. Request a new code.",
			s.redis.PTTL(ctx, authCooldownKey(email)).Val(),
			map[string]any{"request_new_code": true},
		)
	}
	if result != authCodeConsumed {
		return writeAPIError(
			c,
			fiber.StatusUnauthorized,
			"invalid_code",
			"That code is incorrect or has expired. Request a new code and try again.",
			nil,
		)
	}

	user, err := s.upsertVerifiedUser(ctx, email)
	if err != nil {
		return writeAuthUnavailable(c)
	}
	switch user.AccessStatus {
	case models.AccessStatusPending:
		return writeAccessPending(c)
	case models.AccessStatusBlocked:
		return writeAccessBlocked(c)
	case models.AccessStatusActive:
	default:
		return writeAuthUnavailable(c)
	}

	token, expiresAt, err := s.signToken(user.ID, user.Email)
	if err != nil {
		return writeAuthUnavailable(c)
	}
	s.setSessionCookie(c, token, expiresAt)

	return c.JSON(authResponse{
		User:             user,
		SessionExpiresAt: expiresAt.UTC().Format(timeLayout),
	})
}

func (s *Server) consumeAuthCode(ctx context.Context, email, expectedHash string) (authCodeCheckResult, error) {
	fallbackTTL := s.cfg.AuthCodeTTL
	if fallbackTTL <= 0 {
		fallbackTTL = 10 * time.Minute
	}
	result, err := consumeAuthCodeScript.Run(
		ctx,
		s.redis,
		[]string{authCodeKey(email), authAttemptsKey(email)},
		expectedHash,
		fallbackTTL.Milliseconds(),
		5,
	).Int64()
	return authCodeCheckResult(result), err
}

func (s *Server) upsertVerifiedUser(ctx context.Context, email string) (models.User, error) {
	var user models.User
	isAdmin := s.isAdminEmail(email)
	accessStatus := models.AccessStatusPending
	if isAdmin {
		accessStatus = models.AccessStatusActive
	}
	err := s.db.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, active, access_status)
		VALUES ($1, '', $2 = 'active', $2)
		ON CONFLICT (email) DO UPDATE
		SET access_status = CASE WHEN $3 THEN 'active' ELSE users.access_status END,
		    active = CASE WHEN $3 THEN TRUE ELSE users.access_status = 'active' END,
		    updated_at = NOW()
		RETURNING id::text, email, access_status, created_at
	`, normalizeEmail(email), accessStatus, isAdmin).Scan(
		&user.ID, &user.Email, &user.AccessStatus, &user.CreatedAt,
	)
	if err != nil {
		return models.User{}, err
	}
	return s.applyUserAccess(user), nil
}

func (s *Server) setSessionCookie(c *fiber.Ctx, token string, expiresAt time.Time) {
	c.Cookie(&fiber.Cookie{
		Name:     s.cfg.CookieName,
		Value:    token,
		Path:     "/",
		HTTPOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: fiber.CookieSameSiteLaxMode,
		Expires:  expiresAt,
		MaxAge:   max(1, int(time.Until(expiresAt).Seconds())),
	})
}

func (s *Server) exchangeLegacyToken(c *fiber.Ctx) error {
	user, ok := c.Locals("user").(models.User)
	if !ok {
		return fiber.NewError(fiber.StatusUnauthorized, "user not found")
	}
	token, expiresAt, err := s.signToken(user.ID, user.Email)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create session")
	}
	s.setSessionCookie(c, token, expiresAt)
	return c.JSON(authResponse{User: user, SessionExpiresAt: expiresAt.UTC().Format(timeLayout)})
}

func (s *Server) logout(c *fiber.Ctx) error {
	s.clearSessionCookie(c)
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) clearSessionCookie(c *fiber.Ctx) {
	c.Cookie(&fiber.Cookie{
		Name: s.cfg.CookieName, Value: "", Path: "/", HTTPOnly: true,
		Secure: s.cfg.CookieSecure, SameSite: fiber.CookieSameSiteLaxMode,
		Expires: time.Unix(0, 0), MaxAge: -1,
	})
}

const timeLayout = "2006-01-02T15:04:05Z07:00"

func (s *Server) sendAuthCodeEmail(email, code string) error {
	if strings.TrimSpace(s.cfg.SMTPHost) == "" {
		if s.cfg.AppEnv == "development" {
			log.Printf("auth code for %s: %s", email, code)
			return nil
		}
		return fmt.Errorf("smtp is not configured")
	}

	fromValue := strings.TrimSpace(s.cfg.SMTPFrom)
	if fromValue == "" {
		fromValue = strings.TrimSpace(s.cfg.SMTPUsername)
	}
	if fromValue == "" {
		return fmt.Errorf("smtp from address is required")
	}
	envelopeFrom, fromHeader, err := parseSMTPFrom(fromValue)
	if err != nil {
		return err
	}

	addr := net.JoinHostPort(strings.TrimSpace(s.cfg.SMTPHost), strings.TrimSpace(s.cfg.SMTPPort))
	message := []byte(
		fmt.Sprintf(
			"From: %s\r\nTo: %s\r\nSubject: Your ANTOLEX Music sign-in code\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour verification code is %s.\r\nIt expires in %s.\r\n",
			fromHeader,
			(&mail.Address{Address: email}).String(),
			time.Now().UTC().Format(time.RFC1123Z),
			code,
			s.cfg.AuthCodeTTL.String(),
		),
	)

	var auth smtp.Auth
	if s.cfg.SMTPUsername != "" || s.cfg.SMTPPassword != "" {
		auth = smtp.PlainAuth("", s.cfg.SMTPUsername, s.cfg.SMTPPassword, s.cfg.SMTPHost)
	}

	return smtp.SendMail(addr, auth, envelopeFrom, []string{email}, message)
}

func parseSMTPFrom(value string) (string, string, error) {
	parsed, err := mail.ParseAddress(strings.TrimSpace(value))
	if err != nil {
		return "", "", fmt.Errorf("parse SMTP_FROM: %w", err)
	}
	if parsed.Address == "" {
		return "", "", fmt.Errorf("SMTP_FROM address is empty")
	}
	name := strings.TrimSpace(parsed.Name)
	if name == "" {
		name = "ANTOLEX Music"
	}
	header := (&mail.Address{Name: name, Address: parsed.Address}).String()
	return parsed.Address, header, nil
}
