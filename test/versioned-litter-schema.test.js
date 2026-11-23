import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = new URL("../migrations/", import.meta.url);

test("Migration 006 is additive, idempotent, and installs litter history and atomic link schema", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of ["001_cloud_backups.sql", "002_cloud_test_schema.sql", "003_secure_cloud_backups.sql",
    "004_future_lossless_rabbits.sql", "005_versioned_breedings.sql", "006_versioned_litters.sql"]) {
    db.exec(await readFile(new URL(name, migrations), "utf8"));
  }
  const legacy = { _id: "legacy-litter", Born: "2026-01-01" };
  db.prepare("INSERT INTO litters (id, data) VALUES (?, ?)").run(legacy._id, JSON.stringify(legacy));
  db.exec(await readFile(new URL("006_versioned_litters.sql", migrations), "utf8"));
  assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM litters WHERE id = ?").get(legacy._id).data), legacy);
  for (const name of ["litter_record_versions", "breeding_litter_links"]) {
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name).type, "table");
  }
  assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name = 'trg_litter_revision_zero_link'").get().type,
    "trigger");
  const pk = db.prepare("PRAGMA table_info(litter_record_versions)").all().filter(c => c.pk)
    .sort((a, b) => a.pk - b.pk).map(c => c.name);
  assert.deepEqual(pk, ["rabbitry_id", "typed_id", "revision"]);
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(x => x.name));
  for (const name of ["idx_litter_record_versions_latest", "idx_litter_record_versions_birth",
    "idx_litter_record_versions_breeding", "idx_litter_record_versions_parents"]) assert.ok(indexes.has(name));
});
