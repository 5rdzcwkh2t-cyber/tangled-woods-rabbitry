import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../cloud-breeding-source.js", import.meta.url);

function breeding(id, revision = 0, fields = {}) {
  return {
    record: { _id: id, doeTypedId: 's:"doe"', buckTypedId: 's:"buck"', date: "2026-01-01",
      status: "Bred", outcome: "Not recorded", unknown: { preserved: true }, ...fields },
    metadata: { rabbitryId: "dev-auth-test", typedId: `s:${JSON.stringify(id)}`, id, revision }
  };
}

function rabbit(id, sex, fields = {}) {
  return { record: { _id: id, Name: id, Sex: sex, ...fields },
    metadata: { rabbitryId: "dev-auth-test", typedId: `s:${JSON.stringify(id)}`, id, revision: 0 } };
}

async function load(clients = {}) {
  const source = await readFile(sourceUrl, "utf8");
  const context = { window: { ...clients }, document: {}, console, structuredClone, Date, fetch: async () => {} };
  vm.runInNewContext(source, context, { filename: "cloud-breeding-source.js" });
  return { source, helpers: context.window.twCloudBreedingSource };
}

test("kindling estimates and planner grouping are deterministic", async () => {
  const { helpers } = await load();
  assert.deepEqual({ ...helpers.estimateKindling("2026-01-01") }, {
    earliest: "2026-01-29", expected: "2026-02-01", latest: "2026-02-03"
  });
  assert.equal(helpers.estimateKindling("2026-02-30"), null);
  const groups = helpers.groupBreedings([
    breeding("upcoming", 0, { date: "2026-02-01" }),
    breeding("overdue", 0, { date: "2025-01-01" }),
    breeding("kindled", 0, { date: "2025-12-01", status: "Kindled", kindledDate: "2026-01-01" }),
    breeding("cancelled", 0, { status: "Cancelled" })
  ], new Date(2026, 0, 15));
  assert.deepEqual(Array.from(groups.upcoming, entry => entry.record._id), ["upcoming"]);
  assert.deepEqual(Array.from(groups.overdue, entry => entry.record._id), ["overdue"]);
  assert.deepEqual(Array.from(groups.completed, entry => entry.record._id), ["cancelled", "kindled"]);
});

test("eligible parent selection requires matching sex and excludes archived rabbits", async () => {
  const { helpers } = await load();
  const rabbits = [rabbit("doe", "Doe"), rabbit("buck", "Buck"), rabbit("archived", "Doe", { Archived: true })];
  assert.deepEqual(helpers.eligibleParents(rabbits, "doe").map(entry => entry.record._id), ["doe"]);
  assert.deepEqual(helpers.eligibleParents(rabbits, "buck").map(entry => entry.record._id), ["buck"]);
});

test("cloud controller loads breedings and rabbits without invoking local persistence", async () => {
  let breedingLoads = 0;
  let rabbitLoads = 0;
  let storageWrites = 0;
  const breedingClient = { DEFAULT_RABBITRY_ID: "dev-auth-test", listBreedings: async () => { breedingLoads += 1; return [breeding("b-1")]; } };
  const rabbitClient = { listRabbits: async () => { rabbitLoads += 1; return [rabbit("doe", "Doe"), rabbit("buck", "Buck")]; } };
  const { helpers } = await load({ twVersionedBreedingClient: breedingClient, twVersionedRabbitClient: rabbitClient,
    localStorage: { setItem() { storageWrites += 1; } }, save() { storageWrites += 1; } });
  const controller = helpers.createController({ fetchImpl: async () => {}, breedingClient, rabbitClient });
  await controller.initialize("cloud-development.tangled-woods-rabbitry.pages.dev");
  assert.equal(controller.getState().source, "cloud");
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().breedings.length, 1);
  assert.equal(controller.getState().rabbits.length, 2);
  assert.equal(breedingLoads, 1);
  assert.equal(rabbitLoads, 1);
  assert.equal(storageWrites, 0);
});

