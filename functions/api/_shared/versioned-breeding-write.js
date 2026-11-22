import { verifyAccessJwt } from "./access-auth.js";
import { requireTestEnvironment } from "./test-environment.js";
import {
  createBreedingEnvelope,
  validateBreedingEnvelope,
  validateBreedingRecord
} from "../../../breeding-litter-contracts.js";
import { validateRabbitEnvelope } from "../../../rabbit-record-contract.js";
import { decodeRabbitId, encodeRabbitId } from "../../../rabbit-typed-id.js";

const WRITE_ROLES = new Set(["owner", "admin", "editor"]);
const ALLOWED_ROLES = new Set([...WRITE_ROLES, "viewer"]);
const MAX_REQUEST_BYTES = 300 * 1024;

const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const storageUnavailable = error => /no such table|does not exist/i.test(String(error?.message || error));
const uniquenessConflict = error =>
  /(?:unique|primary key) constraint/i.test(String(error?.message || error)) &&
  /breeding_record_versions/i.test(String(error?.message || error));

async function authenticate(request, env) {
  const result = await verifyAccessJwt(request, env);
  if (!result.ok) return { error: result.reason === "configuration"
    ? reply({ error: "Authentication service unavailable" }, 503)
    : reply({ error: "Authentication required" }, 401) };
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
    `SELECT m.role FROM rabbitry_memberships m
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
  if (/^\d+$/.test(declared || "") && Number(declared) > MAX_REQUEST_BYTES) return { tooLarge: true };
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
      try { await reader.cancel(); } catch { /* response is already determined */ }
      return { tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
}

function canonicalTypedId(value) {
  if (typeof value !== "string") return false;
  try { return encodeRabbitId(decodeRabbitId(value)) === value; } catch { return false; }
}

async function requestBody(request, mode) {
  let body;
  try {
    const raw = await boundedRequestText(request);
    if (raw.tooLarge) return { error: reply({ error: "Breeding request exceeds size limit" }, 413) };
    body = JSON.parse(raw.text);
  } catch {
    return { error: reply({ error: "Invalid breeding request" }, 400) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: reply({ error: "Invalid breeding request" }, 400) };
  }
  const allowed = mode === "create"
    ? new Set(["rabbitryId", "record"])
    : mode === "delete"
      ? new Set(["rabbitryId", "typedId", "baseRevision"])
      : new Set(["rabbitryId", "baseRevision", "record"]);
  if (Object.keys(body).some(key => !allowed.has(key)) ||
      typeof body.rabbitryId !== "string" || !body.rabbitryId.trim() || body.rabbitryId.length > 256 ||
      (mode !== "create" && (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 ||
       body.baseRevision >= Number.MAX_SAFE_INTEGER))) {
    return { error: reply({ error: "Invalid breeding request" }, 400) };
  }
  if (mode === "delete") {
    if (!canonicalTypedId(body.typedId)) return { error: reply({ error: "Invalid breeding request" }, 400) };
    return { rabbitryId: body.rabbitryId, typedId: body.typedId, baseRevision: body.baseRevision };
  }
  let record;
  try { record = validateBreedingRecord(body.record); }
  catch { return { error: reply({ error: "Invalid breeding record" }, 400) }; }
  if (Object.is(record._id, -0)) return { error: reply({ error: "Breeding ID is invalid" }, 400) };
  return { rabbitryId: body.rabbitryId, baseRevision: body.baseRevision, record };
}

function projections(record) {
  return {
    doeTypedId: record.doeTypedId,
    buckTypedId: record.buckTypedId,
    breedingDate: record.date,
    expectedKindlingDate: record.expectedKindlingDate || null,
    kindledDate: record.kindledDate || null,
    status: record.status,
    outcome: record.outcome ?? null
  };
}

function preparedVersion(record, revision, createdAt, updatedAt) {
  const typedId = encodeRabbitId(record._id);
  const envelope = validateBreedingEnvelope(createBreedingEnvelope({
    id: record._id, revision, createdAt, updatedAt, record
  }));
  if (encodeRabbitId(envelope.id) !== typedId || !Object.is(decodeRabbitId(typedId), envelope.id)) {
    throw new Error("invalid_prepared_breeding_identity");
  }
  return { typedId, envelope, projections: projections(envelope.record) };
}

function responseBreeding(version) {
  return { typedId: version.typedId, envelope: version.envelope, projections: version.projections };
}

async function latestParent(env, rabbitryId, typedId) {
  return env.DB.prepare(
    `SELECT typed_id, revision, schema_version, created_at, updated_at, deleted_at,
            sex_normalized, envelope
     FROM rabbit_record_versions
     WHERE rabbitry_id = ? AND typed_id = ?
     ORDER BY revision DESC LIMIT 1`
  ).bind(rabbitryId, typedId).first();
}

function validateStoredParent(row, typedId, sex) {
  if (!row || row.deleted_at !== null || row.sex_normalized !== sex) return false;
  try {
    const envelope = validateRabbitEnvelope(JSON.parse(row.envelope));
    return row.typed_id === typedId && encodeRabbitId(envelope.id) === typedId &&
      Object.is(decodeRabbitId(typedId), envelope.id) && envelope.revision === row.revision &&
      envelope.schemaVersion === row.schema_version && envelope.createdAt === row.created_at &&
      envelope.updatedAt === row.updated_at && envelope.record.Archived !== true;
  } catch { return false; }
}

async function validateParents(env, rabbitryId, version) {
  const [doe, buck] = await Promise.all([
    latestParent(env, rabbitryId, version.projections.doeTypedId),
    latestParent(env, rabbitryId, version.projections.buckTypedId)
  ]);
  return validateStoredParent(doe, version.projections.doeTypedId, "doe") &&
    validateStoredParent(buck, version.projections.buckTypedId, "buck");
}

const parentConditions = `
  AND EXISTS (
    SELECT 1 FROM rabbit_record_versions doe
    WHERE doe.rabbitry_id = ? AND doe.typed_id = ?
      AND doe.revision = (SELECT MAX(d.revision) FROM rabbit_record_versions d
                          WHERE d.rabbitry_id = doe.rabbitry_id AND d.typed_id = doe.typed_id)
      AND doe.deleted_at IS NULL AND doe.sex_normalized = 'doe'
      AND json_extract(doe.envelope, '$.record.Archived') IS NOT 1
  )
  AND EXISTS (
    SELECT 1 FROM rabbit_record_versions buck
    WHERE buck.rabbitry_id = ? AND buck.typed_id = ?
      AND buck.revision = (SELECT MAX(b.revision) FROM rabbit_record_versions b
                           WHERE b.rabbitry_id = buck.rabbitry_id AND b.typed_id = buck.typed_id)
      AND buck.deleted_at IS NULL AND buck.sex_normalized = 'buck'
      AND json_extract(buck.envelope, '$.record.Archived') IS NOT 1
  )`;

function insertBindings(rabbitryId, version, deletedAt = null) {
  const p = version.projections;
  return [
    rabbitryId, version.typedId, version.envelope.revision, version.envelope.schemaVersion,
    version.envelope.createdAt, version.envelope.updatedAt, deletedAt,
    p.doeTypedId, p.buckTypedId, p.breedingDate, p.expectedKindlingDate,
    p.kindledDate, p.status, p.outcome, JSON.stringify(version.envelope)
  ];
}

const insertColumns = `(rabbitry_id, typed_id, revision, schema_version, created_at, updated_at,
  deleted_at, doe_typed_id, buck_typed_id, breeding_date, expected_kindling_date,
  kindled_date, status, outcome, envelope)`;
const insertPlaceholders = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

async function insertCreate(env, rabbitryId, version) {
  return env.DB.prepare(
    `INSERT INTO breeding_record_versions ${insertColumns}
     SELECT ${insertPlaceholders}
     WHERE NOT EXISTS (SELECT 1 FROM breeding_record_versions
                       WHERE rabbitry_id = ? AND typed_id = ?)
     ${parentConditions}`
  ).bind(
    ...insertBindings(rabbitryId, version), rabbitryId, version.typedId,
    rabbitryId, version.projections.doeTypedId,
    rabbitryId, version.projections.buckTypedId
  ).run();
}

async function latestBreeding(env, rabbitryId, typedId) {
  return env.DB.prepare(
    `SELECT typed_id, revision, schema_version, created_at, updated_at, deleted_at,
            doe_typed_id, buck_typed_id, breeding_date, expected_kindling_date,
            kindled_date, status, outcome, envelope
     FROM breeding_record_versions WHERE rabbitry_id = ? AND typed_id = ?
     ORDER BY revision DESC LIMIT 1`
  ).bind(rabbitryId, typedId).first();
}

function validateStoredLatest(row) {
  try {
    const envelope = validateBreedingEnvelope(JSON.parse(row.envelope));
    const p = projections(envelope.record);
    if (encodeRabbitId(envelope.id) !== row.typed_id || !Object.is(decodeRabbitId(row.typed_id), envelope.id) ||
        envelope.revision !== row.revision || envelope.schemaVersion !== row.schema_version ||
        envelope.createdAt !== row.created_at || envelope.updatedAt !== row.updated_at ||
        p.doeTypedId !== row.doe_typed_id || p.buckTypedId !== row.buck_typed_id ||
        p.breedingDate !== row.breeding_date || p.expectedKindlingDate !== row.expected_kindling_date ||
        p.kindledDate !== row.kindled_date || p.status !== row.status || p.outcome !== row.outcome) {
      throw new Error("metadata mismatch");
    }
    return envelope;
  } catch {
    throw new Error("invalid_stored_breeding");
  }
}

async function insertRevision(env, rabbitryId, baseRevision, version, deletedAt, requireActiveParents) {
  return env.DB.prepare(
    `INSERT INTO breeding_record_versions ${insertColumns}
     SELECT ${insertPlaceholders}
     WHERE EXISTS (
       SELECT 1 FROM breeding_record_versions current
       WHERE current.rabbitry_id = ? AND current.typed_id = ?
         AND current.revision = ? AND current.deleted_at IS NULL
         AND current.revision = (SELECT MAX(latest.revision) FROM breeding_record_versions latest
                                 WHERE latest.rabbitry_id = current.rabbitry_id
                                   AND latest.typed_id = current.typed_id)
     )
     ${requireActiveParents ? parentConditions : ""}`
  ).bind(
    ...insertBindings(rabbitryId, version, deletedAt),
    rabbitryId, version.typedId, baseRevision,
    ...(requireActiveParents ? [
      rabbitryId, version.projections.doeTypedId,
      rabbitryId, version.projections.buckTypedId
    ] : [])
  ).run();
}

export async function handleVersionedBreedingWrite({ request, env }, mode) {
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
      if (!await validateParents(env, input.rabbitryId, version)) {
        return reply({ error: "Breeding parents are invalid" }, 400);
      }
      let inserted;
      try { inserted = await insertCreate(env, input.rabbitryId, version); }
      catch (error) {
        if (uniquenessConflict(error)) return reply({ error: "Breeding already exists" }, 409);
        throw error;
      }
      if (inserted.meta?.changes !== 1) {
        return reply({ error: "Breeding changed or parent relationship is no longer valid" }, 409);
      }
      return reply({ created: true, rabbitryId: input.rabbitryId, breeding: responseBreeding(version) }, 201);
    }

    const typedId = mode === "delete" ? input.typedId : encodeRabbitId(input.record._id);
    const latest = await latestBreeding(env, input.rabbitryId, typedId);
    if (!latest) return reply({ error: "Breeding changed since the base revision" }, 409);
    let previous;
    try { previous = validateStoredLatest(latest); }
    catch { return reply({ error: "Stored breeding record is invalid" }, 500); }
    if (previous.revision !== input.baseRevision || latest.deleted_at !== null) {
      return reply({ error: "Breeding changed since the base revision" }, 409);
    }
    const timestamp = new Date().toISOString();
    const version = preparedVersion(
      mode === "delete" ? previous.record : input.record,
      input.baseRevision + 1, previous.createdAt, timestamp
    );
    if (mode !== "delete" && !await validateParents(env, input.rabbitryId, version)) {
      return reply({ error: "Breeding parents are invalid" }, 400);
    }
    let inserted;
    try { inserted = await insertRevision(
      env, input.rabbitryId, input.baseRevision, version, mode === "delete" ? timestamp : null,
      mode !== "delete"
    ); }
    catch (error) {
      if (uniquenessConflict(error)) return reply({ error: "Breeding changed since the base revision" }, 409);
      throw error;
    }
    if (inserted.meta?.changes !== 1) {
      return reply({ error: "Breeding changed or parent relationship is no longer valid" }, 409);
    }
    return reply(mode === "delete" ? {
      deleted: true, rabbitryId: input.rabbitryId, deletedAt: timestamp,
      breeding: responseBreeding(version)
    } : {
      updated: true, rabbitryId: input.rabbitryId, breeding: responseBreeding(version)
    });
  } catch (error) {
    if (storageUnavailable(error)) return reply({ error: "Versioned breeding storage unavailable" }, 503);
    console.error(`Versioned breeding ${mode} failed`, error);
    return reply({ error: `Unable to ${mode} versioned breeding` }, 500);
  }
}
