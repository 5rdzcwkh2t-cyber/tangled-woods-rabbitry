import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../versioned-breeding-cloud-client.js", import.meta.url);

function raw(id = "b-1", revision = 0, record = {}) {
  return {
    typedId: `s:${JSON.stringify(id)}`,
    envelope: {
      schemaVersion: 1, entityType: "breeding", id, revision,
      createdAt: "2026-11-22T08:00:00.000Z", updatedAt: "2026-11-22T08:00:00.000Z",
      record: {
        _id: id, doeTypedId: 's:"doe"', buckTypedId: 's:"buck"',
        date: "2026-11-22", status: "Bred", outcome: "Not recorded", notes: "", ...record
      }
    },
    projections: { status: record.status || "Bred" }
  };
}

async function load() {
  const source = await readFile(sourceUrl, "utf8");
  const context = {
    window: {}, structuredClone,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    ArrayBuffer, DataView, JSON, TypeError
  };
  vm.runInNewContext(source, context, { filename: "versioned-breeding-cloud-client.js" });
  return { source, client: context.window.twVersionedBreedingClient };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
}

test("lists versioned breedings and separates records from revision metadata", async () => {
  const { client } = await load();
  let request;
  const result = await client.listBreedings({ fetchImpl: async (url, options) => {
    request = { url, options };
    return response({ rabbitryId: "dev-auth-test", breedings: [raw()] });
  }});
  assert.equal(request.url, "/api/test-versioned-breedings?rabbitryId=dev-auth-test");
  assert.equal(request.options.method, "GET");
  assert.equal(result[0].record._id, "b-1");
  assert.equal(result[0].metadata.revision, 0);
  assert.equal(result[0].metadata.typedId, 's:"b-1"');
  assert.equal(client.createBreedingId(), "b-cloud-00000000-0000-4000-8000-000000000001");
});

test("create, update, and soft delete use exact versioned endpoints and revisions", async () => {
  const { client } = await load();
  const calls = [];
  const record = raw().envelope.record;
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const revision = url.includes("create") ? 0 : 1;
    const key = url.includes("create") ? "created" : url.includes("delete") ? "deleted" : "updated";
    return response({ rabbitryId: "dev-auth-test", [key]: true,
      ...(key === "deleted" ? { deletedAt: "2026-11-22T09:00:00.000Z" } : {}),
      breeding: raw("b-1", revision, record) }, key === "created" ? 201 : 200);
  };
  assert.equal((await client.createBreeding({ fetchImpl, record })).metadata.revision, 0);
  assert.equal((await client.updateBreeding({ fetchImpl, baseRevision: 0, record })).metadata.revision, 1);
  assert.equal((await client.deleteBreeding({ fetchImpl, typedId: 's:"b-1"', baseRevision: 0, id: "b-1" })).metadata.revision, 1);
  assert.deepEqual(calls.map(call => call.url), [
    "/api/test-create-versioned-breeding", "/api/test-update-versioned-breeding", "/api/test-delete-versioned-breeding"
  ]);
  assert.equal(calls[1].body.baseRevision, 0);
  assert.equal(calls[2].body.typedId, 's:"b-1"');
});

test("authentication, offline, conflict, and malformed responses fail safely", async () => {
  const { client } = await load();
  await assert.rejects(client.listBreedings({ fetchImpl: async () => response({ error: "no" }, 401) }),
    error => error.status === 401 && /authentication/i.test(client.requestMessage(error)));
  await assert.rejects(client.updateBreeding({ fetchImpl: async () => response({ error: "stale" }, 409),
    baseRevision: 0, record: raw().envelope.record }),
  error => error.category === "revision-conflict" && /changed after/i.test(client.requestMessage(error)));
  await assert.rejects(client.listBreedings({ fetchImpl: async () => { throw new Error("offline detail"); } }),
    error => error.offline === true && !client.requestMessage(error).includes("offline detail"));
  await assert.rejects(client.listBreedings({ fetchImpl: async () => response({ rabbitryId: "dev-auth-test", breedings: [{}] }) }),
    error => error.category === "malformed");
  await assert.rejects(client.listBreedings({ fetchImpl: async () => response({
    rabbitryId: "dev-auth-test", breedings: [raw("bad", 0, { doeTypedId: "not-typed" })]
  }) }), error => error.category === "malformed");
});

test("client contains no legacy breeding or browser-storage paths", async () => {
  const { source } = await load();
  assert.doesNotMatch(source, /localStorage|indexedDB|\/api\/breedings\b|test-create-breeding|test-save-breeding/);
  assert.match(source, /test-versioned-breedings/);
});
