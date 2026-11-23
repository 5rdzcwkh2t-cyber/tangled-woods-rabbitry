(function () {
  "use strict";

  const DEFAULT_RABBITRY_ID = "dev-auth-test";
  const LIST_API = "/api/test-versioned-litters";
  const CREATE_API = "/api/test-create-versioned-litter";
  const UPDATE_API = "/api/test-update-versioned-litter";
  const DELETE_API = "/api/test-delete-versioned-litter";

  class CloudLitterError extends Error {
    constructor(message, options = {}) {
      super(message); this.name = "CloudLitterError"; this.status = options.status;
      this.category = options.category || "unknown"; this.offline = options.offline === true;
      this.operation = options.operation;
    }
  }
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const clone = value => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  function encodeId(id) {
    if (typeof id === "string") return `s:${JSON.stringify(id)}`;
    if (typeof id !== "number" || !Number.isFinite(id) || Object.is(id, -0)) throw new TypeError("Invalid litter ID");
    const buffer = new ArrayBuffer(8); const view = new DataView(buffer); view.setFloat64(0, id, false); let value = "n:";
    for (let i = 0; i < 8; i += 1) value += view.getUint8(i).toString(16).padStart(2, "0");
    return value;
  }
  function canonicalTypedId(value) {
    if (typeof value !== "string") return false;
    if (/^n:[0-9a-f]{16}$/.test(value)) return true;
    if (!value.startsWith("s:")) return false;
    try { const decoded = JSON.parse(value.slice(2)); return typeof decoded === "string" && `s:${JSON.stringify(decoded)}` === value; }
    catch { return false; }
  }
  function validDate(value, optional = false) {
    if (optional && (value === undefined || value === null || value === "")) return true;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number); const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }
  function validCount(value) { return value === undefined || (Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))); }
  function validateItem(item, rabbitryId) {
    if (!isObject(item) || typeof item.typedId !== "string" || !isObject(item.envelope)) throw malformed();
    const e = item.envelope; const r = e.record;
    if (e.entityType !== "litter" || !Number.isInteger(e.schemaVersion) || e.schemaVersion < 1 ||
      !Number.isSafeInteger(e.revision) || e.revision < 0 || typeof e.createdAt !== "string" || !e.createdAt ||
      typeof e.updatedAt !== "string" || !e.updatedAt || !isObject(r) || !Object.hasOwn(r, "_id") ||
      !Object.is(r._id, e.id) || encodeId(e.id) !== item.typedId || !isObject(item.projections) ||
      !canonicalTypedId(r.breedingTypedId) || !canonicalTypedId(r.damTypedId) || !canonicalTypedId(r.sireTypedId) ||
      r.damTypedId === r.sireTypedId || !validDate(r.Bred, true) || !validDate(r.Born) ||
      typeof r.Dam !== "string" || !r.Dam.trim() || typeof r.Sire !== "string" || !r.Sire.trim() ||
      !["Total Kits", "Live Kits", "Stillborn Kits", "Died Kits", "Sold Kits"].every(key => validCount(r[key]))) throw malformed();
    return { record: clone(r), metadata: { rabbitryId, typedId: item.typedId, id: clone(e.id), schemaVersion: e.schemaVersion,
      revision: e.revision, createdAt: e.createdAt, updatedAt: e.updatedAt, projections: clone(item.projections) } };
  }
  function malformed(status) { return new CloudLitterError("Invalid cloud litter response", { status, category: "malformed" }); }
  async function responseBody(response) { try { return await response.json(); } catch { throw malformed(response.status); } }
  async function request(fetchImpl, url, options) {
    try { return await fetchImpl(url, options); }
    catch (cause) { throw new CloudLitterError("Network request failed", { category: "network", offline: true, cause }); }
  }
  function httpError(status, operation) { return new CloudLitterError("Cloud litter request failed", {
    status, operation, category: status === 409 ? "revision-conflict" : status === 400 ? "validation" : "http"
  }); }
  async function listLitters({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    const response = await request(fetchImpl, `${LIST_API}?rabbitryId=${encodeURIComponent(rabbitryId)}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }
    });
    const body = await responseBody(response); if (!response.ok) throw httpError(response.status, "list");
    if (!isObject(body) || body.rabbitryId !== rabbitryId || !Array.isArray(body.litters)) throw malformed();
    return body.litters.map(item => validateItem(item, rabbitryId));
  }
  async function getLitter({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, typedId } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (!canonicalTypedId(typedId)) throw new TypeError("typedId is required");
    const response = await request(fetchImpl, `${LIST_API}?rabbitryId=${encodeURIComponent(rabbitryId)}&typedId=${encodeURIComponent(typedId)}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }
    });
    const body = await responseBody(response); if (!response.ok) throw httpError(response.status, "detail");
    if (!isObject(body) || body.rabbitryId !== rabbitryId || !isObject(body.litter)) throw malformed();
    const result = validateItem(body.litter, rabbitryId); if (result.metadata.typedId !== typedId) throw malformed();
    return result;
  }
  function createLitterId() {
    if (typeof crypto !== "object" || typeof crypto.randomUUID !== "function") throw new CloudLitterError("Secure litter ID generation is unavailable", { category: "id" });
    return `l-cloud-${crypto.randomUUID()}`;
  }
  async function write({ fetchImpl, rabbitryId, endpoint, body, successKey, expectedRevision, expectedId, operation }) {
    const response = await request(fetchImpl, endpoint, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await responseBody(response); if (!response.ok) throw httpError(response.status, operation);
    if (!isObject(payload) || payload[successKey] !== true || payload.rabbitryId !== rabbitryId) throw malformed();
    const result = validateItem(payload.litter, rabbitryId);
    if (!Object.is(result.record._id, expectedId) || result.metadata.revision !== expectedRevision) throw malformed();
    if (successKey === "deleted") result.metadata.deletedAt = payload.deletedAt;
    return result;
  }
  function createLitter({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, breedingTypedId, record } = {}) {
    if (!canonicalTypedId(breedingTypedId) || !isObject(record) || !Object.hasOwn(record, "_id")) throw new TypeError("breedingTypedId and record are required");
    return write({ fetchImpl, rabbitryId, endpoint: CREATE_API, body: { rabbitryId, breedingTypedId, record: clone(record) },
      successKey: "created", expectedRevision: 0, expectedId: record._id, operation: "create" });
  }
  function updateLitter({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, baseRevision, record } = {}) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !isObject(record)) throw new TypeError("baseRevision and record are required");
    return write({ fetchImpl, rabbitryId, endpoint: UPDATE_API, body: { rabbitryId, baseRevision, record: clone(record) },
      successKey: "updated", expectedRevision: baseRevision + 1, expectedId: record._id, operation: "update" });
  }
  function deleteLitter({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, typedId, baseRevision, id } = {}) {
    if (!canonicalTypedId(typedId) || !Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new TypeError("typedId and baseRevision are required");
    return write({ fetchImpl, rabbitryId, endpoint: DELETE_API, body: { rabbitryId, typedId, baseRevision },
      successKey: "deleted", expectedRevision: baseRevision + 1, expectedId: id, operation: "delete" });
  }
  function requestMessage(error) {
    if (error?.status === 401) return "Cloudflare Access authentication is required. Sign in, then try again.";
    if (error?.status === 403) return "Cloud litter access was denied. Confirm your Development rabbitry role.";
    if (error?.status === 404) return "The development rabbitry, litter, or linked breeding could not be found.";
    if (error?.category === "revision-conflict" && error.operation === "create") return "That breeding already has a live litter, or changed while this litter was being saved. Reload before trying again.";
    if (error?.category === "revision-conflict" && error.operation === "delete") return "This litter changed or has linked kits and cannot be deleted. Reload before trying again.";
    if (error?.category === "revision-conflict") return "This litter changed after you opened it. Reload cloud litters before trying again; your changes were not saved.";
    if (error?.category === "validation") return "The litter could not be saved because its data or breeding relationship is invalid.";
    if (error?.offline) return "Cloud litters could not be reached. Check the internet connection and try again.";
    if (error?.category === "id") return "A secure litter ID could not be generated in this browser.";
    if (error?.category === "malformed") return "Cloud litters returned an invalid response. Local records were not changed.";
    return "Cloud litters could not be loaded. Local records were not changed.";
  }
  window.twVersionedLitterClient = { DEFAULT_RABBITRY_ID, CloudLitterError, listLitters, getLitter, createLitterId,
    createLitter, updateLitter, deleteLitter, requestMessage };
})();