test("duplicate submissions share one request and preserve complete revisions", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  let resolveCreate;
  const original = breeding("b-1");
  const breedingClient = {
    DEFAULT_RABBITRY_ID: "dev-auth-test", listBreedings: async () => [original],
    createBreeding: () => { createCalls += 1; return new Promise(resolve => { resolveCreate = resolve; }); },
    updateBreeding: async ({ record }) => { updateCalls += 1; return breeding(record._id, 1, record); }
  };
  const rabbitClient = { listRabbits: async () => [rabbit("doe", "Doe"), rabbit("buck", "Buck")] };
  const { helpers } = await load();
  const controller = helpers.createController({ fetchImpl: async () => {}, breedingClient, rabbitClient });
  await controller.selectCloud();
  const draft = breeding("new").record;
  const first = controller.createCloud(draft);
  const second = controller.createCloud(draft);
  assert.equal(first, second);
  assert.equal(createCalls, 1);
  resolveCreate(breeding("new"));
  await first;
  controller.selectRecord(original);
  const revision = structuredClone(original.record);
  revision.notes = "changed";
  const updated = await controller.updateCloud(original, revision);
  assert.equal(updated.metadata.revision, 1);
  assert.deepEqual(updated.record.unknown, { preserved: true });
  assert.equal(updateCalls, 1);
});

test("conflicts and late responses cannot overwrite a changed selection or source", async () => {
  let resolveUpdate;
  const first = breeding("first");
  const second = breeding("second");
  const conflict = Object.assign(new Error("stale"), { category: "revision-conflict", status: 409 });
  const breedingClient = {
    DEFAULT_RABBITRY_ID: "dev-auth-test", listBreedings: async () => [first, second],
    updateBreeding: () => new Promise(resolve => { resolveUpdate = resolve; })
  };
  const rabbitClient = { listRabbits: async () => [] };
  const { helpers } = await load();
  const controller = helpers.createController({ fetchImpl: async () => {}, breedingClient, rabbitClient });
  await controller.selectCloud();
  controller.selectRecord(first);
  const pending = controller.updateCloud(first, { ...first.record, notes: "late" });
  controller.selectRecord(second);
  resolveUpdate(breeding("first", 1, { notes: "late" }));
  await pending;
  assert.equal(controller.getState().selected.record._id, "second");
  assert.equal(controller.getState().breedings.find(entry => entry.record._id === "first").metadata.revision, 0);
  breedingClient.updateBreeding = async () => { throw conflict; };
  controller.selectRecord(first);
  await assert.rejects(controller.updateCloud(first, first.record), error => error === conflict);
  assert.equal(controller.getState().breedings.find(entry => entry.record._id === "first").metadata.revision, 0);
  controller.selectLocal();
  assert.equal(controller.getState().source, "local");
  assert.equal(controller.getState().breedings.length, 0);
});

test("soft deletion removes only the selected cloud breeding and never retries", async () => {
  let calls = 0;
  const first = breeding("first");
  const second = breeding("second");
  const breedingClient = {
    DEFAULT_RABBITRY_ID: "dev-auth-test", listBreedings: async () => [first, second],
    deleteBreeding: async () => { calls += 1; return breeding("first", 1); }
  };
  const { helpers } = await load();
  const controller = helpers.createController({ fetchImpl: async () => {}, breedingClient,
    rabbitClient: { listRabbits: async () => [] } });
  await controller.selectCloud();
  controller.selectRecord(first);
  await controller.deleteCloud(first);
  assert.equal(calls, 1);
  assert.deepEqual(controller.getState().breedings.map(entry => entry.record._id), ["second"]);
  assert.equal(controller.getState().selected, null);
});

test("cloud breeding source contains no local storage, litter creation, or financial paths", async () => {
  const { source } = await load();
  assert.doesNotMatch(source, /localStorage|indexedDB|createLitter|reservation|payment|expense/);
  assert.doesNotMatch(source, /\bsave\s*\(/);
  assert.match(source, /Cloud litter creation is not enabled/);
});
