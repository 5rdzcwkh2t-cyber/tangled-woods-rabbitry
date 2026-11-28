# Cloudflare D1 development schema

This repository's cloud endpoints can be tested locally without a Cloudflare account, Wrangler installation, network access, or a persistent database. The integration tests apply every SQL file in `migrations/` to a fresh in-memory SQLite database and expose a small D1-compatible `prepare/bind/first/all/run` adapter to the existing endpoint handlers.

## Run locally

Requirements: Node.js 22.5 or newer for the built-in `node:sqlite` module. The project currently declares Node 20 for the basic smoke suite, but the D1 integration suite requires 22.5 or newer.

```powershell
npm.cmd test
```

No test command reads Wrangler state, contacts Cloudflare, or opens a production database. Each integration test receives a new `:memory:` database that is destroyed when the test finishes.

## Reconstructed schema

The schema is based only on SQL statements in `functions/api`:

| Table | Evidenced columns | Evidence and purpose |
| --- | --- | --- |
| `rabbits` | `id`, `name`, `sex`, `data` | Create, list, parent lookup, and optimistic rabbit update endpoints. |
| `litters` | `id`, `data` | Create, list, and optimistic litter update endpoints. |
| `breedings` | `id`, `data` | Create, authenticated list, and update endpoints. |
| `test_environment` | `marker` | Every test write and the breeding read verify `tangled-woods-dev-v2`. |
| `cloud_backups` | `id`, `created_at`, `device_id`, `backup_data`, `owner_id`, `format_version`, `byte_size` | Append-only, authenticated backup creation and owner-filtered retrieval. |

Primary keys create SQLite's automatic unique indexes. Backups have the original `idx_cloud_backups_created` index plus `idx_cloud_backups_owner_created` for owner-filtered retention and retrieval.

`002_cloud_test_schema.sql` adds primary keys, required columns, the two endpoint-supported rabbit sex values, and valid-JSON-object checks. It seeds only the non-sensitive test-environment marker. It does not seed rabbitry records.

The clean development environment is named `tangled-woods-dev-v2`. Both the `TEST_DATABASE` variable and the marker row must use that exact value. The previous `tangled-woods-test-db` database is intentionally incompatible with these guards and remains preserved as a legacy test database.

## Relationships and assumptions

- Rabbit documents duplicate `_id`, `Name`, and `Sex` inside `data`; the rabbit table also keeps `id`, `name`, and `sex` columns for the existing API.
- Litter parent relationships are JSON properties: `DamID` and `SireID`.
- Breeding parent relationships are JSON properties: `doeId` and `buckId`.
- Because parent IDs are not SQL columns, the current schema cannot declare foreign keys. Endpoint validation supplies the current relationship checks.
- Rabbit, litter, and breeding tables still have no inferred timestamps, owners, revisions, soft-delete columns, or production tenancy model because repository evidence does not establish them. Backup ownership is limited to the verified Access subject required for isolation.
- The migration reconstructs the isolated cloud test schema. It is not presented as a complete or authoritative production schema.

## Cloud backup behavior

`POST /api/test-backup` accepts `{ "deviceId": "...", "backup": { ... } }`. The backup document uses the existing complete local export shape: required `rabbits` and `litters`, with optional `breedings`, `parentLinks`, `expenses`, `photos`, `photoBackupVersion`, `exportedAt`, and future related JSON fields. Known collections and the existing IndexedDB photo/gallery representation are validated before insertion.

Backups are append-only and stored as format version 1. The endpoint never restores records. Payloads are limited to 1,800,000 UTF-8 bytes to stay below the practical single-row D1 limit with operational headroom. Larger photo collections still require local file backups or future object storage.

`GET /api/test-backup` lists metadata for the authenticated owner. `GET /api/test-backup?id=<id>` retrieves one complete backup belonging to that owner. The verified Access `sub` claim is stored as the opaque owner identifier and included in every query. A different authenticated identity receives an empty list or 404, not another owner's data.

