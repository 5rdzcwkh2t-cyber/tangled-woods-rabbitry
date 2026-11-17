import { verifyAccessJwt } from "./access-auth.js";
import { requireTestEnvironment } from "./test-environment.js";
import {
  createRabbitEnvelope,
  deriveRabbitProjections,
  validateRabbitEnvelope,
  validateRabbitRecord
} from "../../../rabbit-record-contract.js";
import { decodeRabbitId, encodeRabbitId } from "../../../rabbit-typed-id.js";

const WRITE_ROLES = new Set(["owner", "admin", "editor"]);
const ALLOWED_ROLES = new Set([...WRITE_ROLES, "viewer"]);
const MAX_REQUEST_BYTES = 300 * 1024;

const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function storageUnavailable(error) {
  return /no such table|does not exist/i.test(String(error?.message || error));
}

function uniquenessConflict(error) {
  const message = String(error?.message || error);
  return /(?:unique|primary key) constraint/i.test(message) &&
    /rabbit_record_versions/i.test(message);
}

async function authenticate(request, env) {
  const result = await verifyAccessJwt(request, env);
  if (!result.ok) {
    return { error: result.reason === "configuration"
      ? reply({ error: "Authentication service unavailable" }, 503)
      : reply({ error: "Authentication required" }, 401) };
  }
  const subject = result.payload?.sub;
  if (typeof subject !== "string" || !subject.trim() || subject.length > 512) {
    return { error: reply({ error: "Authentication required" }, 401) };
  }
  return { subject };
}

async function authorize(env, rabbitryId, subject) {
  const invalidEnvironment = await requireTestEnvironment(env);
  if (invalidEnvironment) return { error: invalidEnvironment };
  const membership = await env.DB.prepare(
    `SELECT m.role
     FROM rabbitry_memberships m
     JOIN rabbitries r ON r.id = m.rabbitry_id
     WHERE m.rabbitry_id = ? AND m.access_subject = ?
       AND m.revoked_at IS NULL AND r.deleted_at IS NULL`
  ).bind(rabbitryId, subject).first();
  if (!membership || !ALLOWED_ROLES.has(membership.role)) {
    return { error: reply({ error: "Rabbitry not found" }, 404) };
  }
  if (!WRITE_ROLES.has(membership.role)) {
    return { error: reply({ error: "Rabbitry write access denied" }, 403) };
  }
  return { role: membership.role };
}

