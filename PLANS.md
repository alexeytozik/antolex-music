# ANTOLEX Music implementation plan

## Goal

Turn the current Tozikron Music prototype into a mobile-first ANTOLEX Music web application with resumable direct-to-R2 uploads, exact SHA-256 duplicate prevention, durable media processing, open email-code registration, and a complete brand replacement.

## Milestones

1. Add ordered SQL migrations for cookie sessions, normalized likes, track lifecycle, upload sessions/parts, and durable media jobs. Keep the legacy role column only for database compatibility; it has no product behavior.
2. Replace the legacy single-request upload and automatic R2 reconciliation with authenticated multipart upload APIs and a dedicated worker that verifies, probes, extracts artwork, and creates 256 kbps M4A playback files.
3. Rebuild the web client around mobile bottom navigation, a dedicated Add queue, infinite feeds, safe-area handling, a mini/full player, Media Session, and persisted playback state.
4. Replace all user-facing branding with ANTOLEX Music and add the complete vector/raster asset package.
5. Add Caddy, worker/deploy services, migration dry-run tooling, and local-to-production runbooks.
6. Verify backend, frontend, Docker, migration dry-run, and 320/390/412 px layouts.
7. Restore the wide desktop listening experience from the original Tozikron UI while keeping the mobile application as a deliberately separate interface: desktop header navigation, horizontal catalog rows, and a full-width fixed player at 900 px and above; mobile bottom navigation, mini-player, and full-screen player below 900 px.
8. Use the same cursor-based infinite catalog on desktop and mobile, fetching 20 tracks at a time. Keep the desktop header on one line with a larger wordmark and a single Add/Profile entry point. Limit every new audio file to 50 MiB in the browser, API, and database.
9. Simplify the visual system: one outline per component, restrained 8–14 px corner radii for fields and surfaces, rectangular action buttons, and circular geometry only for icon/media controls.
10. Keep published tracks immutable in the user application and remove the signed-in Profile destination. Show only direct `Sign in` or `Signed in` / `Sign out` controls in the header; retain `/profile` solely for the guest email-code form. Remove track edit/delete, failed-operation controls, and user-management routes.
11. Preserve embedded artwork when it exists and render a deterministic 512 px ANTOLEX cover from track metadata when an audio file has no artwork, so missing source images no longer collapse the catalog into one repeated placeholder.
12. Make playback resilient without adding new screens: automatically recover a stream after transient network failures, extend a catalog-backed queue before it reaches the last loaded page, and make shuffle cover the complete matching library rather than only tracks already rendered in the feed. Preserve the current track, position, play intent, likes, search ordering, Media Session controls, and persisted player state.
13. Add GitHub Actions on the public repository for frontend tests/build, backend test/vet, and production Compose validation. Serialize deployments from `main`, transfer a checksummed release over strict-host-key SSH without third-party deployment actions, activate only after health checks, and keep versioned releases with a shared production environment.
14. Consolidate the live library around production as the only source of truth. Merge the 13 verified local-only tracks without re-uploading their existing R2 media, retain one canonical M4A playback object plus an optional cover per track, migrate the four legacy `library/` objects, remove verified originals and smoke-test data, and retire the local Docker database immediately after production validation.
15. Allow any valid email address to request a one-time code. Create or reactivate the user only after the code is verified successfully, while keeping likes isolated by user ID and all authenticated product permissions equal.
16. Keep Add as an operational queue rather than permanent upload history: hide successful and cancelled entries, retain actionable errors and duplicates until dismissal, and purge terminal upload metadata and successful jobs after one hour without touching published tracks, media, or likes.
17. Make playback controls consistent across mouse, touch, keyboard, and media keys: selecting the current track toggles pause/resume without rebuilding its queue or losing position. Space is a global play/pause shortcut after pointer navigation, while text editing, value controls, and buttons reached deliberately with Tab retain their native keyboard behavior.
18. Keep the upload queue and its one-at-a-time processor mounted for the authenticated application lifetime instead of tying them to the Add route. Internal navigation must retain selected `File` handles and continue hashing/uploading/processing; a full browser reload still restores durable metadata as `needs_file`. Reconcile reselected files with existing `needs_file` rows before enforcing the 50-file capacity so a full batch can resume in one selection. Scope IndexedDB metadata to the authenticated user, stop local work immediately on logout, and use abortable single-flight processing polls so stale or unauthorized responses cannot cross account/session boundaries.
19. Replace contiguous `LIKE` catalog search with PostgreSQL `simple` full-text search plus `pg_trgm`: accent-insensitive weighted metadata search, order-independent prefix terms, a typo-only fallback, stable versioned cursors, and matching frontend continuation invalidation without adding a separate search service.
20. Restore owner-managed access without restoring product roles: `ADMIN_EMAILS` identifies protected administrators, newly verified accounts start as pending, existing accounts retain their current access, and an owner-only responsive `/admin` page can approve or block users. Blocked sessions lose API access immediately; administrators cannot block themselves or another configured administrator.

