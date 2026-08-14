CREATE INDEX IF NOT EXISTS idx_upload_sessions_terminal_cleanup
    ON upload_sessions (updated_at, id)
    WHERE status IN ('ready', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_upload_sessions_operational_queue
    ON upload_sessions (user_id, created_at DESC, id DESC)
    WHERE status IN ('uploading', 'paused', 'processing', 'error');

CREATE INDEX IF NOT EXISTS idx_media_jobs_succeeded_cleanup
    ON media_jobs (COALESCE(finished_at, updated_at), id)
    WHERE status = 'succeeded';
