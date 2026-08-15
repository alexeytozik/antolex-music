ALTER TABLE users
    ADD COLUMN access_status TEXT;

-- Preserve the access decision that existed before owner approval was added.
-- Existing enabled accounts stay usable; existing disabled accounts stay blocked.
UPDATE users
SET access_status = CASE WHEN active THEN 'active' ELSE 'blocked' END
WHERE access_status IS NULL;

ALTER TABLE users
    ALTER COLUMN active SET DEFAULT FALSE,
    ALTER COLUMN access_status SET DEFAULT 'pending',
    ALTER COLUMN access_status SET NOT NULL;

ALTER TABLE users
    ADD CONSTRAINT users_access_status_check
    CHECK (access_status IN ('pending', 'active', 'blocked'));

ALTER TABLE users
    ADD CONSTRAINT users_active_access_status_check
    CHECK (active = (access_status = 'active'));

-- Keep one-release rollback compatibility. The previous API explicitly writes
-- only users.active; current code writes both columns. Mirror a legacy active
-- change only when access_status was not changed by the same statement.
CREATE FUNCTION sync_user_access_status_for_legacy_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.active = TRUE AND NEW.access_status = 'pending' THEN
            NEW.access_status := 'active';
        END IF;
    ELSIF NEW.active IS DISTINCT FROM OLD.active
          AND NEW.access_status IS NOT DISTINCT FROM OLD.access_status THEN
        NEW.access_status := CASE WHEN NEW.active THEN 'active' ELSE 'blocked' END;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_legacy_active_sync
    BEFORE INSERT OR UPDATE OF active, access_status ON users
    FOR EACH ROW
    EXECUTE FUNCTION sync_user_access_status_for_legacy_write();

CREATE INDEX idx_users_access_list
    ON users (created_at DESC, id DESC);
