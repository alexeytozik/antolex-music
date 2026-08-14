ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'listener';
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('listener', 'uploader', 'admin'));

ALTER TABLE library_tracks ADD COLUMN IF NOT EXISTS album TEXT NOT NULL DEFAULT '';
ALTER TABLE library_tracks ADD COLUMN IF NOT EXISTS sha256 TEXT;
ALTER TABLE library_tracks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE library_tracks ADD COLUMN IF NOT EXISTS original_object_key TEXT;
ALTER TABLE library_tracks ADD COLUMN IF NOT EXISTS playback_object_key TEXT;
ALTER TABLE library_tracks ADD COLUMN IF NOT EXISTS cover_object_key TEXT;
ALTER TABLE library_tracks ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE library_tracks DROP CONSTRAINT IF EXISTS library_tracks_status_check;
ALTER TABLE library_tracks ADD CONSTRAINT library_tracks_status_check
    CHECK (status IN ('uploading', 'processing', 'ready', 'error', 'deleting'));
ALTER TABLE library_tracks DROP CONSTRAINT IF EXISTS library_tracks_sha256_check;
ALTER TABLE library_tracks ADD CONSTRAINT library_tracks_sha256_check
    CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');

UPDATE library_tracks
SET original_object_key = COALESCE(original_object_key, object_key),
    playback_object_key = COALESCE(playback_object_key, object_key),
    status = 'ready'
WHERE status = 'ready';

CREATE UNIQUE INDEX IF NOT EXISTS idx_library_tracks_sha256_unique
    ON library_tracks (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_library_tracks_feed
    ON library_tracks (created_at DESC, id DESC) WHERE status = 'ready';
DROP INDEX IF EXISTS idx_library_tracks_search;
CREATE INDEX IF NOT EXISTS idx_library_tracks_search
    ON library_tracks USING gin ((lower(title || ' ' || artist || ' ' || album)) gin_trgm_ops)
    WHERE status = 'ready';

CREATE TABLE IF NOT EXISTS upload_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id UUID UNIQUE REFERENCES library_tracks(id) ON DELETE SET NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 314572800),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'uploading'
        CHECK (status IN ('uploading', 'paused', 'processing', 'ready', 'error', 'cancelled')),
    r2_object_key TEXT NOT NULL UNIQUE,
    multipart_upload_id TEXT NOT NULL,
    part_size BIGINT NOT NULL DEFAULT 8388608,
    parts_total INTEGER NOT NULL CHECK (parts_total > 0),
    error_message TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_created
    ON upload_sessions (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expiry
    ON upload_sessions (expires_at) WHERE status IN ('uploading', 'paused');

CREATE TABLE IF NOT EXISTS upload_parts (
    upload_id UUID NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK (part_number > 0),
    etag TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE IF NOT EXISTS track_likes (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id UUID NOT NULL REFERENCES library_tracks(id) ON DELETE CASCADE,
    liked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, track_id)
);
INSERT INTO track_likes (user_id, track_id, liked_at)
SELECT liked.user_id, track.id, liked.created_at
FROM liked_songs liked
JOIN library_tracks track ON track.external_track_id = liked.external_track_id
ON CONFLICT (user_id, track_id) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_track_likes_user_recent
    ON track_likes (user_id, liked_at DESC, track_id DESC);

CREATE TABLE IF NOT EXISTS media_jobs (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('process_upload', 'delete_track')),
    track_id UUID NOT NULL REFERENCES library_tracks(id) ON DELETE CASCADE,
    upload_id UUID REFERENCES upload_sessions(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_media_jobs_claim
    ON media_jobs (run_at, id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_jobs_one_active
    ON media_jobs (track_id, kind) WHERE status IN ('pending', 'running');
