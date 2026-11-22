import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../cloud-rabbit-source.js", import.meta.url);
const clientUrl = new URL("../versioned-rabbit-cloud-client.js", import.meta.url);
const managementUrl = new URL("../rabbit-management-controller.js", import.meta.url);

function versionedRabbit(id = "cloud-1", name = "Cloud Clover", revision = 2, fields = {}) {
  return {
    typedId: `s:${JSON.stringify(id)}`,
    envelope: {
      schemaVersion: 1,
      id,
      revision,
      createdAt: "2026-11-19T08:00:00.000Z",
      updatedAt: "2026-11-19T09:00:00.000Z",
      record: { _id: id, Name: name, ...fields }
    },
    projections: { name, sex: null, birthDate: null }
  };
}

async function loadController(fetchImpl) {
  const source = await readFile(sourceUrl, "utf8");
  const clientSource = await readFile(clientUrl, "utf8");
  const managementSource = await readFile(managementUrl, "utf8");
  const context = {
    window: {},
    document: {},
    console,
    fetch: fetchImpl,
    structuredClone
  };
  vm.runInNewContext(managementSource, context, { filename: "rabbit-management-controller.js" });
  vm.runInNewContext(clientSource, context, { filename: "versioned-rabbit-cloud-client.js" });
  vm.runInNewContext(source, context, { filename: "cloud-rabbit-source.js" });
  return {
    source,
    CLOUD_ARCHIVE_FILTERS: context.window.twCloudRabbitSource.CLOUD_ARCHIVE_FILTERS,
    CLOUD_PROFILE_FIELDS: context.window.twCloudRabbitSource.CLOUD_PROFILE_FIELDS,
    CLOUD_VIEWS: context.window.twCloudRabbitSource.CLOUD_VIEWS,
    MAX_WEIGHT_ENTRIES: context.window.twCloudRabbitSource.MAX_WEIGHT_ENTRIES,
    MILESTONE_FIELDS: context.window.twCloudRabbitSource.MILESTONE_FIELDS,
    buildWeightHistoryFromDraft: context.window.twCloudRabbitSource.buildWeightHistoryFromDraft,
    clearMilestoneDraft: context.window.twCloudRabbitSource.clearMilestoneDraft,
    createArchiveRevision: context.window.twCloudRabbitSource.createArchiveRevision,
    createController: context.window.twCloudRabbitSource.createController,
    createMilestoneRevision: context.window.twCloudRabbitSource.createMilestoneRevision,
    createWeightRevision: context.window.twCloudRabbitSource.createWeightRevision,
    filterCloudRecords: context.window.twCloudRabbitSource.filterCloudRecords,
    isDevelopmentPreviewHost: context.window.twCloudRabbitSource.isDevelopmentPreviewHost,
    isValidDate: context.window.twCloudRabbitSource.isValidDate,
    nextCloudView: context.window.twCloudRabbitSource.nextCloudView,
    validateMilestones: context.window.twCloudRabbitSource.validateMilestones,
    validateWeightHistory: context.window.twCloudRabbitSource.validateWeightHistory,
    weightFromParts: context.window.twCloudRabbitSource.weightFromParts
  };
}

