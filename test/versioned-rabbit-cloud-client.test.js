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

test("updates a rabbit using its current revision and preserves every record field", async () => {
  const { client } = await loadClient();
  const record = { _id: "rabbit-1", Name: "Edited", Notes: "preserved", nested: { future: true } };
  let requestBody;
  const updated = await client.updateRabbit({
    baseRevision: 3,
    record,
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/test-update-versioned-rabbit");
      assert.equal(options.method, "POST");
      assert.equal(options.credentials, "same-origin");
      requestBody = JSON.parse(options.body);
      return response({ rabbitryId: "dev-auth-test", updated: true, rabbit: {
        ...item("rabbit-1", 4), envelope: { ...item("rabbit-1", 4).envelope, record }
      } });
    }
  });
  assert.deepEqual(requestBody, { rabbitryId: "dev-auth-test", baseRevision: 3, record });
  assert.equal(updated.metadata.revision, 4);
  assert.equal(updated.metadata.typedId, 's:"rabbit-1"');
  assert.deepEqual(updated.record.nested, { future: true });
});

test("rejects invalid update inputs and malformed successful updates", async () => {
  const { client } = await loadClient();
  await assert.rejects(client.updateRabbit({ fetchImpl: async () => response({}), baseRevision: -1, record: { _id: "r" } }), (error) => error.name === "TypeError");
  await assert.rejects(client.updateRabbit({ fetchImpl: async () => response({}), baseRevision: 0, record: { Name: "missing id" } }), (error) => error.name === "TypeError");
  await assert.rejects(
    client.updateRabbit({
      fetchImpl: async () => response({ rabbitryId: "dev-auth-test", updated: true, rabbit: item("r", 3) }),
      baseRevision: 0,
      record: { _id: "r", Name: "edit" }
    }),
    (error) => error.category === "malformed"
  );
});

test("reports revision conflicts without exposing or retrying the rejected update", async () => {
  const { client } = await loadClient();
  let calls = 0;
  await assert.rejects(
    client.updateRabbit({
      baseRevision: 0,
      record: { _id: "rabbit-1", Name: "stale" },
      fetchImpl: async () => { calls += 1; return response({ error: "private detail" }, 409); }
    }),
    (error) => error.status === 409 && /changed after you opened it/.test(client.requestMessage(error))
  );
  assert.equal(calls, 1);
});

test("reports update validation failures without exposing submitted data", async () => {
  const { client } = await loadClient();
  await assert.rejects(
    client.updateRabbit({
      baseRevision: 0,
      record: { _id: "rabbit-1", Name: "invalid server-side" },
      fetchImpl: async () => response({ error: "private validation detail" }, 400)
    }),
    (error) => error.status === 400 && /data was invalid/.test(client.requestMessage(error)) &&
      !client.requestMessage(error).includes("private validation detail")
  );
});

test("soft deletes with the canonical typed ID and current revision", async () => {
  const { client } = await loadClient();
  let requestBody;
  const deleted = await client.deleteRabbit({
    typedId: 's:"rabbit-1"',
    baseRevision: 4,
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/test-delete-versioned-rabbit");
      assert.equal(options.method, "POST");
      assert.equal(options.credentials, "same-origin");
      requestBody = JSON.parse(options.body);
      return response({
        rabbitryId: "dev-auth-test",
        deleted: true,
        deletedAt: "2026-11-21T08:00:00.000Z",
        rabbit: item("rabbit-1", 5)
      });
    }
  });
  assert.deepEqual(requestBody, {
    rabbitryId: "dev-auth-test", typedId: 's:"rabbit-1"', baseRevision: 4
  });
  assert.equal(deleted.metadata.typedId, 's:"rabbit-1"');
  assert.equal(deleted.metadata.revision, 5);
  assert.equal(deleted.metadata.deletedAt, "2026-11-21T08:00:00.000Z");
});

test("delete conflicts and failures are not retried or accepted as success", async () => {
  const { client } = await loadClient();
  let calls = 0;
  await assert.rejects(client.deleteRabbit({
    typedId: 's:"rabbit-1"', baseRevision: 1,
    fetchImpl: async () => { calls += 1; return response({ error: "private" }, 409); }
  }), (error) => error.status === 409 && /Reload Development D1/.test(client.requestMessage(error)));
  assert.equal(calls, 1);
  await assert.rejects(client.deleteRabbit({
    typedId: 's:"rabbit-1"', baseRevision: 1,
    fetchImpl: async () => response({
      rabbitryId: "dev-auth-test", deleted: true, deletedAt: "now", rabbit: item("rabbit-1", 9)
    })
  }), (error) => error.category === "malformed");
  await assert.rejects(client.deleteRabbit({
    typedId: "", baseRevision: 1, fetchImpl: async () => response({})
  }), (error) => error.name === "TypeError");
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

test("client source allows only versioned GET and create/update POST operations", async () => {
  const { source } = await loadClient();
  assert.match(source, /method: "GET"/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /test-create-versioned-rabbit/);
  assert.doesNotMatch(source, /localStorage|indexedDB/);
  assert.doesNotMatch(source, /method:\s*"(?:PUT|PATCH|DELETE)"/);
  assert.match(source, /test-update-versioned-rabbit/);
  assert.match(source, /test-delete-versioned-rabbit/);
});