The newest 20 backups per owner are retained. Creation always inserts a new row; it never overwrites an earlier backup. Retention failures do not discard a successfully inserted backup and are reported by `retentionApplied: false`. Rows created before ownership was added have a null owner and are intentionally inaccessible until an explicit, separately reviewed migration policy exists.

## Safety and Wrangler

Wrangler is not required for the local suite and was not installed. `.wrangler/`, `.dev.vars`, and environment files remain ignored. If Wrangler is added later, use a separate local/test D1 binding and apply migrations with `--local`; never put a production database ID or secret in committed configuration.

## Known security limitations

- Every current API endpoint uses the shared Access JWT verifier; no endpoint is intentionally public.
- Configure `CLOUDFLARE_ACCESS_TEAM_DOMAIN` with the Access team domain (or issuer URL) and `CLOUDFLARE_ACCESS_AUD` with the application audience. Multiple accepted audiences may be comma-separated during a controlled migration.
- The verifier accepts Cloudflare's `Cf-Access-Jwt-Assertion` header and retains `CF_Authorization` cookie compatibility. It verifies RS256 signatures against the team's public JWKS, issuer, audience, expiration, and optional not-before time.
- Production requests fetch public signing keys from the configured team domain and cache them in memory for five minutes. Tests inject an isolated, generated JWKS; no production key or identifier is stored in the repository.
- Rabbit, litter, and breeding edits now use baseline comparison; their final SQL updates also compare the original JSON to prevent a race between read and write.
- JSON relationships cannot receive database-level foreign-key enforcement.

If the two Access bindings are missing, endpoints fail closed with HTTP 503. Missing, malformed, expired, forged, or incorrectly scoped tokens receive HTTP 401 without token-validation details.

## Versioned rabbit photographs

Stage 4E6A requires development migration `009_versioned_rabbit_photos.sql` and a private development R2 bucket bound as `PHOTOS`. Migration 009 adds an upload ledger and a commit trigger. Existing envelopes and images need no conversion.

`/api/test-rabbit-photos` requires Access and rabbitry membership. All requests take `rabbitryId` and canonical `typedId`. GET returns the current gallery and revision, or JPEG bytes when given `photoId`. POST requires a same-origin request and an owner/admin/editor membership:

- `action=add` or `action=replace`: send a normalized JPEG body, `baseRevision`, and a new UUID v4 `operationId`; replace additionally takes the existing `photoId`. Retry the exact same operation and bytes with the same ID. A committed retry returns the original revision and `replayed: true`. Reload the gallery after a replay or conflict.
- `action=primary` or `action=remove`: send `baseRevision` and `photoId`; use an empty body.
- `action=reconcile`: send `operationId` with an empty body and no base revision. The uploader or a rabbitry owner/admin can inspect the receipt and R2 object presence. Expired reservations are marked abandoned; no physical deletion takes place. An abandoned ID cannot be reused.
- `action=cancel`: send the original `operationId` and `baseRevision` with an empty body. The uploader must still have write access. Cancellation records an abandoned receipt even before reservation, or returns the existing committed receipt if the upload already won. It accepts no image bytes and does not delete objects. The migration 009 ledger already supports this operation.

The JPEG limit is 2 MiB, 2048 pixels per edge, and 4 million pixels. The server checks container boundaries, marker structure, dimensions, scan presence, and the exact end of the JPEG. It rejects EXIF, comments, and trailing data. It does not decode or re-encode pixels, verify every Huffman code or table entry, or detect every corrupt image that a browser may fail to decode. Clients should apply orientation and re-encode before upload. Images are served with a fixed JPEG media type and filename, no MIME sniffing, a sandboxed document policy, and same-origin resource protection.

Database and object backups must be coordinated. For inventory or cleanup, preserve all objects referenced by retained revisions, including tombstones. Abandoned ledger entries are tracked and require an explicit retention and cleanup policy before physical deletion.