test("dated cloud weight helpers validate values, duplicates, limits, and complete clones", async () => {
  const helpers = await loadController(async () => { throw new Error("unused"); });
  assert.equal(helpers.isValidDate("2024-02-29"), true);
  assert.equal(helpers.isValidDate("2025-02-29"), false);
  assert.equal(helpers.weightFromParts("4", "8"), 72);
  assert.throws(() => helpers.weightFromParts("4", "8.5"), /whole ounces/);
  assert.throws(() => helpers.weightFromParts("4.5", "0"), /whole pounds/);
  assert.throws(() => helpers.weightFromParts("0", "16"), /through 15/);
  assert.throws(() => helpers.weightFromParts("0", "0"), /greater than zero/);
  const record = {
    _id: "weight-rabbit", Weight: "legacy free text", unknown: { retained: true },
    weightHistory: [{ date: "2026-01-01", ounces: 64, note: "preserve" }]
  };
  const next = helpers.createWeightRevision(record, [
    { date: "2026-01-01", ounces: 65, note: "preserve" },
    { date: "2026-02-01", ounces: 70.25 }
  ]);
  assert.equal(next.Weight, "legacy free text");
  assert.deepEqual(next.unknown, { retained: true });
  assert.equal(next.weightHistory[0].note, "preserve");
  assert.notEqual(next, record);
  assert.notEqual(next.unknown, record.unknown);
  assert.throws(() => helpers.validateWeightHistory([
    { date: "2026-01-01", ounces: 60 }, { date: "2026-01-01", ounces: 61 }
  ]), /duplicated/);
  assert.throws(() => helpers.validateWeightHistory([{ date: "bad", ounces: 60 }]), /malformed/);
  const fractional = [{ date: "2025-12-01", ounces: 63.75, imported: { retained: true } }];
  const preservedFractional = helpers.createWeightRevision(
    { _id: "fractional", weightHistory: fractional },
    [...fractional, { date: "2026-01-01", ounces: helpers.weightFromParts("4", "0") }]
  );
  assert.deepEqual(preservedFractional.weightHistory[0], fractional[0]);
  assert.equal(preservedFractional.weightHistory[1].ounces, 64);
  const draftPreserved = helpers.buildWeightHistoryFromDraft([{
    entry: fractional[0], date: "2025-12-01", pounds: "3", ounces: "15.75", changed: false
  }]);
  assert.deepEqual(draftPreserved[0], fractional[0]);
  assert.throws(() => helpers.buildWeightHistoryFromDraft([{
    entry: fractional[0], date: "2025-12-02", pounds: "3", ounces: "15.75", changed: true
  }]), /whole ounces/);
  assert.throws(() => helpers.validateWeightHistory(Array.from(
    { length: helpers.MAX_WEIGHT_ENTRIES + 1 }, (_, index) => ({ date: "2026-01-01", ounces: index + 1 })
  )), /cannot exceed/);
});

test("cloud milestone revisions preserve unknown keys and independent WeanedDate", async () => {
  const { clearMilestoneDraft, createMilestoneRevision, validateMilestones } = await loadController(async () => { throw new Error("unused"); });
  const record = {
    _id: "milestone-rabbit",
    WeanedDate: "2026-03-01",
    future: { retained: true },
    kitMilestones: { weaned: "2026-03-02", customFutureMilestone: "preserve" }
  };
  const next = createMilestoneRevision(record, {
    weaned: "", separated: "2026-03-15", readyForSale: "2026-04-01"
  });
  assert.equal(next.WeanedDate, "2026-03-01");
  assert.equal(next.kitMilestones.weaned, undefined);
  assert.equal(next.kitMilestones.separated, "2026-03-15");
  assert.equal(next.kitMilestones.readyForSale, "2026-04-01");
  assert.equal(next.kitMilestones.customFutureMilestone, "preserve");
  assert.deepEqual(next.future, { retained: true });
  assert.throws(() => validateMilestones({ weaned: "2026-02-30" }), /malformed/);
  assert.throws(() => validateMilestones([]), /must be an object/);
  const draft = { weaned: "2026-03-02", separated: "2026-03-15", readyForSale: "2026-04-01" };
  assert.equal(clearMilestoneDraft(draft, "separated"), draft);
  assert.deepEqual(draft, { weaned: "2026-03-02", separated: "", readyForSale: "2026-04-01" });
  assert.throws(() => clearMilestoneDraft(draft, "unknown"), /unavailable/);
});

test("cloud profile fields include biography, weaning date, and stored parent text", async () => {
  const { CLOUD_PROFILE_FIELDS } = await loadController(async () => { throw new Error("unused"); });
  assert.deepEqual(Array.from(CLOUD_PROFILE_FIELDS), [
    "Prefix", "Name", "Sex", "Tattoo", "Breed", "Color", "DoB", "Father", "Mother",
    "Weight", "Status", "Bio", "WeanedDate", "Notes"
  ]);
});

test("active and archived filters use only the explicit Archived flag", async () => {
  const { CLOUD_ARCHIVE_FILTERS, filterCloudRecords } = await loadController(async () => { throw new Error("unused"); });
  const records = [
    { record: { _id: "missing" } },
    { record: { _id: "false", Archived: false } },
    { record: { _id: "true", Archived: true } },
    { record: { _id: "truthy", Archived: "true" } }
  ];
  assert.deepEqual(Array.from(CLOUD_ARCHIVE_FILTERS), ["active", "archived"]);
  assert.deepEqual(filterCloudRecords(records, "active").map((entry) => entry.record._id), ["missing", "false", "truthy"]);
  assert.deepEqual(filterCloudRecords(records, "archived").map((entry) => entry.record._id), ["true"]);
  assert.throws(() => filterCloudRecords(records, "all"), /archive filter/);
});

