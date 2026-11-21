(function () {
  "use strict";

  const LOCAL = "local";
  const VERSIONED = "versioned-cloud";

  function clone(value) {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function typedId(id) {
    if (typeof id === "string") return `s:${JSON.stringify(id)}`;
    if (typeof id !== "number" || !Number.isFinite(id) || Object.is(id, -0)) {
      throw new TypeError("Rabbit ID must be a string or finite number");
    }
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, id, false);
    let encoded = "n:";
    for (let index = 0; index < 8; index += 1) {
      encoded += view.getUint8(index).toString(16).padStart(2, "0");
    }
    return encoded;
  }

  function localSource() {
    return Object.freeze({ kind: LOCAL, key: LOCAL });
  }

  function versionedSource(rabbitryId) {
    if (typeof rabbitryId !== "string" || !rabbitryId.trim()) {
      throw new TypeError("rabbitryId is required");
    }
    return Object.freeze({
      kind: VERSIONED,
      rabbitryId,
      key: `${VERSIONED}:${JSON.stringify(rabbitryId)}`
    });
  }

  function validateSource(source) {
    if (!isObject(source)) throw new TypeError("Rabbit source is required");
    if (source.kind === LOCAL && source.key === LOCAL) return localSource();
    if (source.kind === VERSIONED) {
      const expected = versionedSource(source.rabbitryId);
      if (source.key !== expected.key) throw new TypeError("Rabbit source is invalid");
      return expected;
    }
    throw new TypeError("Rabbit source is invalid");
  }

  function identity(source, id, options = {}) {
    const validSource = validateSource(source);
    const canonicalTypedId = typedId(id);
    if (options.typedId !== undefined && options.typedId !== canonicalTypedId) {
      throw new TypeError("Rabbit typed ID is not canonical");
    }
    const revision = options.revision ?? null;
    if (validSource.kind === VERSIONED && (!Number.isSafeInteger(revision) || revision < 0)) {
      throw new TypeError("Versioned rabbit revision is required");
    }
    if (validSource.kind === LOCAL && revision !== null) {
      throw new TypeError("Local rabbit revisions are not supported");
    }
    return Object.freeze({
      source: validSource,
      id: clone(id),
      typedId: canonicalTypedId,
      revision,
      key: JSON.stringify([validSource.key, canonicalTypedId])
    });
  }

  function qualifyLocal(record) {
    if (!isObject(record) || !Object.hasOwn(record, "_id")) {
      throw new TypeError("Local rabbit record is invalid");
    }
    const rabbitIdentity = identity(localSource(), record._id);
    return {
      record: clone(record),
      metadata: { source: rabbitIdentity.source, identity: rabbitIdentity, identityKey: rabbitIdentity.key }
    };
  }

  function qualifyVersioned(entry, source) {
    const validSource = validateSource(source);
    if (validSource.kind !== VERSIONED || !isObject(entry) || !isObject(entry.record) ||
        !isObject(entry.metadata) || entry.metadata.rabbitryId !== validSource.rabbitryId ||
        !Object.hasOwn(entry.record, "_id")) {
      throw new TypeError("Versioned rabbit record is invalid");
    }
    const rabbitIdentity = identity(validSource, entry.record._id, {
      typedId: entry.metadata.typedId,
      revision: entry.metadata.revision
    });
    return {
      record: clone(entry.record),
      metadata: {
        ...clone(entry.metadata),
        source: rabbitIdentity.source,
        identity: rabbitIdentity,
        identityKey: rabbitIdentity.key
      }
    };
  }

  function createController({ source = localSource() } = {}) {
    let activeSource = validateSource(source);
    let records = [];
    let selectedKey = null;

    function qualify(entry) {
      return activeSource.kind === LOCAL
        ? qualifyLocal(entry)
        : qualifyVersioned(entry, activeSource);
    }

    function snapshot() {
      const selected = selectedKey === null
        ? null
        : records.find(entry => entry.metadata.identityKey === selectedKey) || null;
      return { source: activeSource, records: records.slice(), selected };
    }

    function activate(nextSource) {
      activeSource = validateSource(nextSource);
      records = [];
      selectedKey = null;
      return snapshot();
    }

    function setRecords(nextRecords) {
      if (!Array.isArray(nextRecords)) throw new TypeError("Rabbit records must be an array");
      const qualified = nextRecords.map(qualify);
      const keys = new Set();
      for (const entry of qualified) {
        if (keys.has(entry.metadata.identityKey)) throw new TypeError("Duplicate rabbit identity");
        keys.add(entry.metadata.identityKey);
      }
      records = qualified;
      if (selectedKey !== null && !keys.has(selectedKey)) selectedKey = null;
      return snapshot();
    }

    function upsert(entry) {
      const qualified = qualify(entry);
      const key = qualified.metadata.identityKey;
      const index = records.findIndex(candidate => candidate.metadata.identityKey === key);
      records = records.slice();
      if (index < 0) records.push(qualified);
      else records[index] = qualified;
      return qualified;
    }

    function remove(identityKey) {
      if (typeof identityKey !== "string") throw new TypeError("Rabbit identity key is required");
      records = records.filter(entry => entry.metadata.identityKey !== identityKey);
      if (selectedKey === identityKey) selectedKey = null;
      return snapshot();
    }

    function select(identityKey) {
      if (typeof identityKey !== "string" ||
          !records.some(entry => entry.metadata.identityKey === identityKey)) {
        throw new TypeError("Rabbit selection is unavailable");
      }
      selectedKey = identityKey;
      return snapshot().selected;
    }

    function clearSelection() {
      selectedKey = null;
    }

    return { getState: snapshot, activate, setRecords, upsert, remove, select, clearSelection };
  }

  window.twRabbitManagementController = {
    SOURCE_KINDS: Object.freeze({ LOCAL, VERSIONED }),
    localSource,
    versionedSource,
    identity,
    qualifyLocal,
    qualifyVersioned,
    createController
  };
})();
