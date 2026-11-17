import assert from "node:assert/strict";
import test from "node:test";

import { onRequestGet } from "../functions/api/test-versioned-rabbits.js";
import { createRabbitEnvelope, deriveRabbitProjections } from "../rabbit-record-contract.js";
import { encodeRabbitId } from "../rabbit-typed-id.js";
import { authenticatedEnv, getTestAuth } from "./support/access-test-auth.js";
import { createTestDatabase } from "./support/d1-test-database.js";

const origin = "https://local.test";
const now = "2026-11-17T08:00:00.000Z";

function request(token, rabbitryId = "woods-a", typedId, extraParameters = {}) {
  const url = new URL("/api/test-versioned-rabbits", origin);
  url.searchParams.set("rabbitryId", rabbitryId);
  if (typedId !== undefined) url.searchParams.set("typedId", typedId);
  for (const [key, value] of Object.entries(extraParameters)) url.searchParams.set(key, value);
  return new Request(url, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });
}

async function responseJson(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

function addRabbitry(database, id) {
  database.prepare(`
    INSERT INTO rabbitries (id, name, created_by_access_subject, created_at, updated_at)
    VALUES (?, ?, 'bootstrap-subject', ?, ?)
  `).run(id, id, now, now);
}

function addMembership(database, rabbitryId, subject, role = "viewer", revokedAt = null) {
  database.prepare(`
    INSERT INTO rabbitry_memberships
      (rabbitry_id, access_subject, role, created_at, updated_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(rabbitryId, subject, role, now, now, revokedAt);
}

function envelope(id, revision, name = `Rabbit ${String(id)}`) {
  return createRabbitEnvelope({
    id,
    revision,
    createdAt: now,
    updatedAt: `2026-11-17T${String(8 + revision).padStart(2, "0")}:00:00.000Z`,
    record: { _id: id, Name: name, Sex: "DoE", DoB: "04/15/2025", imported: { preserved: true } }
  });
}

function addVersion(database, rabbitryId, value, deletedAt = null, typedId = encodeRabbitId(value.id)) {
  const projections = deriveRabbitProjections(value.record);
  database.prepare(`
    INSERT INTO rabbit_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at,
       deleted_at, name_normalized, sex_normalized, birth_date_normalized, envelope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rabbitryId, typedId, value.revision, value.schemaVersion, value.createdAt, value.updatedAt,
    deletedAt, projections.name, projections.sex, projections.birthDate, JSON.stringify(value)
  );
}

test("missing and invalid JWTs are rejected before database access", async () => {
  const auth = await getTestAuth();
  const forgedParts = auth.validToken.split(".");
  forgedParts[2] = `${forgedParts[2][0] === "A" ? "B" : "A"}${forgedParts[2].slice(1)}`;
  const missingSubject = await auth.token({ sub: undefined });
  for (const token of [null, forgedParts.join("."), missingSubject]) {
    let queries = 0;
    const response = await onRequestGet({
      request: request(token),
      env: await authenticatedEnv({
        TEST_DATABASE: "tangled-woods-dev-v2",
        DB: { prepare() { queries += 1; throw new Error("database must not be queried"); } }
      })
    });
    assert.deepEqual(await responseJson(response, 401), { error: "Authentication required" });
    assert.equal(queries, 0);
  }
});

test("active memberships allow every defined role while nonmembers and revoked members are isolated", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const auth = await getTestAuth();
  for (const rabbitryId of ["owner-r", "admin-r", "editor-r", "viewer-r", "other-r", "revoked-r"]) {
    addRabbitry(fixture.database, rabbitryId);
  }
  for (const role of ["owner", "admin", "editor", "viewer"]) {
    addMembership(fixture.database, `${role}-r`, "integration-test-user", role);
    const body = await responseJson(await onRequestGet({
      request: request(fixture.accessToken, `${role}-r`), env: fixture.env
    }), 200);
    assert.deepEqual(body, { rabbitryId: `${role}-r`, rabbits: [] });
  }
  addMembership(fixture.database, "revoked-r", "integration-test-user", "viewer", now);
  addMembership(fixture.database, "other-r", "different-user", "owner");
  fixture.database.prepare("UPDATE rabbitries SET deleted_at = ? WHERE id = 'viewer-r'").run(now);
  for (const rabbitryId of ["revoked-r", "other-r", "viewer-r"]) {
    const body = await responseJson(await onRequestGet({
      request: request(fixture.accessToken, rabbitryId), env: fixture.env
    }), 404);
    assert.deepEqual(body, { error: "Rabbitry not found" });
  }
  const impersonation = await responseJson(await onRequestGet({
    request: request(fixture.accessToken, "other-r", undefined, { accessSubject: "different-user" }),
    env: fixture.env
  }), 404);
  assert.deepEqual(impersonation, { error: "Rabbitry not found" });
  const otherToken = await auth.token({ sub: "different-user" });
  assert.equal((await onRequestGet({ request: request(otherToken, "other-r"), env: fixture.env })).status, 200);
});

