"use strict";

export const RABBIT_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_DEPTH = 32;
export const DEFAULT_MAX_BYTES = 256 * 1024;

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STRING_FIELDS = new Set([
  "Name", "name", "Sex", "sex", "DoB", "DOB", "dob",
  "Prefix", "Tattoo", "Breed", "Color", "Father", "Mother",
  "FatherID", "MotherID", "Status", "Notes"
]);

export class RabbitContractError extends TypeError {
  constructor(message, path = "record") {
    super(`${path}: ${message}`);
    this.name = "RabbitContractError";
    this.path = path;
  }
}

function isRecordObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function propertyPath(path, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
             value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function copyJsonValue(value, path, depth, maxDepth, ancestors) {
  if (depth > maxDepth) {
    throw new RabbitContractError(`nesting exceeds the maximum depth of ${maxDepth}`, path);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RabbitContractError("must be a finite JSON number", path);
    return value;
  }
  if (typeof value !== "object") {
    throw new RabbitContractError(`unsupported ${typeof value} value`, path);
  }
  if (ancestors.has(value)) throw new RabbitContractError("circular references are not supported", path);

  ancestors.add(value);
  let copy;
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const index = typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
      if (Number.isSafeInteger(index) && index >= 0 && index < value.length && String(index) === key) continue;
      throw new RabbitContractError("arrays cannot contain non-index properties", path);
    }
    copy = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) {
        throw new RabbitContractError("sparse arrays are not JSON-compatible", `${path}[${index}]`);
      }
      if (!descriptor.enumerable) {
        throw new RabbitContractError("non-enumerable array items are not JSON-compatible", `${path}[${index}]`);
      }
      if (!Object.hasOwn(descriptor, "value")) {
        throw new RabbitContractError("accessor array items are not JSON-compatible", `${path}[${index}]`);
      }
      copy[index] = copyJsonValue(descriptor.value, `${path}[${index}]`, depth + 1, maxDepth, ancestors);
    }
  } else {
    if (!isRecordObject(value)) throw new RabbitContractError("must be a plain JSON object", path);
    copy = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new RabbitContractError("symbol keys are not JSON-compatible", path);
      const childPath = propertyPath(path, key);
      if (UNSAFE_KEYS.has(key)) throw new RabbitContractError(`unsafe key ${JSON.stringify(key)} is not allowed`, childPath);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable) throw new RabbitContractError("non-enumerable fields are not JSON-compatible", childPath);
      if (!Object.hasOwn(descriptor, "value")) throw new RabbitContractError("accessor fields are not JSON-compatible", childPath);
      copy[key] = copyJsonValue(descriptor.value, childPath, depth + 1, maxDepth, ancestors);
    }
  }
  ancestors.delete(value);
  return copy;
}

function validateKnownFields(record) {
  for (const key of STRING_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value !== "string") {
      throw new RabbitContractError("known field must be a string", propertyPath("record", key));
    }
  }
  const idDescriptor = Object.getOwnPropertyDescriptor(record, "_id");
  if (idDescriptor && Object.hasOwn(idDescriptor, "value") &&
      typeof idDescriptor.value !== "string" &&
      !(typeof idDescriptor.value === "number" && Number.isFinite(idDescriptor.value))) {
    throw new RabbitContractError("known field must be a string or finite number", "record._id");
  }
}

export function validateRabbitRecord(record, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError("maxDepth must be a non-negative integer");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");
  if (!isRecordObject(record)) throw new RabbitContractError("must be a plain object");

  validateKnownFields(record);
  const copy = copyJsonValue(record, "record", 0, maxDepth, new Set());
  const bytes = utf8ByteLength(JSON.stringify(copy));
  if (bytes > maxBytes) {
    throw new RabbitContractError(`serialized size ${bytes} bytes exceeds the ${maxBytes}-byte limit`);
  }
  return copy;
}

function firstOwnString(record, fields) {
  for (const field of fields) {
    if (Object.hasOwn(record, field) && typeof record[field] === "string") return record[field];
  }
  return null;
}

function normalizedDate(value) {
  if (value === null || value.trim() === "") return null;
  const input = value.trim();
  let year;
  let month;
  let day;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (match) [, year, month, day] = match;
  else {
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input);
    if (!match) return null;
    [, month, day, year] = match;
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function deriveRabbitProjections(record) {
  const safe = validateRabbitRecord(record);
  const name = firstOwnString(safe, ["Name", "name"]);
  const sex = firstOwnString(safe, ["Sex", "sex"]);
  const birthDate = firstOwnString(safe, ["DoB", "DOB", "dob"]);
  return Object.freeze({
    name: name === null ? null : name.trim().replace(/\s+/g, " "),
    sex: sex === null ? null : sex.trim().toLowerCase(),
    birthDate: normalizedDate(birthDate)
  });
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RabbitContractError("must be a non-empty string", path);
  }
}

export function createRabbitEnvelope({ id, revision, createdAt, updatedAt, record }, options = {}) {
  if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
    throw new RabbitContractError("must be a string or finite number", "envelope.id");
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RabbitContractError("must be a non-negative integer", "envelope.revision");
  }
  requiredString(createdAt, "envelope.createdAt");
  requiredString(updatedAt, "envelope.updatedAt");
  return {
    schemaVersion: RABBIT_SCHEMA_VERSION,
    id,
    revision,
    createdAt,
    updatedAt,
    record: validateRabbitRecord(record, options)
  };
}

export function validateRabbitEnvelope(envelope, options = {}) {
  if (!isRecordObject(envelope)) throw new RabbitContractError("must be a plain object", "envelope");
  const expected = ["schemaVersion", "id", "revision", "createdAt", "updatedAt", "record"];
  const unknown = Object.keys(envelope).filter(key => !expected.includes(key));
  if (unknown.length) throw new RabbitContractError(`unknown field(s): ${unknown.join(", ")}`, "envelope");
  if (envelope.schemaVersion !== RABBIT_SCHEMA_VERSION) {
    throw new RabbitContractError(`unsupported schema version ${JSON.stringify(envelope.schemaVersion)}`, "envelope.schemaVersion");
  }
  return createRabbitEnvelope(envelope, options);
}
