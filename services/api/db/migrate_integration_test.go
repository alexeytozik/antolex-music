package database

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateBackfillsLegacyLikesAndIsIdempotent(t *testing.T) {
	db := newMigrationTestDB(t)
	ctx := context.Background()

	if _, err := db.Exec(ctx, `
		CREATE TABLE schema_migrations (
			version TEXT PRIMARY KEY,
			checksum TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`); err != nil {
		t.Fatalf("create migration table: %v", err)
	}
	initial, err := migrationFiles.ReadFile("migrations/0001_initial.sql")
	if err != nil {
		t.Fatalf("read initial migration: %v", err)
	}
	if _, err := db.Exec(ctx, string(initial)); err != nil {
		t.Fatalf("apply initial migration: %v", err)
	}
	checksum := sha256.Sum256(initial)
	if _, err := db.Exec(ctx, `INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)`, "0001_initial.sql", hex.EncodeToString(checksum[:])); err != nil {
		t.Fatalf("record initial migration: %v", err)
	}

	userID := uuid.NewString()
	trackID := uuid.NewString()
	likedAt := time.Date(2026, 8, 12, 7, 30, 0, 0, time.UTC)
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash) VALUES($1,'legacy@example.com','')`, userID); err != nil {
		t.Fatalf("insert legacy user: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO library_tracks(
			id,external_track_id,title,artist,cover_url,object_key,content_type,size_bytes
		) VALUES($1,'legacy-track','Legacy Song','Legacy Artist','','library/legacy.m4a','audio/mp4',123)
	`, trackID); err != nil {
		t.Fatalf("insert legacy track: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO liked_songs(user_id,external_track_id,title,artist,cover_url,created_at,updated_at)
		VALUES($1,'legacy-track','Legacy Song','Legacy Artist','',$2,$2)
	`, userID, likedAt); err != nil {
		t.Fatalf("insert legacy like: %v", err)
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply remaining migrations: %v", err)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("repeat migrations: %v", err)
	}

	var migratedTrackID string
	var migratedLikedAt time.Time
	if err := db.QueryRow(ctx, `SELECT track_id::text,liked_at FROM track_likes WHERE user_id=$1`, userID).Scan(&migratedTrackID, &migratedLikedAt); err != nil {
		t.Fatalf("load migrated like: %v", err)
	}
	if migratedTrackID != trackID || !migratedLikedAt.Equal(likedAt) {
		t.Fatalf("migrated like track=%q liked_at=%s; want %q at %s", migratedTrackID, migratedLikedAt, trackID, likedAt)
	}

	var role, status, originalKey, playbackKey, coverKey string
	var active bool
	if err := db.QueryRow(ctx, `
		SELECT users.role,users.active,track.status,
		       COALESCE(track.original_object_key,''),COALESCE(track.playback_object_key,''),
		       COALESCE(track.cover_object_key,'')
		FROM users JOIN library_tracks track ON track.id=$2
		WHERE users.id=$1
	`, userID, trackID).Scan(&role, &active, &status, &originalKey, &playbackKey, &coverKey); err != nil {
		t.Fatalf("load migrated records: %v", err)
	}
	if role != "listener" || !active || status != "ready" {
		t.Fatalf("migrated user/track role=%q active=%v status=%q", role, active, status)
	}
	if originalKey != "library/legacy.m4a" || playbackKey != "library/legacy.m4a" || !strings.HasPrefix(coverKey, "library/covers/") {
		t.Fatalf("migrated object keys original=%q playback=%q cover=%q", originalKey, playbackKey, coverKey)
	}

	var migrationCount, likeCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&migrationCount); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM track_likes WHERE user_id=$1 AND track_id=$2`, userID, trackID).Scan(&likeCount); err != nil {
		t.Fatalf("count migrated likes: %v", err)
	}
	if migrationCount != 4 || likeCount != 1 {
		t.Fatalf("migration rows=%d migrated likes=%d; want 4 and 1", migrationCount, likeCount)
	}

	var uploadSizeConstraint string
	if err := db.QueryRow(ctx, `
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'upload_sessions'::regclass
		  AND conname = 'upload_sessions_size_bytes_check'
	`).Scan(&uploadSizeConstraint); err != nil {
		t.Fatalf("load upload size constraint: %v", err)
	}
	if !strings.Contains(uploadSizeConstraint, "52428800") {
		t.Fatalf("upload size constraint does not enforce 50 MiB: %s", uploadSizeConstraint)
	}
}

func newMigrationTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	rawURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if rawURL == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL migration integration tests")
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

	schema := "antolex_migration_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	return db
}
