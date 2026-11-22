"use strict";

import { decodeRabbitId, encodeRabbitId } from "./rabbit-typed-id.js";

export const BREEDING_LITTER_SCHEMA_VERSION = 1;

export const BREEDING_STATUSES = Object.freeze([
  "Bred",
  "Confirmed pregnant",
  "Kindled",
  "Unsuccessful",
  "Cancelled"
]);

// Outcome describes the observed result, independently of workflow status and notes.
export const BREEDING_OUTCOMES = Object.freeze([
  "Not recorded",
  "Live litter",
  "Mixed live and stillborn",
  "Stillborn litter",
  "No litter"
]);

const BREEDING_STATUS_SET = new Set(BREEDING_STATUSES);
const BREEDING_OUTCOME_SET = new Set(BREEDING_OUTCOMES);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class BreedingLitterContractError extends TypeError {
  constructor(message, path = "record") {
    super(`${path}: ${message}`);
    this.name = "BreedingLitterContractError";
    this.path = path;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathFor(path, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function cloneJson(value, path = "record", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BreedingLitterContractError("must be a finite JSON number", path);
    return value;
  }
  if (typeof value !== "object") {
    throw new BreedingLitterContractError(`unsupported ${typeof value} value`, path);
  }
  if (ancestors.has(value)) throw new BreedingLitterContractError("circular references are not supported", path);
  ancestors.add(value);
  let copy;
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const index = typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
        throw new BreedingLitterContractError("sparse or extended arrays are not supported", path);
      }
    }
    copy = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new BreedingLitterContractError("sparse, accessor, or hidden array items are not supported", `${path}[${index}]`);
      }
      copy[index] = cloneJson(descriptor.value, `${path}[${index}]`, ancestors);
    }
  } else {
    if (!isPlainObject(value)) throw new BreedingLitterContractError("must be a plain JSON object", path);
    copy = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new BreedingLitterContractError("symbol keys are not supported", path);
      const childPath = pathFor(path, key);
      if (UNSAFE_KEYS.has(key)) throw new BreedingLitterContractError("unsafe key is not allowed", childPath);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new BreedingLitterContractError("accessor or hidden fields are not supported", childPath);
      }
      copy[key] = cloneJson(descriptor.value, childPath, ancestors);
    }
  }
  ancestors.delete(value);
  return copy;
}

function requireObject(value, path) {
  if (!isPlainObject(value)) throw new BreedingLitterContractError("must be a plain object", path);
}

function requireString(value, path, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.trim() === "")) {
    throw new BreedingLitterContractError(empty ? "must be a string" : "must be a non-empty string", path);
  }
}

function requireEntityId(id, path) {
  if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
    throw new BreedingLitterContractError("must be a string or finite number", path);
  }
  return encodeRabbitId(id);
}

export function validateTypedRelationshipId(typedId, path = "typedId") {
  requireString(typedId, path);
  try {
    const id = decodeRabbitId(typedId);
    if (encodeRabbitId(id) !== typedId) throw new TypeError();
    return typedId;
  } catch {
    throw new BreedingLitterContractError("must be a canonical typed ID", path);
  }
}

function validateDate(value, path, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return;
  requireString(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new BreedingLitterContractError("must use YYYY-MM-DD", path);
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new BreedingLitterContractError("must be a valid calendar date", path);
  }
}

function validateCommonRecord(record) {
  requireObject(record, "record");
  requireEntityId(record._id, "record._id");
}

export function validateBreedingRecord(record) {
  validateCommonRecord(record);
  validateTypedRelationshipId(record.doeTypedId, "record.doeTypedId");
  validateTypedRelationshipId(record.buckTypedId, "record.buckTypedId");
  if (record.doeTypedId === record.buckTypedId) {
    throw new BreedingLitterContractError("doe and buck must be different rabbits", "record.buckTypedId");
  }
  validateDate(record.date, "record.date");
  validateDate(record.expectedKindlingDate, "record.expectedKindlingDate", { optional: true });
  validateDate(record.kindledDate, "record.kindledDate", { optional: true });
  if (!BREEDING_STATUS_SET.has(record.status)) {
    throw new BreedingLitterContractError("is not a supported breeding status", "record.status");
  }
  if (record.outcome !== undefined && !BREEDING_OUTCOME_SET.has(record.outcome)) {
    throw new BreedingLitterContractError("is not a supported breeding outcome", "record.outcome");
  }
  if (record.notes !== undefined) requireString(record.notes, "record.notes", { empty: true });
  return cloneJson(record);
}

export function validateLitterRecord(record) {
  validateCommonRecord(record);
  validateTypedRelationshipId(record.damTypedId, "record.damTypedId");
  validateTypedRelationshipId(record.sireTypedId, "record.sireTypedId");
  if (record.damTypedId === record.sireTypedId) {
    throw new BreedingLitterContractError("dam and sire must be different rabbits", "record.sireTypedId");
  }
  if (record.breedingTypedId !== undefined && record.breedingTypedId !== null) {
    validateTypedRelationshipId(record.breedingTypedId, "record.breedingTypedId");
  }
  validateDate(record.Bred, "record.Bred", { optional: true });
  validateDate(record.Born, "record.Born");
  if (record.status !== undefined) requireString(record.status, "record.status");
  if (record.Notes !== undefined) requireString(record.Notes, "record.Notes", { empty: true });
  return cloneJson(record);
}

