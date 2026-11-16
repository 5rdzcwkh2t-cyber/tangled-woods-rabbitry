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
| `test_environment` | `marker` | Every test write and the breeding read verify `tangled-woods-test-db`. |
| `cloud_backups` | `id`, `created_at`, `device_id`, `backup_data` | Existing migration; backup writes remain disabled. |

Primary keys create SQLite's automatic unique indexes. The only explicit repository-evidenced index is `idx_cloud_backups_created` on `cloud_backups(created_at)`.

`002_cloud_test_schema.sql` adds primary keys, required columns, the two endpoint-supported rabbit sex values, and valid-JSON-object checks. It seeds only the non-sensitive test-environment marker. It does not seed rabbitry records.

## Relationships and assumptions

- Rabbit documents duplicate `_id`, `Name`, and `Sex` inside `data`; the rabbit table also keeps `id`, `name`, and `sex` columns for the existing API.
- Litter parent relationships are JSON properties: `DamID` and `SireID`.
- Breeding parent relationships are JSON properties: `doeId` and `buckId`.
- Because parent IDs are not SQL columns, the current schema cannot declare foreign keys. Endpoint validation supplies the current relationship checks.
- No timestamps, owners, revisions, soft-delete columns, or production tenancy model were inferred because repository evidence does not establish them.
- The migration reconstructs the isolated cloud test schema. It is not presented as a complete or authoritative production schema.

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