## Production consolidation (completed)

1. Captured the exact local/production database diff and R2 inventory. The owner explicitly waived backups for this pet-project consolidation.
2. Dry-ran collision and object checks, transactionally inserted the 13 local-only `library_tracks` rows into production, and invalidated the search cache.
3. Deployed worker changes that retain only canonical M4A playback and optional cover objects after publication.
4. Copied and SHA-256-verified the four legacy playable objects under `playback/<track-id>.m4a`, then updated production rows atomically.
5. Removed the 25 unreferenced `originals/` objects, four replaced `library/` audio objects, and the smoke-test object. R2 now contains exactly the 41 objects referenced by production PostgreSQL.
6. Stopped the local ANTOLEX stack and immediately removed its PostgreSQL/Redis volumes, the old Tozikron volumes, and project-specific development images while preserving unrelated Docker resources.

## Current local status

- Milestones 1–20 are implemented locally; final verification is repeated after each production change.
- The six confirmed legacy duplicates and the Cover Test track were removed through guarded worker jobs after explicit approval; the library has no unresolved hashes or exact SHA-256 duplicate groups.
- The `antolex-music` R2 bucket is created, scoped credentials and CORS are configured, all 13 legacy objects are copied, and key/size plus full SHA-256 verification passed. The local API and worker now use the new bucket; the old bucket remains intact for the required seven-day rollback window.
- `antolex.net` is an active Mailjet sending domain with SPF, DKIM, and DMARC published in Cloudflare. Local sign-in email now comes from `ANTOLEX Music <auth@antolex.net>` and was verified in Gmail Inbox.
- The GitHub repository is renamed to `alexeytozik/antolex-music` and the local `origin` uses the new URL. Production deployment/DNS, duplicate merge/deletion, and old-bucket deletion remain behind the safety gates below.
- The responsive presentation has two explicit modes. Desktop keeps the visual rhythm of the original player and catalog, updated to the ANTOLEX brand; mobile keeps the touch-first navigation and player designed for iOS and Android.
- Any valid email can request and verify a code, but a new account remains pending until a configured owner approves it on `/admin`. Owners can approve or block accounts; the application still exposes no general product roles or published-track management controls.
- Likes remain private to each account through the `(user_id, track_id)` key; the mobile navigation contains only Search, Liked, and Add.
- Embedded artwork is preserved whenever the source contains it; files without an image stream receive distinct metadata-derived ANTOLEX covers without pretending they are official album artwork.
- Ordered and liked playback queues continue through cursor pages while retaining only a bounded consumed history. Shuffle uses a signed, indexed server cursor across the complete ready library, and transient stream/network failures recover automatically without a manual Retry.
- The CI/deploy workflow and release-layout runbook use four repository secrets and the server-side `/home/atozik/antolex-music/shared/.env`. Every successful `main` run publishes an immutable release and keeps application secrets outside GitHub.
- Production is live at `music.antolex.net` and is the only catalog source of truth: 29 ready tracks, 29 canonical playback objects, 12 stored covers, no original references, and no duplicate SHA-256 groups. Automatic bucket scanning remains intentionally disabled.

## Safety gates

- Any future database or R2 cleanup requires a dry-run report and explicit confirmation of the exact targets.
- Do not create/copy/delete remote R2 buckets, rename the GitHub repository, or change production DNS/deployment without action-time confirmation.
- Keep the old R2 bucket for seven days after a verified cutover; deletion requires separate confirmation.
- Never commit `.env`, SMTP credentials, R2 credentials, database dumps, or generated presigned URLs.

## Explicit v1 boundaries

No PWA/service worker, native shell, offline audio, ZIP/URL/cloud imports, automatic bucket scanning, audio similarity/AI matching, or playback modes beyond shuffle.
