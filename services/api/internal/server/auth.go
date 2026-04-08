package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tozikron/tozikron-music/services/api/internal/models"
)

type requestCodeRequest struct {
	Email string `json:"email"`
}

type verifyCodeRequest struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

type authResponse struct {
	Token            string      `json:"token"`
	User             models.User `json:"user"`
	SessionExpiresAt string      `json:"session_expires_at"`
}

func authCodeKey(email string) string {
	return "auth-code:" + strings.ToLower(strings.TrimSpace(email))
}

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func isValidEmail(value string) bool {
	_, err := mail.ParseAddress(value)
	return err == nil
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
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	email := normalizeEmail(req.Email)
	if !isValidEmail(email) {
		return fiber.NewError(fiber.StatusBadRequest, "valid email is required")
	}

	code, err := generateAuthCode()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to generate verification code")
	}

	if err := s.redis.Set(ctx, authCodeKey(email), s.hashAuthCode(email, code), s.cfg.AuthCodeTTL).Err(); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to store verification code")
	}

	if err := s.sendAuthCodeEmail(email, code); err != nil {
		_ = s.redis.Del(ctx, authCodeKey(email)).Err()
		return writeAPIError(
			c,
			fiber.StatusServiceUnavailable,
			"email_unavailable",
			"Failed to send verification code",
			map[string]any{"email": email},
		)
	}

	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) verifyCode(c *fiber.Ctx) error {
	ctx := c.UserContext()

	var req verifyCodeRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	email := normalizeEmail(req.Email)
	code := strings.TrimSpace(req.Code)
	if !isValidEmail(email) || len(code) != 6 {
		return fiber.NewError(fiber.StatusBadRequest, "valid email and 6-digit code are required")
	}

	storedHash, err := s.redis.Get(ctx, authCodeKey(email)).Result()
	if err != nil || storedHash == "" {
		return writeAPIError(
			c,
			fiber.StatusUnauthorized,
			"invalid_code",
			"Verification code is invalid or expired",
			map[string]any{"email": email},
		)
	}

	calculatedHash := s.hashAuthCode(email, code)
	if subtle.ConstantTimeCompare([]byte(storedHash), []byte(calculatedHash)) != 1 {
		return writeAPIError(
			c,
			fiber.StatusUnauthorized,
			"invalid_code",
			"Verification code is invalid or expired",
			map[string]any{"email": email},
		)
	}

	_ = s.redis.Del(ctx, authCodeKey(email)).Err()

	user, err := s.upsertUserByEmail(ctx, email)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create session")
	}

	token, expiresAt, err := s.signToken(user.ID, user.Email)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create token")
	}

	return c.JSON(authResponse{
		Token:            token,
		User:             user,
		SessionExpiresAt: expiresAt.UTC().Format(timeLayout),
	})
}

func (s *Server) upsertUserByEmail(ctx context.Context, email string) (models.User, error) {
	var user models.User
	err := s.db.QueryRow(
		ctx,
		`INSERT INTO users (email, password_hash)
		 VALUES ($1, '')
		 ON CONFLICT (email)
		 DO UPDATE SET updated_at = NOW()
		 RETURNING id::text, email, created_at`,
		email,
	).Scan(&user.ID, &user.Email, &user.CreatedAt)
	if err != nil {
		return models.User{}, err
	}

	return user, nil
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

	from := strings.TrimSpace(s.cfg.SMTPFrom)
	if from == "" {
		from = strings.TrimSpace(s.cfg.SMTPUsername)
	}
	if from == "" {
		return fmt.Errorf("smtp from address is required")
	}

	addr := net.JoinHostPort(strings.TrimSpace(s.cfg.SMTPHost), strings.TrimSpace(s.cfg.SMTPPort))
	message := []byte(
		fmt.Sprintf(
			"From: Tozikron <%s>\r\nTo: %s\r\nSubject: Your Tozikron sign-in code\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour verification code is %s.\r\nIt expires in %s.\r\n",
			from,
			email,
			time.Now().UTC().Format(time.RFC1123Z),
			code,
			s.cfg.AuthCodeTTL.String(),
		),
	)

	var auth smtp.Auth
	if s.cfg.SMTPUsername != "" || s.cfg.SMTPPassword != "" {
		auth = smtp.PlainAuth("", s.cfg.SMTPUsername, s.cfg.SMTPPassword, s.cfg.SMTPHost)
	}

	return smtp.SendMail(addr, auth, from, []string{email}, message)
}
