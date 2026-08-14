package config

import (
	"log"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	AppEnv            string
	Port              string
	DatabaseURL       string
	RedisURL          string
	JWTSecret         string
	LegacyJWTSecret   string
	CORSOrigins       []string
	AuthCodeTTL       time.Duration
	SessionTTL        time.Duration
	UploadSessionTTL  time.Duration
	AccessEmails      []string
	CookieName        string
	CookieSecure      bool
	SMTPHost          string
	SMTPPort          string
	SMTPUsername      string
	SMTPPassword      string
	SMTPFrom          string
	R2AccountID       string
	R2BucketName      string
	R2AccessKeyID     string
	R2SecretAccessKey string
}

func Load() Config {
	_ = godotenv.Load()

	cfg := Config{
		AppEnv:            getEnv("APP_ENV", "development"),
		Port:              getEnv("PORT", "8080"),
		DatabaseURL:       getEnv("DATABASE_URL", "postgres://music:music@localhost:5432/music_stream?sslmode=disable"),
		RedisURL:          getEnv("REDIS_URL", "redis://localhost:6379/0"),
		JWTSecret:         getEnv("JWT_SECRET", "change-me"),
		LegacyJWTSecret:   getEnv("LEGACY_JWT_SECRET", ""),
		CORSOrigins:       splitCSV(getEnv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")),
		AuthCodeTTL:       getDuration("AUTH_CODE_TTL", 10*time.Minute),
		SessionTTL:        getDuration("SESSION_TTL", 30*24*time.Hour),
		UploadSessionTTL:  getDuration("UPLOAD_SESSION_TTL", 7*24*time.Hour),
		AccessEmails:      splitCSV(getEnv("ACCESS_EMAILS", getEnv("ADMIN_EMAILS", ""))),
		CookieName:        getEnv("SESSION_COOKIE_NAME", "antolex_session"),
		CookieSecure:      getBool("SESSION_COOKIE_SECURE", getEnv("APP_ENV", "development") == "production"),
		SMTPHost:          getEnv("SMTP_HOST", ""),
		SMTPPort:          getEnv("SMTP_PORT", "587"),
		SMTPUsername:      getEnv("SMTP_USERNAME", ""),
		SMTPPassword:      getEnv("SMTP_PASSWORD", ""),
		SMTPFrom:          getEnv("SMTP_FROM", ""),
		R2AccountID:       getEnv("R2_ACCOUNT_ID", ""),
		R2BucketName:      getEnv("R2_BUCKET_NAME", ""),
		R2AccessKeyID:     getEnv("R2_ACCESS_KEY_ID", ""),
		R2SecretAccessKey: getEnv("R2_SECRET_ACCESS_KEY", ""),
	}

	if cfg.JWTSecret == "change-me" {
		log.Println("warning: using the default JWT secret")
	}

	return cfg
}

func getBool(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func getEnv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func getDuration(key string, fallback time.Duration) time.Duration {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		duration, err := time.ParseDuration(value)
		if err == nil {
			return duration
		}
		log.Printf("warning: invalid duration for %s: %q", key, value)
	}

	return fallback
}
