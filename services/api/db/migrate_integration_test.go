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
	func() {
		conn, err := db.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire staged migration connection: %v", err)
		}
		defer conn.Release()
		if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(1948596401)`); err != nil {
			t.Fatalf("lock staged migration: %v", err)
		}
		defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock(1948596401)`) //nolint:errcheck
		if _, err := conn.Exec(ctx, string(initial)); err != nil {
			t.Fatalf("apply initial migration: %v", err)
		}
		checksum := sha256.Sum256(initial)
		if _, err := conn.Exec(ctx, `INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)`, "0001_initial.sql", hex.EncodeToString(checksum[:])); err != nil {
			t.Fatalf("record initial migration: %v", err)
		}
	}()

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
	if migrationCount != 7 || likeCount != 1 {
		t.Fatalf("migration rows=%d migrated likes=%d; want 7 and 1", migrationCount, likeCount)
	}

	var readyShuffleIndex string
	if err := db.QueryRow(ctx, `
		SELECT indexname
		FROM pg_indexes
		WHERE schemaname = current_schema()
		  AND tablename = 'library_tracks'
		  AND indexname = 'idx_library_tracks_ready_id'
	`).Scan(&readyShuffleIndex); err != nil {
		t.Fatalf("load ready-track shuffle index: %v", err)
	}
	for _, indexName := range []string{"idx_upload_sessions_terminal_cleanup", "idx_upload_sessions_operational_queue", "idx_media_jobs_succeeded_cleanup"} {
		var stored string
		if err := db.QueryRow(ctx, `
			SELECT indexname FROM pg_indexes
			WHERE schemaname=current_schema() AND indexname=$1
		`, indexName).Scan(&stored); err != nil {
			t.Fatalf("load cleanup index %s: %v", indexName, err)
		}
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

	assertFullTextSearchSchema(t, ctx, db)
}

func assertFullTextSearchSchema(t *testing.T, ctx context.Context, db *pgxpool.Pool) {
	t.Helper()

	trackID := uuid.NewString()
	var searchText string
	var prefixMatch bool
	if err := db.QueryRow(ctx, `
		INSERT INTO library_tracks(
			id,external_track_id,title,artist,album,cover_url,object_key,content_type,size_bytes
		) VALUES(
			$1,'fts-track','  Ace   of Spades  ','Motörhead','No   Remorse','','library/fts.m4a','audio/mp4',123
		)
		RETURNING search_text, search_vector @@ to_tsquery('simple', 'motorhead:*')
	`, trackID).Scan(&searchText, &prefixMatch); err != nil {
		t.Fatalf("insert full-text search fixture: %v", err)
	}
	if searchText != "ace of spades motorhead no remorse" {
		t.Fatalf("normalized search_text=%q", searchText)
	}
	if !prefixMatch {
		t.Fatal("weighted search_vector did not normalize diacritics or match a prefix")
	}

	for _, columnName := range []string{"search_text", "search_vector"} {
		var generated string
		if err := db.QueryRow(ctx, `
			SELECT is_generated
			FROM information_schema.columns
			WHERE table_schema=current_schema()
			  AND table_name='library_tracks'
			  AND column_name=$1
		`, columnName).Scan(&generated); err != nil {
			t.Fatalf("load generated column %s: %v", columnName, err)
		}
		if generated != "ALWAYS" {
			t.Fatalf("column %s is_generated=%q; want ALWAYS", columnName, generated)
		}
	}

	for _, indexName := range []string{"idx_library_tracks_search_vector", "idx_library_tracks_search_trgm"} {
		var definition string
		if err := db.QueryRow(ctx, `
			SELECT indexdef
			FROM pg_indexes
			WHERE schemaname=current_schema()
			  AND tablename='library_tracks'
			  AND indexname=$1
		`, indexName).Scan(&definition); err != nil {
			t.Fatalf("load search index %s: %v", indexName, err)
		}
		if !strings.Contains(definition, "USING gin") || !strings.Contains(definition, "WHERE (status = 'ready'::text)") {
			t.Fatalf("search index %s has unexpected definition: %s", indexName, definition)
		}
	}

	var obsoleteIndexCount int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM pg_indexes
		WHERE schemaname=current_schema()
		  AND tablename='library_tracks'
		  AND indexname='idx_library_tracks_search'
	`).Scan(&obsoleteIndexCount); err != nil {
		t.Fatalf("check obsolete search index: %v", err)
	}
	if obsoleteIndexCount != 0 {
		t.Fatalf("obsolete search index count=%d; want 0", obsoleteIndexCount)
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
