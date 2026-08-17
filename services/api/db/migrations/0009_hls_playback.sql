ALTER TABLE media_jobs
    DROP CONSTRAINT IF EXISTS media_jobs_kind_check;

ALTER TABLE media_jobs
    ADD CONSTRAINT media_jobs_kind_check
    CHECK (kind IN ('process_upload', 'delete_track', 'prepare_hls'));

CREATE TABLE track_playback_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    track_id UUID REFERENCES library_tracks(id) ON DELETE SET NULL,
    object_key TEXT NOT NULL UNIQUE,
    init_offset BIGINT NOT NULL DEFAULT 0 CHECK (init_offset >= 0),
    init_length BIGINT NOT NULL DEFAULT 0 CHECK (init_length >= 0),
    segments JSONB NOT NULL DEFAULT '[]'::JSONB
        CHECK (jsonb_typeof(segments) = 'array'),
    duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    target_duration INTEGER NOT NULL DEFAULT 0 CHECK (target_duration >= 0),
    status TEXT NOT NULL DEFAULT 'preparing'
        CHECK (status IN ('preparing', 'ready', 'error')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_track_playback_assets_current_track
    ON track_playback_assets (track_id)
    WHERE track_id IS NOT NULL AND status = 'ready' AND retired_at IS NULL;

CREATE INDEX idx_track_playback_assets_backfill
    ON track_playback_assets (status, updated_at, track_id)
    WHERE retired_at IS NULL;

CREATE INDEX idx_track_playback_assets_retired_cleanup
    ON track_playback_assets (COALESCE(retired_at, updated_at), id)
    WHERE retired_at IS NOT NULL OR track_id IS NULL;

CREATE TABLE playback_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL
        CHECK (source_kind IN ('search', 'likes', 'shuffle')),
    source_query TEXT NOT NULL DEFAULT '',
    source_state JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (jsonb_typeof(source_state) = 'object'),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'ended', 'expired')),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    start_position_ms BIGINT NOT NULL DEFAULT 0 CHECK (start_position_ms >= 0),
    last_fetched_media_sequence BIGINT NOT NULL DEFAULT -1
        CHECK (last_fetched_media_sequence >= -1),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at)
);

CREATE INDEX idx_playback_sessions_user_access
    ON playback_sessions (user_id, last_accessed_at DESC, id DESC);

CREATE INDEX idx_playback_sessions_expiry
    ON playback_sessions (expires_at, id)
    WHERE status = 'active';

CREATE TABLE playback_session_items (
    session_id UUID NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    cycle_no INTEGER NOT NULL DEFAULT 0 CHECK (cycle_no >= 0),
    track_id UUID REFERENCES library_tracks(id) ON DELETE SET NULL,
    hls_asset_id UUID NOT NULL REFERENCES track_playback_assets(id) ON DELETE RESTRICT,
    track_snapshot JSONB NOT NULL CHECK (jsonb_typeof(track_snapshot) = 'object'),
    first_media_sequence BIGINT NOT NULL CHECK (first_media_sequence >= 0),
    segment_count INTEGER NOT NULL CHECK (segment_count > 0),
    timeline_start_ms BIGINT NOT NULL CHECK (timeline_start_ms >= 0),
    duration_ms BIGINT NOT NULL CHECK (duration_ms > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, ordinal)
);

CREATE UNIQUE INDEX idx_playback_session_items_media_sequence
    ON playback_session_items (session_id, first_media_sequence);

CREATE UNIQUE INDEX idx_playback_session_items_cycle_track
    ON playback_session_items (session_id, cycle_no, track_id);

CREATE INDEX idx_playback_session_items_track
    ON playback_session_items (track_id, session_id)
    WHERE track_id IS NOT NULL;

-- During a rolling Compose replacement the previous worker can still be
-- polling briefly. Delay the new kind so only an HLS-aware worker claims it.
INSERT INTO media_jobs (kind, track_id, status, run_at)
SELECT 'prepare_hls', track.id, 'pending', NOW() + INTERVAL '30 seconds'
FROM library_tracks track
WHERE track.status = 'ready'
  AND NOT EXISTS (
      SELECT 1
      FROM track_playback_assets asset
      WHERE asset.track_id = track.id
        AND asset.status = 'ready'
        AND asset.retired_at IS NULL
  )
  AND NOT EXISTS (
      SELECT 1
      FROM media_jobs job
      WHERE job.track_id = track.id
        AND job.kind = 'prepare_hls'
        AND job.status IN ('pending', 'running')
  )
ON CONFLICT DO NOTHING;
