import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./support/d1-test-database.js";

test("all migrations reconstruct the evidenced cloud test tables and index", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());

  const objects = fixture.database.prepare(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')"
  ).all();
  const names = new Map(objects.map((object) => [object.name, object.type]));

  for (const table of [
    "cloud_backups",
    "test_environment",
    "rabbits",
    "litters",
    "breedings"
  ]) {
    assert.equal(names.get(table), "table", `missing ${table} table`);
  }
  assert.equal(names.get("idx_cloud_backups_created"), "index");
  assert.equal(names.get("idx_cloud_backups_owner_created"), "index");

  const backupColumns = fixture.database.prepare(
    "PRAGMA table_info(cloud_backups)"
  ).all().map(column => column.name);
  for (const column of [
    "id", "created_at", "device_id", "backup_data",
    "owner_id", "format_version", "byte_size"
  ]) {
    assert.ok(backupColumns.includes(column), `missing cloud_backups.${column}`);
  }

  assert.equal(
    fixture.database.prepare("SELECT marker FROM test_environment").get().marker,
    "tangled-woods-dev-v2"
  );
});

test("database constraints reject duplicate IDs, invalid sex, and invalid JSON", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const insert = fixture.database.prepare(
    "INSERT INTO rabbits (id, name, sex, data) VALUES (?, ?, ?, ?)"
  );

  insert.run("TEST-001", "Maple", "Doe", JSON.stringify({ _id: "TEST-001" }));
  assert.throws(
    () => insert.run("TEST-001", "Other", "Doe", "{}"),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => insert.run("TEST-002", "Other", "Unknown", "{}"),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insert.run("TEST-003", "Other", "Buck", "not-json"),
    /CHECK constraint failed/
  );
});

