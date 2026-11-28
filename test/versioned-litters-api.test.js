import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost as createLitter } from "../functions/api/test-create-versioned-litter.js";
import { onRequestPost as createKit } from "../functions/api/test-create-versioned-kit.js";
import { onRequestPost as createRabbit } from "../functions/api/test-create-versioned-rabbit.js";
import { onRequestPost as updateRabbit } from "../functions/api/test-update-versioned-rabbit.js";
import { onRequestPost as deleteRabbit } from "../functions/api/test-delete-versioned-rabbit.js";
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

function kitRequest(f, litterTypedId, record = { _id: "kit-1", Name: "Kit" }, rabbitryId = "woods") {
  return post("test-create-versioned-kit", f.accessToken, { rabbitryId, litterTypedId, record });
}

test("kits inherit snapshots, accept Unknown, retain profile fields and protect their litter until tombstoned", async t => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  const { litter } = await json(await create(f, draft("litter-1", { Breed: "Rex" })), 201);
  const request = kitRequest(f, litter.typedId, { _id: "kit-1", Name: "Kit", Father: "Ignored",
    Breed: "Ignored", DoB: "2020-01-01", weightHistory: [{ date: "2026-12-02", ounces: 4 }] });
  const base = f.env.DB;
  const inclusive = { ...f.env, DB: { prepare(sql) {
    const statement = base.prepare(sql);
    if (!sql.startsWith("INSERT INTO rabbit_record_versions")) return statement;
    return { bind(...args) {
      return { async run() {
        const result = await statement.bind(...args).run();
        if (result.meta.changes > 0) result.meta.changes += 1;
        return result;
      } };
    } };
  } } };
  const { rabbit } = await json(await createKit({ request, env: inclusive }), 201);
  const record = rabbit.envelope.record;
  assert.deepEqual([record.litterTypedId, record.FatherTypedId, record.MotherTypedId,
    record.Father, record.Mother, record.DoB, record.Breed, record.Sex],
  [litter.typedId, BUCK, DOE, "Historical Buck", "Historical Doe", "2026-12-02", "Rex", "Unknown"]);
  const update = (record, baseRevision = 0) => updateRabbit({ env: f.env, request: post(
    "test-update-versioned-rabbit", f.accessToken, { rabbitryId: "woods", baseRevision, record }) });
  for (const field of ["litterTypedId", "FatherTypedId", "MotherTypedId", "Father", "Mother"]) {
    assert.equal((await update({ ...record, [field]: "changed" })).status, 400);
  }
  assert.equal((await updateRabbit({ env: f.env, request: post(
    "test-update-versioned-rabbit", f.accessToken,
    { rabbitryId: "woods", baseRevision: 0, record, parentChanges: { Father: null } }
  ) })).status, 400);
  const revised = await json(await update({ ...record, Archived: true,
    kitMilestones: { weaned: "2027-01-02" } }), 200);
  assert.deepEqual(revised.rabbit.envelope.record.weightHistory, record.weightHistory);
  assert.equal(revised.rabbit.envelope.record.kitMilestones.weaned, "2027-01-02");
  assert.equal((await update(record)).status, 409);
  const removeLitter = () => deleteLitter({ env: f.env, request: post("test-delete-versioned-litter",
    f.accessToken, { rabbitryId: "woods", typedId: litter.typedId, baseRevision: 0 }) });
  assert.equal((await removeLitter()).status, 409);
  const removed = await json(await deleteRabbit({ env: f.env, request: post("test-delete-versioned-rabbit",
    f.accessToken, { rabbitryId: "woods", typedId: rabbit.typedId, baseRevision: 1 }) }), 200);
  assert.equal(removed.rabbit.envelope.record.litterTypedId, litter.typedId);
  assert.equal(removed.rabbit.envelope.record.FatherTypedId, BUCK);
  assert.equal((await removeLitter()).status, 200);
  assert.equal((await createKit({ request: kitRequest(f, litter.typedId), env: f.env })).status, 404);
});