test("latest live revisions are ordered deterministically and history is not exposed", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user", "viewer");
  addRabbitry(fixture.database, "woods-b");
  addMembership(fixture.database, "woods-b", "integration-test-user", "viewer");
  addVersion(fixture.database, "woods-a", envelope("r-maple", 0, "Z old"));
  const mapleLatest = envelope("r-maple", 1, "Maple");
  addVersion(fixture.database, "woods-a", mapleLatest);
  assert.throws(() => addVersion(fixture.database, "woods-a", mapleLatest), /UNIQUE constraint failed/);
  addVersion(fixture.database, "woods-a", envelope(7, 0, "Aspen"));
  addVersion(fixture.database, "woods-a", envelope("7", 0, "Aspen"));
  addVersion(fixture.database, "woods-b", envelope("r-maple", 2, "Other Rabbitry Secret"));

  const body = await responseJson(await onRequestGet({
    request: request(fixture.accessToken), env: fixture.env
  }), 200);
  assert.equal(body.rabbitryId, "woods-a");
  assert.deepEqual(body.rabbits.map(item => item.envelope.id), [7, "7", "r-maple"]);
  assert.deepEqual(body.rabbits.map(item => item.envelope.revision), [0, 0, 1]);
  assert.deepEqual(body.rabbits[2].envelope, mapleLatest);
  assert.equal(JSON.stringify(body).includes("Z old"), false);
  assert.equal(JSON.stringify(body).includes("Other Rabbitry Secret"), false);

  const single = await responseJson(await onRequestGet({
    request: request(fixture.accessToken, "woods-a", encodeRabbitId("r-maple")), env: fixture.env
  }), 200);
  assert.deepEqual(single, {
    rabbitryId: "woods-a",
    rabbit: body.rabbits[2]
  });
  const otherRabbitry = await responseJson(await onRequestGet({
    request: request(fixture.accessToken, "woods-b", encodeRabbitId("r-maple")), env: fixture.env
  }), 200);
  assert.equal(otherRabbitry.rabbit.envelope.record.Name, "Other Rabbitry Secret");
});

test("a latest tombstone hides the rabbit instead of revealing an older revision", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user");
  addVersion(fixture.database, "woods-a", envelope("retired", 0));
  addVersion(fixture.database, "woods-a", envelope("retired", 1), now);

  const listed = await responseJson(await onRequestGet({
    request: request(fixture.accessToken), env: fixture.env
  }), 200);
  assert.deepEqual(listed.rabbits, []);
  const read = await responseJson(await onRequestGet({
    request: request(fixture.accessToken, "woods-a", encodeRabbitId("retired")), env: fixture.env
  }), 404);
  assert.deepEqual(read, { error: "Rabbit not found" });
});

