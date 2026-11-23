-- Additive append-only litter storage for authenticated rabbitries.
-- Legacy mutable litters remain untouched.

CREATE TABLE IF NOT EXISTS litter_record_versions (
    rabbitry_id TEXT NOT NULL,
    typed_id TEXT NOT NULL CHECK (
        (substr(typed_id, 1, 2) = 's:' AND json_valid(substr(typed_id, 3)) AND
         json_type(substr(typed_id, 3)) = 'text') OR
        (substr(typed_id, 1, 2) = 'n:' AND length(typed_id) = 18 AND
         substr(typed_id, 3) NOT GLOB '*[^0-9a-f]*')
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    stored_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (length(stored_at) > 0),
    deleted_at TEXT,
    breeding_typed_id TEXT NOT NULL CHECK (
        (substr(breeding_typed_id,1,2)='s:' AND json_valid(substr(breeding_typed_id,3)) AND json_type(substr(breeding_typed_id,3))='text') OR
        (substr(breeding_typed_id,1,2)='n:' AND length(breeding_typed_id)=18 AND substr(breeding_typed_id,3) NOT GLOB '*[^0-9a-f]*')
    ),
    dam_typed_id TEXT NOT NULL CHECK (
        (substr(dam_typed_id,1,2)='s:' AND json_valid(substr(dam_typed_id,3)) AND json_type(substr(dam_typed_id,3))='text') OR
        (substr(dam_typed_id,1,2)='n:' AND length(dam_typed_id)=18 AND substr(dam_typed_id,3) NOT GLOB '*[^0-9a-f]*')
    ),
    sire_typed_id TEXT NOT NULL CHECK (
        (substr(sire_typed_id,1,2)='s:' AND json_valid(substr(sire_typed_id,3)) AND json_type(substr(sire_typed_id,3))='text') OR
        (substr(sire_typed_id,1,2)='n:' AND length(sire_typed_id)=18 AND substr(sire_typed_id,3) NOT GLOB '*[^0-9a-f]*')
    ),
    breeding_date TEXT NOT NULL,
    birth_date TEXT NOT NULL,
    dam_name TEXT NOT NULL,
    sire_name TEXT NOT NULL,
    total_kits INTEGER,
    envelope TEXT NOT NULL CHECK (
        json_valid(envelope) AND json_type(envelope) = 'object' AND
        json_extract(envelope, '$.entityType') = 'litter' AND
        json_extract(envelope, '$.schemaVersion') = schema_version AND
        json_extract(envelope, '$.revision') = revision AND
        json_extract(envelope, '$.createdAt') = created_at AND
        json_extract(envelope, '$.updatedAt') = updated_at AND
        json_extract(envelope, '$.record.breedingTypedId') = breeding_typed_id AND
        json_extract(envelope, '$.record.damTypedId') = dam_typed_id AND
        json_extract(envelope, '$.record.sireTypedId') = sire_typed_id AND
        json_extract(envelope, '$.record.Bred') = breeding_date AND
        json_extract(envelope, '$.record.Born') = birth_date AND
        json_extract(envelope, '$.record.Dam') = dam_name AND
        json_extract(envelope, '$.record.Sire') = sire_name AND
        ((total_kits IS NULL AND json_type(envelope, '$.record.Total Kits') IS NULL) OR
         (total_kits IS NOT NULL AND total_kits >= 0 AND
          ((json_type(envelope, '$.record.Total Kits') = 'integer' AND
            json_extract(envelope, '$.record.Total Kits') = total_kits) OR
           (json_type(envelope, '$.record.Total Kits') = 'text' AND
            json_extract(envelope, '$.record.Total Kits') <> '' AND
            json_extract(envelope, '$.record.Total Kits') NOT GLOB '*[^0-9]*' AND
            CAST(json_extract(envelope, '$.record.Total Kits') AS INTEGER) = total_kits)))) AND
        ((substr(typed_id, 1, 2) = 's:' AND json_type(envelope, '$.id') = 'text' AND
          json_type(envelope, '$.record._id') = 'text' AND
          substr(typed_id, 3) = json_quote(json_extract(envelope, '$.id')) AND
          json_extract(envelope, '$.record._id') = json_extract(envelope, '$.id')) OR
         (substr(typed_id, 1, 2) = 'n:' AND json_type(envelope, '$.id') IN ('integer','real') AND
          json_type(envelope, '$.record._id') IN ('integer','real') AND
          json_extract(envelope, '$.record._id') = json_extract(envelope, '$.id')))
    ),
    PRIMARY KEY (rabbitry_id, typed_id, revision),
    FOREIGN KEY (rabbitry_id) REFERENCES rabbitries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (dam_typed_id <> sire_typed_id),
    CHECK (length(breeding_date) = 10 AND breeding_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    CHECK (length(birth_date) = 10 AND birth_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    CHECK (length(dam_name) > 0 AND length(sire_name) > 0),
    CHECK (total_kits IS NULL OR total_kits >= 0),
    CHECK (deleted_at IS NULL OR length(deleted_at) > 0)
);

CREATE TABLE IF NOT EXISTS breeding_litter_links (
    rabbitry_id TEXT NOT NULL,
    breeding_typed_id TEXT NOT NULL CHECK (
        (substr(breeding_typed_id,1,2)='s:' AND json_valid(substr(breeding_typed_id,3)) AND json_type(substr(breeding_typed_id,3))='text') OR
        (substr(breeding_typed_id,1,2)='n:' AND length(breeding_typed_id)=18 AND substr(breeding_typed_id,3) NOT GLOB '*[^0-9a-f]*')
    ),
    litter_typed_id TEXT NOT NULL CHECK (
        (substr(litter_typed_id,1,2)='s:' AND json_valid(substr(litter_typed_id,3)) AND json_type(substr(litter_typed_id,3))='text') OR
        (substr(litter_typed_id,1,2)='n:' AND length(litter_typed_id)=18 AND substr(litter_typed_id,3) NOT GLOB '*[^0-9a-f]*')
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (rabbitry_id, breeding_typed_id),
    UNIQUE (rabbitry_id, litter_typed_id),
    FOREIGN KEY (rabbitry_id) REFERENCES rabbitries(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS trg_litter_revision_zero_link
AFTER INSERT ON litter_record_versions
WHEN NEW.revision = 0
BEGIN
    INSERT INTO breeding_litter_links
        (rabbitry_id, breeding_typed_id, litter_typed_id, created_at)
    VALUES (NEW.rabbitry_id, NEW.breeding_typed_id, NEW.typed_id, NEW.created_at);
END;

CREATE INDEX IF NOT EXISTS idx_litter_record_versions_latest
ON litter_record_versions(rabbitry_id, typed_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_litter_record_versions_birth
ON litter_record_versions(rabbitry_id, deleted_at, birth_date DESC, revision DESC);
CREATE INDEX IF NOT EXISTS idx_litter_record_versions_breeding
ON litter_record_versions(rabbitry_id, breeding_typed_id, deleted_at, revision DESC);
CREATE INDEX IF NOT EXISTS idx_litter_record_versions_parents
ON litter_record_versions(rabbitry_id, dam_typed_id, sire_typed_id, revision DESC);
