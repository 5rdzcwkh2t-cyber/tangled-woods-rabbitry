import assert from "node:assert/strict";
import test from "node:test";

import {
  BREEDING_OUTCOMES,
  BREEDING_STATUSES,
  BreedingLitterContractError,
  createBreedingEnvelope,
  createLitterEnvelope,
  selectLatestBreedingVersions,
  selectLatestLitterVersions,
  validateBreedingRecord,
  validateBreedingRelationships,
  validateLitterRecord,
  validateLitterRelationships,
  validateTypedRelationshipId
} from "../breeding-litter-contracts.js";
import { encodeRabbitId } from "../rabbit-typed-id.js";

const DOE = encodeRabbitId("doe-1");
const BUCK = encodeRabbitId("buck-1");
const BREEDING = encodeRabbitId("breeding-1");
const metadata = {
  revision: 0,
  createdAt: "2026-11-21T12:00:00.000Z",
  updatedAt: "2026-11-21T12:00:00.000Z"
};

function breeding(overrides = {}) {
  return {
    _id: "breeding-1",
    doeTypedId: DOE,
    buckTypedId: BUCK,
    date: "2026-11-21",
    expectedKindlingDate: "2026-12-22",
    kindledDate: "",
    status: "Bred",
    outcome: "Not recorded",
    notes: "",
    ...overrides
  };
}

function litter(overrides = {}) {
  return {
    _id: "litter-1",
    breedingTypedId: BREEDING,
    damTypedId: DOE,
    sireTypedId: BUCK,
    Bred: "2026-11-21",
    Born: "2026-12-22",
    status: "Born",
    Notes: "",
    ...overrides
  };
}

test("the contract preserves the five local breeding statuses and minimal outcomes", () => {
  assert.deepEqual(BREEDING_STATUSES, ["Bred", "Confirmed pregnant", "Kindled", "Unsuccessful", "Cancelled"]);
  assert.deepEqual(BREEDING_OUTCOMES, [
    "Not recorded", "Live litter", "Mixed live and stillborn", "Stillborn litter", "No litter"
  ]);
  for (const status of BREEDING_STATUSES) assert.equal(validateBreedingRecord(breeding({ status })).status, status);
  for (const outcome of BREEDING_OUTCOMES) assert.equal(validateBreedingRecord(breeding({ outcome })).outcome, outcome);
});

test("breeding and litter records preserve unknown nested fields without mutating inputs", () => {
  const breedingRecord = breeding({ imported: { source: "legacy", flags: [true, null], count: 2 } });
  const litterRecord = litter({ custom: { label: "keep", nested: { value: 7 } } });
  const breedingBefore = structuredClone(breedingRecord);
  const litterBefore = structuredClone(litterRecord);
  const safeBreeding = validateBreedingRecord(breedingRecord);
  const safeLitter = validateLitterRecord(litterRecord);
  assert.deepEqual(safeBreeding, breedingBefore);
  assert.deepEqual(safeLitter, litterBefore);
  assert.deepEqual(breedingRecord, breedingBefore);
  assert.deepEqual(litterRecord, litterBefore);
  assert.notEqual(safeBreeding.imported, breedingRecord.imported);
  assert.notEqual(safeLitter.custom, litterRecord.custom);
});

test("canonical typed IDs keep numeric and string relationship identities distinct", () => {
  const numeric = encodeRabbitId(7);
  const textual = encodeRabbitId("7");
  assert.notEqual(numeric, textual);
  assert.equal(validateTypedRelationshipId(numeric), numeric);
  assert.equal(validateTypedRelationshipId(textual), textual);
  assert.throws(() => validateTypedRelationshipId("s:7"), /canonical typed ID/);
  const safe = validateBreedingRecord(breeding({ doeTypedId: numeric, buckTypedId: textual }));
  assert.equal(safe.doeTypedId, numeric);
  assert.equal(safe.buckTypedId, textual);
});

