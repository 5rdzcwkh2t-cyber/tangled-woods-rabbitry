import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createBreedingEnvelope } from "../breeding-litter-contracts.js";
import { createRabbitEnvelope, deriveRabbitProjections } from "../rabbit-record-contract.js";
import { encodeRabbitId } from "../rabbit-typed-id.js";

const migrations = new URL("../migrations/", import.meta.url);
const now = "2026-11-21T12:00:00.000Z";

async function databaseThrough005(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "001_cloud_backups.sql", "002_cloud_test_schema.sql", "003_secure_cloud_backups.sql",
    "004_future_lossless_rabbits.sql", "005_versioned_breedings.sql"
  ]) database.exec(await readFile(new URL(name, migrations), "utf8"));
  return database;
}

function breeding(id = "breeding-1") {
  return {
    _id: id,
    doeTypedId: encodeRabbitId("doe-1"),
    buckTypedId: encodeRabbitId("buck-1"),
    date: "2026-11-21",
    expectedKindlingDate: "2026-12-22",
    kindledDate: "",
    status: "Bred",
    outcome: "Not recorded",
    notes: "preserved",
    unknown: { nested: [1, null, true] }
  };
}

function insertBreeding(database, rabbitryId, envelope, overrides = {}) {
  const record = envelope.record;
  database.prepare(`
    INSERT INTO breeding_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at,
       deleted_at, doe_typed_id, buck_typed_id, breeding_date,
       expected_kindling_date, kindled_date, status, outcome, envelope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rabbitryId, overrides.typedId ?? encodeRabbitId(envelope.id), envelope.revision,
    envelope.schemaVersion, envelope.createdAt, envelope.updatedAt, overrides.deletedAt ?? null,
    overrides.doeTypedId ?? record.doeTypedId, overrides.buckTypedId ?? record.buckTypedId,
    record.date, record.expectedKindlingDate || null, record.kindledDate || null,
    record.status, record.outcome ?? null, JSON.stringify(envelope)
  );
}

test("Migration 005 is additive, idempotent, and creates the versioned breeding indexes", async (t) => {
  const database = await databaseThrough005(t);
  const legacy = { _id: "legacy-b", doeId: "legacy-doe", buckId: "legacy-buck" };
  database.prepare("INSERT INTO breedings (id, data) VALUES (?, ?)").run(legacy._id, JSON.stringify(legacy));
  database.exec(await readFile(new URL("005_versioned_breedings.sql", migrations), "utf8"));
  assert.deepEqual(JSON.parse(database.prepare("SELECT data FROM breedings WHERE id = ?").get(legacy._id).data), legacy);
  assert.equal(database.prepare("SELECT type FROM sqlite_master WHERE name = 'breeding_record_versions'").get().type, "table");
  const primaryKey = database.prepare("PRAGMA table_info(breeding_record_versions)").all()
    .filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
  assert.deepEqual(primaryKey, ["rabbitry_id", "typed_id", "revision"]);
  const indexes = new Set(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index'"
  ).all().map(row => row.name));
  for (const name of [
    "idx_breeding_record_versions_latest", "idx_breeding_record_versions_planner",
    "idx_breeding_record_versions_doe", "idx_breeding_record_versions_buck"
  ]) assert.ok(indexes.has(name), name);
});

test("schema preserves complete envelopes and distinct numeric and string breeding IDs", async (t) => {
  const database = await databaseThrough005(t);
  database.prepare(`INSERT INTO rabbitries
    (id, name, created_by_access_subject, created_at, updated_at)
    VALUES ('woods', 'Woods', 'subject', ?, ?)`
  ).run(now, now);
  for (const id of [7, "7"]) {
    insertBreeding(database, "woods", createBreedingEnvelope({
      id, revision: 0, createdAt: now, updatedAt: now, record: breeding(id)
    }));
  }
  const rows = database.prepare(
    "SELECT typed_id, envelope FROM breeding_record_versions ORDER BY typed_id"
  ).all();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].typed_id, rows[1].typed_id);
  assert.deepEqual(rows.map(row => JSON.parse(row.envelope).record.unknown), [
    { nested: [1, null, true] }, { nested: [1, null, true] }
  ]);
});

test("schema rejects noncanonical breeding and parent IDs and mismatched envelopes", async (t) => {
  const database = await databaseThrough005(t);
  database.prepare(`INSERT INTO rabbitries
    (id, name, created_by_access_subject, created_at, updated_at)
    VALUES ('woods', 'Woods', 'subject', ?, ?)`
  ).run(now, now);
  const envelope = createBreedingEnvelope({
    id: "breeding-1", revision: 0, createdAt: now, updatedAt: now, record: breeding()
  });
  for (const overrides of [
    { typedId: 's:"other"' },
    { doeTypedId: "s:not-json" },
    { buckTypedId: "n:gggggggggggggggg" },
    { buckTypedId: envelope.record.doeTypedId }
  ]) assert.throws(() => insertBreeding(database, "woods", envelope, overrides), /constraint failed|malformed JSON/i);
});
