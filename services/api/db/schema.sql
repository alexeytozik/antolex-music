CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS liked_songs (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_track_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    cover_url TEXT NOT NULL,
    source_page_url TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, external_track_id)
);

CREATE INDEX IF NOT EXISTS idx_liked_songs_user_created_at
    ON liked_songs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS library_tracks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_track_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    cover_url TEXT NOT NULL,
    source_page_url TEXT,
    object_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes BIGINT NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_library_tracks_created_at
    ON library_tracks (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_tracks_uploaded_by
    ON library_tracks (uploaded_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_tracks_search
    ON library_tracks
    USING gin ((lower(title || ' ' || artist || ' ' || COALESCE(source_page_url, ''))) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_library_tracks_alpha
    ON library_tracks ((lower(title)), (lower(artist)), external_track_id);

CREATE INDEX IF NOT EXISTS idx_liked_songs_user_alpha
    ON liked_songs (user_id, lower(title), lower(artist), external_track_id);
