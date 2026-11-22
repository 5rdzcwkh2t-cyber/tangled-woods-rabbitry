-- Additive append-only breeding storage for authenticated rabbitries.
-- The legacy mutable breedings table remains untouched.

CREATE TABLE IF NOT EXISTS breeding_record_versions (
    rabbitry_id TEXT NOT NULL,
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
    doe_typed_id TEXT NOT NULL CHECK (
        (substr(doe_typed_id, 1, 2) = 's:' AND
         json_valid(substr(doe_typed_id, 3)) AND
         json_type(substr(doe_typed_id, 3)) = 'text') OR
        (substr(doe_typed_id, 1, 2) = 'n:' AND
         length(doe_typed_id) = 18 AND
         substr(doe_typed_id, 3) NOT GLOB '*[^0-9a-f]*')
    ),
    buck_typed_id TEXT NOT NULL CHECK (
        (substr(buck_typed_id, 1, 2) = 's:' AND
         json_valid(substr(buck_typed_id, 3)) AND
         json_type(substr(buck_typed_id, 3)) = 'text') OR
        (substr(buck_typed_id, 1, 2) = 'n:' AND
         length(buck_typed_id) = 18 AND
         substr(buck_typed_id, 3) NOT GLOB '*[^0-9a-f]*')
    ),
    breeding_date TEXT NOT NULL CHECK (
        length(breeding_date) = 10 AND
        breeding_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    expected_kindling_date TEXT CHECK (
        expected_kindling_date IS NULL OR
        (length(expected_kindling_date) = 10 AND
         expected_kindling_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    ),
    kindled_date TEXT CHECK (
        kindled_date IS NULL OR
        (length(kindled_date) = 10 AND
         kindled_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    ),
    status TEXT NOT NULL CHECK (status IN (
        'Bred', 'Confirmed pregnant', 'Kindled', 'Unsuccessful', 'Cancelled'
    )),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN (
        'Not recorded', 'Live litter', 'Mixed live and stillborn',
        'Stillborn litter', 'No litter'
    )),
    envelope TEXT NOT NULL CHECK (
        json_valid(envelope) AND
        json_type(envelope) = 'object' AND
        json_extract(envelope, '$.entityType') = 'breeding' AND
        json_type(envelope, '$.record') = 'object' AND
        json_extract(envelope, '$.schemaVersion') = schema_version AND
        json_extract(envelope, '$.revision') = revision AND
        json_extract(envelope, '$.createdAt') = created_at AND
        json_extract(envelope, '$.updatedAt') = updated_at AND
        json_extract(envelope, '$.record.doeTypedId') = doe_typed_id AND
        json_extract(envelope, '$.record.buckTypedId') = buck_typed_id AND
        json_extract(envelope, '$.record.date') = breeding_date AND
        NULLIF(json_extract(envelope, '$.record.expectedKindlingDate'), '')
            IS expected_kindling_date AND
        NULLIF(json_extract(envelope, '$.record.kindledDate'), '') IS kindled_date AND
        json_extract(envelope, '$.record.status') = status AND
        json_extract(envelope, '$.record.outcome') IS outcome AND
        (
            (substr(typed_id, 1, 2) = 's:' AND
             json_type(envelope, '$.id') = 'text' AND
             json_type(envelope, '$.record._id') = 'text' AND
             substr(typed_id, 3) = json_quote(json_extract(envelope, '$.id')) AND
             json_extract(envelope, '$.record._id') = json_extract(envelope, '$.id')) OR
            (substr(typed_id, 1, 2) = 'n:' AND
             json_type(envelope, '$.id') IN ('integer', 'real') AND
             json_type(envelope, '$.record._id') IN ('integer', 'real') AND
             json_extract(envelope, '$.record._id') = json_extract(envelope, '$.id'))
        )
    ),
    PRIMARY KEY (rabbitry_id, typed_id, revision),
    FOREIGN KEY (rabbitry_id) REFERENCES rabbitries(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (doe_typed_id <> buck_typed_id),
    CHECK (deleted_at IS NULL OR length(deleted_at) > 0)
);

CREATE INDEX IF NOT EXISTS idx_breeding_record_versions_latest
ON breeding_record_versions(rabbitry_id, typed_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_breeding_record_versions_planner
ON breeding_record_versions(
    rabbitry_id, deleted_at, status, breeding_date, revision DESC
);

CREATE INDEX IF NOT EXISTS idx_breeding_record_versions_doe
ON breeding_record_versions(rabbitry_id, doe_typed_id, deleted_at, revision DESC);

CREATE INDEX IF NOT EXISTS idx_breeding_record_versions_buck
ON breeding_record_versions(rabbitry_id, buck_typed_id, deleted_at, revision DESC);
