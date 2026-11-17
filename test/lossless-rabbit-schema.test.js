import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createRabbitEnvelope,
  deriveRabbitProjections,
  validateRabbitEnvelope
} from "../rabbit-record-contract.js";
import { decodeRabbitId, encodeRabbitId } from "../rabbit-typed-id.js";
import { createTestDatabase } from "./support/d1-test-database.js";

const migrationsDirectory = new URL("../migrations/", import.meta.url);

function addRabbitry(database, id, subject = "access-subject-owner") {
  database.prepare(`
    INSERT INTO rabbitries
      (id, name, created_by_access_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, `Rabbitry ${id}`, subject, "2026-11-17T08:00:00.000Z", "2026-11-17T08:00:00.000Z");
  database.prepare(`
    INSERT INTO rabbitry_memberships
      (rabbitry_id, access_subject, role, created_at, updated_at)
    VALUES (?, ?, 'owner', ?, ?)
  `).run(id, subject, "2026-11-17T08:00:00.000Z", "2026-11-17T08:00:00.000Z");
}

function addVersion(database, rabbitryId, envelope) {
  const projections = deriveRabbitProjections(envelope.record);
  database.prepare(`
    INSERT INTO rabbit_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at,
       name_normalized, sex_normalized, birth_date_normalized, envelope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rabbitryId,
    encodeRabbitId(envelope.id),
    envelope.revision,
    envelope.schemaVersion,
    envelope.createdAt,
    envelope.updatedAt,
    projections.name,
    projections.sex,
    projections.birthDate,
    JSON.stringify(envelope)
  );
}