test("archive revisions are deep complete-record clones that preserve canonical identity", async () => {
  const { createArchiveRevision } = await loadController(async () => { throw new Error("unused"); });
  const original = {
    _id: 42,
    Name: "Cloud Clover",
    Father: "Stored sire text",
    Mother: "Stored dam text",
    Bio: "Complete profile",
    WeanedDate: "2026-06-01",
    unknown: { nested: [1, { retained: true }] }
  };
  const archived = createArchiveRevision(original, true);
  assert.deepEqual(archived, { ...original, Archived: true });
  assert.equal(archived._id, 42);
  assert.notEqual(archived, original);
  assert.notEqual(archived.unknown, original.unknown);
  archived.unknown.nested[1].retained = false;
  assert.equal(original.unknown.nested[1].retained, true);
  assert.equal(createArchiveRevision(archived, false).Archived, false);
});

test("unified cloud navigation follows explicit list, detail, create, edit, and confirmation states", async () => {
  const { CLOUD_VIEWS, nextCloudView } = await loadController(async () => { throw new Error("unused"); });
  assert.deepEqual(Array.from(CLOUD_VIEWS), [
    "list", "detail", "create", "edit", "edit-weight", "edit-milestones", "confirm-delete"
  ]);
  assert.equal(nextCloudView("list", "select"), "detail");
  assert.equal(nextCloudView("detail", "edit"), "edit");
  assert.equal(nextCloudView("detail", "weight"), "edit-weight");
  assert.equal(nextCloudView("detail", "milestones"), "edit-milestones");
  assert.equal(nextCloudView("edit", "cancel"), "detail");
  assert.equal(nextCloudView("edit-weight", "success"), "detail");
  assert.equal(nextCloudView("edit-milestones", "cancel"), "detail");
  assert.equal(nextCloudView("detail", "delete"), "confirm-delete");
  assert.equal(nextCloudView("confirm-delete", "cancel"), "detail");
  assert.equal(nextCloudView("confirm-delete", "success"), "list");
  assert.equal(nextCloudView("detail", "back"), "list");
  assert.equal(nextCloudView("list", "create"), "create");
  assert.equal(nextCloudView("create", "cancel"), "list");
  assert.equal(nextCloudView("create", "success"), "detail");
  assert.equal(nextCloudView("edit", "reset"), "list");
  assert.throws(() => nextCloudView("list", "edit"), /navigation/);
});

test("cloud-first activation is limited to development Preview hosts", async () => {
  const { isDevelopmentPreviewHost } = await loadController(async () => { throw new Error("unused"); });
  assert.equal(isDevelopmentPreviewHost("cloud-development.tangled-woods-rabbitry.pages.dev"), true);
  assert.equal(isDevelopmentPreviewHost("c491e4ad.tangled-woods-rabbitry.pages.dev"), true);
  assert.equal(isDevelopmentPreviewHost("C491E4AD.TANGLED-WOODS-RABBITRY.PAGES.DEV."), true);
  for (const host of [
    "tangled-woods-rabbitry.pages.dev",
    "www.tangledwoodsrabbitry.com",
    "localhost",
    "127.0.0.1",
    "feature.tangled-woods-rabbitry.pages.dev",
    "c491e4ad.other-project.pages.dev",
    ""
  ]) assert.equal(isDevelopmentPreviewHost(host), false, host);
});

test("cloud-first initialization never invokes local save or modifies localStorage", async () => {
  let saveCalls = 0;
  let storageWrites = 0;
  const localRecords = [{ _id: 1, Name: "Local one" }, { _id: "1", Name: "Local text one" }];
  const before = structuredClone(localRecords);
  const request = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [versionedRabbit()] })
  });
  const { createController } = await loadController(request);
  const controller = createController({
    fetchImpl: request,
    render() {},
    save: () => { saveCalls += 1; },
    localStorage: { setItem: () => { storageWrites += 1; } }
  });

  await controller.initialize("cloud-development.tangled-woods-rabbitry.pages.dev");
  assert.equal(controller.getState().source, "cloud");
  assert.equal(controller.getState().status, "ready");
  assert.equal(saveCalls, 0);
  assert.equal(storageWrites, 0);
  assert.deepEqual(localRecords, before);
});

