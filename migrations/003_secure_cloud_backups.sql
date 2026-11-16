-- Ownership and format metadata for authenticated, append-only backups.
-- Existing rows remain unowned and therefore cannot be retrieved by users.

ALTER TABLE cloud_backups ADD COLUMN owner_id TEXT;
ALTER TABLE cloud_backups ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cloud_backups ADD COLUMN byte_size INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_cloud_backups_owner_created
ON cloud_backups(owner_id, created_at DESC, id DESC);
