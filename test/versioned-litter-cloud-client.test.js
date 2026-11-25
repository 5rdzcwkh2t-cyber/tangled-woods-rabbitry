import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
const sourceUrl = new URL("../versioned-litter-cloud-client.js", import.meta.url);
async function load() { const source = await readFile(sourceUrl, "utf8"); const context = { window: {}, structuredClone, Date, ArrayBuffer, DataView, JSON, Number, Object, Set,
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" } }; vm.runInNewContext(source, context); return context.window.twVersionedLitterClient; }
function payload(id = "l-1", revision = 0) { return { typedId: `s:${JSON.stringify(id)}`, envelope: { schemaVersion: 1, entityType: "litter", id, revision,
  createdAt: "2026-11-23T00:00:00.000Z", updatedAt: "2026-11-23T00:00:00.000Z", record: { _id: id, breedingTypedId: 's:"b-1"', damTypedId: 's:"d-1"', sireTypedId: 's:"s-1"',
    Dam: "Doe", Sire: "Buck", Bred: "2026-10-01", Born: "2026-11-01", "Total Kits": "5", unknown: { kept: true } } }, projections: {} }; }
test("lists and validates live versioned litters", async () => { const client = await load(); let call;
  const result = await client.listLitters({ fetchImpl: async (...args) => { call = args; return { ok: true, json: async () => ({ rabbitryId: "dev-auth-test", litters: [payload()], claimedBreedingTypedIds: ['s:"historical"'] }) }; } });
  assert.equal(result.litters[0].metadata.revision, 0); assert.deepEqual(result.litters[0].record.unknown, { kept: true }); assert.match(call[0], /test-versioned-litters/); assert.equal(call[1].credentials, "same-origin"); });
test("loads canonical litter detail", async () => { const client = await load(); let url;
  const result = await client.getLitter({ typedId: 's:"l-1"', fetchImpl: async value => { url = value; return { ok: true, json: async () => ({ rabbitryId: "dev-auth-test", litter: payload() }) }; } });
  assert.equal(result.record._id, "l-1"); assert.match(url, /typedId=s%3A%22l-1%22/);
});
test("create, update, and delete use versioned contracts and revisions", async () => { const client = await load(); const calls = [];
  const fetchImpl = async (url, options) => { calls.push([url, JSON.parse(options.body)]); const body = JSON.parse(options.body); const revision = body.baseRevision === undefined ? 0 : body.baseRevision + 1;
    return { ok: true, json: async () => ({ rabbitryId: "dev-auth-test", [url.includes("create") ? "created" : url.includes("update") ? "updated" : "deleted"]: true,
      deletedAt: "2026-11-23T00:00:01.000Z", litter: payload(body.record?._id || "l-1", revision) }) }; };
  await client.createLitter({ fetchImpl, breedingTypedId: 's:"b-1"', record: { _id: "l-1", Born: "2026-11-01" } });
  await client.updateLitter({ fetchImpl, baseRevision: 0, record: payload().envelope.record });
  await client.deleteLitter({ fetchImpl, typedId: 's:"l-1"', baseRevision: 1, id: "l-1" });
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["breedingTypedId", "rabbitryId", "record"]); assert.equal(calls[1][1].baseRevision, 0); assert.equal(calls[2][1].typedId, 's:"l-1"'); });
test("maps duplicate, stale, deletion, and offline failures", async () => { const client = await load();
  for (const [operation, expected] of [["create", /already has a live litter/], ["update", /changed after/], ["delete", /linked kits/]]) {
    const fn = operation === "create" ? () => client.createLitter({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: "conflict" }) }), breedingTypedId: 's:"b"', record: { _id: "l" } }) :
      operation === "update" ? () => client.updateLitter({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({}) }), baseRevision: 0, record: { _id: "l" } }) :
        () => client.deleteLitter({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({}) }), typedId: 's:"l"', baseRevision: 0, id: "l" });
    await assert.rejects(fn(), error => expected.test(client.requestMessage(error)));
  }
  await assert.rejects(client.listLitters({ fetchImpl: async () => { throw new Error("offline"); } }), error => error.offline && /internet/.test(client.requestMessage(error)));
});