function resolveParent(typedId, expectedSex, resolveRabbit, path) {
  if (typeof resolveRabbit !== "function") {
    throw new TypeError("resolveRabbit must be a function");
  }
  const resolved = resolveRabbit(typedId);
  if (!isPlainObject(resolved) || resolved.deleted === true) {
    throw new BreedingLitterContractError("must reference an existing live rabbit", path);
  }
  if (resolved.typedId !== undefined && resolved.typedId !== typedId) {
    throw new BreedingLitterContractError("resolved a different rabbit", path);
  }
  const sex = resolved.sex ?? resolved.Sex ?? resolved.record?.Sex ?? resolved.record?.sex;
  if (typeof sex !== "string" || sex.trim().toLowerCase() !== expectedSex) {
    throw new BreedingLitterContractError(`must reference a ${expectedSex}`, path);
  }
}

export function validateBreedingRelationships(record, resolveRabbit) {
  const safe = validateBreedingRecord(record);
  resolveParent(safe.doeTypedId, "doe", resolveRabbit, "record.doeTypedId");
  resolveParent(safe.buckTypedId, "buck", resolveRabbit, "record.buckTypedId");
  return safe;
}

export function validateLitterRelationships(record, resolveRabbit, resolveBreeding = null) {
  const safe = validateLitterRecord(record);
  resolveParent(safe.damTypedId, "doe", resolveRabbit, "record.damTypedId");
  resolveParent(safe.sireTypedId, "buck", resolveRabbit, "record.sireTypedId");
  if (safe.breedingTypedId !== undefined && safe.breedingTypedId !== null) {
    if (typeof resolveBreeding !== "function" || !isPlainObject(resolveBreeding(safe.breedingTypedId))) {
      throw new BreedingLitterContractError("must reference an existing breeding", "record.breedingTypedId");
    }
  }
  return safe;
}

function createEnvelope(entityType, validator, { id, revision, createdAt, updatedAt, record }) {
  const typedId = requireEntityId(id, "envelope.id");
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new BreedingLitterContractError("must be a non-negative safe integer", "envelope.revision");
  }
  requireString(createdAt, "envelope.createdAt");
  requireString(updatedAt, "envelope.updatedAt");
  const safeRecord = validator(record);
  if (requireEntityId(safeRecord._id, "record._id") !== typedId) {
    throw new BreedingLitterContractError("must match envelope.id", "record._id");
  }
  return {
    schemaVersion: BREEDING_LITTER_SCHEMA_VERSION,
    entityType,
    id,
    revision,
    createdAt,
    updatedAt,
    record: safeRecord
  };
}

function validateEnvelope(entityType, validator, envelope) {
  requireObject(envelope, "envelope");
  const expected = ["schemaVersion", "entityType", "id", "revision", "createdAt", "updatedAt", "record"];
  const unknown = Object.keys(envelope).filter(key => !expected.includes(key));
  if (unknown.length) throw new BreedingLitterContractError(`unknown field(s): ${unknown.join(", ")}`, "envelope");
  if (envelope.schemaVersion !== BREEDING_LITTER_SCHEMA_VERSION) {
    throw new BreedingLitterContractError("unsupported schema version", "envelope.schemaVersion");
  }
  if (envelope.entityType !== entityType) {
    throw new BreedingLitterContractError(`must be ${entityType}`, "envelope.entityType");
  }
  return createEnvelope(entityType, validator, envelope);
}

export const createBreedingEnvelope = input => createEnvelope("breeding", validateBreedingRecord, input);
export const createLitterEnvelope = input => createEnvelope("litter", validateLitterRecord, input);
export const validateBreedingEnvelope = envelope => validateEnvelope("breeding", validateBreedingRecord, envelope);
export const validateLitterEnvelope = envelope => validateEnvelope("litter", validateLitterRecord, envelope);

function selectLatestVersions(entries, validateEntityEnvelope) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const latest = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    requireObject(entry, `entries[${index}]`);
    const typedId = validateTypedRelationshipId(entry.typedId, `entries[${index}].typedId`);
    const envelope = validateEntityEnvelope(entry.envelope);
    if (encodeRabbitId(envelope.id) !== typedId) {
      throw new BreedingLitterContractError("does not match envelope.id", `entries[${index}].typedId`);
    }
    if (entry.deletedAt !== null && entry.deletedAt !== undefined) {
      requireString(entry.deletedAt, `entries[${index}].deletedAt`);
    }
    const previous = latest.get(typedId);
    if (previous && previous.envelope.revision === envelope.revision) {
      throw new BreedingLitterContractError("duplicate revision", `entries[${index}].envelope.revision`);
    }
    if (!previous || envelope.revision > previous.envelope.revision) {
      latest.set(typedId, { typedId, envelope, deletedAt: entry.deletedAt ?? null });
    }
  }
  return [...latest.values()].filter(entry => entry.deletedAt === null);
}

export const selectLatestBreedingVersions = entries => selectLatestVersions(entries, validateBreedingEnvelope);
export const selectLatestLitterVersions = entries => selectLatestVersions(entries, validateLitterEnvelope);
