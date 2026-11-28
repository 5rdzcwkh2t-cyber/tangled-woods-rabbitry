import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { onRequestPost as createRabbit } from "../functions/api/test-create-versioned-rabbit.js";
import { onRequestPost as updateRabbit } from "../functions/api/test-update-versioned-rabbit.js";
import { onRequestPost as deleteRabbit } from "../functions/api/test-delete-versioned-rabbit.js";
import { onRequestGet as readRabbits } from "../functions/api/test-versioned-rabbits.js";
import { createRabbitEnvelope, deriveRabbitProjections } from "../rabbit-record-contract.js";
import { encodeRabbitId } from "../rabbit-typed-id.js";
import { getTestAuth } from "./support/access-test-auth.js";
import { createTestDatabase } from "./support/d1-test-database.js";

const origin = "https://local.test";
const now = "2026-11-17T08:00:00.000Z";

function post(path, token, body, options = {}) {
  return new Request(`${origin}/api/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.omitOrigin ? {} : { Origin: options.origin ?? origin }),
      ...(options.headers || {}),
      ...(token ? { "Cf-Access-Jwt-Assertion": token } : {})
    },
    body: options.raw ? body : JSON.stringify(body)
  });
}

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

function addRabbitry(database, id, deletedAt = null) {
  database.prepare(`
    INSERT INTO rabbitries
      (id, name, created_by_access_subject, created_at, updated_at, deleted_at)
    VALUES (?, ?, 'bootstrap-subject', ?, ?, ?)
  `).run(id, id, now, now, deletedAt);
}

function addMembership(database, rabbitryId, subject, role, revokedAt = null) {
  database.prepare(`
    INSERT INTO rabbitry_memberships
      (rabbitry_id, access_subject, role, created_at, updated_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(rabbitryId, subject, role, now, now, revokedAt);
}

function record(id, name = "Maple", extra = {}) {
  return {
    _id: id,
    Name: name,
    Sex: "DoE",
    DoB: "04/15/2025",
    imported: { nested: [1, null, { preserved: true }] },
    ...extra
  };
}

function seedVersion(database, rabbitryId, envelope, deletedAt = null, typedId = encodeRabbitId(envelope.id)) {
  const projections = deriveRabbitProjections(envelope.record);
  database.prepare(`
    INSERT INTO rabbit_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at,
       deleted_at, name_normalized, sex_normalized, birth_date_normalized, envelope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rabbitryId, typedId, envelope.revision, envelope.schemaVersion,
    envelope.createdAt, envelope.updatedAt, deletedAt,
    projections.name, projections.sex, projections.birthDate, JSON.stringify(envelope)
  );
}

function storedRows(database, rabbitryId, id) {
  return database.prepare(`
    SELECT revision, deleted_at, envelope FROM rabbit_record_versions
    WHERE rabbitry_id = ? AND typed_id = ? ORDER BY revision
  `).all(rabbitryId, encodeRabbitId(id));
}

async function pedigreeFixture(t, options) {
  const fixture = await createTestDatabase(options);
  t.after(() => fixture.close());
  for (const id of ["woods-a", "woods-b"]) {
    addRabbitry(fixture.database, id);
    addMembership(fixture.database, id, "integration-test-user", "editor");
  }
  const write = (handler, body, rabbitryId = "woods-a") => handler({
    request: post("pedigree-test", fixture.accessToken, { rabbitryId, ...body }), env: fixture.env
  });
  const create = (record, parentChanges, rabbitryId) => write(createRabbit, { record, parentChanges }, rabbitryId);
  const update = (record, baseRevision, parentChanges) => write(updateRabbit, { record, baseRevision, parentChanges });
  const remove = (id, baseRevision) => write(deleteRabbit, { typedId: encodeRabbitId(id), baseRevision });
  return { ...fixture, create, update, remove };
}

test("historical parent names replace links, save without links, and survive unrelated revisions", async t => {
  const { create, update } = await pedigreeFixture(t);
  await json(await create(record("sire", "Linked snapshot", { Sex: "Buck" })), 201);
  const created = await json(await create(record("child"), {
    Father: encodeRabbitId("sire"), Mother: { name: " Historical dam " }
  }), 201);
  assert.equal(created.rabbit.envelope.record.Mother, "Historical dam");
  const changed = await json(await update(created.rabbit.envelope.record, 0, {
    Father: { name: " Historical sire " }, Mother: { name: "Corrected dam" }
  }), 200);
  const first = changed.rabbit.envelope.record;
  assert.equal(first.Father, "Historical sire");
  assert.equal(first.FatherTypedId, undefined);
  assert.equal(first.Mother, "Corrected dam");
  const preserved = await json(await update({ _id: "child", Name: "Unrelated edit" }, 1), 200);
  assert.equal(preserved.rabbit.envelope.record.Father, "Historical sire");
  assert.equal(preserved.rabbit.envelope.record.Mother, "Corrected dam");
  const cleared = await json(await update(preserved.rabbit.envelope.record, 2, { Father: null }), 200);
  assert.equal(cleared.rabbit.envelope.record.Father, undefined);
  const entered = await json(await update(cleared.rabbit.envelope.record, 3, {
    Father: { name: "Sire without a link" }
  }), 200);
  assert.equal(entered.rabbit.envelope.record.Father, "Sire without a link");
  assert.equal(entered.rabbit.envelope.record.FatherTypedId, undefined);
  await json(await update(entered.rabbit.envelope.record, 4, { Father: { name: " " } }), 400);
});

test("parent assignments snapshot names, preserve text-only ancestors, and can be corrected or cleared", async t => {
  const { create, update, remove, database } = await pedigreeFixture(t);
  const sire = record(7, "Old sire", { Sex: "Buck" });
  const replacement = record("7", "Other sire", { Sex: "Buck" });
  await json(await create(sire), 201);
  await json(await create(replacement), 201);
  const child = record("child", "Child", { Father: "Client supplied", Mother: "Historical dam" });
  const created = await json(await create(child, { Father: encodeRabbitId(7) }), 201);
  const linked = created.rabbit.envelope.record;
  assert.equal(linked.Father, "Old sire");
  assert.equal(linked.Mother, "Historical dam");
  await json(await update({ ...sire, Name: "Renamed sire", Archived: true }, 0), 200);
  await json(await remove(7, 1), 200);
  const unchanged = await json(await update({ ...linked, Father: "Spoofed" }, 0), 200);
  assert.equal(unchanged.rabbit.envelope.record.Father, "Old sire");
  await json(await update(linked, 0, { Father: null }), 409);
  const corrected = await json(await update(linked, 1, { Father: encodeRabbitId("7") }), 200);
  assert.equal(corrected.rabbit.envelope.record.Father, "Other sire");
  const cleared = await json(await update(corrected.rabbit.envelope.record, 2, { Father: null }), 200);
  assert.equal(cleared.rabbit.envelope.record.FatherTypedId, undefined);
  assert.equal(cleared.rabbit.envelope.record.Father, undefined);
  assert.equal(cleared.rabbit.envelope.record.Mother, "Historical dam");
  assert.equal(storedRows(database, "woods-a", "child").length, 4);
});

test("new parent links reject malformed, out-of-scope, wrong-sex, archived, deleted and self IDs", async t => {
  const { create, remove, database } = await pedigreeFixture(t);
  const buck = (id, extra) => record(id, id, { Sex: "Buck", ...extra });
  await json(await create(buck("foreign"), undefined, "woods-b"), 201);
  await json(await create(buck("archived", { Archived: true })), 201);
  await json(await create(buck("deleted")), 201);
  await json(await remove("deleted", 0), 200);
  await json(await create(record("doe")), 201);
  for (const id of ["foreign", "archived", "deleted", "doe", "missing", "child"].map(encodeRabbitId).concat("s:malformed")) {
    await json(await create(buck("child"), { Father: id }), 400);
  }
  assert.deepEqual(storedRows(database, "woods-a", "child"), []);
});

test("reciprocal concurrent assignments cannot both commit and longer cycles are rejected", async t => {
  const { create, update, database } = await pedigreeFixture(t);
  const a = record("a", "A", { Sex: "Buck" });
  const b = record("b", "B", { Sex: "Buck" });
  await json(await create(a), 201);
  await json(await create(b), 201);
  const responses = await Promise.all([
    update(a, 0, { Father: encodeRabbitId("b") }),
    update(b, 0, { Father: encodeRabbitId("a") })
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const [child, ancestor] = responses[0].ok ? [a, b] : [b, a];
  const c = record("c", "C");
  await json(await create(c, { Father: encodeRabbitId(child._id) }), 201);
  const result = await json(await update(ancestor, 0, { Mother: encodeRabbitId("c") }), 409);
  assert.match(result.error, /ancestry cycle/);
  assert.equal(storedRows(database, "woods-a", ancestor._id).length, 1);
});

test("migration 008 projects old envelopes without rewriting rows and guards old-style inserts", async t => {
  const { database, create } = await pedigreeFixture(t, { through: 7 });
  const parent = record("p", "Sire", { Sex: "Buck" });
  await json(await create(parent), 201);
  const historical = record("old", "Old", { FatherTypedId: encodeRabbitId("p"), Father: "Original sire", Mother: "Text dam" });
  const envelope = (record, revision) => createRabbitEnvelope({ id: record._id, revision, createdAt: now, updatedAt: now, record });
  seedVersion(database, "woods-a", envelope(historical, 0));
  const before = storedRows(database, "woods-a", "old");
  await json(await create(record("new"), { Father: encodeRabbitId("p") }), 503);
  database.exec(await readFile(new URL("../migrations/008_versioned_rabbit_pedigrees.sql", import.meta.url), "utf8"));
  assert.deepEqual(storedRows(database, "woods-a", "old"), before);
  const row = database.prepare("SELECT father_typed_id, father_name_snapshot, mother_name_snapshot FROM rabbit_record_versions WHERE typed_id = ?").get(encodeRabbitId("old"));
  assert.deepEqual({ ...row }, { father_typed_id: encodeRabbitId("p"), father_name_snapshot: "Original sire", mother_name_snapshot: "Text dam" });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN ('idx_rabbit_versions_father', 'idx_rabbit_versions_mother')").get().count, 2);
  assert.throws(() => seedVersion(database, "woods-a", envelope({ ...historical, Father: "Overwritten" }, 1)), /rabbit_pedigree_changed/);
  seedVersion(database, "woods-a", envelope({ ...historical, Notes: "Old handler profile edit" }, 1));
});

test("the insert rejects a parent archived after the API validates it", async t => {
  const { create, update, env, database } = await pedigreeFixture(t);
  const sire = record("sire", "Sire", { Sex: "Buck" });
  await json(await create(sire), 201);
  const original = env.DB;
  let intercepted = false;
  env.DB = {
    prepare(sql) {
      const prepared = original.prepare(sql);
      if (intercepted || !sql.includes("INSERT INTO rabbit_record_versions")) return prepared;
      return {
        bind(...values) {
          const bound = prepared.bind(...values);
          return {
            async run() {
              intercepted = true;
              await json(await update({ ...sire, Archived: true }, 0), 200);
              return bound.run();
            }
          };
        }
      };
    }
  };
  const response = await json(await create(record("child"), { Father: encodeRabbitId("sire") }), 409);
  assert.match(response.error, /Parent selection changed/);
  assert.equal(intercepted, true);
  assert.deepEqual(storedRows(database, "woods-a", "child"), []);
});

test("create preserves unknown fields and keeps numeric and string IDs distinct", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "editor");

  const numericRecord = record(7, "Numeric", { futureField: { untouched: "yes" } });
  const textRecord = record("7", "Text");
  const numeric = await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: numericRecord
    }), env: fixture.env
  }), 201);
  const textual = await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: textRecord
    }), env: fixture.env
  }), 201);

  assert.equal(numeric.created, true);
  assert.equal(numeric.rabbit.envelope.revision, 0);
  assert.deepEqual(numeric.rabbit.envelope.record, numericRecord);
  assert.equal(numeric.rabbit.envelope.createdAt, numeric.rabbit.envelope.updatedAt);
  assert.equal(textual.rabbit.envelope.id, "7");
  assert.notEqual(numeric.rabbit.typedId, textual.rabbit.typedId);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) count FROM rabbit_record_versions").get().count, 2);
});

test("owner, admin, and editor can write while viewer, revoked, deleted, and nonmembers cannot", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  for (const role of ["owner", "admin", "editor", "viewer"]) {
    addRabbitry(fixture.database, `${role}-r`);
    addMembership(fixture.database, `${role}-r`, "integration-test-user", role);
  }
  addRabbitry(fixture.database, "revoked-r");
  addMembership(fixture.database, "revoked-r", "integration-test-user", "editor", now);
  addRabbitry(fixture.database, "deleted-r", now);
  addMembership(fixture.database, "deleted-r", "integration-test-user", "owner");
  addRabbitry(fixture.database, "other-r");
  addMembership(fixture.database, "other-r", "different-user", "owner");

  for (const role of ["owner", "admin", "editor"]) {
    const response = await createRabbit({
      request: post("test-create-versioned-rabbit", fixture.accessToken, {
        rabbitryId: `${role}-r`, record: record(`${role}-id`)
      }), env: fixture.env
    });
    assert.equal(response.status, 201, role);
  }
  assert.deepEqual(await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "viewer-r", record: record("viewer-id")
    }), env: fixture.env
  }), 403), { error: "Rabbitry write access denied" });
  for (const rabbitryId of ["revoked-r", "deleted-r", "other-r"]) {
    assert.deepEqual(await json(await createRabbit({
      request: post("test-create-versioned-rabbit", fixture.accessToken, {
        rabbitryId, record: record(`blocked-${rabbitryId}`)
      }), env: fixture.env
    }), 404), { error: "Rabbitry not found" });
    assert.equal(fixture.database.prepare(
      "SELECT COUNT(*) count FROM rabbit_record_versions WHERE rabbitry_id = ?"
    ).get(rabbitryId).count, 0);
  }
  assert.deepEqual(await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "other-r", record: record("impersonation"), accessSubject: "different-user"
    }), env: fixture.env
  }), 400), { error: "Invalid rabbit request" });
});

test("authentication, origin, malformed input, and negative zero fail before writes", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "owner");
  const auth = await getTestAuth();
  const missingSubject = await auth.token({ sub: undefined });
  const expired = await auth.token({ exp: Math.floor(Date.now() / 1000) - 1 });
  const forgedParts = auth.validToken.split(".");
  forgedParts[2] = `${forgedParts[2][0] === "A" ? "B" : "A"}${forgedParts[2].slice(1)}`;

  for (const [request, status, error] of [
    [post("test-create-versioned-rabbit", null, { rabbitryId: "woods-a", record: record("a") }), 401, "Authentication required"],
    [post("test-create-versioned-rabbit", missingSubject, { rabbitryId: "woods-a", record: record("b") }), 401, "Authentication required"],
    [post("test-create-versioned-rabbit", expired, { rabbitryId: "woods-a", record: record("expired") }), 401, "Authentication required"],
    [post("test-create-versioned-rabbit", forgedParts.join("."), { rabbitryId: "woods-a", record: record("forged") }), 401, "Authentication required"],
    [post("test-create-versioned-rabbit", fixture.accessToken, { rabbitryId: "woods-a", record: record("c") }, {
      origin: "https://evil.test",
      headers: { "X-Forwarded-Host": "local.test", "X-Forwarded-Proto": "https" }
    }), 403, "Invalid request origin"],
    [post("test-create-versioned-rabbit", fixture.accessToken, { rabbitryId: "woods-a", record: record("no-origin") }, { omitOrigin: true }), 403, "Invalid request origin"],
    [post("test-create-versioned-rabbit", fixture.accessToken, "{bad-json", { raw: true }), 400, "Invalid rabbit request"],
    [post("test-create-versioned-rabbit", fixture.accessToken, new Uint8Array([123, 255, 125]), { raw: true }), 400, "Invalid rabbit request"],
    [post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: { _id: "unsupported", Name: "Bad", Sex: "Doe", DOB: null }
    }), 400, "Invalid rabbit record"],
    [post("test-create-versioned-rabbit", fixture.accessToken,
      '{"rabbitryId":"woods-a","record":{"_id":-0,"Name":"Zero","Sex":"Doe"}}', { raw: true }),
    400, "Rabbit ID is invalid"]
  ]) {
    const body = await json(await createRabbit({ request, env: fixture.env }), status);
    assert.equal(body.error, error);
  }
  assert.equal(fixture.database.prepare("SELECT COUNT(*) count FROM rabbit_record_versions").get().count, 0);
});

test("request byte limits use actual streamed size and do not trust Content-Length", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "owner");
  const oversized = JSON.stringify({
    rabbitryId: "woods-a",
    record: record("oversized", "x".repeat(310 * 1024))
  });
  const cases = [
    post("test-create-versioned-rabbit", fixture.accessToken, "{}", {
      raw: true, headers: { "Content-Length": String(301 * 1024) }
    }),
    post("test-create-versioned-rabbit", fixture.accessToken, oversized, { raw: true }),
    post("test-create-versioned-rabbit", fixture.accessToken, oversized, {
      raw: true, headers: { "Content-Length": "10" }
    })
  ];
  for (const request of cases) {
    assert.deepEqual(await json(await createRabbit({ request, env: fixture.env }), 413), {
      error: "Rabbit request exceeds size limit"
    });
  }
  assert.equal(fixture.database.prepare("SELECT COUNT(*) count FROM rabbit_record_versions").get().count, 0);
});

test("create rejects active and soft-deleted duplicates atomically", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "editor");
  const existing = createRabbitEnvelope({
    id: "duplicate", revision: 0, createdAt: now, updatedAt: now,
    record: record("duplicate")
  });
  seedVersion(fixture.database, "woods-a", existing, now);

  const responses = await Promise.all([1, 2].map(() => createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: record("new-race")
    }), env: fixture.env
  })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const duplicate = await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: record("duplicate")
    }), env: fixture.env
  }), 409);
  assert.deepEqual(duplicate, { error: "Rabbit already exists" });
});

test("update appends history and rejects stale and simultaneous competing edits", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "editor");
  const created = await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: record("r-1", "Original")
    }), env: fixture.env
  }), 201);

  const identityChange = await json(await updateRabbit({
    request: post("test-update-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", baseRevision: 0, record: record("r-2", "Changed identity")
    }), env: fixture.env
  }), 409);
  assert.deepEqual(identityChange, { error: "Rabbit changed since the base revision" });
  assert.equal(storedRows(fixture.database, "woods-a", "r-2").length, 0);

  const competing = await Promise.all(["First edit", "Second edit"].map(name => updateRabbit({
    request: post("test-update-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", baseRevision: 0, record: record("r-1", name)
    }), env: fixture.env
  })));
  assert.deepEqual(competing.map(response => response.status).sort(), [200, 409]);
  const rows = storedRows(fixture.database, "woods-a", "r-1");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.revision), [0, 1]);
  assert.equal(JSON.parse(rows[0].envelope).record.Name, "Original");
  assert.equal(JSON.parse(rows[1].envelope).createdAt, created.rabbit.envelope.createdAt);

  const stale = await json(await updateRabbit({
    request: post("test-update-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", baseRevision: 0, record: record("r-1", "Stale")
    }), env: fixture.env
  }), 409);
  assert.deepEqual(stale, { error: "Rabbit changed since the base revision" });
  assert.equal(storedRows(fixture.database, "woods-a", "r-1").length, 2);
});

test("soft deletion appends a tombstone, preserves history, and hides the rabbit", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "owner");
  addRabbitry(fixture.database, "woods-b");
  addMembership(fixture.database, "woods-b", "integration-test-user", "owner");
  const originalRecord = record("delete-me", "Temporary", { futureField: { preserved: true } });
  await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: originalRecord
    }), env: fixture.env
  }), 201);
  seedVersion(fixture.database, "woods-b", createRabbitEnvelope({
    id: "delete-me", revision: 0, createdAt: now, updatedAt: now,
    record: record("delete-me", "Other rabbitry")
  }));

  const deleted = await json(await deleteRabbit({
    request: post("test-delete-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", typedId: encodeRabbitId("delete-me"), baseRevision: 0
    }), env: fixture.env
  }), 200);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.rabbit.envelope.revision, 1);
  assert.deepEqual(deleted.rabbit.envelope.record, originalRecord);
  assert.equal(typeof deleted.deletedAt, "string");

  const rows = storedRows(fixture.database, "woods-a", "delete-me");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].deleted_at, null);
  assert.equal(rows[1].deleted_at, deleted.deletedAt);
  assert.deepEqual(JSON.parse(rows[0].envelope).record, originalRecord);
  assert.deepEqual(JSON.parse(rows[1].envelope).record, originalRecord);
  assert.equal(storedRows(fixture.database, "woods-b", "delete-me").length, 1);
  assert.equal(storedRows(fixture.database, "woods-b", "delete-me")[0].deleted_at, null);

  const listed = await json(await readRabbits({
    request: new Request(`${origin}/api/test-versioned-rabbits?rabbitryId=woods-a`, {
      headers: { "Cf-Access-Jwt-Assertion": fixture.accessToken }
    }), env: fixture.env
  }), 200);
  assert.deepEqual(listed.rabbits, []);

  const repeated = await json(await deleteRabbit({
    request: post("test-delete-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", typedId: encodeRabbitId("delete-me"), baseRevision: 0
    }), env: fixture.env
  }), 409);
  assert.deepEqual(repeated, { error: "Rabbit changed since the base revision" });
  assert.equal(storedRows(fixture.database, "woods-a", "delete-me").length, 2);
});

test("delete authorization and rabbitry scoping protect other records", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  for (const [rabbitryId, role, subject] of [
    ["owner-r", "owner", "integration-test-user"],
    ["viewer-r", "viewer", "integration-test-user"],
    ["other-r", "owner", "different-user"]
  ]) {
    addRabbitry(fixture.database, rabbitryId);
    addMembership(fixture.database, rabbitryId, subject, role);
    seedVersion(fixture.database, rabbitryId, createRabbitEnvelope({
      id: "shared", revision: 0, createdAt: now, updatedAt: now, record: record("shared", rabbitryId)
    }));
  }

  assert.deepEqual(await json(await deleteRabbit({
    request: post("test-delete-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "viewer-r", typedId: encodeRabbitId("shared"), baseRevision: 0
    }), env: fixture.env
  }), 403), { error: "Rabbitry write access denied" });
  assert.deepEqual(await json(await deleteRabbit({
    request: post("test-delete-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "other-r", typedId: encodeRabbitId("shared"), baseRevision: 0
    }), env: fixture.env
  }), 404), { error: "Rabbitry not found" });
  assert.equal(storedRows(fixture.database, "viewer-r", "shared").length, 1);
  assert.equal(storedRows(fixture.database, "other-r", "shared").length, 1);
});

test("delete authentication, origin, and canonical identity fail before writes", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "owner");
  seedVersion(fixture.database, "woods-a", createRabbitEnvelope({
    id: "protected", revision: 0, createdAt: now, updatedAt: now, record: record("protected")
  }));
  const body = { rabbitryId: "woods-a", typedId: encodeRabbitId("protected"), baseRevision: 0 };
  assert.deepEqual(await json(await deleteRabbit({
    request: post("test-delete-versioned-rabbit", null, body), env: fixture.env
  }), 401), { error: "Authentication required" });
  assert.deepEqual(await json(await deleteRabbit({
    request: post("test-delete-versioned-rabbit", fixture.accessToken, body, { omitOrigin: true }), env: fixture.env
  }), 403), { error: "Invalid request origin" });
  assert.deepEqual(await json(await deleteRabbit({
    request: post("test-delete-versioned-rabbit", fixture.accessToken, {
      ...body, typedId: 's:"protected" '
    }), env: fixture.env
  }), 400), { error: "Invalid rabbit request" });
  assert.equal(storedRows(fixture.database, "woods-a", "protected").length, 1);
});

test("concurrent edit and delete from the same base revision cannot both succeed", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "editor");
  seedVersion(fixture.database, "woods-a", createRabbitEnvelope({
    id: "race", revision: 0, createdAt: now, updatedAt: now, record: record("race", "Original")
  }));

  const responses = await Promise.all([
    updateRabbit({
      request: post("test-update-versioned-rabbit", fixture.accessToken, {
        rabbitryId: "woods-a", baseRevision: 0, record: record("race", "Edited")
      }), env: fixture.env
    }),
    deleteRabbit({
      request: post("test-delete-versioned-rabbit", fixture.accessToken, {
        rabbitryId: "woods-a", typedId: encodeRabbitId("race"), baseRevision: 0
      }), env: fixture.env
    })
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const rows = storedRows(fixture.database, "woods-a", "race");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.revision), [0, 1]);
  assert.equal(rows.filter(row => row.deleted_at !== null).length <= 1, true);
});

test("updates are rabbitry-scoped and reject corrupted latest records", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  for (const rabbitryId of ["woods-a", "woods-b"]) {
    addRabbitry(fixture.database, rabbitryId);
    addMembership(fixture.database, rabbitryId, "integration-test-user", "editor");
  }
  const original = createRabbitEnvelope({
    id: "shared", revision: 0, createdAt: now, updatedAt: now,
    record: record("shared", "A")
  });
  seedVersion(fixture.database, "woods-a", original);
  seedVersion(fixture.database, "woods-b", { ...original, record: record("shared", "B") });

  await json(await updateRabbit({
    request: post("test-update-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", baseRevision: 0, record: record("shared", "A updated")
    }), env: fixture.env
  }), 200);
  assert.equal(storedRows(fixture.database, "woods-b", "shared").length, 1);
  assert.equal(JSON.parse(storedRows(fixture.database, "woods-b", "shared")[0].envelope).record.Name, "B");

  const corrupt = createRabbitEnvelope({
    id: 7, revision: 0, createdAt: now, updatedAt: now, record: record(7)
  });
  seedVersion(fixture.database, "woods-a", corrupt, null, encodeRabbitId(8));
  const invalid = await json(await updateRabbit({
    request: post("test-update-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", baseRevision: 0, record: record(8, "Attempt")
    }), env: fixture.env
  }), 500);
  assert.deepEqual(invalid, { error: "Stored rabbit record is invalid" });
});

test("missing schema and database failures return generic non-success responses", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "owner");
  const wrongEnvironment = {
    ...fixture.env,
    TEST_DATABASE: "production",
    DB: { prepare() { throw new Error("database must not be queried"); } }
  };
  assert.deepEqual(await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: record("wrong-environment")
    }), env: wrongEnvironment
  }), 403), { error: "Test environment not configured" });
  const missingSchemaEnv = {
    ...fixture.env,
    DB: {
      prepare(sql) {
        if (sql.includes("test_environment")) return fixture.env.DB.prepare(sql);
        throw new Error("no such table: rabbitry_memberships");
      }
    }
  };
  assert.deepEqual(await json(await createRabbit({
    request: post("test-create-versioned-rabbit", fixture.accessToken, {
      rabbitryId: "woods-a", record: record("missing-schema")
    }), env: missingSchemaEnv
  }), 503), { error: "Versioned rabbit storage unavailable" });

  const failingEnv = {
    ...fixture.env,
    DB: {
      prepare(sql) {
        if (!sql.includes("INSERT INTO rabbit_record_versions")) return fixture.env.DB.prepare(sql);
        throw new Error("private database detail");
      }
    }
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await json(await createRabbit({
      request: post("test-create-versioned-rabbit", fixture.accessToken, {
        rabbitryId: "woods-a", record: record("failure")
      }), env: failingEnv
    }), 500), { error: "Unable to create versioned rabbit" });

    const unrelatedUniqueEnv = {
      ...fixture.env,
      DB: {
        prepare(sql) {
          if (!sql.includes("INSERT INTO rabbit_record_versions")) return fixture.env.DB.prepare(sql);
          throw new Error("UNIQUE constraint failed: unrelated_table.value");
        }
      }
    };
    assert.deepEqual(await json(await createRabbit({
      request: post("test-create-versioned-rabbit", fixture.accessToken, {
        rabbitryId: "woods-a", record: record("unrelated-unique")
      }), env: unrelatedUniqueEnv
    }), 500), { error: "Unable to create versioned rabbit" });
  } finally {
    console.error = originalError;
  }
});
