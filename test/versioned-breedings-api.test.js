import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost as createBreeding } from "../functions/api/test-create-versioned-breeding.js";
import { onRequestPost as updateBreeding } from "../functions/api/test-update-versioned-breeding.js";
import { onRequestPost as deleteBreeding } from "../functions/api/test-delete-versioned-breeding.js";
import { onRequestGet as readBreedings } from "../functions/api/test-versioned-breedings.js";
import { createRabbitEnvelope, deriveRabbitProjections } from "../rabbit-record-contract.js";
import { encodeRabbitId } from "../rabbit-typed-id.js";
import { createTestDatabase } from "./support/d1-test-database.js";

const origin = "https://local.test";
const now = "2026-11-21T12:00:00.000Z";

function post(path, token, body, options = {}) {
  return new Request(`${origin}/api/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.omitOrigin ? {} : { Origin: options.origin ?? origin }),
      ...(token ? { "Cf-Access-Jwt-Assertion": token } : {})
    },
    body: JSON.stringify(body)
  });
}

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

function addRabbitry(database, id, role = "editor", subject = "integration-test-user") {
  database.prepare(`INSERT INTO rabbitries
    (id, name, created_by_access_subject, created_at, updated_at)
    VALUES (?, ?, 'bootstrap', ?, ?)`
  ).run(id, id, now, now);
  database.prepare(`INSERT INTO rabbitry_memberships
    (rabbitry_id, access_subject, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`
  ).run(id, subject, role, now, now);
}

function seedRabbit(database, rabbitryId, id, sex, options = {}) {
  const record = { _id: id, Name: id, Sex: sex, ...(options.archived ? { Archived: true } : {}) };
  const envelope = createRabbitEnvelope({ id, revision: options.revision ?? 0, createdAt: now, updatedAt: now, record });
  const p = deriveRabbitProjections(record);
  database.prepare(`INSERT INTO rabbit_record_versions
    (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at, deleted_at,
     name_normalized, sex_normalized, birth_date_normalized, envelope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(rabbitryId, encodeRabbitId(id), envelope.revision, envelope.schemaVersion,
    now, now, options.deletedAt ?? null, p.name, p.sex, p.birthDate, JSON.stringify(envelope));
}

function breeding(id = "breeding-1", overrides = {}) {
  return {
    _id: id,
    doeTypedId: encodeRabbitId("doe-1"),
    buckTypedId: encodeRabbitId("buck-1"),
    date: "2026-11-21",
    expectedKindlingDate: "2026-12-22",
    kindledDate: "",
    status: "Bred",
    outcome: "Not recorded",
    notes: "initial",
    unknown: { preserved: true },
    ...overrides
  };
}

function setupParents(database, rabbitryId) {
  seedRabbit(database, rabbitryId, "doe-1", "Doe");
  seedRabbit(database, rabbitryId, "buck-1", "Buck");
}

function stored(database, rabbitryId, id = "breeding-1") {
  return database.prepare(`SELECT revision, deleted_at, envelope FROM breeding_record_versions
    WHERE rabbitry_id = ? AND typed_id = ? ORDER BY revision`
  ).all(rabbitryId, encodeRabbitId(id));
}

async function create(fixture, rabbitryId = "woods", record = breeding()) {
  return createBreeding({
    request: post("test-create-versioned-breeding", fixture.accessToken, { rabbitryId, record }),
    env: fixture.env
  });
}

test("authenticated writer creates and reads a complete revision-zero breeding", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods");
  setupParents(fixture.database, "woods");
  const created = await json(await create(fixture), 201);
  assert.equal(created.created, true);
  assert.equal(created.breeding.envelope.revision, 0);
  assert.deepEqual(created.breeding.envelope.record, breeding());
  const listed = await json(await readBreedings({
    request: new Request(`${origin}/api/test-versioned-breedings?rabbitryId=woods`, {
      headers: { "Cf-Access-Jwt-Assertion": fixture.accessToken }
    }), env: fixture.env
  }), 200);
  assert.deepEqual(listed.breedings, [created.breeding]);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) count FROM breedings").get().count, 0,
    "legacy mutable table must remain unused");
});