test("kit creation rejects invalid relationships, unauthorized requests and ordinary rabbit injection", async t => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  const { litter } = await json(await create(f), 201);
  const submit = request => createKit({ request, env: f.env });
  addRabbitry(f.database, "other");
  addRabbitry(f.database, "viewer", "viewer");
  assert.equal((await submit(kitRequest(f, litter.typedId, undefined, "other"))).status, 404);
  assert.equal((await submit(kitRequest(f, litter.typedId, undefined, "viewer"))).status, 403);
  assert.equal((await submit(kitRequest(f, "raw-id"))).status, 400);
  assert.equal((await submit(post("test-create-versioned-kit", null, {}))).status, 401);
  assert.equal((await createKit({ request: kitRequest(f, litter.typedId),
    env: { ...f.env, TEST_DATABASE: "production" } })).status, 403);
  const record = { _id: "ordinary", Name: "Ordinary" };
  const rabbitRequest = (handler, endpoint, input) => handler({ env: f.env, request: post(endpoint,
    f.accessToken, { rabbitryId: "woods", ...input }) });
  assert.equal((await rabbitRequest(createRabbit, "test-create-versioned-rabbit",
    { record: { ...record, litterTypedId: litter.typedId } })).status, 400);
  assert.equal((await rabbitRequest(createRabbit, "test-create-versioned-rabbit", { record })).status, 201);
  assert.equal((await rabbitRequest(updateRabbit, "test-update-versioned-rabbit",
    { record: { ...record, FatherTypedId: BUCK }, baseRevision: 0 })).status, 400);
  seedRabbit(f.database, "woods", "buck-1", "Historical Buck", "Doe", { revision: 1 });
  assert.equal((await submit(kitRequest(f, litter.typedId))).status, 409);
  f.database.exec("DROP TRIGGER trg_litter_delete_requires_no_live_kits");
  assert.equal((await submit(kitRequest(f, litter.typedId))).status, 503);
});

for (const parentState of ["missing", "tombstoned"]) {
  test(`kit creation rejects a ${parentState} parent`, async t => {
    const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
    const { litter } = await json(await create(f), 201);
    if (parentState === "missing") {
      f.database.prepare("DELETE FROM rabbit_record_versions WHERE rabbitry_id = ? AND typed_id = ?")
        .run("woods", BUCK);
    } else {
      seedRabbit(f.database, "woods", "buck-1", "Historical Buck", "Buck", { revision: 1, deletedAt: now });
    }
    await json(await createKit({ request: kitRequest(f, litter.typedId), env: f.env }), 409);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM rabbit_record_versions WHERE typed_id = ?")
      .get(encodeRabbitId("kit-1")).count, 0);
  });
}

test("a subsequent parent soft deletion preserves the kit's historical parent references", async t => {
  const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
  const { litter } = await json(await create(f), 201);
  const { rabbit: kit } = await json(await createKit({
    request: kitRequest(f, litter.typedId), env: f.env
  }), 201);
  await json(await deleteRabbit({ env: f.env, request: post("test-delete-versioned-rabbit",
    f.accessToken, { rabbitryId: "woods", typedId: BUCK, baseRevision: 0 }) }), 200);
  const row = f.database.prepare(
    "SELECT envelope, deleted_at FROM rabbit_record_versions WHERE rabbitry_id = ? AND typed_id = ? ORDER BY revision DESC LIMIT 1"
  ).get("woods", kit.typedId);
  assert.equal(row.deleted_at, null);
  assert.deepEqual(JSON.parse(row.envelope), kit.envelope);
  assert.equal(kit.envelope.record.FatherTypedId, BUCK);
  assert.equal(kit.envelope.record.Father, "Historical Buck");
});

for (const kitWins of [true, false]) {
  test(`concurrent litter deletion and kit creation are atomic when ${kitWins ? "creation" : "deletion"} wins`, async t => {
    const f = await createTestDatabase(); t.after(() => f.close()); setup(f.database);
    const { litter } = await json(await create(f), 201);
    const add = env => createKit({ env, request: kitRequest(f, litter.typedId) });
    const remove = env => deleteLitter({ env, request: post("test-delete-versioned-litter",
      f.accessToken, { rabbitryId: "woods", typedId: litter.typedId, baseRevision: 0 }) });
    const losingTable = kitWins ? "litter_record_versions" : "rabbit_record_versions";
    let winningResponse;
    const env = { ...f.env, DB: { prepare(sql) {
      const statement = f.env.DB.prepare(sql);
      if (!sql.startsWith(`INSERT INTO ${losingTable}`)) return statement;
      return { bind(...args) {
        return { async run() {
          winningResponse = await (kitWins ? add : remove)(f.env);
          return statement.bind(...args).run();
        } };
      } };
    } } };
    assert.equal((await (kitWins ? remove : add)(env)).status, 409);
    assert.equal(winningResponse.status, kitWins ? 201 : 200);
  });
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
