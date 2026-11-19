import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const clientUrl = new URL("../versioned-rabbit-cloud-client.js", import.meta.url);

async function loadClient() {
  const source = await readFile(clientUrl, "utf8");
  const context = {
    window: {}, structuredClone, ArrayBuffer, DataView,
    crypto: { randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" }
  };
  vm.runInNewContext(source, context, { filename: "versioned-rabbit-cloud-client.js" });
  return { client: context.window.twVersionedRabbitClient, source };
}

function item(id = "rabbit-1", revision = 0) {
  return {
    typedId: `s:${JSON.stringify(id)}`,
    envelope: {
      schemaVersion: 1,
      id,
      revision,
      createdAt: "2026-11-19T08:00:00.000Z",
      updatedAt: "2026-11-19T08:00:00.000Z",
      record: { _id: id, Name: "Cloud Maple", future: { preserved: true } }
    },
    projections: { name: "Cloud Maple", sex: null, birthDate: null }
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("lists versioned rabbits and separates editable records from metadata", async () => {
  const { client } = await loadClient();
  const sourceItem = item("rabbit-1", 3);
  const calls = [];
  const records = await client.listRabbits({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response({ rabbitryId: "dev-auth-test", rabbits: [sourceItem] });
    }
  });

  assert.equal(calls[0][0], "/api/test-versioned-rabbits?rabbitryId=dev-auth-test");
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[0][1].credentials, "same-origin");
  assert.equal(calls[0][1].cache, "no-store");
  assert.equal(calls[0][1].headers.Accept, "application/json");
  assert.equal(records.length, 1);
  assert.equal(records[0].record.Name, "Cloud Maple");
  assert.equal(records[0].metadata.typedId, 's:"rabbit-1"');
  assert.equal(records[0].metadata.id, "rabbit-1");
  assert.equal(records[0].metadata.revision, 3);
  assert.equal(records[0].metadata.schemaVersion, 1);
  assert.equal(records[0].metadata.rabbitryId, "dev-auth-test");
  assert.notEqual(records[0].record, sourceItem.envelope.record);
  records[0].record.Name = "Changed display copy";
  assert.equal(sourceItem.envelope.record.Name, "Cloud Maple");
});

test("rejects malformed response and envelope shapes", async () => {
  const { client } = await loadClient();
  const malformed = [
    null,
    {},
    { rabbitryId: "wrong", rabbits: [] },
    { rabbitryId: "dev-auth-test", rabbits: {} },
    { rabbitryId: "dev-auth-test", rabbits: [{ ...item(), typedId: 's:"different"' }] },
    { rabbitryId: "dev-auth-test", rabbits: [{ ...item(), envelope: { ...item().envelope, revision: -1 } }] },
    { rabbitryId: "dev-auth-test", rabbits: [{ ...item(), envelope: { ...item().envelope, record: { _id: "other" } } }] }
  ];
  for (const body of malformed) {
    await assert.rejects(
      client.listRabbits({ fetchImpl: async () => response(body) }),
      (error) => error.category === "malformed"
    );
  }
  await assert.rejects(
    client.listRabbits({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) }),
    (error) => error.category === "malformed"
  );
});

test("creates a revision-zero rabbit with a collision-resistant ID and exact record payload", async () => {
  const { client } = await loadClient();
  const id = client.createRabbitId();
  assert.equal(id, "r-cloud-123e4567-e89b-42d3-a456-426614174000");
  const record = { _id: id, Name: "New Cloud Rabbit", Notes: "all fields retained", nested: { future: true } };
  let requestBody;
  const created = await client.createRabbit({
    record,
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/test-create-versioned-rabbit");
      assert.equal(options.method, "POST");
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.cache, "no-store");
      assert.equal(options.headers.Accept, "application/json");
      assert.equal(options.headers["Content-Type"], "application/json");
      requestBody = JSON.parse(options.body);
      return response({ rabbitryId: "dev-auth-test", created: true, rabbit: {
        ...item(id, 0),
        envelope: { ...item(id, 0).envelope, record }
      } }, 201);
    }
  });
  assert.deepEqual(requestBody, { rabbitryId: "dev-auth-test", record });
  assert.equal(created.record.Name, "New Cloud Rabbit");
  assert.equal(created.metadata.revision, 0);
  assert.equal(created.metadata.typedId, `s:${JSON.stringify(id)}`);
});

test("cloud create safely reports authentication, network, and duplicate conflicts", async () => {
  const { client } = await loadClient();
  const record = { _id: client.createRabbitId(), Name: "Attempt" };
  await assert.rejects(
    client.createRabbit({ record, fetchImpl: async () => { throw new TypeError("offline detail"); } }),
    (error) => error.offline === true && /internet connection/.test(client.requestMessage(error))
  );
  for (const [status, pattern] of [[401, /authentication is required/], [409, /already exists/]]) {
    await assert.rejects(
      client.createRabbit({ record, fetchImpl: async () => response({ error: "private" }, status) }),
      (error) => error.status === status && pattern.test(client.requestMessage(error))
    );
  }
});

test("maps network and requested HTTP failures without exposing response bodies", async () => {
  const { client } = await loadClient();
  await assert.rejects(
    client.listRabbits({ fetchImpl: async () => { throw new TypeError("private network detail"); } }),
    (error) => error.offline === true && /internet connection/.test(client.requestMessage(error))
  );

  for (const [status, message] of [
    [401, /authentication is required/],
    [403, /access was denied/],
    [404, /could not be found/],
    [409, /already exists/],
    [503, /temporarily unavailable/]
  ]) {
    const privateBody = { error: `private-${status}` };
    await assert.rejects(
      client.listRabbits({ fetchImpl: async () => response(privateBody, status) }),
      (error) => error.status === status && message.test(client.requestMessage(error)) && !client.requestMessage(error).includes(privateBody.error)
    );
  }
});

test("client source allows only versioned GET and create POST operations", async () => {
  const { source } = await loadClient();
  assert.match(source, /method: "GET"/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /test-create-versioned-rabbit/);
  assert.doesNotMatch(source, /localStorage|indexedDB/);
  assert.doesNotMatch(source, /method:\s*"(?:PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(source, /test-update-versioned-rabbit/);
});
