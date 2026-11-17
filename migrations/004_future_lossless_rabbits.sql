-- Additive development schema for future lossless, multi-rabbitry rabbit storage.
-- Existing endpoint tables remain authoritative and are intentionally untouched.

CREATE TABLE IF NOT EXISTS rabbitries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) > 0),
    created_by_access_subject TEXT NOT NULL
        CHECK (length(created_by_access_subject) > 0),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    deleted_at TEXT,
    CHECK (deleted_at IS NULL OR length(deleted_at) > 0)
);

CREATE TABLE IF NOT EXISTS rabbitry_memberships (
    rabbitry_id TEXT NOT NULL,
    -- This is an opaque identity lookup value, not proof of authentication.
    -- Future writers must obtain it from a server-verified Access JWT.
    access_subject TEXT NOT NULL CHECK (length(access_subject) > 0),
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    revoked_at TEXT,
    PRIMARY KEY (rabbitry_id, access_subject),
    FOREIGN KEY (rabbitry_id) REFERENCES rabbitries(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (revoked_at IS NULL OR length(revoked_at) > 0)
);

CREATE TABLE IF NOT EXISTS rabbit_record_versions (
    rabbitry_id TEXT NOT NULL,
    -- typed_id is produced by rabbit-typed-id.js. Its s:/n: tag prevents
    -- SQLite TEXT affinity from merging numeric and string legacy identities.
    typed_id TEXT NOT NULL CHECK (
        (substr(typed_id, 1, 2) = 's:' AND
         json_valid(substr(typed_id, 3)) AND
         json_type(substr(typed_id, 3)) = 'text') OR
        (substr(typed_id, 1, 2) = 'n:' AND
         length(typed_id) = 18 AND
         substr(typed_id, 3) NOT GLOB '*[^0-9a-f]*')
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    stored_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (length(stored_at) > 0),
    deleted_at TEXT,
    name_normalized TEXT,
    sex_normalized TEXT,
    birth_date_normalized TEXT,
    envelope TEXT NOT NULL CHECK (
        json_valid(envelope) AND
        json_type(envelope) = 'object' AND
        json_type(envelope, '$.record') = 'object' AND
        json_extract(envelope, '$.schemaVersion') = schema_version AND
        json_extract(envelope, '$.revision') = revision AND
        json_extract(envelope, '$.createdAt') = created_at AND
        json_extract(envelope, '$.updatedAt') = updated_at AND
        (
            (substr(typed_id, 1, 2) = 's:' AND
             json_type(envelope, '$.id') = 'text' AND
             substr(typed_id, 3) = json_quote(json_extract(envelope, '$.id'))) OR
            (substr(typed_id, 1, 2) = 'n:' AND json_type(envelope, '$.id') IN ('integer', 'real'))
        )
    ),
    PRIMARY KEY (rabbitry_id, typed_id, revision),
    FOREIGN KEY (rabbitry_id) REFERENCES rabbitries(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (deleted_at IS NULL OR length(deleted_at) > 0),
    CHECK (name_normalized IS NULL OR typeof(name_normalized) = 'text'),
    CHECK (sex_normalized IS NULL OR typeof(sex_normalized) = 'text'),
    CHECK (birth_date_normalized IS NULL OR typeof(birth_date_normalized) = 'text')
);

CREATE INDEX IF NOT EXISTS idx_rabbitry_memberships_subject
ON rabbitry_memberships(access_subject, revoked_at, rabbitry_id);

CREATE INDEX IF NOT EXISTS idx_rabbit_record_versions_latest
ON rabbit_record_versions(rabbitry_id, typed_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_rabbit_record_versions_name
ON rabbit_record_versions(rabbitry_id, deleted_at, name_normalized, revision DESC);

CREATE INDEX IF NOT EXISTS idx_rabbit_record_versions_sex_birth
ON rabbit_record_versions(rabbitry_id, deleted_at, sex_normalized, birth_date_normalized);
