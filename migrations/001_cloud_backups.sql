CREATE TABLE IF NOT EXISTS cloud_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    device_id TEXT NOT NULL,
    backup_data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_backups_created
ON cloud_backups(created_at);
