CREATE TABLE rabbit_photo_uploads (
  rabbitry_id TEXT NOT NULL REFERENCES rabbitries(id),
  rabbit_typed_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  replace_photo_id TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','committed','abandoned')),
  expires_at TEXT NOT NULL,
  committed_revision INTEGER,
  PRIMARY KEY (rabbitry_id, rabbit_typed_id, photo_id),
  FOREIGN KEY (rabbitry_id, rabbit_typed_id, base_revision)
    REFERENCES rabbit_record_versions(rabbitry_id, typed_id, revision),
  FOREIGN KEY (rabbitry_id, rabbit_typed_id, committed_revision)
    REFERENCES rabbit_record_versions(rabbitry_id, typed_id, revision),
  CHECK ((state = 'committed' AND committed_revision = base_revision + 1)
    OR (state <> 'committed' AND committed_revision IS NULL))
);

CREATE INDEX idx_rabbit_photo_uploads_expiry
ON rabbit_photo_uploads (rabbitry_id, rabbit_typed_id, expires_at)
WHERE state = 'reserved';

-- The rabbit revision and its upload receipt commit or roll back together.
CREATE TRIGGER trg_rabbit_photo_upload_commit
AFTER INSERT ON rabbit_record_versions
WHEN NEW.deleted_at IS NULL AND json_type(NEW.envelope, '$.record.cloudPhotoGalleryV1.photos') = 'array'
BEGIN
  UPDATE rabbit_photo_uploads
  SET state = 'committed', committed_revision = NEW.revision
  WHERE rabbitry_id = NEW.rabbitry_id AND rabbit_typed_id = NEW.typed_id
    AND base_revision = NEW.revision - 1 AND state = 'reserved'
    AND EXISTS (
      SELECT 1 FROM json_each(NEW.envelope, '$.record.cloudPhotoGalleryV1.photos') p
      WHERE json_extract(p.value, '$.id') = photo_id AND json_extract(p.value, '$.sha256') = sha256
    );
END;