test("non-Preview initialization stays local without making a request", async () => {
  let requests = 0;
  const { createController } = await loadController(async () => { requests += 1; });
  const controller = createController({ fetchImpl: async () => { requests += 1; }, render() {} });
  await controller.initialize("tangled-woods-rabbitry.pages.dev");
  assert.equal(requests, 0);
  assert.equal(controller.getState().source, "local");
  assert.equal(controller.getState().status, "idle");
});

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
  assert.equal(controller.getState().sourceIdentity.kind, "versioned-cloud");
  assert.equal(typeof controller.getState().records[0].metadata.identityKey, "string");
  assert.deepEqual(localRecords, before);

  controller.selectLocal();
  assert.equal(controller.getState().source, "local");
  assert.equal(controller.getState().status, "idle");
  assert.equal(controller.getState().records.length, 0);
  assert.equal(controller.getState().sourceIdentity.kind, "local");
  assert.ok(renders.length >= 3);
});

test("failed, offline, and unauthenticated fetches clear cloud records", async () => {
  for (const [fetchImpl, expected] of [
    [async () => { throw new TypeError("offline"); }, /internet connection/],
    [async () => ({ ok: false, status: 401, json: async () => ({ error: "ignored" }) }), /authentication is required/],
    [async () => ({ ok: false, status: 403, json: async () => ({ error: "ignored" }) }), /access was denied/],
    [async () => ({ ok: false, status: 404, json: async () => ({ error: "ignored" }) }), /could not be found/],
    [async () => ({ ok: false, status: 409, json: async () => ({ error: "ignored" }) }), /already exists/],
    [async () => ({ ok: false, status: 503, json: async () => ({ error: "ignored" }) }), /temporarily unavailable/],
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

test("cloud selection is source-qualified and remains stable after an update", async () => {
  const request = async (url) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      return { ok: true, status: 200, json: async () => ({
        rabbitryId: "dev-auth-test", rabbits: [versionedRabbit("selected", "Before", 2)]
      }) };
    }
    if (url === "/api/test-update-versioned-rabbit") {
      return { ok: true, status: 200, json: async () => ({
        rabbitryId: "dev-auth-test", updated: true, rabbit: versionedRabbit("selected", "After", 3)
      }) };
    }
    throw new Error("Unexpected URL");
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const entry = controller.getState().records[0];
  controller.selectRecord(entry);
  const key = controller.getState().selected.metadata.identityKey;
  await controller.updateCloud(entry, { ...entry.record, Name: "After" });
  assert.equal(controller.getState().selected.metadata.identityKey, key);
  assert.equal(controller.getState().selected.metadata.revision, 3);
  assert.equal(controller.getState().selected.record.Name, "After");
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
  assert.deepEqual(requestBody.record.future, { retained: true });
  assert.equal(requestBody.record._id, entry.metadata.id);
  assert.equal(updated.metadata.revision, 3);
  assert.equal(controller.getState().records[0].record.Name, "Edited Clover");
  assert.deepEqual(localRecords, before);
});

test("weight and milestone saves append revisions without changing unrelated record fields", async () => {
  const bodies = [];
  const initial = {
    Weight: "do not synchronize",
    WeanedDate: "2026-01-02",
    unknown: { nested: ["retain"] },
    weightHistory: [{ date: "2026-01-01", ounces: 64, source: "legacy" }],
    kitMilestones: { custom: "retain" }
  };
  const request = async (url, options) => {
    if (url.startsWith("/api/test-versioned-rabbits")) return {
      ok: true, status: 200, json: async () => ({
        rabbitryId: "dev-auth-test", rabbits: [versionedRabbit("health-rabbit", "Health Rabbit", 2, initial)]
      })
    };
    const body = JSON.parse(options.body);
    bodies.push(body);
    return { ok: true, status: 200, json: async () => ({
      rabbitryId: "dev-auth-test", updated: true,
      rabbit: versionedRabbit("health-rabbit", "Health Rabbit", body.baseRevision + 1, body.record)
    }) };
  };
  const { createController, createMilestoneRevision, createWeightRevision } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const original = controller.getState().records[0];
  const withWeight = await controller.updateCloud(original, createWeightRevision(original.record, [
    ...original.record.weightHistory,
    { date: "2026-02-01", ounces: 70 }
  ]));
  const withMilestones = await controller.updateCloud(withWeight, createMilestoneRevision(withWeight.record, {
    weaned: "2026-02-02", separated: "", readyForSale: ""
  }));
  assert.deepEqual(bodies.map((body) => body.baseRevision), [2, 3]);
  assert.equal(withMilestones.metadata.revision, 4);
  assert.equal(withMilestones.record.Weight, "do not synchronize");
  assert.equal(withMilestones.record.WeanedDate, "2026-01-02");
  assert.deepEqual(withMilestones.record.unknown, { nested: ["retain"] });
  assert.equal(withMilestones.record.weightHistory[0].source, "legacy");
  assert.equal(withMilestones.record.kitMilestones.custom, "retain");
});

test("archive and unarchive use normal revision updates and preserve the complete record", async () => {
  const originalFields = {
    Bio: "Working rabbit profile",
    WeanedDate: "2026-05-12",
    Father: "Stored sire",
    Mother: "Stored dam",
    future: { nested: ["preserve", { value: 7 }] }
  };
  const requestBodies = [];
  const request = async (url, options) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      return { ok: true, status: 200, json: async () => ({
        rabbitryId: "dev-auth-test", rabbits: [versionedRabbit("profile-1", "Profile Rabbit", 6, originalFields)]
      }) };
    }
    if (url === "/api/test-update-versioned-rabbit") {
      const body = JSON.parse(options.body);
      requestBodies.push(body);
      return { ok: true, status: 200, json: async () => ({
        rabbitryId: "dev-auth-test",
        updated: true,
        rabbit: versionedRabbit("profile-1", "Profile Rabbit", body.baseRevision + 1, body.record)
      }) };
    }
    throw new Error("Unexpected URL");
  };
  const { createArchiveRevision, createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const active = controller.getState().records[0];
  const archivedRecord = createArchiveRevision(active.record, true);
  const archived = await controller.updateCloud(active, archivedRecord);
  assert.equal(archived.metadata.revision, 7);
  assert.equal(archived.record.Archived, true);
  assert.deepEqual(archived.record.future, originalFields.future);
  assert.equal(requestBodies[0].baseRevision, 6);
  assert.deepEqual(requestBodies[0].record, archivedRecord);

  const restoredRecord = createArchiveRevision(archived.record, false);
  const restored = await controller.updateCloud(archived, restoredRecord);
  assert.equal(restored.metadata.revision, 8);
  assert.equal(restored.record.Archived, false);
  assert.deepEqual(restored.record.future, originalFields.future);
  assert.equal(requestBodies[1].baseRevision, 7);
  assert.deepEqual(requestBodies[1].record, restoredRecord);
});

test("stale archive conflicts leave the complete loaded profile unchanged", async () => {
  const request = async (url) => url.startsWith("/api/test-versioned-rabbits")
    ? { ok: true, status: 200, json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [
      versionedRabbit("archive-conflict", "Conflict Rabbit", 4, { Bio: "Keep", unknown: { value: 1 } })
    ] }) }
    : { ok: false, status: 409, json: async () => ({ error: "private" }) };
  const { createArchiveRevision, createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const entry = controller.getState().records[0];
  await assert.rejects(controller.updateCloud(entry, createArchiveRevision(entry.record, true)), (error) => error.status === 409);
  const unchanged = controller.getState().records[0];
  assert.equal(unchanged.metadata.revision, 4);
  assert.equal(unchanged.record.Archived, undefined);
  assert.equal(unchanged.record.Bio, "Keep");
  assert.deepEqual(unchanged.record.unknown, { value: 1 });
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

test("duplicate soft-delete submissions share one request and remove only the matching cloud entry", async () => {
  const localRecords = [{ _id: "local-1", Name: "Local Maple" }];
  const before = structuredClone(localRecords);
  let deleteCalls = 0;
  let finishDelete;
  const pendingDelete = new Promise((resolve) => { finishDelete = resolve; });
  const request = async (url) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      return { ok: true, status: 200, json: async () => ({
        rabbitryId: "dev-auth-test",
        rabbits: [versionedRabbit("cloud-1"), versionedRabbit("cloud-2", "Cloud Hazel", 1)]
      }) };
    }
    if (url === "/api/test-delete-versioned-rabbit") {
      deleteCalls += 1;
      return pendingDelete;
    }
    throw new Error("Unexpected URL");
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const entry = controller.getState().records[0];
  const first = controller.deleteCloud(entry);
  const second = controller.deleteCloud(entry);
  assert.equal(first, second);
  finishDelete({ ok: true, status: 200, json: async () => ({
    rabbitryId: "dev-auth-test", deleted: true, deletedAt: "2026-11-21T08:00:00.000Z",
    rabbit: versionedRabbit("cloud-1", "Cloud Clover", 3)
  }) });
  await first;
  assert.equal(deleteCalls, 1);
  assert.deepEqual(controller.getState().records.map(item => item.metadata.id), ["cloud-2"]);
  assert.deepEqual(localRecords, before);
});

test("failed soft deletion preserves the loaded cloud entry", async () => {
  const request = async (url) => url.startsWith("/api/test-versioned-rabbits")
    ? { ok: true, status: 200, json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [versionedRabbit()] }) }
    : { ok: false, status: 409, json: async () => ({ error: "private" }) };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const entry = controller.getState().records[0];
  await assert.rejects(controller.deleteCloud(entry), (error) => error.status === 409);
  assert.equal(controller.getState().records.length, 1);
  assert.equal(controller.getState().records[0].metadata.revision, 2);
});

