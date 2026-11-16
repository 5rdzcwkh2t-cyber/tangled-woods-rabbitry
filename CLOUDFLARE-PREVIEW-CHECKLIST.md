# Cloudflare Preview deployment checklist

This checklist covers the isolated `cloud-development` Preview environment. It does not authorize a deployment or any Production database operation.

## Verified environment

Verified as of November 16, 2026:

- The Git development branch is `cloud-development`.
- The Cloudflare Pages Production branch is `main`.
- Automatic Preview deployments are disabled.
- The dedicated development D1 database is named `tangled-woods-dev-v2`.
- Its immutable database ID is `14e2ae93-d0de-49df-a436-389ae1c7ce10`.
- Migrations `001_cloud_backups.sql`, `002_cloud_test_schema.sql`, and `003_secure_cloud_backups.sql` were applied successfully, with no migrations pending.
- The Pages Preview `DB` binding points to `tangled-woods-dev-v2`.
- The Pages Preview variable `TEST_DATABASE` is exactly `tangled-woods-dev-v2`.
- The Preview Access team domain is `red-tree-a71a.cloudflareaccess.com`.
- The Preview Access AUD is configured in Cloudflare Pages.
- The Preview hostname is protected by Cloudflare Access.

The Functions require the binding name `DB`. Database write endpoints also require both the `TEST_DATABASE` value and the `test_environment` marker to equal `tangled-woods-dev-v2`.

## Before enabling a Preview deployment

1. Review and commit only the focused development files; exclude local configuration, historical snapshots, ZIP files, database files, and unrelated changes.
2. Run `npm.cmd test` and require zero failures.
3. Run JavaScript syntax checks and `git diff --check`.
4. Confirm the Pages Production branch still shows `main`.
5. Confirm the Preview `DB` binding still shows `tangled-woods-dev-v2` and its immutable ID matches the verified development database ID above.
6. Confirm `TEST_DATABASE` is still exactly `tangled-woods-dev-v2`.
7. Confirm the Access team domain is still `red-tree-a71a.cloudflareaccess.com` and the configured AUD belongs to the application protecting the Preview hostname.
8. Keep automatic Preview deployments disabled until an explicitly approved one-time deployment.
9. Stop if any binding, identifier, branch, Access value, or hostname protection differs from this checklist.

Do not configure `CLOUDFLARE_ACCESS_JWKS` in Cloudflare. That injection exists only for isolated automated tests.

## Database verification

Use only the ignored `wrangler.dev-v2.jsonc` configuration and always pass it explicitly. Never rely on an implicit Wrangler configuration.

Read-only verification commands:

```powershell
npx.cmd wrangler d1 info tangled-woods-dev-v2 --json --config wrangler.dev-v2.jsonc
npx.cmd wrangler d1 migrations list DB --remote --config wrangler.dev-v2.jsonc
```

Before any future migration, confirm Wrangler reports the expected database name and exact development UUID shown above. Require separate approval before applying a remote migration.

The migrated schema must include:

- `test_environment` with exactly the marker `tangled-woods-dev-v2`
- `rabbits`, `litters`, and `breedings`
- `cloud_backups` with `owner_id`, `format_version`, and `byte_size`
- `idx_cloud_backups_created`
- `idx_cloud_backups_owner_created`
- Wrangler migration records for migrations 001 through 003

## Approved-deployment procedure

1. Obtain explicit approval to stage and commit the reviewed file list on `cloud-development`.
2. Re-run the full tests, syntax checks, secret scan, and staged-diff review.
3. Obtain explicit approval before pushing `cloud-development`.
4. Because automatic Preview deployments are disabled, obtain explicit approval before initiating a one-time Preview deployment.
5. Confirm Cloudflare labels the result as a Preview deployment and leaves the `main` Production deployment unchanged.
6. Record the hash-specific Preview URL used for browser verification.

## Browser verification

Use synthetic records and photographs only:

1. Open the hash-specific Preview URL and authenticate through Access.
2. Confirm an incognito or unauthenticated request is blocked.
3. Confirm Rabbit, Litter, Breeding, Health, and Backup APIs reject missing or invalid authentication.
4. Open Backup & restore and confirm the existing local download and restore controls still render.
5. Create a small cloud backup and confirm its success message, date, device label, and approximate size.
6. Download the backup and verify rabbits, litters, breedings, parent links, expenses, and photographs are preserved.
7. Confirm creating or downloading a cloud backup does not restore or alter local records.
8. With a second authorized identity, confirm it cannot list or retrieve the first identity's backup.
9. Test an intentionally oversized synthetic photo backup. Confirm no upload occurs, photographs are not omitted, and the complete local-backup fallback is offered.
10. Verify only the development D1 database received test rows.

## Rollback

Application rollback:

1. Stop using the affected Preview URL or select the prior known-good Preview deployment.
2. Keep automatic Preview deployments disabled.
3. Do not change or roll back the Production deployment.

Development-data rollback:

1. Stop Preview traffic or remove only the Preview `DB` binding.
2. Reconfirm the target is the verified `tangled-woods-dev-v2` database before taking any recovery action.
3. Prefer D1 Time Travel for recovery. Destructive recreation requires separate approval and a fresh immutable-ID verification.
4. Reapply migrations only with the explicit ignored Wrangler configuration and separate approval.
5. Rebind only the Preview environment and repeat all database and Access checks before testing.

Never use these rollback steps against a Production database.
