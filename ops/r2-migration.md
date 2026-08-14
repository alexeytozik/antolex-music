# R2 migration: copy and verify

The migration moves objects from the old `tozikron-music` bucket to `antolex-music`. The included script is read-only: it lists each bucket with its own credential, compares key/size inventories, and derives the copy preview without issuing a write request.

## 1. Prerequisites

- Create the target bucket separately; creation changes remote state and is not hidden inside a script.
- Configure a read-only R2 S3 token for the source bucket and a separate read/write token for the target bucket. Keep both outside shell history.
- Back up PostgreSQL with `scripts/backup-postgres.sh`.
- Keep uploads disabled for the final copy window so the source inventory cannot change underneath the verification.

Load these values from a mode-`600` environment file or a secret manager:

```text
R2_ACCOUNT_ID=...
R2_SOURCE_BUCKET_NAME=tozikron-music
R2_SOURCE_ACCESS_KEY_ID=...       # read-only access to the old bucket
R2_SOURCE_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=antolex-music
R2_ACCESS_KEY_ID=...              # read/write access to the new bucket
R2_SECRET_ACCESS_KEY=...
```

For backwards compatibility, the dry-run script falls back to `R2_ACCESS_KEY_ID`
and `R2_SECRET_ACCESS_KEY` when both source credential variables are empty. Do not
use that fallback for a new production migration; separate bucket-scoped tokens
make an accidental cross-bucket write impossible.

## 2. Inventory and copy preview

Legacy database rows do not yet have trusted full-file hashes. Build a local manifest and duplicate report first; this reads the database and downloads every source object, but changes neither one:

```bash
ANTOLEX_REPORT_DIR=./migration-reports ./scripts/legacy-r2-hash-report.sh
```

Review the JSON report before any deduplication. Its `keep` row is the earliest database row for each exact SHA-256 group. Deletion and like reassignment remain a separate, explicitly approved migration.

Backfill only those canonical rows after reviewing the report. The command is a
transactional dry-run by default: it stages the manifest, verifies every row
against PostgreSQL, selects the earliest `created_at, id` row per hash, exercises
the update, and rolls it back.

```bash
./scripts/backfill-legacy-sha256.sh
```

When its counts and canonical assignments are correct, opt in locally to the
same validated transaction:

```bash
./scripts/backfill-legacy-sha256.sh --apply
```

You can select a specific report with `--manifest PATH`; otherwise the newest
`legacy-r2-sha256-*.tsv` file is used. The apply step writes SHA-256 only to the
earliest row for each hash, including hashes with one copy. It does not delete
or merge tracks, move likes, or change R2. The later duplicate rows deliberately
remain without a hash so the unique index stays valid. New uploads matching a
canonical legacy hash can then be rejected with `409 duplicate_track`. Merging
or deleting the remaining legacy duplicates still requires separate approval.

Then compare source and target inventories:

```bash
ANTOLEX_REPORT_DIR=./migration-reports ./scripts/r2-migration-dry-run.sh
```

The report shows source/target object counts and bytes, a key/size diff, and every
source object that is absent from the target or differs in size. The preview is
computed locally from the two read-only inventory responses because one remote
`aws s3 sync` process cannot authenticate to its source and target with different
credentials. Stop if the bucket names are wrong or the source count is unexpected.

## 3. Approved copy window

There is intentionally no write-capable migration script. After reviewing the
dry-run, copy through a temporary local staging directory during the approved
maintenance window. The first process can only read the source; the second can
only write the target. Ensure the host has free space for the full source bucket.
Do not add `--delete` to either command:

```bash
migration_stage="$(mktemp -d "${TMPDIR:-/tmp}/antolex-r2-stage.XXXXXX")"
chmod 700 "${migration_stage}"

AWS_ACCESS_KEY_ID="${R2_SOURCE_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${R2_SOURCE_SECRET_ACCESS_KEY}" \
AWS_SESSION_TOKEN="" AWS_DEFAULT_REGION=auto AWS_REGION=auto AWS_PAGER="" \
aws --endpoint-url "${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}" \
  s3 sync "s3://${R2_SOURCE_BUCKET_NAME}/" "${migration_stage}/" --no-progress

AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
AWS_SESSION_TOKEN="" AWS_DEFAULT_REGION=auto AWS_REGION=auto AWS_PAGER="" \
aws --endpoint-url "${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}" \
  s3 cp "${migration_stage}/" "s3://${R2_BUCKET_NAME}/" --recursive --dryrun --no-progress

# Review the target-scoped dry-run above, then repeat it without --dryrun.
AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
AWS_SESSION_TOKEN="" AWS_DEFAULT_REGION=auto AWS_REGION=auto AWS_PAGER="" \
aws --endpoint-url "${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}" \
  s3 cp "${migration_stage}/" "s3://${R2_BUCKET_NAME}/" --recursive --no-progress
```

The final `s3 cp` changes the target bucket and intentionally rewrites every
source key, including an existing same-size target object; it never deletes a
target-only key. Run it only after the backup and both preview reviews have
passed. Keep `migration_stage` until the verification below passes, then remove
that exact temporary directory.

## 4. Verification

Run the dry-run again. A completed key/size copy has an empty diff and no proposed sync actions:

```bash
./scripts/r2-migration-dry-run.sh
```

R2 multipart ETags are not full-file hashes. For byte-for-byte verification, opt in to the read-only full check; it downloads every matching source and target object and compares SHA-256 locally:

```bash
ANTOLEX_R2_VERIFY_CONTENT=yes ./scripts/r2-migration-dry-run.sh
```

Only after both checks pass should `R2_BUCKET_NAME=antolex-music` be activated and the application restarted. Confirm several old and new tracks play before reopening uploads.

After successful verification, remove the local staged copy (never substitute a
broader path):

```bash
rm -rf -- "${migration_stage:?migration_stage is not set}"
```

## 5. Safety period

Keep the source bucket unchanged for seven days. Compare daily database/job errors and spot-check playback. Deleting the source bucket or any duplicate objects is outside this runbook and requires separate explicit confirmation.