test("late create response cannot populate records after switching away and back", async () => {
  let finishCreate;
  const pending = new Promise((resolve) => { finishCreate = resolve; });
  const request = async (url) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      return { ok: true, status: 200, json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [] }) };
    }
    return pending;
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const saving = controller.createCloud({ _id: "late-create", Name: "Late" });
  controller.selectLocal();
  await controller.selectCloud();
  finishCreate({ ok: true, status: 201, json: async () => ({
    rabbitryId: "dev-auth-test", created: true, rabbit: versionedRabbit("late-create", "Late", 0)
  }) });
  await saving;
  assert.equal(controller.getState().source, "cloud");
  assert.equal(controller.getState().records.length, 0);
  assert.equal(controller.getState().selected, null);
});

test("late update response cannot replace a newly selected rabbit", async () => {
  let finishUpdate;
  const pending = new Promise((resolve) => { finishUpdate = resolve; });
  const request = async (url) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      return { ok: true, status: 200, json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [
        versionedRabbit("first", "First", 1), versionedRabbit("second", "Second", 4)
      ] }) };
    }
    return pending;
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const [first, second] = controller.getState().records;
  controller.selectRecord(first);
  const saving = controller.updateCloud(first, { ...first.record, Name: "First updated" });
  controller.selectRecord(second);
  finishUpdate({ ok: true, status: 200, json: async () => ({
    rabbitryId: "dev-auth-test", updated: true, rabbit: versionedRabbit("first", "First updated", 2)
  }) });
  await saving;
  assert.equal(controller.getState().selected.metadata.id, "second");
  assert.equal(controller.getState().selected.metadata.revision, 4);
  assert.equal(controller.getState().selected.record.Name, "Second");
});

