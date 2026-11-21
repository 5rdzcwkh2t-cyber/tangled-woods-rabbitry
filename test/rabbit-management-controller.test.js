import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const moduleUrl = new URL("../rabbit-management-controller.js", import.meta.url);

async function loadController() {
  const source = await readFile(moduleUrl, "utf8");
  const context = { window: {}, structuredClone, ArrayBuffer, DataView };
  vm.runInNewContext(source, context, { filename: "rabbit-management-controller.js" });
  return { api: context.window.twRabbitManagementController, source };
}

function cloudEntry(api, id, revision = 0, rabbitryId = "dev-auth-test") {
  return {
    record: { _id: id, Name: `Rabbit ${String(id)}`, nested: { preserved: true } },
    metadata: {
      rabbitryId,
      typedId: api.identity(api.versionedSource(rabbitryId), id, { revision }).typedId,
      revision,
      schemaVersion: 1,
      createdAt: "2026-11-21T08:00:00.000Z",
      updatedAt: "2026-11-21T08:00:00.000Z",
      projections: {}
    }
  };
}

test("local is the explicit default source and records are isolated copies", async () => {
  const { api } = await loadController();
  const controller = api.createController();
  const local = [{ _id: "local-1", Name: "Maple", nested: { value: 1 } }];
  controller.setRecords(local);
  const state = controller.getState();
  assert.equal(state.source.kind, "local");
  assert.equal(state.source.key, "local");
  assert.equal(state.records[0].metadata.identity.revision, null);
  state.records[0].record.nested.value = 2;
  assert.equal(local[0].nested.value, 1);
});

test("numeric and string IDs remain distinct in every source", async () => {
  const { api } = await loadController();
  const local = api.createController();
  local.setRecords([{ _id: 7, Name: "Numeric" }, { _id: "7", Name: "Text" }]);
  const localIdentities = local.getState().records.map(entry => entry.metadata.identity);
  assert.notEqual(localIdentities[0].typedId, localIdentities[1].typedId);
  assert.notEqual(localIdentities[0].key, localIdentities[1].key);

  const cloudSource = api.versionedSource("dev-auth-test");
  const cloud = api.createController({ source: cloudSource });
  cloud.setRecords([cloudEntry(api, 7), cloudEntry(api, "7")]);
  assert.notEqual(
    cloud.getState().records[0].metadata.identityKey,
    cloud.getState().records[1].metadata.identityKey
  );
});

test("selection uses a stable source-qualified identity across reorder and revision updates", async () => {
  const { api } = await loadController();
  const source = api.versionedSource("dev-auth-test");
  const controller = api.createController({ source });
  const first = cloudEntry(api, "a", 1);
  const second = cloudEntry(api, "b", 4);
  controller.setRecords([first, second]);
  const key = controller.getState().records[1].metadata.identityKey;
  controller.select(key);
  controller.setRecords([second, first]);
  assert.equal(controller.getState().selected.record._id, "b");
  assert.equal(controller.getState().selected.metadata.revision, 4);

  const updated = cloudEntry(api, "b", 5);
  updated.record.Name = "Updated B";
  controller.upsert(updated);
  assert.equal(controller.getState().selected.record.Name, "Updated B");
  assert.equal(controller.getState().selected.metadata.revision, 5);
});

test("source changes clear records and selection and reject cross-rabbitry entries", async () => {
  const { api } = await loadController();
  const source = api.versionedSource("woods-a");
  const controller = api.createController({ source });
  controller.setRecords([cloudEntry(api, "shared", 0, "woods-a")]);
  controller.select(controller.getState().records[0].metadata.identityKey);
  controller.activate(api.localSource());
  assert.equal(controller.getState().source.kind, "local");
  assert.equal(controller.getState().records.length, 0);
  assert.equal(controller.getState().selected, null);

  controller.activate(source);
  assert.throws(
    () => controller.setRecords([cloudEntry(api, "shared", 0, "woods-b")]),
    /Versioned rabbit record is invalid/
  );
});

test("canonical identity validation rejects malformed metadata and duplicates", async () => {
  const { api } = await loadController();
  const source = api.versionedSource("dev-auth-test");
  const controller = api.createController({ source });
  const wrong = cloudEntry(api, "rabbit-1", 0);
  wrong.metadata.typedId = 's:"other"';
  assert.throws(() => controller.setRecords([wrong]), /not canonical/);
  const valid = cloudEntry(api, "rabbit-1", 0);
  assert.throws(() => controller.setRecords([valid, valid]), /Duplicate rabbit identity/);
  assert.throws(() => controller.select("missing"), /selection is unavailable/);
});

test("management boundary has no persistence, legacy API, import, backup, or mutation transport", async () => {
  const { source } = await loadController();
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(source, /\/api\//);
  assert.doesNotMatch(source, /\b(?:save|restore|commitCSV|previewCSV|fetch)\s*\(/);
  assert.doesNotMatch(source, /method\s*:/);
});
