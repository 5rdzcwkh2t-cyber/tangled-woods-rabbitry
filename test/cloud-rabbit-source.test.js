import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../cloud-rabbit-source.js", import.meta.url);
const clientUrl = new URL("../versioned-rabbit-cloud-client.js", import.meta.url);

function versionedRabbit(id = "cloud-1", name = "Cloud Clover", revision = 2) {
  return {
    typedId: `s:${JSON.stringify(id)}`,
    envelope: {
      schemaVersion: 1,
      id,
      revision,
      createdAt: "2026-11-19T08:00:00.000Z",
      updatedAt: "2026-11-19T09:00:00.000Z",
      record: { _id: id, Name: name }
    },
    projections: { name, sex: null, birthDate: null }
  };
}

async function loadController(fetchImpl) {
  const source = await readFile(sourceUrl, "utf8");
  const clientSource = await readFile(clientUrl, "utf8");
  const context = {
    window: {},
    document: {},
    console,
    fetch: fetchImpl,
    structuredClone
  };
  vm.runInNewContext(clientSource, context, { filename: "versioned-rabbit-cloud-client.js" });
  vm.runInNewContext(source, context, { filename: "cloud-rabbit-source.js" });
  return { source, createController: context.window.twCloudRabbitSource.createController };
}

test("Development D1 source switches without changing local records", async () => {
  const localRecords = [{ _id: "local-1", Name: "Local Maple" }];
  const before = structuredClone(localRecords);
  const renders = [];
  const request = async (url, options) => {
    assert.equal(url, "/api/test-versioned-rabbits?rabbitryId=dev-auth-test");
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    return {
      ok: true,
      status: 200,
      json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [versionedRabbit()] })
    };
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render: (state) => renders.push(state) });

  await controller.selectCloud();
  assert.equal(controller.getState().source, "cloud");
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().records[0].record.Name, "Cloud Clover");
  assert.equal(controller.getState().records[0].metadata.revision, 2);
  assert.deepEqual(localRecords, before);

  controller.selectLocal();
  assert.equal(controller.getState().source, "local");
  assert.equal(controller.getState().status, "idle");
  assert.equal(controller.getState().records.length, 0);
  assert.ok(renders.length >= 3);
});

test("failed, offline, and unauthenticated fetches clear cloud records", async () => {
  for (const [fetchImpl, expected] of [
    [async () => { throw new TypeError("offline"); }, /internet connection/],
    [async () => ({ ok: false, status: 401, json: async () => ({ error: "ignored" }) }), /authentication is required/],
    [async () => ({ ok: false, status: 500, json: async () => ({}) }), /could not be loaded/]
  ]) {
    const { createController } = await loadController(fetchImpl);
    const controller = createController({ fetchImpl, render() {} });
    await controller.selectCloud();
    const state = controller.getState();
    assert.equal(state.source, "cloud");
    assert.equal(state.status, "error");
    assert.equal(state.records.length, 0);
    assert.match(state.message, expected);
  }
});

test("leaving cloud view invalidates an in-flight response", async () => {
  let resolveRequest;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const { createController } = await loadController(() => pending);
  const controller = createController({ fetchImpl: () => pending, render() {} });
  const loading = controller.selectCloud();
  controller.selectLocal();
  resolveRequest({
    ok: true,
    status: 200,
    json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [versionedRabbit("stale", "Stale")] })
  });
  await loading;
  assert.equal(controller.getState().source, "local");
  assert.equal(controller.getState().records.length, 0);
});

test("duplicate cloud create submissions share one request and never touch local records", async () => {
  const localRecords = [{ _id: "local-1", Name: "Local Maple" }];
  const before = structuredClone(localRecords);
  let createCalls = 0;
  let finishCreate;
  const pendingCreate = new Promise((resolve) => { finishCreate = resolve; });
  const request = async (url) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      return { ok: true, status: 200, json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [] }) };
    }
    if (url === "/api/test-create-versioned-rabbit") {
      createCalls += 1;
      return pendingCreate;
    }
    throw new Error("Unexpected URL");
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const record = { _id: "r-cloud-test", Name: "Created" };
  const first = controller.createCloud(record);
  const second = controller.createCloud(record);
  assert.equal(first, second);
  finishCreate({
    ok: true,
    status: 201,
    json: async () => ({ rabbitryId: "dev-auth-test", created: true, rabbit: versionedRabbit("r-cloud-test", "Created", 0) })
  });
  const created = await first;
  assert.equal(createCalls, 1);
  assert.equal(created.record.Name, "Created");
  assert.equal(controller.getState().records.length, 1);
  assert.deepEqual(localRecords, before);
});

test("successful cloud edits replace only the matching versioned entry and increment revision", async () => {
  const localRecords = [{ _id: "local-1", Name: "Local Maple" }];
  const before = structuredClone(localRecords);
  let updateCalls = 0;
  let requestBody;
  const request = async (url, options) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      return { ok: true, status: 200, json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [versionedRabbit()] }) };
    }
    if (url === "/api/test-update-versioned-rabbit") {
      updateCalls += 1;
      requestBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({
        rabbitryId: "dev-auth-test", updated: true, rabbit: versionedRabbit("cloud-1", "Edited Clover", 3)
      }) };
    }
    throw new Error("Unexpected URL");
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const entry = controller.getState().records[0];
  const edited = { ...entry.record, Name: "Edited Clover", future: { retained: true } };
  const first = controller.updateCloud(entry, edited);
  const second = controller.updateCloud(entry, edited);
  assert.equal(first, second);
  const updated = await first;
  assert.equal(updateCalls, 1);
  assert.equal(requestBody.baseRevision, 2);
  assert.equal(updated.metadata.revision, 3);
  assert.equal(controller.getState().records[0].record.Name, "Edited Clover");
  assert.deepEqual(localRecords, before);
});

test("revision conflicts leave the loaded cloud entry unchanged", async () => {
  const request = async (url) => url.startsWith("/api/test-versioned-rabbits")
    ? { ok: true, status: 200, json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [versionedRabbit()] }) }
    : { ok: false, status: 409, json: async () => ({ error: "private" }) };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const entry = controller.getState().records[0];
  await assert.rejects(controller.updateCloud(entry, { ...entry.record, Name: "Stale edit" }), (error) => error.status === 409);
  assert.equal(controller.getState().records[0].record.Name, "Cloud Clover");
  assert.equal(controller.getState().records[0].metadata.revision, 2);
});

test("cloud source contains no browser storage or delete paths", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const clientSource = await readFile(clientUrl, "utf8");
  assert.match(source, /Development D1/);
  assert.match(clientSource, /credentials: "same-origin"/);
  assert.doesNotMatch(source, /localStorage|indexedDB/);
  assert.doesNotMatch(source, /method:\s*"(?:PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(source, /\bdb\s*=/);
  assert.doesNotMatch(source, /\b(?:restore|previewCSV|commitCSV|writePhotos)\s*\(/);
  assert.doesNotMatch(clientSource, /localStorage|indexedDB/);
  assert.match(clientSource, /test-create-versioned-rabbit/);
  assert.doesNotMatch(clientSource, /method:\s*"(?:PUT|PATCH|DELETE)"/);
  assert.match(clientSource, /test-update-versioned-rabbit/);
});
