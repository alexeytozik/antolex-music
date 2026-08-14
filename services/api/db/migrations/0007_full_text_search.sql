CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA public;

-- PostgreSQL marks unaccent() as STABLE because its dictionary may be changed.
-- ANTOLEX uses the extension's fixed, schema-qualified dictionary, so this
-- immutable wrapper is safe to use from stored generated columns and indexes.
-- Resolve the extension schema instead of assuming it is public: an existing
-- installation may have been placed in a dedicated extensions schema.
DO $migration$
DECLARE
    extension_schema NAME;
BEGIN
    SELECT namespace.nspname
    INTO extension_schema
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname = 'unaccent';

    IF extension_schema IS NULL THEN
        RAISE EXCEPTION 'unaccent extension is not installed';
    END IF;

    EXECUTE format(
        $function_sql$
            CREATE OR REPLACE FUNCTION antolex_normalize_search_text(input TEXT)
            RETURNS TEXT
            LANGUAGE sql
            IMMUTABLE
            PARALLEL SAFE
            STRICT
            SET search_path = pg_catalog, %1$I
            AS $body$
                SELECT btrim(
                    regexp_replace(
                        lower(%1$I.unaccent(%2$L::regdictionary, input)),
                        '[[:space:]]+',
                        ' ',
                        'g'
                    )
                )
            $body$
        $function_sql$,
        extension_schema,
        format('%I.unaccent', extension_schema)
    );
END
$migration$;

ALTER TABLE library_tracks
    ADD COLUMN search_text TEXT GENERATED ALWAYS AS (
        antolex_normalize_search_text(title || ' ' || artist || ' ' || album)
    ) STORED;

ALTER TABLE library_tracks
    ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(
            to_tsvector('simple'::regconfig, antolex_normalize_search_text(title)),
            'A'
        ) ||
        setweight(
            to_tsvector('simple'::regconfig, antolex_normalize_search_text(artist)),
            'B'
        ) ||
        setweight(
            to_tsvector('simple'::regconfig, antolex_normalize_search_text(album)),
            'C'
        )
    ) STORED;

DROP INDEX IF EXISTS idx_library_tracks_search;

CREATE INDEX idx_library_tracks_search_vector
    ON library_tracks USING gin (search_vector)
    WHERE status = 'ready';

CREATE INDEX idx_library_tracks_search_trgm
    ON library_tracks USING gin (search_text gin_trgm_ops)
    WHERE status = 'ready';
