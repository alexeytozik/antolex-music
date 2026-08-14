-- Legacy imports stored extracted artwork under a SHA-1 derived key but did not
-- persist that key in library_tracks. New uploads use covers/<track-id>.jpg and
-- are intentionally excluded by the legacy library/ prefix.
UPDATE library_tracks
SET cover_object_key = 'library/covers/' ||
    SUBSTRING(encode(digest(object_key, 'sha1'), 'hex') FROM 1 FOR 16) || '.jpg',
    updated_at = NOW()
WHERE cover_object_key IS NULL
  AND object_key LIKE 'library/%';
