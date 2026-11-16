import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../cloud-rabbit-source.js", import.meta.url);

async function loadController(fetchImpl) {
  const source = await readFile(sourceUrl, "utf8");
  const context = {
    window: {},
    document: {},
    console,
    fetch: fetchImpl,
    structuredClone
  };
  vm.runInNewContext(source, context, { filename: "cloud-rabbit-source.js" });
  return { source, createController: context.window.twCloudRabbitSource.createController };
}

test("Development D1 source switches without changing local records", async () => {
  const localRecords = [{ _id: "local-1", Name: "Local Maple" }];
  const before = structuredClone(localRecords);
  const renders = [];
  const request = async (url, options) => {
    assert.equal(url, "/api/rabbits");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    return {
      ok: true,
      status: 200,
      json: async () => ({ rabbits: [{ _id: "cloud-1", Name: "Cloud Clover" }] })
    };
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render: (state) => renders.push(state) });

  await controller.selectCloud();
  assert.equal(controller.getState().source, "cloud");
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().records[0].Name, "Cloud Clover");
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
  resolveRequest({ ok: true, status: 200, json: async () => ({ rabbits: [{ Name: "Stale" }] }) });
  await loading;
  assert.equal(controller.getState().source, "local");
  assert.equal(controller.getState().records.length, 0);
});

test("read-only source contains no browser or cloud write paths", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /Development D1 \(read-only\)/);
  assert.match(source, /credentials: "same-origin"/);
  assert.doesNotMatch(source, /localStorage|indexedDB/);
  assert.doesNotMatch(source, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(source, /\bdb\s*=/);
  assert.doesNotMatch(source, /\b(?:edit|restore|previewCSV|commitCSV|writePhotos|save)\s*\(/);
});