test("records reject malformed IDs, dates, status, outcome, and same-parent relationships", () => {
  for (const [record, pattern] of [
    [breeding({ doeTypedId: "rabbit-1" }), /canonical typed ID/],
    [breeding({ buckTypedId: DOE }), /different rabbits/],
    [breeding({ date: "2026-02-30" }), /valid calendar date/],
    [breeding({ status: "Unknown" }), /supported breeding status/],
    [breeding({ outcome: "Maybe" }), /supported breeding outcome/]
  ]) assert.throws(() => validateBreedingRecord(record), pattern);

  assert.throws(() => validateLitterRecord(litter({ sireTypedId: DOE })), /different rabbits/);
  assert.throws(() => validateLitterRecord(litter({ Born: "12\/22\/2026" })), /YYYY-MM-DD/);
  assert.throws(() => validateBreedingRecord(breeding({ extra: undefined })), /unsupported undefined/);
  const circular = breeding();
  circular.extra = circular;
  assert.throws(() => validateBreedingRecord(circular), /circular references/);
  const accessorArray = ["safe"];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => validateBreedingRecord(breeding({ extra: accessorArray })), /accessor/);
});

test("relationship validation requires live parents with the correct sex", () => {
  const rabbits = new Map([
    [DOE, { typedId: DOE, sex: "Doe" }],
    [BUCK, { typedId: BUCK, record: { Sex: "buck" } }]
  ]);
  const resolveRabbit = typedId => rabbits.get(typedId) ?? null;
  assert.deepEqual(validateBreedingRelationships(breeding(), resolveRabbit), breeding());
  assert.deepEqual(validateLitterRelationships(litter(), resolveRabbit, id => id === BREEDING ? {} : null), litter());

  rabbits.set(DOE, { typedId: DOE, sex: "buck" });
  assert.throws(() => validateBreedingRelationships(breeding(), resolveRabbit), /must reference a doe/);
  rabbits.set(DOE, { typedId: DOE, sex: "doe", deleted: true });
  assert.throws(() => validateLitterRelationships(litter(), resolveRabbit, () => ({})), /existing live rabbit/);
  rabbits.set(DOE, { typedId: DOE, sex: "doe" });
  assert.throws(() => validateLitterRelationships(litter(), resolveRabbit, () => null), /existing breeding/);
});

test("envelopes preserve IDs and reject record identity mismatches", () => {
  const breedingEnvelope = createBreedingEnvelope({ ...metadata, id: "breeding-1", record: breeding() });
  const litterEnvelope = createLitterEnvelope({ ...metadata, id: "litter-1", record: litter() });
  assert.equal(breedingEnvelope.entityType, "breeding");
  assert.equal(litterEnvelope.entityType, "litter");
  assert.throws(() => createBreedingEnvelope({ ...metadata, id: "other", record: breeding() }), /match envelope.id/);
  assert.throws(() => createLitterEnvelope({ ...metadata, id: 1, record: litter({ _id: "1" }) }), /match envelope.id/);
});

test("latest-version helpers select the newest active revision and hide tombstones", () => {
  const breeding0 = createBreedingEnvelope({ ...metadata, id: "breeding-1", record: breeding() });
  const breeding1 = createBreedingEnvelope({
    ...metadata, id: "breeding-1", revision: 1,
    updatedAt: "2026-11-21T13:00:00.000Z", record: breeding({ status: "Confirmed pregnant" })
  });
  assert.deepEqual(selectLatestBreedingVersions([
    { typedId: BREEDING, envelope: breeding1, deletedAt: null },
    { typedId: BREEDING, envelope: breeding0, deletedAt: null }
  ]), [{ typedId: BREEDING, envelope: breeding1, deletedAt: null }]);

  const litterEnvelope = createLitterEnvelope({ ...metadata, id: "litter-1", record: litter() });
  const litterTypedId = encodeRabbitId("litter-1");
  assert.deepEqual(selectLatestLitterVersions([
    { typedId: litterTypedId, envelope: litterEnvelope, deletedAt: "2026-11-21T14:00:00.000Z" }
  ]), []);
  assert.throws(() => selectLatestBreedingVersions([
    { typedId: BREEDING, envelope: breeding0 }, { typedId: BREEDING, envelope: breeding0 }
  ]), /duplicate revision/);
  assert.throws(() => selectLatestLitterVersions([
    { typedId: encodeRabbitId("wrong"), envelope: litterEnvelope }
  ]), /does not match envelope.id/);
});