async function boundedRequestText(request) {
  const declared = request.headers.get("Content-Length");
  if (/^\d+$/.test(declared || "") && Number(declared) > MAX_REQUEST_BYTES) {
    return { tooLarge: true };
  }
  if (!request.body) return { text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      try { await reader.cancel(); } catch { /* The response is already determined. */ }
      return { tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text };
}

async function requestBody(request, mode) {
  let body;
  try {
    const raw = await boundedRequestText(request);
    if (raw.tooLarge) {
      return { error: reply({ error: "Rabbit request exceeds size limit" }, 413) };
    }
    body = JSON.parse(raw.text);
  } catch {
    return { error: reply({ error: "Invalid rabbit request" }, 400) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: reply({ error: "Invalid rabbit request" }, 400) };
  }
  const allowed = mode === "create"
    ? new Set(["rabbitryId", "record"])
    : new Set(["rabbitryId", "baseRevision", "record"]);
  if (Object.keys(body).some(key => !allowed.has(key)) ||
      typeof body.rabbitryId !== "string" || !body.rabbitryId.trim() || body.rabbitryId.length > 256 ||
      (mode === "update" && (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 ||
       body.baseRevision >= Number.MAX_SAFE_INTEGER))) {
    return { error: reply({ error: "Invalid rabbit request" }, 400) };
  }

  let record;
  try {
    record = validateRabbitRecord(body.record);
  } catch {
    return { error: reply({ error: "Invalid rabbit record" }, 400) };
  }
  if (!Object.hasOwn(record, "_id") ||
      (typeof record._id !== "string" && typeof record._id !== "number") ||
      Object.is(record._id, -0)) {
    return { error: reply({ error: "Rabbit ID is invalid" }, 400) };
  }
  return { rabbitryId: body.rabbitryId, baseRevision: body.baseRevision, record };
}

function preparedVersion(record, revision, createdAt, updatedAt) {
  const typedId = encodeRabbitId(record._id);
  const envelope = validateRabbitEnvelope(createRabbitEnvelope({
    id: record._id,
    revision,
    createdAt,
    updatedAt,
    record
  }));
  if (encodeRabbitId(envelope.id) !== typedId || !Object.is(decodeRabbitId(typedId), envelope.id)) {
    throw new Error("invalid_prepared_rabbit_identity");
  }
  return { typedId, envelope, projections: deriveRabbitProjections(envelope.record) };
}

function responseRabbit(version) {
  return {
    typedId: version.typedId,
    envelope: version.envelope,
    projections: version.projections
  };
}

async function insertCreate(env, rabbitryId, version) {
  const { envelope, projections, typedId } = version;
  return env.DB.prepare(
    `INSERT INTO rabbit_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at,
       name_normalized, sex_normalized, birth_date_normalized, envelope)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM rabbit_record_versions
       WHERE rabbitry_id = ? AND typed_id = ?
     )`
  ).bind(
    rabbitryId, typedId, envelope.revision, envelope.schemaVersion,
    envelope.createdAt, envelope.updatedAt,
    projections.name, projections.sex, projections.birthDate, JSON.stringify(envelope),
    rabbitryId, typedId
  ).run();
}

function validateStoredLatest(row) {
  let envelope;
  let decoded;
  try {
    envelope = validateRabbitEnvelope(JSON.parse(row.envelope));
    decoded = decodeRabbitId(row.typed_id);
  } catch {
    throw new Error("invalid_stored_rabbit");
  }
  if (encodeRabbitId(envelope.id) !== row.typed_id || !Object.is(decoded, envelope.id) ||
      envelope.revision !== row.revision || envelope.schemaVersion !== row.schema_version ||
      envelope.createdAt !== row.created_at || envelope.updatedAt !== row.updated_at) {
    throw new Error("invalid_stored_rabbit");
  }
  return envelope;
}

async function latestRow(env, rabbitryId, typedId) {
  return env.DB.prepare(
    `SELECT typed_id, revision, schema_version, created_at, updated_at, deleted_at, envelope
     FROM rabbit_record_versions
     WHERE rabbitry_id = ? AND typed_id = ?
     ORDER BY revision DESC LIMIT 1`
  ).bind(rabbitryId, typedId).first();
}

async function insertUpdate(env, rabbitryId, baseRevision, version) {
  const { envelope, projections, typedId } = version;
  return env.DB.prepare(
    `INSERT INTO rabbit_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at,
       name_normalized, sex_normalized, birth_date_normalized, envelope)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM rabbit_record_versions current
       WHERE current.rabbitry_id = ? AND current.typed_id = ?
         AND current.revision = ? AND current.deleted_at IS NULL
         AND current.revision = (
           SELECT MAX(latest.revision) FROM rabbit_record_versions latest
           WHERE latest.rabbitry_id = current.rabbitry_id
             AND latest.typed_id = current.typed_id
         )
     )`
  ).bind(
    rabbitryId, typedId, envelope.revision, envelope.schemaVersion,
    envelope.createdAt, envelope.updatedAt,
    projections.name, projections.sex, projections.birthDate, JSON.stringify(envelope),
    rabbitryId, typedId, baseRevision
  ).run();
}

export async function handleVersionedRabbitWrite({ request, env }, mode) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    return reply({ error: "Invalid request origin" }, 403);
  }
  const input = await requestBody(request, mode);
  if (input.error) return input.error;

  try {
    const access = await authorize(env, input.rabbitryId, auth.subject);
    if (access.error) return access.error;

    if (mode === "create") {
      const timestamp = new Date().toISOString();
      const version = preparedVersion(input.record, 0, timestamp, timestamp);
      let inserted;
      try {
        inserted = await insertCreate(env, input.rabbitryId, version);
      } catch (error) {
        if (uniquenessConflict(error)) return reply({ error: "Rabbit already exists" }, 409);
        throw error;
      }
      if (inserted.meta?.changes !== 1) return reply({ error: "Rabbit already exists" }, 409);
      return reply({
        created: true,
        rabbitryId: input.rabbitryId,
        rabbit: responseRabbit(version)
      }, 201);
    }

    const typedId = encodeRabbitId(input.record._id);
    const latest = await latestRow(env, input.rabbitryId, typedId);
    if (!latest) return reply({ error: "Rabbit changed since the base revision" }, 409);
    let previous;
    try {
      previous = validateStoredLatest(latest);
    } catch {
      return reply({ error: "Stored rabbit record is invalid" }, 500);
    }
    if (previous.revision !== input.baseRevision || latest.deleted_at !== null) {
      return reply({ error: "Rabbit changed since the base revision" }, 409);
    }

    const version = preparedVersion(
      input.record,
      input.baseRevision + 1,
      previous.createdAt,
      new Date().toISOString()
    );
    let inserted;
    try {
      inserted = await insertUpdate(env, input.rabbitryId, input.baseRevision, version);
    } catch (error) {
      if (uniquenessConflict(error)) {
        return reply({ error: "Rabbit changed since the base revision" }, 409);
      }
      throw error;
    }
    if (inserted.meta?.changes !== 1) {
      return reply({ error: "Rabbit changed since the base revision" }, 409);
    }
    return reply({
      updated: true,
      rabbitryId: input.rabbitryId,
      rabbit: responseRabbit(version)
    });
  } catch (error) {
    if (storageUnavailable(error)) {
      return reply({ error: "Versioned rabbit storage unavailable" }, 503);
    }
    console.error(`Versioned rabbit ${mode} failed`, error);
    return reply({ error: `Unable to ${mode} versioned rabbit` }, 500);
  }
}
