(function () {
  "use strict";

  const DEFAULT_RABBITRY_ID = "dev-auth-test";
  const API = "/api/test-versioned-rabbits";
  const CREATE_API = "/api/test-create-versioned-rabbit";
  const UPDATE_API = "/api/test-update-versioned-rabbit";
  const DELETE_API = "/api/test-delete-versioned-rabbit";

  class CloudRabbitError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "CloudRabbitError";
      this.status = options.status;
      this.category = options.category || "unknown";
      this.offline = options.offline === true;
    }
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function encodeId(id) {
    if (typeof id === "string") return `s:${JSON.stringify(id)}`;
    if (typeof id !== "number" || !Number.isFinite(id)) throw new TypeError("Invalid rabbit ID");
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, id, false);
    let encoded = "n:";
    for (let index = 0; index < 8; index += 1) {
      encoded += view.getUint8(index).toString(16).padStart(2, "0");
    }
    return encoded;
  }

  function validateItem(item, rabbitryId) {
    if (!isObject(item) || typeof item.typedId !== "string" || !isObject(item.envelope)) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    const envelope = item.envelope;
    if (
      !Number.isInteger(envelope.schemaVersion) || envelope.schemaVersion < 1 ||
      !Number.isSafeInteger(envelope.revision) || envelope.revision < 0 ||
      typeof envelope.createdAt !== "string" || !envelope.createdAt ||
      typeof envelope.updatedAt !== "string" || !envelope.updatedAt ||
      !isObject(envelope.record) ||
      !Object.hasOwn(envelope.record, "_id") ||
      !Object.is(envelope.record._id, envelope.id) ||
      encodeId(envelope.id) !== item.typedId
    ) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    if (item.projections !== undefined && !isObject(item.projections)) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    return {
      record: clone(envelope.record),
      metadata: {
        rabbitryId,
        typedId: item.typedId,
        id: clone(envelope.id),
        schemaVersion: envelope.schemaVersion,
        revision: envelope.revision,
        createdAt: envelope.createdAt,
        updatedAt: envelope.updatedAt,
        projections: clone(item.projections || {})
      }
    };
  }

  async function listRabbits({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof rabbitryId !== "string" || !rabbitryId.trim()) throw new TypeError("rabbitryId is required");
    const url = `${API}?rabbitryId=${encodeURIComponent(rabbitryId)}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
    } catch (cause) {
      throw new CloudRabbitError("Network request failed", { category: "network", offline: true, cause });
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new CloudRabbitError("Invalid cloud rabbit response", {
        status: response.status,
        category: "malformed"
      });
    }
    if (!response.ok) {
      throw new CloudRabbitError("Cloud rabbit request failed", {
        status: response.status,
        category: "http"
      });
    }
    if (!isObject(body) || body.rabbitryId !== rabbitryId || !Array.isArray(body.rabbits)) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    return body.rabbits.map((item) => validateItem(item, rabbitryId));
  }

  function createRabbitId() {
    if (typeof crypto !== "object" || typeof crypto.randomUUID !== "function") {
      throw new CloudRabbitError("Secure rabbit ID generation is unavailable", { category: "id" });
    }
    return `r-cloud-${crypto.randomUUID()}`;
  }

  async function createRabbit({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, record } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof rabbitryId !== "string" || !rabbitryId.trim()) throw new TypeError("rabbitryId is required");
    if (!isObject(record) || !Object.hasOwn(record, "_id")) throw new TypeError("record is required");

    let response;
    try {
      response = await fetchImpl(CREATE_API, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ rabbitryId, record: clone(record) })
      });
    } catch (cause) {
      throw new CloudRabbitError("Network request failed", { category: "network", offline: true, cause });
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new CloudRabbitError("Invalid cloud rabbit response", {
        status: response.status,
        category: "malformed"
      });
    }
    if (!response.ok) {
      throw new CloudRabbitError("Cloud rabbit request failed", {
        status: response.status,
        category: "http"
      });
    }
    if (!isObject(body) || body.created !== true || body.rabbitryId !== rabbitryId) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    const created = validateItem(body.rabbit, rabbitryId);
    if (!Object.is(created.record._id, record._id) || created.metadata.revision !== 0) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    return created;
  }

  async function updateRabbit({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, baseRevision, record } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof rabbitryId !== "string" || !rabbitryId.trim()) throw new TypeError("rabbitryId is required");
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new TypeError("baseRevision is required");
    if (!isObject(record) || !Object.hasOwn(record, "_id")) throw new TypeError("record is required");
    let response;
    try {
      response = await fetchImpl(UPDATE_API, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ rabbitryId, baseRevision, record: clone(record) })
      });
    } catch (cause) {
      throw new CloudRabbitError("Network request failed", { category: "network", offline: true, cause });
    }
    let body;
    try { body = await response.json(); }
    catch { throw new CloudRabbitError("Invalid cloud rabbit response", { status: response.status, category: "malformed" }); }
    if (!response.ok) throw new CloudRabbitError("Cloud rabbit request failed", {
      status: response.status,
      category: response.status === 409 ? "revision-conflict" : response.status === 400 ? "validation" : "http"
    });
    if (!isObject(body) || body.updated !== true || body.rabbitryId !== rabbitryId) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    const updated = validateItem(body.rabbit, rabbitryId);
    if (!Object.is(updated.record._id, record._id) || updated.metadata.revision !== baseRevision + 1) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    return updated;
  }

  async function deleteRabbit({ fetchImpl, rabbitryId = DEFAULT_RABBITRY_ID, typedId, baseRevision } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof rabbitryId !== "string" || !rabbitryId.trim()) throw new TypeError("rabbitryId is required");
    if (typeof typedId !== "string" || !typedId) throw new TypeError("typedId is required");
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new TypeError("baseRevision is required");
    let response;
    try {
      response = await fetchImpl(DELETE_API, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ rabbitryId, typedId, baseRevision })
      });
    } catch (cause) {
      throw new CloudRabbitError("Network request failed", { category: "network", offline: true, cause });
    }
    let body;
    try { body = await response.json(); }
    catch { throw new CloudRabbitError("Invalid cloud rabbit response", { status: response.status, category: "malformed" }); }
    if (!response.ok) throw new CloudRabbitError("Cloud rabbit request failed", {
      status: response.status,
      category: response.status === 409 ? "revision-conflict" : response.status === 400 ? "validation" : "http"
    });
    if (!isObject(body) || body.deleted !== true || body.rabbitryId !== rabbitryId ||
        typeof body.deletedAt !== "string" || !body.deletedAt) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    const deleted = validateItem(body.rabbit, rabbitryId);
    if (deleted.metadata.typedId !== typedId || deleted.metadata.revision !== baseRevision + 1) {
      throw new CloudRabbitError("Invalid cloud rabbit response", { category: "malformed" });
    }
    deleted.metadata.deletedAt = body.deletedAt;
    return deleted;
  }

  function requestMessage(error) {
    if (error?.status === 401) return "Cloudflare Access authentication is required. Sign in, then try again.";
    if (error?.status === 403) return "Cloud rabbit access was denied. Confirm the Development D1 environment and your rabbitry role.";
    if (error?.status === 404) return "The development rabbitry could not be found or is not available to this account.";
    if (error?.category === "revision-conflict") return "This cloud rabbit changed after you opened it. Reload Development D1 before trying again; your changes were not saved.";
    if (error?.category === "validation") return "The cloud rabbit could not be saved because its data was invalid. No changes were made.";
    if (error?.status === 409) return "A cloud rabbit with this ID already exists. Reload before trying again.";
    if (error?.status === 503) return "Versioned cloud rabbit storage is temporarily unavailable.";
    if (error?.offline) return "Cloud rabbits could not be reached. Check the internet connection and try again.";
    if (error?.category === "id") return "A secure cloud rabbit ID could not be generated in this browser.";
    if (error?.category === "malformed") return "Cloud rabbits returned an invalid response. Local rabbits were not changed.";
    return "Cloud rabbits could not be loaded. Try again; local rabbits were not changed.";
  }

  window.twVersionedRabbitClient = {
    DEFAULT_RABBITRY_ID,
    CloudRabbitError,
    listRabbits,
    createRabbitId,
    createRabbit,
    updateRabbit,
    deleteRabbit,
    requestMessage
  };
})();
