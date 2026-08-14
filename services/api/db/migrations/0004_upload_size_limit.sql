ALTER TABLE upload_sessions
    DROP CONSTRAINT IF EXISTS upload_sessions_size_bytes_check;

ALTER TABLE upload_sessions
    ADD CONSTRAINT upload_sessions_size_bytes_check
    CHECK (size_bytes > 0 AND size_bytes <= 52428800) NOT VALID;

-- Keep historical sessions larger than the new limit readable. PostgreSQL still
-- enforces a NOT VALID check for every new or changed row.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM upload_sessions WHERE size_bytes > 52428800
    ) THEN
        ALTER TABLE upload_sessions
            VALIDATE CONSTRAINT upload_sessions_size_bytes_check;
    END IF;
END
$$;