test("late archive response cannot cross a source switch", async () => {
  let finishArchive;
  const pending = new Promise((resolve) => { finishArchive = resolve; });
  let listCalls = 0;
  const request = async (url) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      listCalls += 1;
      return { ok: true, status: 200, json: async () => ({
        rabbitryId: "dev-auth-test",
        rabbits: listCalls === 1 ? [versionedRabbit("archive-late", "Before", 1)] : []
      }) };
    }
    return pending;
  };
  const { createArchiveRevision, createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const entry = controller.getState().records[0];
  const archiving = controller.updateCloud(entry, createArchiveRevision(entry.record, true));
  controller.selectLocal();
  await controller.selectCloud();
  finishArchive({ ok: true, status: 200, json: async () => ({
    rabbitryId: "dev-auth-test", updated: true,
    rabbit: versionedRabbit("archive-late", "Before", 2, { Archived: true })
  }) });
  await archiving;
  assert.equal(controller.getState().source, "cloud");
  assert.equal(controller.getState().records.length, 0);
  assert.equal(controller.getState().selected, null);
});

test("late delete response cannot clear a newly selected rabbit", async () => {
  let finishDelete;
  const pending = new Promise((resolve) => { finishDelete = resolve; });
  const request = async (url) => {
    if (url.startsWith("/api/test-versioned-rabbits")) {
      return { ok: true, status: 200, json: async () => ({ rabbitryId: "dev-auth-test", rabbits: [
        versionedRabbit("first", "First", 1), versionedRabbit("second", "Second", 4)
      ] }) };
    }
    return pending;
  };
  const { createController } = await loadController(request);
  const controller = createController({ fetchImpl: request, render() {} });
  await controller.selectCloud();
  const [first, second] = controller.getState().records;
  controller.selectRecord(first);
  const deleting = controller.deleteCloud(first);
  controller.selectRecord(second);
  finishDelete({ ok: true, status: 200, json: async () => ({
    rabbitryId: "dev-auth-test", deleted: true, deletedAt: "2026-11-21T08:00:00.000Z",
    rabbit: versionedRabbit("first", "First", 2)
  }) });
  await deleting;
  assert.equal(controller.getState().selected.metadata.id, "second");
  assert.deepEqual(controller.getState().records.map(item => item.metadata.id), ["second"]);
});