test("corrupt typed identity or envelope metadata fails explicitly", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  addRabbitry(fixture.database, "woods-a");
  addMembership(fixture.database, "woods-a", "integration-test-user");
  const stored = envelope(7, 0);
  addVersion(fixture.database, "woods-a", stored, null, encodeRabbitId(8));

  const body = await responseJson(await onRequestGet({
    request: request(fixture.accessToken), env: fixture.env
  }), 500);
  assert.deepEqual(body, { error: "Stored rabbit record is invalid" });

  fixture.database.prepare("DELETE FROM rabbit_record_versions WHERE rabbitry_id = 'woods-a'").run();
  addVersion(fixture.database, "woods-a", envelope(-0, 0));
  const negativeZero = await responseJson(await onRequestGet({
    request: request(fixture.accessToken), env: fixture.env
  }), 500);
  assert.deepEqual(negativeZero, { error: "Stored rabbit record is invalid" },
    "JSON serialization turns the envelope ID into +0 while typed_id remains -0");

  fixture.database.prepare("DELETE FROM rabbit_record_versions WHERE rabbitry_id = 'woods-a'").run();
  const valid = envelope("bad-revision", 0);
  addVersion(fixture.database, "woods-a", valid);
  fixture.database.exec("PRAGMA ignore_check_constraints = ON");
  fixture.database.prepare(`
    UPDATE rabbit_record_versions SET revision = 'malformed'
    WHERE rabbitry_id = 'woods-a' AND typed_id = ?
  `).run(encodeRabbitId(valid.id));
  const malformedRevision = await responseJson(await onRequestGet({
    request: request(fixture.accessToken), env: fixture.env
  }), 500);
  assert.deepEqual(malformedRevision, { error: "Stored rabbit record is invalid" });
});

test("incorrect development bindings and markers fail closed", async () => {
  const auth = await getTestAuth();
  let queries = 0;
  const incorrectBinding = await responseJson(await onRequestGet({
    request: request(auth.validToken),
    env: await authenticatedEnv({
      TEST_DATABASE: "production",
      DB: { prepare() { queries += 1; throw new Error("must not query"); } }
    })
  }), 403);
  assert.deepEqual(incorrectBinding, { error: "Test environment not configured" });
  assert.equal(queries, 0);

  const incorrectMarker = await responseJson(await onRequestGet({
    request: request(auth.validToken),
    env: await authenticatedEnv({
      TEST_DATABASE: "tangled-woods-dev-v2",
      DB: {
        prepare(sql) {
          queries += 1;
          assert.match(sql, /test_environment/);
          return { bind() { return this; }, first: async () => null };
        }
      }
    })
  }), 403);
  assert.deepEqual(incorrectMarker, { error: "Test database verification failed" });
  assert.equal(queries, 1);

  const originalError = console.error;
  console.error = () => {};
  try {
    const missingDatabase = await responseJson(await onRequestGet({
      request: request(auth.validToken),
      env: await authenticatedEnv({ TEST_DATABASE: "tangled-woods-dev-v2" })
    }), 500);
    assert.deepEqual(missingDatabase, { error: "Unable to load versioned rabbit records" });
  } finally {
    console.error = originalError;
  }
});

test("missing Stage 3C tables return a clear unavailable response without creating schema", async () => {
  const env = await authenticatedEnv({
    TEST_DATABASE: "tangled-woods-dev-v2",
    DB: {
      prepare(sql) {
        if (sql.includes("test_environment")) {
          return { bind() { return this; }, first: async () => ({ marker: "tangled-woods-dev-v2" }) };
        }
        throw new Error("no such table: rabbitry_memberships");
      }
    }
  });
  const auth = await getTestAuth();
  const body = await responseJson(await onRequestGet({ request: request(auth.validToken), env }), 503);
  assert.deepEqual(body, { error: "Versioned rabbit storage unavailable" });
});
