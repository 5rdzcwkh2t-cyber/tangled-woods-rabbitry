import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_BYTES,
  RABBIT_SCHEMA_VERSION,
  RabbitContractError,
  createRabbitEnvelope,
  deriveRabbitProjections,
  validateRabbitEnvelope,
  validateRabbitRecord
} from "../rabbit-record-contract.js";

test("legacy records and imported nested fields round trip without loss", () => {
  const original = {
    _id: "legacy-001",
    Name: "  Maple   Wood  ",
    Sex: "dOE",
    DoB: "04/15/2025",
    DOB: "",
    Weight: "4 lb 7 oz",
    imported: {
      source: "old-app",
      flags: [true, false, null],
      measurements: [{ date: "Spring 2025", ounces: 71.5 }]
    },
    empty: ""
  };
  const before = structuredClone(original);
  const validated = validateRabbitRecord(original);

  assert.deepEqual(validated, original);
  assert.deepEqual(original, before, "input must not be mutated");
  assert.notEqual(validated, original);
  assert.notEqual(validated.imported, original.imported);
  assert.deepEqual(JSON.parse(JSON.stringify(validated)), original);
  assert.equal(validated._id, "legacy-001");
  assert.ok(Object.hasOwn(validated, "DoB"));
  assert.ok(Object.hasOwn(validated, "DOB"));
  assert.equal(validated.Sex, "dOE");
});

test("projections normalize separately and leave legacy source values intact", () => {
  const rabbit = { _id: 42, Name: "  Maple   Wood ", Sex: " DoE ", DoB: "04/15/2025" };
  assert.deepEqual(deriveRabbitProjections(rabbit), {
    name: "Maple Wood",
    sex: "doe",
    birthDate: "2025-04-15"
  });
  assert.deepEqual(rabbit, { _id: 42, Name: "  Maple   Wood ", Sex: " DoE ", DoB: "04/15/2025" });

  assert.deepEqual(deriveRabbitProjections({ Name: "", Sex: "", DOB: "legacy unknown" }), {
    name: "",
    sex: "",
    birthDate: null
  });
});

test("versioned envelopes preserve record and metadata exactly", () => {
  const record = { _id: "r-1", Name: "Maple", custom: { importedId: 7 } };
  const envelope = createRabbitEnvelope({
    id: record._id,
    revision: 3,
    createdAt: "2026-11-17T08:00:00.000Z",
    updatedAt: "2026-11-17T09:00:00.000Z",
    record
  });
  assert.equal(envelope.schemaVersion, RABBIT_SCHEMA_VERSION);
  assert.deepEqual(validateRabbitEnvelope(JSON.parse(JSON.stringify(envelope))), envelope);
  assert.notEqual(envelope.record, record);
});

test("numeric legacy IDs stay distinct from text IDs through envelope JSON round trips", () => {
  const metadata = {
    revision: 0,
    createdAt: "2026-11-17T08:00:00.000Z",
    updatedAt: "2026-11-17T08:00:00.000Z"
  };
  const numeric = createRabbitEnvelope({ ...metadata, id: 7, record: { _id: 7 } });
  const textual = createRabbitEnvelope({ ...metadata, id: "7", record: { _id: "7" } });
  const [numericRoundTrip, textualRoundTrip] = JSON.parse(JSON.stringify([numeric, textual]));

  assert.equal(typeof numericRoundTrip.id, "number");
  assert.equal(typeof numericRoundTrip.record._id, "number");
  assert.equal(typeof textualRoundTrip.id, "string");
  assert.equal(typeof textualRoundTrip.record._id, "string");
  assert.notStrictEqual(numericRoundTrip.id, textualRoundTrip.id);
});

test("known fields reject wrong types without coercion or field removal", () => {
  for (const [record, path] of [
    [{ Name: 7 }, "record.Name"],
    [{ Sex: false }, "record.Sex"],
    [{ DOB: null }, "record.DOB"],
    [{ _id: {} }, "record._id"]
  ]) {
    assert.throws(() => validateRabbitRecord(record), error =>
      error instanceof RabbitContractError && error.path === path && /known field/.test(error.message));
  }
});

test("unsafe keys are rejected at every nesting level with an explicit path", () => {
  const record = JSON.parse('{"Name":"Maple","imported":{"__proto__":{"polluted":true}}}');
  assert.throws(() => validateRabbitRecord(record), error =>
    error instanceof RabbitContractError &&
    error.path === "record.imported.__proto__" &&
    /unsafe key/.test(error.message));

  assert.throws(() => validateRabbitRecord({ nested: { constructor: "legacy" } }),
    /record\.nested\.constructor: unsafe key/);
});

test("unsupported values, cycles, excessive nesting, and oversized records fail explicitly", () => {
  assert.throws(() => validateRabbitRecord({ imported: undefined }), /record\.imported: unsupported undefined/);
  assert.throws(() => validateRabbitRecord({ score: Number.NaN }), /record\.score: must be a finite JSON number/);
  assert.throws(() => validateRabbitRecord({ when: new Date() }), /record\.when: must be a plain JSON object/);

  const accessor = {};
  Object.defineProperty(accessor, "surprise", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => validateRabbitRecord(accessor), /record\.surprise: accessor fields are not JSON-compatible/);
  assert.throws(() => validateRabbitRecord({ [Symbol("hidden")]: true }), /symbol keys are not JSON-compatible/);

  const extendedArray = [];
  extendedArray[4294967295] = "must not disappear";
  assert.throws(() => validateRabbitRecord({ imported: extendedArray }), /arrays cannot contain non-index properties/);

  const accessorArray = ["safe"];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => validateRabbitRecord({ imported: accessorArray }), /accessor array items are not JSON-compatible/);

  const circular = {};
  circular.self = circular;
  assert.throws(() => validateRabbitRecord(circular), /record\.self: circular references/);

  const deep = { level: { level: { value: true } } };
  assert.throws(() => validateRabbitRecord(deep, { maxDepth: 1 }), /maximum depth of 1/);
  assert.throws(() => validateRabbitRecord({ Notes: "x".repeat(DEFAULT_MAX_BYTES) }), /serialized size .* exceeds/);
});

test("envelope validation rejects incomplete, invalid, and silently extended envelopes", () => {
  const base = {
    schemaVersion: RABBIT_SCHEMA_VERSION,
    id: "r-1",
    revision: 0,
    createdAt: "legacy-created-value",
    updatedAt: "legacy-updated-value",
    record: { _id: "r-1" }
  };
  assert.throws(() => validateRabbitEnvelope({ ...base, schemaVersion: 99 }), /unsupported schema version/);
  assert.throws(() => validateRabbitEnvelope({ ...base, revision: -1 }), /non-negative integer/);
  assert.throws(() => validateRabbitEnvelope({ ...base, extra: true }), /unknown field\(s\): extra/);
});
