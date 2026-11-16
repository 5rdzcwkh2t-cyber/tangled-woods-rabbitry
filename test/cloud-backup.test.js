import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet, onRequestPost } from "../functions/api/test-backup.js";
import { createTestDatabase } from "./support/d1-test-database.js";
import { getTestAuth } from "./support/access-test-auth.js";

const origin = "https://local.test";

function backupDocument(overrides = {}) {
  return {
    rabbits: [{ _id: "r-1", Name: "Maple", Sex: "Doe", Notes: "Preserved" }],
    litters: [{ _id: "l-1", Name: "Spring Litter" }],
    breedings: [{ _id: "b-1", doeId: "r-1", buckId: "r-2" }],
    parentLinks: { "r-1": { Father: "r-2" } },
    expenses: [{ id: "e-1", amountCents: 2500 }],
    photos: {
      "rabbit:r-1": "data:image/png;base64,aGVsbG8=",
      "gallery:r-1": JSON.stringify(["data:image/jpeg;base64,aGVsbG8="])
    },
    photoBackupVersion: 1,
    exportedAt: "2026-11-15T12:00:00.000Z",
    ...overrides
  };
}

function postRequest(token, body, raw = false) {
  return new Request(`${origin}/api/test-backup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "Cf-Access-Jwt-Assertion": token
    },
    body: raw ? body : JSON.stringify(body)
  });
}

function getRequest(token, id) {
  const suffix = id === undefined ? "" : `?id=${id}`;
  return new Request(`${origin}/api/test-backup${suffix}`, {
    headers: { "Cf-Access-Jwt-Assertion": token }
  });
}

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("authenticated owner can create, list, and retrieve a complete versioned backup", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const document = backupDocument({ futureRelatedData: { preserved: true } });

  const created = await json(await onRequestPost({
    request: postRequest(fixture.accessToken, { deviceId: "iphone-main", backup: document }),
    env: fixture.env
  }), 201);
  assert.equal(created.created, true);
  assert.equal(created.backup.formatVersion, 1);
  assert.equal(created.backup.deviceId, "iphone-main");
  assert.equal(created.retentionApplied, true);

  const listed = await json(await onRequestGet({
    request: getRequest(fixture.accessToken), env: fixture.env
  }), 200);
  assert.equal(listed.backups.length, 1);
  assert.equal(Object.hasOwn(listed.backups[0], "data"), false);

  const retrieved = await json(await onRequestGet({
    request: getRequest(fixture.accessToken, created.backup.id), env: fixture.env
  }), 200);
  assert.deepEqual(retrieved.backup.data, document);
});

test("backup creation rejects malformed JSON and malformed record or photo structures", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());

  const malformedJson = await json(await onRequestPost({
    request: postRequest(fixture.accessToken, "{not-json", true), env: fixture.env
  }), 400);
  assert.equal(malformedJson.error, "Invalid backup request");

  for (const backup of [
    { rabbits: [], litters: "wrong" },
    backupDocument({ rabbits: [null] }),
    backupDocument({ photos: { "rabbit:r-1": "not-an-image" } })
  ]) {
    const invalid = await json(await onRequestPost({
      request: postRequest(fixture.accessToken, { deviceId: "test", backup }), env: fixture.env
    }), 400);
    assert.equal(invalid.error, "Invalid backup request");
  }
  assert.equal(fixture.database.prepare("SELECT COUNT(*) total FROM cloud_backups").get().total, 0);
});

test("backup payloads over the byte limit are rejected before storage", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const oversized = backupDocument({
    rabbits: [{ _id: "large", Name: "Large", Notes: "x".repeat(1_800_000) }]
  });

  const response = await json(await onRequestPost({
    request: postRequest(fixture.accessToken, { deviceId: "test", backup: oversized }),
    env: fixture.env
  }), 413);
  assert.equal(response.error, "Backup exceeds the size limit");
  assert.equal(fixture.database.prepare("SELECT COUNT(*) total FROM cloud_backups").get().total, 0);
});

test("missing authentication and forged tokens cannot create or retrieve backups", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const auth = await getTestAuth();
  const tokenParts = auth.validToken.split(".");
  tokenParts[2] = (tokenParts[2][0] === "A" ? "B" : "A") + tokenParts[2].slice(1);
  const forged = tokenParts.join(".");

  for (const token of ["", forged]) {
    const create = await json(await onRequestPost({
      request: postRequest(token, { deviceId: "test", backup: backupDocument() }),
      env: fixture.env
    }), 401);
    assert.equal(create.error, "Authentication required");
    const list = await json(await onRequestGet({ request: getRequest(token), env: fixture.env }), 401);
    assert.equal(list.error, "Authentication required");
  }
});

test("one authenticated identity cannot list or retrieve another owner's backup", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const auth = await getTestAuth();
  const otherToken = await auth.token({ sub: "different-user" });

  const created = await json(await onRequestPost({
    request: postRequest(fixture.accessToken, { deviceId: "owner-device", backup: backupDocument() }),
    env: fixture.env
  }), 201);
  const otherList = await json(await onRequestGet({
    request: getRequest(otherToken), env: fixture.env
  }), 200);
  assert.deepEqual(otherList.backups, []);
  const otherRead = await json(await onRequestGet({
    request: getRequest(otherToken, created.backup.id), env: fixture.env
  }), 404);
  assert.equal(otherRead.error, "Backup not found");
});

test("retention keeps 20 append-only versions per owner without affecting other owners", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const auth = await getTestAuth();
  const otherToken = await auth.token({ sub: "retention-other-user" });
  let firstId;

  for (let index = 0; index < 21; index += 1) {
    const created = await json(await onRequestPost({
      request: postRequest(fixture.accessToken, {
        deviceId: "retention-device",
        backup: backupDocument({ sequence: index })
      }), env: fixture.env
    }), 201);
    firstId ??= created.backup.id;
  }
  await json(await onRequestPost({
    request: postRequest(otherToken, { deviceId: "other-device", backup: backupDocument() }),
    env: fixture.env
  }), 201);

  const ownerCount = fixture.database.prepare(
    "SELECT COUNT(*) total FROM cloud_backups WHERE owner_id = ?"
  ).get("integration-test-user").total;
  const otherCount = fixture.database.prepare(
    "SELECT COUNT(*) total FROM cloud_backups WHERE owner_id = ?"
  ).get("retention-other-user").total;
  assert.equal(ownerCount, 20);
  assert.equal(otherCount, 1);
  await json(await onRequestGet({
    request: getRequest(fixture.accessToken, firstId), env: fixture.env
  }), 404);
});

test("database failures return generic errors and do not expose internals", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalConsoleError; });
  const failingEnv = {
    ...fixture.env,
    DB: {
      prepare(sql) {
        if (sql.includes("INSERT INTO cloud_backups")) throw new Error("sensitive database detail");
        return fixture.env.DB.prepare(sql);
      }
    }
  };

  const failed = await json(await onRequestPost({
    request: postRequest(fixture.accessToken, { deviceId: "test", backup: backupDocument() }),
    env: failingEnv
  }), 500);
  assert.deepEqual(failed, { error: "Unable to create backup" });
});
