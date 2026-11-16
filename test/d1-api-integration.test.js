import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase, insertRabbit } from "./support/d1-test-database.js";
import { getTestAuth } from "./support/access-test-auth.js";
import { onRequestGet as readRabbits } from "../functions/api/rabbits.js";
import { onRequestGet as readLitters } from "../functions/api/litters.js";
import { onRequestGet as readBreedings } from "../functions/api/breedings.js";
import { onRequestPost as createRabbit } from "../functions/api/test-create-rabbit.js";
import { onRequestPost as saveRabbit } from "../functions/api/test-save-rabbit.js";
import { onRequestPost as createLitter } from "../functions/api/test-create-litter.js";
import { onRequestPost as saveLitter } from "../functions/api/test-save-litter.js";
import { onRequestPost as createBreeding } from "../functions/api/test-create-breeding.js";
import { onRequestPost as saveBreeding } from "../functions/api/test-save-breeding.js";

const origin = "https://local.test";
let accessToken;

test.before(async () => {
  accessToken = (await getTestAuth()).validToken;
});

function post(path, body, headers = {}) {
  return new Request(`${origin}/api/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "Cf-Access-Jwt-Assertion": accessToken,
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function json(response, expectedStatus) {
  assert.equal(response.status, expectedStatus, await response.clone().text());
  return response.json();
}

const rabbitFields = (overrides = {}) => ({
  Prefix: "TW",
  Name: "Maple",
  Sex: "Doe",
  Tattoo: "D1",
  Breed: "Holland Lop",
  Color: "Orange",
  DOB: "2025-04-15",
  Father: "",
  Mother: "",
  Weight: "3 lb",
  Status: "Active",
  Notes: "Test record",
  ...overrides
});

const parents = {
  doe: {
    _id: "TEST-00000000-0000-4000-8000-000000000001",
    Name: "Maple",
    Sex: "Doe",
    Breed: "Holland Lop",
    Status: "Active"
  },
  buck: {
    _id: "TEST-00000000-0000-4000-8000-000000000002",
    Name: "Clover",
    Sex: "Buck",
    Breed: "Holland Lop",
    Status: "Active"
  }
};

function litterFields(overrides = {}) {
  return {
    Name: "Spring Litter",
    Dam: parents.doe.Name,
    Sire: parents.buck.Name,
    DamID: parents.doe._id,
    SireID: parents.buck._id,
    Bred: "2026-01-01",
    Born: "2026-02-01",
    "Total Kits": "5",
    "Sold Kits": "0",
    "Died Kits": "0",
    Notes: "Integration test",
    ...overrides
  };
}

function breedingFields(overrides = {}) {
  return {
    doeId: parents.doe._id,
    buckId: parents.buck._id,
    date: "2026-01-01",
    status: "Bred",
    kindledDate: "",
    notes: "Integration test",
    ...overrides
  };
}

function seedParents(database) {
  insertRabbit(database, parents.doe);
  insertRabbit(database, parents.buck);
}

test("rabbit create, read, and edit execute against migrated SQLite", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());

  const created = await json(await createRabbit({
    request: post("test-create-rabbit", rabbitFields()),
    env: fixture.env
  }), 201);
  assert.equal(created.rabbit.Name, "Maple");

  const listed = await json(await readRabbits({
    request: new Request(`${origin}/api/rabbits`, {
      headers: { "Cf-Access-Jwt-Assertion": accessToken }
    }),
    env: fixture.env
  }), 200);
  assert.equal(listed.rabbits.length, 1);
  assert.equal(listed.rabbits[0]._id, created.rabbit._id);

  const expected = rabbitFields();
  const update = rabbitFields({
    _id: created.rabbit._id,
    Name: "Maple Updated",
    expected
  });
  const saved = await json(await saveRabbit({
    request: post("test-save-rabbit", update),
    env: fixture.env
  }), 200);
  assert.equal(saved.rabbit.Name, "Maple Updated");
  assert.equal(saved.rabbit._id, created.rabbit._id);
});

test("rabbit validation and stale-edit protection reject unsafe writes", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());

  const invalid = await json(await createRabbit({
    request: post("test-create-rabbit", rabbitFields({ Sex: "Unknown" })),
    env: fixture.env
  }), 400);
  assert.equal(invalid.error, "Sex must be Buck or Doe");

  insertRabbit(fixture.database, parents.doe);
  const stale = rabbitFields({
    _id: parents.doe._id,
    expected: rabbitFields({ Name: "Old name" })
  });
  const conflict = await json(await saveRabbit({
    request: post("test-save-rabbit", stale),
    env: fixture.env
  }), 409);
  assert.match(conflict.error, /changed since you opened it/);
  assert.equal(
    fixture.database.prepare("SELECT name FROM rabbits WHERE id = ?").get(parents.doe._id).name,
    "Maple"
  );
});

test("litter create, read, and edit validate permanent parent IDs", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  seedParents(fixture.database);

  const created = await json(await createLitter({
    request: post("test-create-litter", litterFields()),
    env: fixture.env
  }), 201);
  const listed = await json(await readLitters({
    request: new Request(`${origin}/api/litters`, {
      headers: { "Cf-Access-Jwt-Assertion": accessToken }
    }),
    env: fixture.env
  }), 200);
  assert.equal(listed.litters.length, 1);
  assert.equal(listed.litters[0].DamID, parents.doe._id);

  const update = {
    ...litterFields({ Name: "Spring Litter Updated" }),
    _id: created.litter._id,
    expected: litterFields()
  };
  const saved = await json(await saveLitter({
    request: post("test-save-litter", update),
    env: fixture.env
  }), 200);
  assert.equal(saved.litter.Name, "Spring Litter Updated");
});

test("litter endpoints reject invalid parents and stale edits", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  seedParents(fixture.database);

  const invalid = await json(await createLitter({
    request: post("test-create-litter", litterFields({ DamID: "missing" })),
    env: fixture.env
  }), 400);
  assert.match(invalid.error, /Dam.*not found/);

  const created = await json(await createLitter({
    request: post("test-create-litter", litterFields()),
    env: fixture.env
  }), 201);
  const staleExpected = litterFields({ Notes: "Older value" });
  const conflict = await json(await saveLitter({
    request: post("test-save-litter", {
      ...litterFields(),
      _id: created.litter._id,
      expected: staleExpected
    }),
    env: fixture.env
  }), 409);
  assert.match(conflict.error, /changed since you opened it/);
});

test("breeding create, authenticated read, and edit use validated parents", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  seedParents(fixture.database);

  const created = await json(await createBreeding({
    request: post("test-create-breeding", breedingFields()),
    env: fixture.env
  }), 201);
  const listed = await json(await readBreedings({
    request: new Request(`${origin}/api/breedings`, {
      headers: { "Cf-Access-Jwt-Assertion": accessToken }
    }),
    env: fixture.env
  }), 200);
  assert.equal(listed.breedings.length, 1);

  const updated = await json(await saveBreeding({
    request: post("test-save-breeding", {
      ...breedingFields({ status: "Confirmed pregnant", notes: "Checked" }),
      _id: created.breeding._id,
      expected: breedingFields()
    }),
    env: fixture.env
  }), 200);
  assert.equal(updated.breeding.status, "Confirmed pregnant");
});

test("breeding endpoints reject invalid dates, same-parent records, and missing records", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  seedParents(fixture.database);

  const invalidDate = await json(await createBreeding({
    request: post("test-create-breeding", breedingFields({ date: "2026-02-30" })),
    env: fixture.env
  }), 400);
  assert.equal(invalidDate.error, "Invalid breeding details");

  const sameParent = await json(await createBreeding({
    request: post("test-create-breeding", breedingFields({ buckId: parents.doe._id })),
    env: fixture.env
  }), 400);
  assert.equal(sameParent.error, "Invalid breeding details");

  const missing = await json(await saveBreeding({
    request: post("test-save-breeding", {
      ...breedingFields(),
      _id: "TEST-BREEDING-00000000-0000-4000-8000-000000000099",
      expected: breedingFields()
    }),
    env: fixture.env
  }), 404);
  assert.equal(missing.error, "Breeding record not found");
});

test("breeding stale-edit protection preserves the newer database record", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  seedParents(fixture.database);

  const created = await json(await createBreeding({
    request: post("test-create-breeding", breedingFields()),
    env: fixture.env
  }), 201);
  const stored = {
    ...created.breeding,
    notes: "Changed by another session"
  };
  fixture.database.prepare("UPDATE breedings SET data = ? WHERE id = ?")
    .run(JSON.stringify(stored), created.breeding._id);

  const conflict = await json(await saveBreeding({
    request: post("test-save-breeding", {
      ...breedingFields({ notes: "My stale edit" }),
      _id: created.breeding._id,
      expected: breedingFields()
    }),
    env: fixture.env
  }), 409);
  assert.match(conflict.error, /changed since you opened it/);
  assert.equal(
    JSON.parse(fixture.database.prepare("SELECT data FROM breedings WHERE id = ?")
      .get(created.breeding._id).data).notes,
    "Changed by another session"
  );
});

test("write endpoints remain isolated by environment, authentication, and origin", async (t) => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());

  const wrongEnvironment = await json(await createRabbit({
    request: post("test-create-rabbit", rabbitFields()),
    env: { ...fixture.env, TEST_DATABASE: "production" }
  }), 403);
  assert.equal(wrongEnvironment.error, "Test environment not configured");

  const unauthenticated = await json(await createRabbit({
    request: post("test-create-rabbit", rabbitFields(), { "Cf-Access-Jwt-Assertion": "" }),
    env: fixture.env
  }), 401);
  assert.equal(unauthenticated.error, "Authentication required");

  const foreignOrigin = await json(await createRabbit({
    request: post("test-create-rabbit", rabbitFields(), { Origin: "https://attacker.test" }),
    env: fixture.env
  }), 403);
  assert.equal(foreignOrigin.error, "Invalid request origin");
});