test("cloud source contains no browser storage or physical-delete paths", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const clientSource = await readFile(clientUrl, "utf8");
  const managementSource = await readFile(managementUrl, "utf8");
  assert.match(source, /Development cloud/);
  assert.match(clientSource, /credentials: "same-origin"/);
  assert.doesNotMatch(source, /localStorage|indexedDB/);
  assert.doesNotMatch(source, /\bsave\s*\(/);
  assert.doesNotMatch(source, /method:\s*"(?:PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(source, /\bdb\s*=/);
  assert.doesNotMatch(source, /\b(?:restore|previewCSV|commitCSV|writePhotos)\s*\(/);
  assert.doesNotMatch(clientSource, /localStorage|indexedDB/);
  assert.match(clientSource, /test-create-versioned-rabbit/);
  assert.doesNotMatch(clientSource, /method:\s*"(?:PUT|PATCH|DELETE)"/);
  assert.match(clientSource, /test-update-versioned-rabbit/);
  assert.match(clientSource, /test-delete-versioned-rabbit/);
  assert.match(source, /Confirm versioned rabbit deletion/);
  assert.match(source, /function renderCloudForm/);
  assert.match(source, /viewMode === "confirm-delete"/);
  assert.doesNotMatch(source, /let (?:creating|editing|confirmingDelete)\s*=/);
  assert.match(source, /rabbitLabel\(entry\.record\)/);
  assert.match(source, /Delete versioned rabbit/);
  assert.match(source, /Archive rabbit/);
  assert.match(source, /Unarchive rabbit/);
  assert.match(source, /"Bio", "WeanedDate"/);
  assert.match(source, /CLOUD_ARCHIVE_FILTERS/);
  assert.match(source, /Filter cloud rabbits by archive status/);
  assert.match(source, /filters\.style\.gap = "12px"/);
  assert.match(source, /filters\.style\.flexWrap = "wrap"/);
  assert.match(source, /add\.style\.marginBottom = "14px"/);
  assert.match(source, /function styleCloudActionRow/);
  assert.match(source, /row\.style\.gap = "12px"/);
  assert.match(source, /row\.style\.flexWrap = "wrap"/);
  assert.match(source, /function styleCloudDestructiveButton/);
  assert.match(source, /Cloud rabbit actions/);
  assert.match(source, /Deletion confirmation actions/);
  assert.match(source, /remove\.style\.marginLeft = "auto"/);
  assert.match(source, /MAX_WEIGHT_ENTRIES = 500/);
  assert.match(source, /function renderCloudWeightCard/);
  assert.match(source, /function renderWeightGraph/);
  assert.match(source, /function renderCloudWeightEditor/);
  assert.match(source, /function renderCloudMilestoneEditor/);
  assert.match(source, /viewMode === "edit-weight"/);
  assert.match(source, /viewMode === "edit-milestones"/);
  assert.match(source, /The existing Weight field is not changed/);
  assert.match(source, /WeanedDate and relationship records are not changed/);
  assert.match(source, /Weight history actions/);
  assert.match(source, /actions\.style\.marginTop = "16px"/);
  assert.match(source, /Clear \$\{label\} date/);
  assert.match(source, /clear\.style\.minWidth = "44px"/);
  assert.match(source, /clearMilestoneDraft\(milestoneDraft, key\)/);
  assert.doesNotMatch(managementSource, /localStorage|indexedDB|\/api\//);
});
