import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost as createLitter } from "../functions/api/test-create-versioned-litter.js";
import { onRequestPost as updateLitter } from "../functions/api/test-update-versioned-litter.js";
import { onRequestPost as deleteLitter } from "../functions/api/test-delete-versioned-litter.js";
import { onRequestGet as readLitters } from "../functions/api/test-versioned-litters.js";
import { onRequestPost as deleteBreeding } from "../functions/api/test-delete-versioned-breeding.js";
import { createBreedingEnvelope } from "../breeding-litter-contracts.js";
import { createRabbitEnvelope, deriveRabbitProjections } from "../rabbit-record-contract.js";
import { encodeRabbitId } from "../rabbit-typed-id.js";
import { createTestDatabase } from "./support/d1-test-database.js";

const origin = "https://local.test";
const now = "2026-11-23T12:00:00.000Z";
const DOE = encodeRabbitId("doe-1");
const BUCK = encodeRabbitId("buck-1");
const BREEDING = encodeRabbitId("breeding-1");

function post(path, token, body, options = {}) {
  return new Request(`${origin}/api/${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", ...(options.omitOrigin ? {} : { Origin: options.origin ?? origin }),
    ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}) }, body: JSON.stringify(body) });
}
async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
function addRabbitry(db, id = "woods", role = "editor") {
  db.prepare(`INSERT INTO rabbitries (id,name,created_by_access_subject,created_at,updated_at)
    VALUES (?,?,'bootstrap',?,?)`).run(id, id, now, now);
  db.prepare(`INSERT INTO rabbitry_memberships (rabbitry_id,access_subject,role,created_at,updated_at)
    VALUES (?,'integration-test-user',?,?,?)`).run(id, role, now, now);
}
function seedRabbit(db, rabbitryId, id, name, sex, options = {}) {
  const record = { _id: id, Name: name, Sex: sex, ...(options.archived ? { Archived: true } : {}) };
  const envelope = createRabbitEnvelope({ id, revision: options.revision ?? 0, createdAt: now, updatedAt: now, record });
  const p = deriveRabbitProjections(record);
  db.prepare(`INSERT INTO rabbit_record_versions
    (rabbitry_id,typed_id,revision,schema_version,created_at,updated_at,deleted_at,
     name_normalized,sex_normalized,birth_date_normalized,envelope) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(rabbitryId, encodeRabbitId(id), envelope.revision, envelope.schemaVersion, now, now,
    options.deletedAt ?? null, p.name, p.sex, p.birthDate, JSON.stringify(envelope));
}
function seedBreeding(db, rabbitryId = "woods", options = {}) {
  const record = { _id: "breeding-1", doeTypedId: DOE, buckTypedId: BUCK, date: "2026-11-01",
    expectedKindlingDate: "2026-12-02", kindledDate: "", status: "Kindled", outcome: "Live litter" };
  const envelope = createBreedingEnvelope({ id: record._id, revision: options.revision ?? 0,
    createdAt: now, updatedAt: now, record });
  db.prepare(`INSERT INTO breeding_record_versions
    (rabbitry_id,typed_id,revision,schema_version,created_at,updated_at,deleted_at,doe_typed_id,
     buck_typed_id,breeding_date,expected_kindling_date,kindled_date,status,outcome,envelope)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(rabbitryId, BREEDING, envelope.revision,
    envelope.schemaVersion, now, now, options.deletedAt ?? null, DOE, BUCK, record.date,
    record.expectedKindlingDate, null, record.status, record.outcome, JSON.stringify(envelope));
}
function setup(db, role = "editor") {
  addRabbitry(db, "woods", role);
  seedRabbit(db, "woods", "doe-1", "Historical Doe", "Doe");
  seedRabbit(db, "woods", "buck-1", "Historical Buck", "Buck");
  seedBreeding(db);
}
function draft(id = "litter-1", overrides = {}) {
  return { _id: id, Born: "2026-12-02", "Total Kits": "6", status: "Born", Notes: "initial",
    custom: { preserved: true }, ...overrides };
}
async function create(f, record = draft()) {
  return createLitter({ request: post("test-create-versioned-litter", f.accessToken,
    { rabbitryId: "woods", breedingTypedId: BREEDING, record }), env: f.env });
}

test("create-from-breeding snapshots canonical relationships and lists detail without legacy writes", async (t) => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  seedRabbit(f.database, "woods", "doe-1", "Historical Doe", "Doe", { revision: 1, archived: true });
  const created = await json(await create(f), 201);
  assert.deepEqual(created.litter.envelope.record, { ...draft(), breedingTypedId: BREEDING,
    damTypedId: DOE, sireTypedId: BUCK, Dam: "Historical Doe", Sire: "Historical Buck", Bred: "2026-11-01" });
  assert.equal(created.litter.envelope.revision, 0);
  const list = await json(await readLitters({ request: new Request(
    `${origin}/api/test-versioned-litters?rabbitryId=woods`,
    { headers: { "Cf-Access-Jwt-Assertion": f.accessToken } }), env: f.env }), 200);
  assert.deepEqual(list.litters, [created.litter]);
  const detail = await json(await readLitters({ request: new Request(
    `${origin}/api/test-versioned-litters?rabbitryId=woods&typedId=${encodeURIComponent(created.litter.typedId)}`,
    { headers: { "Cf-Access-Jwt-Assertion": f.accessToken } }), env: f.env }), 200);
  assert.deepEqual(detail.litter, created.litter);
  assert.equal(f.database.prepare("SELECT COUNT(*) count FROM litters").get().count, 0);
});

test("trigger-inclusive D1 change counts do not turn a committed create into a false conflict", async (t) => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  const base = f.env.DB;
  const env = { ...f.env, DB: { prepare(sql) {
    const prepared = base.prepare(sql);
    if (!/^INSERT INTO litter_record_versions/.test(sql)) return prepared;
    return { bind(...values) {
      const bound = prepared.bind(...values);
      return { async run() {
        const result = await bound.run();
        return { ...result, meta: { ...result.meta, changes: 2 } };
      } };
    } };
  } } };
  const response = await createLitter({ request: post("test-create-versioned-litter", f.accessToken,
    { rabbitryId: "woods", breedingTypedId: BREEDING, record: draft() }), env });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(f.database.prepare("SELECT COUNT(*) count FROM litter_record_versions").get().count, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) count FROM breeding_litter_links").get().count, 1);
});

test("authorization, origin, environment, role, malformed dates, and kit counts fail closed", async (t) => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  assert.equal((await createLitter({ request: post("test-create-versioned-litter", null,
    { rabbitryId: "woods", breedingTypedId: BREEDING, record: draft() }), env: f.env })).status, 401);
  assert.equal((await createLitter({ request: post("test-create-versioned-litter", f.accessToken,
    { rabbitryId: "woods", breedingTypedId: BREEDING, record: draft() }, { omitOrigin: true }), env: f.env })).status, 403);
  assert.equal((await createLitter({ request: post("test-create-versioned-litter", f.accessToken,
    { rabbitryId: "woods", breedingTypedId: BREEDING, record: draft() }),
    env: { ...f.env, TEST_DATABASE: "production" } })).status, 403);
  for (const record of [draft("bad-date", { Born: "2026-02-30" }), draft("bad-count", { "Total Kits": "-1" })]) {
    assert.equal((await create(f, record)).status, 400);
  }
  addRabbitry(f.database, "view", "viewer");
  assert.equal((await createLitter({ request: post("test-create-versioned-litter", f.accessToken,
    { rabbitryId: "view", breedingTypedId: BREEDING, record: draft("viewer") }), env: f.env })).status, 403);
});

test("one breeding can claim only one litter atomically under concurrent creates", async (t) => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  const responses = await Promise.all([create(f, draft("litter-a")), create(f, draft("litter-b"))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(f.database.prepare("SELECT COUNT(*) count FROM litter_record_versions").get().count, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) count FROM breeding_litter_links").get().count, 1);
});

test("updates append complete revisions, preserve unknown fields, and reject stale or relationship edits", async (t) => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  const created = await json(await create(f), 201);
  const record = { ...created.litter.envelope.record, Notes: "changed" };
  delete record.custom;
  const updated = await json(await updateLitter({ request: post("test-update-versioned-litter", f.accessToken,
    { rabbitryId: "woods", baseRevision: 0, record }), env: f.env }), 200);
  assert.deepEqual(updated.litter.envelope.record.custom, { preserved: true });
  assert.equal(updated.litter.envelope.revision, 1);
  assert.equal((await updateLitter({ request: post("test-update-versioned-litter", f.accessToken,
    { rabbitryId: "woods", baseRevision: 0, record }), env: f.env })).status, 409);
  assert.equal((await updateLitter({ request: post("test-update-versioned-litter", f.accessToken,
    { rabbitryId: "woods", baseRevision: 1, record: { ...updated.litter.envelope.record, Dam: "Changed" } }),
    env: f.env })).status, 400);
});

test("litter deletion tombstones history and live linked kits protect deletion when kit support exists", async (t) => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  const created = await json(await create(f), 201);
  f.database.exec(`CREATE TABLE kit_record_versions (
    rabbitry_id TEXT, typed_id TEXT, revision INTEGER, litter_typed_id TEXT, deleted_at TEXT)`);
  f.database.prepare("INSERT INTO kit_record_versions VALUES (?,?,?,?,NULL)").run(
    "woods", encodeRabbitId("kit-1"), 0, created.litter.typedId);
  const request = () => post("test-delete-versioned-litter", f.accessToken,
    { rabbitryId: "woods", typedId: created.litter.typedId, baseRevision: 0 });
  assert.deepEqual(await json(await deleteLitter({ request: request(), env: f.env }), 409),
    { error: "Litter has live linked kits" });
  f.database.prepare("UPDATE kit_record_versions SET deleted_at = ?").run(now);
  const deleted = await json(await deleteLitter({ request: request(), env: f.env }), 200);
  assert.equal(deleted.litter.envelope.revision, 1);
  const list = await json(await readLitters({ request: new Request(
    `${origin}/api/test-versioned-litters?rabbitryId=woods`,
    { headers: { "Cf-Access-Jwt-Assertion": f.accessToken } }), env: f.env }), 200);
  assert.deepEqual(list.litters, []);
  assert.deepEqual(list.claimedBreedingTypedIds, [BREEDING]);
  assert.equal(f.database.prepare("SELECT COUNT(*) count FROM breeding_litter_links").get().count, 1,
    "historical breeding claim remains after tombstone");
});

test("a live linked litter blocks breeding deletion without cascading history", async (t) => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  await json(await create(f), 201);
  const response = await deleteBreeding({ request: post("test-delete-versioned-breeding", f.accessToken,
    { rabbitryId: "woods", typedId: BREEDING, baseRevision: 0 }), env: f.env });
  assert.deepEqual(await json(response, 409), { error: "Breeding has a live linked litter" });
  assert.equal(f.database.prepare("SELECT COUNT(*) count FROM breeding_record_versions").get().count, 1);
});

test("deleted or cross-rabbitry breedings cannot create litters and a tombstone never frees the claim", async (t) => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  const created = await json(await create(f), 201);
  await json(await deleteLitter({ request: post("test-delete-versioned-litter", f.accessToken,
    { rabbitryId: "woods", typedId: created.litter.typedId, baseRevision: 0 }), env: f.env }), 200);
  assert.equal((await create(f, draft("second"))).status, 409);
  addRabbitry(f.database, "other");
  assert.equal((await createLitter({ request: post("test-create-versioned-litter", f.accessToken,
    { rabbitryId: "other", breedingTypedId: BREEDING, record: draft("foreign") }), env: f.env })).status, 400);
});