test("read roles are allowed while only owner, admin, and editor may write", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  for (const role of ["owner", "admin", "editor", "viewer"]) {
    addRabbitry(fixture.database, role, role);
    setupParents(fixture.database, role);
    const response = await create(fixture, role, breeding(`${role}-breeding`));
    assert.equal(response.status, role === "viewer" ? 403 : 201, role);
    const read = await readBreedings({
      request: new Request(`${origin}/api/test-versioned-breedings?rabbitryId=${role}`, {
        headers: { "Cf-Access-Jwt-Assertion": fixture.accessToken }
      }), env: fixture.env
    });
    assert.equal(read.status, 200, role);
  }
});

test("authentication, origin, environment, and rabbitry isolation fail closed", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods");
  setupParents(fixture.database, "woods");
  assert.deepEqual(await json(await createBreeding({
    request: post("test-create-versioned-breeding", null, { rabbitryId: "woods", record: breeding() }),
    env: fixture.env
  }), 401), { error: "Authentication required" });
  assert.deepEqual(await json(await createBreeding({
    request: post("test-create-versioned-breeding", fixture.accessToken,
      { rabbitryId: "woods", record: breeding() }, { omitOrigin: true }), env: fixture.env
  }), 403), { error: "Invalid request origin" });
  assert.deepEqual(await json(await createBreeding({
    request: post("test-create-versioned-breeding", fixture.accessToken,
      { rabbitryId: "woods", record: breeding() }), env: { ...fixture.env, TEST_DATABASE: "production" }
  }), 403), { error: "Test environment not configured" });
  assert.deepEqual(await json(await createBreeding({
    request: post("test-create-versioned-breeding", fixture.accessToken,
      { rabbitryId: "other", record: breeding() }), env: fixture.env
  }), 404), { error: "Rabbitry not found" });
});

test("parent validation rejects missing, wrong-sex, archived, deleted, foreign, and identical parents", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  for (const id of ["missing", "wrong", "archived", "deleted", "foreign"]) addRabbitry(fixture.database, id);
  addRabbitry(fixture.database, "other-parents", "editor", "different-user");
  seedRabbit(fixture.database, "missing", "buck-1", "Buck");
  seedRabbit(fixture.database, "wrong", "doe-1", "Buck");
  seedRabbit(fixture.database, "wrong", "buck-1", "Buck");
  seedRabbit(fixture.database, "archived", "doe-1", "Doe", { archived: true });
  seedRabbit(fixture.database, "archived", "buck-1", "Buck");
  seedRabbit(fixture.database, "deleted", "doe-1", "Doe", { deletedAt: now });
  seedRabbit(fixture.database, "deleted", "buck-1", "Buck");
  setupParents(fixture.database, "foreign");
  const foreignRecord = breeding("foreign-b", { doeTypedId: encodeRabbitId("other-doe") });
  seedRabbit(fixture.database, "other-parents", "other-doe", "Doe");
  for (const [id, record] of [
    ["missing", breeding("missing-b")], ["wrong", breeding("wrong-b")],
    ["archived", breeding("archived-b")], ["deleted", breeding("deleted-b")],
    ["foreign", foreignRecord]
  ]) assert.deepEqual(await json(await create(fixture, id, record), 400), { error: "Breeding parents are invalid" });
  assert.deepEqual(await json(await create(fixture, "foreign", breeding("same-b", {
    buckTypedId: encodeRabbitId("doe-1")
  })), 400), { error: "Invalid breeding record" });
  assert.equal(fixture.database.prepare("SELECT COUNT(*) count FROM breeding_record_versions").get().count, 0);
});

