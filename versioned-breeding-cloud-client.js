(function () {
  "use strict";

  const DEFAULT_RABBITRY_ID = "dev-auth-test";
  const LIST_API = "/api/test-versioned-breedings";
  const CREATE_API = "/api/test-create-versioned-breeding";
  const UPDATE_API = "/api/test-update-versioned-breeding";
  const DELETE_API = "/api/test-delete-versioned-breeding";
  const STATUSES = new Set(["Bred", "Confirmed pregnant", "Kindled", "Unsuccessful", "Cancelled"]);
  const OUTCOMES = new Set(["Not recorded", "Live litter", "Mixed live and stillborn", "Stillborn litter", "No litter"]);

  class CloudBreedingError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "CloudBreedingError";
      this.status = options.status;
      this.category = options.category || "unknown";
      this.offline = options.offline === true;
    }
  }

  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const clone = value => typeof structuredClone === "function"
    ? structuredClone(value) : JSON.parse(JSON.stringify(value));

  function encodeId(id) {
    if (typeof id === "string") return `s:${JSON.stringify(id)}`;
    if (typeof id !== "number" || !Number.isFinite(id) || Object.is(id, -0)) throw new TypeError("Invalid breeding ID");
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, id, false);
    let value = "n:";
    for (let index = 0; index < 8; index += 1) value += view.getUint8(index).toString(16).padStart(2, "0");
    return value;
  }

  function canonicalTypedId(value) {
    if (typeof value !== "string") return false;
    if (/^n:[0-9a-f]{16}$/.test(value)) return true;
    if (!value.startsWith("s:")) return false;
    try {
      const decoded = JSON.parse(value.slice(2));
      return typeof decoded === "string" && `s:${JSON.stringify(decoded)}` === value;
    } catch { return false; }
  }

  function validDate(value, optional = false) {
    if (optional && (value === undefined || value === null || value === "")) return true;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function validateItem(item, rabbitryId) {
    if (!isObject(item) || typeof item.typedId !== "string" || !isObject(item.envelope)) {
      throw new CloudBreedingError("Invalid cloud breeding response", { category: "malformed" });
    }
    const envelope = item.envelope;
    if (envelope.entityType !== "breeding" || !Number.isInteger(envelope.schemaVersion) || envelope.schemaVersion < 1 ||
        !Number.isSafeInteger(envelope.revision) || envelope.revision < 0 ||
        typeof envelope.createdAt !== "string" || !envelope.createdAt ||
        typeof envelope.updatedAt !== "string" || !envelope.updatedAt || !isObject(envelope.record) ||
        !Object.hasOwn(envelope.record, "_id") || !Object.is(envelope.record._id, envelope.id) ||
        encodeId(envelope.id) !== item.typedId || !isObject(item.projections) ||
        !canonicalTypedId(envelope.record.doeTypedId) || !canonicalTypedId(envelope.record.buckTypedId) ||
        envelope.record.doeTypedId === envelope.record.buckTypedId || !validDate(envelope.record.date) ||
        !validDate(envelope.record.expectedKindlingDate, true) || !validDate(envelope.record.kindledDate, true) ||
        !STATUSES.has(envelope.record.status) ||
        (envelope.record.outcome !== undefined && !OUTCOMES.has(envelope.record.outcome))) {
      throw new CloudBreedingError("Invalid cloud breeding response", { category: "malformed" });
    }
    return {
      record: clone(envelope.record),
      metadata: {
        rabbitryId, typedId: item.typedId, id: clone(envelope.id),
        schemaVersion: envelope.schemaVersion, revision: envelope.revision,
        createdAt: envelope.createdAt, updatedAt: envelope.updatedAt,
        projections: clone(item.projections)
      }
    };
  }

  async function responseBody(response) {
    try { return await response.json(); }
    catch { throw new CloudBreedingError("Invalid cloud breeding response", {
      status: response.status, category: "malformed"
    }); }
  }

  async function request(fetchImpl, url, options) {
    try { return await fetchImpl(url, options); }
    catch (cause) {
      throw new CloudBreedingError("Network request failed", { category: "network", offline: true, cause });
    }
  }

  async function listBreedings({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof rabbitryId !== "string" || !rabbitryId.trim()) throw new TypeError("rabbitryId is required");
    const response = await request(fetchImpl, `${LIST_API}?rabbitryId=${encodeURIComponent(rabbitryId)}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }
    });
    const body = await responseBody(response);
    if (!response.ok) throw httpError(response.status);
    if (!isObject(body) || body.rabbitryId !== rabbitryId || !Array.isArray(body.breedings)) {
      throw new CloudBreedingError("Invalid cloud breeding response", { category: "malformed" });
    }
    return body.breedings.map(item => validateItem(item, rabbitryId));
  }

  function createBreedingId() {
    if (typeof crypto !== "object" || typeof crypto.randomUUID !== "function") {
      throw new CloudBreedingError("Secure breeding ID generation is unavailable", { category: "id" });
    }
    return `b-cloud-${crypto.randomUUID()}`;
  }

  function httpError(status) {
    return new CloudBreedingError("Cloud breeding request failed", {
      status,
      category: status === 409 ? "revision-conflict" : status === 400 ? "validation" : "http"
    });
  }

  async function write({ fetchImpl, rabbitryId, endpoint, body, successKey, expectedRevision, expectedId }) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof rabbitryId !== "string" || !rabbitryId.trim()) throw new TypeError("rabbitryId is required");
    const response = await request(fetchImpl, endpoint, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await responseBody(response);
    if (!response.ok) throw httpError(response.status);
    if (!isObject(payload) || payload[successKey] !== true || payload.rabbitryId !== rabbitryId) {
      throw new CloudBreedingError("Invalid cloud breeding response", { category: "malformed" });
    }
    const result = validateItem(payload.breeding, rabbitryId);
    if (!Object.is(result.record._id, expectedId) || result.metadata.revision !== expectedRevision) {
      throw new CloudBreedingError("Invalid cloud breeding response", { category: "malformed" });
    }
    if (successKey === "deleted") {
      if (typeof payload.deletedAt !== "string" || !payload.deletedAt) {
        throw new CloudBreedingError("Invalid cloud breeding response", { category: "malformed" });
      }
      result.metadata.deletedAt = payload.deletedAt;
    }
    return result;
  }

  function createBreeding({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, record } = {}) {
    if (!isObject(record) || !Object.hasOwn(record, "_id")) throw new TypeError("record is required");
    return write({ fetchImpl, rabbitryId, endpoint: CREATE_API,
      body: { rabbitryId, record: clone(record) }, successKey: "created", expectedRevision: 0, expectedId: record._id });
  }

  function updateBreeding({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, baseRevision, record } = {}) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new TypeError("baseRevision is required");
    if (!isObject(record) || !Object.hasOwn(record, "_id")) throw new TypeError("record is required");
    return write({ fetchImpl, rabbitryId, endpoint: UPDATE_API,
      body: { rabbitryId, baseRevision, record: clone(record) }, successKey: "updated",
      expectedRevision: baseRevision + 1, expectedId: record._id });
  }

  function deleteBreeding({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, typedId, baseRevision, id } = {}) {
    if (typeof typedId !== "string" || !typedId) throw new TypeError("typedId is required");
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new TypeError("baseRevision is required");
    return write({ fetchImpl, rabbitryId, endpoint: DELETE_API,
      body: { rabbitryId, typedId, baseRevision }, successKey: "deleted",
      expectedRevision: baseRevision + 1, expectedId: id });
  }

  function requestMessage(error) {
    if (error?.status === 401) return "Cloudflare Access authentication is required. Sign in, then try again.";
    if (error?.status === 403) return "Cloud breeding access was denied. Confirm your Development rabbitry role.";
    if (error?.status === 404) return "The development rabbitry or breeding could not be found.";
    if (error?.category === "revision-conflict") return "This breeding changed after you opened it. Reload cloud breedings before trying again; your changes were not saved.";
    if (error?.category === "validation") return "The breeding could not be saved because its data or parent relationship is invalid.";
    if (error?.status === 503) return "Versioned breeding storage is temporarily unavailable.";
    if (error?.offline) return "Cloud breedings could not be reached. Check the internet connection and try again.";
    if (error?.category === "id") return "A secure breeding ID could not be generated in this browser.";
    if (error?.category === "malformed") return "Cloud breedings returned an invalid response. Local records were not changed.";
    return "Cloud breedings could not be loaded. Local records were not changed.";
  }

  window.twVersionedBreedingClient = {
    DEFAULT_RABBITRY_ID, CloudBreedingError, listBreedings, createBreedingId,
    createBreeding, updateBreeding, deleteBreeding, requestMessage
  };
})();
