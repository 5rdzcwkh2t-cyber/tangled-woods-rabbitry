CREATE INDEX IF NOT EXISTS idx_rabbit_versions_kit_litter
ON rabbit_record_versions(rabbitry_id, json_extract(envelope, '$.record.litterTypedId'), typed_id, revision)
WHERE deleted_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_kit_create_requires_live_litter
BEFORE INSERT ON rabbit_record_versions
WHEN NEW.revision = 0 AND json_type(NEW.envelope, '$.record.litterTypedId') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'kit_relationship_changed')
  WHERE NOT EXISTS (
    SELECT 1 FROM litter_record_versions l
    WHERE l.rabbitry_id = NEW.rabbitry_id
      AND l.typed_id = json_extract(NEW.envelope, '$.record.litterTypedId')
      AND l.revision = (SELECT MAX(v.revision) FROM litter_record_versions v
        WHERE v.rabbitry_id = l.rabbitry_id AND v.typed_id = l.typed_id)
      AND l.deleted_at IS NULL
      AND l.sire_typed_id = json_extract(NEW.envelope, '$.record.FatherTypedId')
      AND l.dam_typed_id = json_extract(NEW.envelope, '$.record.MotherTypedId')
      AND l.sire_name = json_extract(NEW.envelope, '$.record.Father')
      AND l.dam_name = json_extract(NEW.envelope, '$.record.Mother')
      AND l.birth_date = json_extract(NEW.envelope, '$.record.DoB')
      AND COALESCE(json_extract(l.envelope, '$.record.Breed'), '') = json_extract(NEW.envelope, '$.record.Breed')
      AND 2 = (SELECT COUNT(*) FROM rabbit_record_versions p
        WHERE p.rabbitry_id = l.rabbitry_id AND p.deleted_at IS NULL
          AND ((p.typed_id = l.sire_typed_id AND p.sex_normalized = 'buck')
            OR (p.typed_id = l.dam_typed_id AND p.sex_normalized = 'doe'))
          AND p.revision = (SELECT MAX(v.revision) FROM rabbit_record_versions v
            WHERE v.rabbitry_id = p.rabbitry_id AND v.typed_id = p.typed_id))
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_litter_delete_requires_no_live_kits
BEFORE INSERT ON litter_record_versions
WHEN NEW.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'litter_has_live_kits')
  WHERE EXISTS (
    SELECT 1 FROM rabbit_record_versions k
    WHERE k.rabbitry_id = NEW.rabbitry_id AND k.deleted_at IS NULL
      AND json_extract(k.envelope, '$.record.litterTypedId') = NEW.typed_id
      AND k.revision = (SELECT MAX(v.revision) FROM rabbit_record_versions v
        WHERE v.rabbitry_id = k.rabbitry_id AND v.typed_id = k.typed_id)
  );
END;