test("future schema is additive and keeps existing TEST rabbits accessible", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = (await readdir(migrationsDirectory)).filter(name => /^00[1-3].*\.sql$/.test(name)).sort();
  for (const migration of migrations) {
    database.exec(await readFile(new URL(migration, migrationsDirectory), "utf8"));
  }
  const legacy = { _id: "TEST-existing", Name: "Maple", Sex: "Doe", imported: { intact: true } };
  database.prepare("INSERT INTO rabbits (id, name, sex, data) VALUES (?, ?, ?, ?)")
    .run(legacy._id, legacy.Name, legacy.Sex, JSON.stringify(legacy));

  const stage3cMigration = await readFile(new URL("004_future_lossless_rabbits.sql", migrationsDirectory), "utf8");
  database.exec(stage3cMigration);
  database.exec(stage3cMigration);

  assert.deepEqual(JSON.parse(database.prepare("SELECT data FROM rabbits WHERE id = ?").get(legacy._id).data), legacy);
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  for (const table of ["rabbitries", "rabbitry_memberships", "rabbit_record_versions"]) {
    assert.equal(database.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(table).type, "table");
  }
  const versionPrimaryKey = database.prepare("PRAGMA table_info(rabbit_record_versions)").all()
    .filter(column => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(column => column.name);
  assert.deepEqual(versionPrimaryKey, ["rabbitry_id", "typed_id", "revision"]);
  assert.deepEqual(
    database.prepare("PRAGMA foreign_key_list(rabbit_record_versions)").all().map(key => key.table),
    ["rabbitries"]
  );
  const indexes = new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%'
  `).all().map(index => index.name));
  for (const index of [
    "idx_rabbitry_memberships_subject",
    "idx_rabbit_record_versions_latest",
    "idx_rabbit_record_versions_name",
    "idx_rabbit_record_versions_sex_birth"
  ]) {
    assert.ok(indexes.has(index), `missing ${index}`);
  }
});

test("typed ID encoding is reversible and prevents numeric/string collisions", () => {
  for (const id of ["7", "", "legacy:å/兔", 7, -12.5, 0, -0, Number.MAX_SAFE_INTEGER]) {
    const decoded = decodeRabbitId(encodeRabbitId(id));
    assert.ok(Object.is(decoded, id), `${String(id)} must round trip with its exact type and value`);
  }
  assert.notEqual(encodeRabbitId(7), encodeRabbitId("7"));
  assert.notEqual(encodeRabbitId(0), encodeRabbitId(-0));
  assert.throws(() => decodeRabbitId("n:7"), /invalid number representation/);
  assert.throws(() => encodeRabbitId(Number.NaN), /finite number/);

  const negativeZeroEnvelope = createRabbitEnvelope({
    id: -0,
    revision: 0,
    createdAt: "2026-11-17T08:00:00.000Z",
    updatedAt: "2026-11-17T08:00:00.000Z",
    record: { _id: -0 }
  });
  assert.ok(Object.is(negativeZeroEnvelope.id, -0));
  assert.ok(Object.is(decodeRabbitId(encodeRabbitId(negativeZeroEnvelope.id)), -0));
  assert.ok(Object.is(JSON.parse(JSON.stringify(negativeZeroEnvelope)).id, 0),
    "JSON number serialization canonicalizes negative zero to positive zero");
});

test("rabbit revisions are isolated by rabbitry and typed identity", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const { database } = fixture;
  addRabbitry(database, "woods-a");
  addRabbitry(database, "woods-b", "access-subject-other");
  const metadata = {
    revision: 0,
    createdAt: "2026-11-17T08:00:00.000Z",
    updatedAt: "2026-11-17T08:00:00.000Z"
  };
  const numeric = createRabbitEnvelope({ ...metadata, id: 7, record: { _id: 7, Name: "Numeric" } });
  const textual = createRabbitEnvelope({ ...metadata, id: "7", record: { _id: "7", Name: "Text" } });

  addVersion(database, "woods-a", numeric);
  addVersion(database, "woods-a", textual);
  addVersion(database, "woods-b", numeric);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM rabbit_record_versions").get().count, 3);
  assert.throws(() => addVersion(database, "woods-a", numeric), /UNIQUE constraint failed/);
});

test("foreign keys, memberships, envelope checks, and append-only revisions are enforced", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const { database } = fixture;
  addRabbitry(database, "woods-a", "verified-access-subject");
  assert.equal(
    database.prepare("SELECT access_subject FROM rabbitry_memberships WHERE rabbitry_id = 'woods-a'").get().access_subject,
    "verified-access-subject"
  );
  assert.throws(() => database.prepare(`
    INSERT INTO rabbitry_memberships
      (rabbitry_id, access_subject, role, created_at, updated_at)
    VALUES ('missing', 'subject', 'viewer', 'now', 'now')
  `).run(), /FOREIGN KEY constraint failed/);
  assert.throws(() => database.prepare(`
    INSERT INTO rabbitry_memberships
      (rabbitry_id, access_subject, role, created_at, updated_at)
    VALUES ('woods-a', 'subject', 'superuser', 'now', 'now')
  `).run(), /CHECK constraint failed/);

  const first = createRabbitEnvelope({
    id: "r-1", revision: 0,
    createdAt: "2026-11-17T08:00:00.000Z", updatedAt: "2026-11-17T08:00:00.000Z",
    record: { _id: "r-1", Name: "  Maple  ", Sex: "DoE", DoB: "04/15/2025", imported: { nested: [1, null] } }
  });
  const second = createRabbitEnvelope({ ...first, revision: 1, updatedAt: "2026-11-17T09:00:00.000Z" });
  addVersion(database, "woods-a", first);
  addVersion(database, "woods-a", second);

  const rows = database.prepare(`
    SELECT revision, name_normalized, sex_normalized, birth_date_normalized, envelope
    FROM rabbit_record_versions WHERE rabbitry_id = ? AND typed_id = ? ORDER BY revision
  `).all("woods-a", encodeRabbitId("r-1"));
  assert.equal(rows.length, 2);
  assert.deepEqual(validateRabbitEnvelope(JSON.parse(rows[0].envelope)), first);
  assert.equal(rows[0].name_normalized, "Maple");
  assert.equal(rows[0].sex_normalized, "doe");
  assert.equal(rows[0].birth_date_normalized, "2025-04-15");
  const latest = database.prepare(`
    SELECT revision, envelope FROM rabbit_record_versions
    WHERE rabbitry_id = ? AND typed_id = ?
    ORDER BY revision DESC LIMIT 1
  `).get("woods-a", encodeRabbitId("r-1"));
  assert.equal(latest.revision, 1);
  assert.deepEqual(validateRabbitEnvelope(JSON.parse(latest.envelope)), second);
  const latestPlan = database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT revision FROM rabbit_record_versions
    WHERE rabbitry_id = ? AND typed_id = ?
    ORDER BY revision DESC LIMIT 1
  `).all("woods-a", encodeRabbitId("r-1"));
  assert.match(latestPlan.map(step => step.detail).join(" "), /idx_rabbit_record_versions_latest/);

  const invalid = { ...first, revision: 9 };
  assert.throws(() => database.prepare(`
    INSERT INTO rabbit_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at, envelope)
    VALUES ('woods-a', ?, 2, 1, ?, ?, ?)
  `).run(encodeRabbitId("r-1"), first.createdAt, first.updatedAt, JSON.stringify(invalid)), /CHECK constraint failed/);

  assert.throws(() => database.prepare(`
    INSERT INTO rabbit_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at, envelope)
    VALUES ('woods-a', ?, 4, 2, ?, ?, ?)
  `).run(
    encodeRabbitId("r-1"),
    first.createdAt,
    first.updatedAt,
    JSON.stringify({ ...first, revision: 4 })
  ), /CHECK constraint failed/);

  for (const invalidTypedId of ["s:not-json", "s:\"different-id\"", "n:gggggggggggggggg"]) {
    assert.throws(() => database.prepare(`
      INSERT INTO rabbit_record_versions
        (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at, envelope)
      VALUES ('woods-a', ?, 3, 1, ?, ?, ?)
    `).run(
      invalidTypedId,
      first.createdAt,
      first.updatedAt,
      JSON.stringify({ ...first, revision: 3 })
    ), /CHECK constraint failed|malformed JSON/);
  }
});
