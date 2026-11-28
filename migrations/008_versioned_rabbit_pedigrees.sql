-- Virtual projections cover historical rows without rewriting their envelopes.
ALTER TABLE rabbit_record_versions ADD COLUMN father_typed_id TEXT
    GENERATED ALWAYS AS (json_extract(envelope, '$.record.FatherTypedId')) VIRTUAL;
ALTER TABLE rabbit_record_versions ADD COLUMN mother_typed_id TEXT
    GENERATED ALWAYS AS (json_extract(envelope, '$.record.MotherTypedId')) VIRTUAL;
ALTER TABLE rabbit_record_versions ADD COLUMN father_name_snapshot TEXT
    GENERATED ALWAYS AS (json_extract(envelope, '$.record.Father')) VIRTUAL;
ALTER TABLE rabbit_record_versions ADD COLUMN mother_name_snapshot TEXT
    GENERATED ALWAYS AS (json_extract(envelope, '$.record.Mother')) VIRTUAL;

CREATE INDEX idx_rabbit_versions_father
ON rabbit_record_versions(rabbitry_id, father_typed_id, typed_id, revision)
WHERE father_typed_id IS NOT NULL;
CREATE INDEX idx_rabbit_versions_mother
ON rabbit_record_versions(rabbitry_id, mother_typed_id, typed_id, revision)
WHERE mother_typed_id IS NOT NULL;

CREATE VIEW latest_rabbit_pedigree_versions AS
SELECT v.* FROM rabbit_record_versions v
WHERE v.revision = (SELECT MAX(p.revision) FROM rabbit_record_versions p
    WHERE p.rabbitry_id = v.rabbitry_id AND p.typed_id = v.typed_id);

CREATE TRIGGER trg_rabbit_pedigree_guard
BEFORE INSERT ON rabbit_record_versions
BEGIN
  SELECT RAISE(ABORT, 'rabbit_pedigree_changed')
  WHERE EXISTS (
    SELECT 1 FROM latest_rabbit_pedigree_versions old
    WHERE old.rabbitry_id = NEW.rabbitry_id AND old.typed_id = NEW.typed_id
      AND (
        json_extract(old.envelope, '$.record.litterTypedId')
          IS NOT json_extract(NEW.envelope, '$.record.litterTypedId')
        OR (old.father_name_snapshot IS NOT NEW.father_name_snapshot
          AND old.father_typed_id IS NOT NULL AND old.father_typed_id IS NEW.father_typed_id)
        OR (old.mother_name_snapshot IS NOT NEW.mother_name_snapshot
          AND old.mother_typed_id IS NOT NULL AND old.mother_typed_id IS NEW.mother_typed_id)
        OR (json_type(old.envelope, '$.record.litterTypedId') IS NOT NULL AND (
          old.father_typed_id IS NOT NEW.father_typed_id OR old.mother_typed_id IS NOT NEW.mother_typed_id
          OR old.father_name_snapshot IS NOT NEW.father_name_snapshot
          OR old.mother_name_snapshot IS NOT NEW.mother_name_snapshot))
      )
  );

  -- Historical/unchanged edges remain valid after ancestor lifecycle changes.
  SELECT RAISE(ABORT, 'rabbit_pedigree_changed')
  WHERE EXISTS (
    SELECT 1
    FROM (
      SELECT NEW.father_typed_id AS parent_id, NEW.father_name_snapshot AS snapshot,
        'buck' AS sex, '$.record.FatherTypedId' AS path
      UNION ALL
      SELECT NEW.mother_typed_id, NEW.mother_name_snapshot, 'doe', '$.record.MotherTypedId'
    ) proposed
    LEFT JOIN latest_rabbit_pedigree_versions old
      ON old.rabbitry_id = NEW.rabbitry_id AND old.typed_id = NEW.typed_id
    WHERE proposed.parent_id IS NOT NULL
      AND proposed.parent_id IS NOT json_extract(old.envelope, proposed.path)
      AND json_type(NEW.envelope, '$.record.litterTypedId') IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM latest_rabbit_pedigree_versions p
        WHERE p.rabbitry_id = NEW.rabbitry_id AND p.typed_id = proposed.parent_id
          AND p.deleted_at IS NULL AND p.sex_normalized = proposed.sex
          AND json_extract(p.envelope, '$.record.Archived') IS NOT 1
          AND p.name_normalized = proposed.snapshot AND p.name_normalized <> ''
      )
  );

  -- Check the whole graph while SQLite is serializing the insert. UNION
  -- deduplicates identities, including in any pre-existing cyclic component.
  SELECT RAISE(ABORT, 'rabbit_pedigree_cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.father_typed_id WHERE NEW.father_typed_id IS NOT NULL
      UNION SELECT NEW.mother_typed_id WHERE NEW.mother_typed_id IS NOT NULL
      UNION SELECT p.father_typed_id FROM ancestors a
        JOIN latest_rabbit_pedigree_versions p
          ON p.rabbitry_id = NEW.rabbitry_id AND p.typed_id = a.id
        WHERE p.father_typed_id IS NOT NULL
      UNION SELECT p.mother_typed_id FROM ancestors a
        JOIN latest_rabbit_pedigree_versions p
          ON p.rabbitry_id = NEW.rabbitry_id AND p.typed_id = a.id
        WHERE p.mother_typed_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE id = NEW.typed_id
  ) AND NOT EXISTS (
    SELECT 1 FROM latest_rabbit_pedigree_versions old
    WHERE old.rabbitry_id = NEW.rabbitry_id AND old.typed_id = NEW.typed_id
      AND old.father_typed_id IS NEW.father_typed_id
      AND old.mother_typed_id IS NEW.mother_typed_id
  );
END;
