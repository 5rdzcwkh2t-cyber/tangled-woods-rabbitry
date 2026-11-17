# Stage 3C development migration

`004_future_lossless_rabbits.sql` is an additive development-only design for future multi-rabbitry storage. It creates `rabbitries`, `rabbitry_memberships`, and `rabbit_record_versions`; it does not alter, copy, delete, or reinterpret any existing row. Current endpoints continue to use the existing `rabbits`, `litters`, `breedings`, and `cloud_backups` tables.

## Identity and compatibility

Membership identity is the verified Cloudflare Access JWT `sub` value, stored as the opaque `access_subject`. A future API must obtain this value from the existing server-side Access verifier. It must never accept an owner or subject identifier from a request body, query parameter, or browser storage.

Rabbit IDs use the reversible codec in `rabbit-typed-id.js`. Strings are tagged with `s:` and a JSON string representation; finite numbers are tagged with `n:` and their exact IEEE-754 binary64 bits in lowercase hexadecimal. Consequently string `"7"`, number `7`, positive zero, and negative zero have different keys. The full original ID remains in the Stage 3B envelope; `typed_id` is only the indexed identity representation.

JSON itself serializes negative zero as positive zero. The codec can distinguish `-0` before serialization, but a Stage 3B envelope that has already passed through `JSON.stringify`/`JSON.parse` cannot recover that sign. Future write code must derive and validate `typed_id` from the in-memory envelope ID before serialization and reject any supplied typed key that does not equal `encodeRabbitId(envelope.id)`. SQLite verifies exact string-ID agreement and numeric type agreement, but it cannot reproduce the JavaScript IEEE-754 hexadecimal encoding in a `CHECK` constraint; exact numeric typed-ID agreement therefore remains a required server-side validation.

Each stored row contains one immutable logical revision of the complete Stage 3B envelope. The primary key includes rabbitry, typed identity, and revision. Separate normalized name, sex, and birth-date columns are search projections and do not replace or modify fields inside `envelope.record`. `deleted_at` reserves soft deletion without removing historical revisions. A future writer can implement optimistic concurrency by requiring an expected latest revision and inserting the next revision transactionally.

Membership rows are authorization data only after a future API has authenticated the request. Possession of an `access_subject` value or an existing membership row is not proof that the caller controls that subject; every request must first verify the Cloudflare Access JWT and derive `sub` server-side.

## Recovery instead of destructive rollback

There is intentionally no rollback SQL. Before any later approved environment migration, take and verify a D1 backup and test the migration against an isolated development database. Because no current endpoint reads or writes these tables, recovery from a Stage 3C problem is to stop future feature rollout, leave the additive tables unused, restore the pre-migration database backup if the database itself is unhealthy, and ship a new forward-only corrective migration after review. Do not drop these tables in place: doing so could destroy future revision history and complicate migration bookkeeping.

This repository change does not execute Wrangler, contact a remote D1 database, or authorize production use.