test("updates preserve complete history and stale updates return 409", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods");
  setupParents(fixture.database, "woods");
  await json(await create(fixture), 201);
  const changed = breeding("breeding-1", { status: "Confirmed pregnant", notes: "changed" });
  const updated = await json(await updateBreeding({
    request: post("test-update-versioned-breeding", fixture.accessToken,
      { rabbitryId: "woods", baseRevision: 0, record: changed }), env: fixture.env
  }), 200);
  assert.equal(updated.breeding.envelope.revision, 1);
  assert.deepEqual(updated.breeding.envelope.record, changed);
  assert.deepEqual(stored(fixture.database, "woods").map(row => row.revision), [0, 1]);
  assert.deepEqual(await json(await updateBreeding({
    request: post("test-update-versioned-breeding", fixture.accessToken,
      { rabbitryId: "woods", baseRevision: 0, record: breeding() }), env: fixture.env
  }), 409), { error: "Breeding changed since the base revision" });
});

test("duplicate breeding identities remain unavailable after creation or tombstoning", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods");
  setupParents(fixture.database, "woods");
  await json(await create(fixture), 201);
  assert.equal((await create(fixture)).status, 409);
  await json(await deleteBreeding({
    request: post("test-delete-versioned-breeding", fixture.accessToken, {
      rabbitryId: "woods", typedId: encodeRabbitId("breeding-1"), baseRevision: 0
    }), env: fixture.env
  }), 200);
  assert.equal((await create(fixture)).status, 409);
  assert.equal(stored(fixture.database, "woods").length, 2);
});

test("soft deletion appends a tombstone, hides the breeding, and preserves its record", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods");
  setupParents(fixture.database, "woods");
  await json(await create(fixture), 201);
  seedRabbit(fixture.database, "woods", "doe-1", "Doe", { revision: 1, deletedAt: now });
  const deleted = await json(await deleteBreeding({
    request: post("test-delete-versioned-breeding", fixture.accessToken, {
      rabbitryId: "woods", typedId: encodeRabbitId("breeding-1"), baseRevision: 0
    }), env: fixture.env
  }), 200);
  assert.equal(deleted.breeding.envelope.revision, 1);
  assert.deepEqual(deleted.breeding.envelope.record, breeding());
  const rows = stored(fixture.database, "woods");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].deleted_at, null);
  assert.equal(rows[1].deleted_at, deleted.deletedAt);
  const listed = await json(await readBreedings({
    request: new Request(`${origin}/api/test-versioned-breedings?rabbitryId=woods`, {
      headers: { "Cf-Access-Jwt-Assertion": fixture.accessToken }
    }), env: fixture.env
  }), 200);
  assert.deepEqual(listed.breedings, []);
});

test("concurrent update and deletion from one base revision cannot both succeed", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods");
  setupParents(fixture.database, "woods");
  await json(await create(fixture), 201);
  const responses = await Promise.all([
    updateBreeding({ request: post("test-update-versioned-breeding", fixture.accessToken, {
      rabbitryId: "woods", baseRevision: 0, record: breeding("breeding-1", { notes: "race" })
    }), env: fixture.env }),
    deleteBreeding({ request: post("test-delete-versioned-breeding", fixture.accessToken, {
      rabbitryId: "woods", typedId: encodeRabbitId("breeding-1"), baseRevision: 0
    }), env: fixture.env })
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.deepEqual(stored(fixture.database, "woods").map(row => row.revision), [0, 1]);
});

test("atomic insert rechecks latest parents after preflight validation", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods");
  setupParents(fixture.database, "woods");
  let changed = false;
  const env = {
    ...fixture.env,
    DB: {
      prepare(sql) {
        if (!changed && sql.includes("INSERT INTO breeding_record_versions")) {
          changed = true;
          seedRabbit(fixture.database, "woods", "doe-1", "Doe", { revision: 1, deletedAt: now });
        }
        return fixture.env.DB.prepare(sql);
      }
    }
  };
  const response = await createBreeding({
    request: post("test-create-versioned-breeding", fixture.accessToken,
      { rabbitryId: "woods", record: breeding() }), env
  });
  assert.equal(response.status, 409);
  assert.equal(stored(fixture.database, "woods").length, 0);
});
