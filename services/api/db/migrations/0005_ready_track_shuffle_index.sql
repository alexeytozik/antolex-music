CREATE INDEX IF NOT EXISTS idx_library_tracks_ready_id
    ON library_tracks (id)
    WHERE status = 'ready';
