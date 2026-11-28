import { verifyAccessJwt } from "./access-auth.js";
import { requireTestEnvironment } from "./test-environment.js";
import {
  createRabbitEnvelope,
  deriveRabbitProjections,
  validateRabbitEnvelope,
  validateRabbitRecord
} from "../../../rabbit-record-contract.js";
import { decodeRabbitId, encodeRabbitId } from "../../../rabbit-typed-id.js";
import { validateTypedRelationshipId } from "../../../breeding-litter-contracts.js";
import { inheritKitRecord, kitLinkFields, kitSnapshotFields } from "./kit-relationship.js";

const WRITE_ROLES = new Set(["owner", "admin", "editor"]);
const ALLOWED_ROLES = new Set([...WRITE_ROLES, "viewer"]);
const MAX_REQUEST_BYTES = 300 * 1024;
const parentRoles = { Father: "buck", Mother: "doe" };
export const PHOTO_GALLERY_FIELD = "cloudPhotoGalleryV1";

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

export async function authenticate(request, env) {
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

export async function authorize(env, rabbitryId, subject, write = true) {
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
  if (write && !WRITE_ROLES.has(membership.role)) {
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
  const creating = mode === "create" || mode === "create-kit";
  const allowed = mode === "create-kit"
    ? new Set(["rabbitryId", "litterTypedId", "record"])
    : mode === "create"
    ? new Set(["rabbitryId", "record", "parentChanges"])
    : mode === "delete"
      ? new Set(["rabbitryId", "typedId", "baseRevision"])
      : new Set(["rabbitryId", "baseRevision", "record", "parentChanges"]);
  if (Object.keys(body).some(key => !allowed.has(key)) ||
      typeof body.rabbitryId !== "string" || !body.rabbitryId.trim() || body.rabbitryId.length > 256 ||
      (!creating && (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 ||
       body.baseRevision >= Number.MAX_SAFE_INTEGER))) {
    return { error: reply({ error: "Invalid rabbit request" }, 400) };
  }

  if (mode === "delete") {
    if (typeof body.typedId !== "string") {
      return { error: reply({ error: "Invalid rabbit request" }, 400) };
    }
    try {
      if (encodeRabbitId(decodeRabbitId(body.typedId)) !== body.typedId) {
        throw new TypeError("Non-canonical typed ID");
      }
    } catch {
      return { error: reply({ error: "Invalid rabbit request" }, 400) };
    }
    return { rabbitryId: body.rabbitryId, baseRevision: body.baseRevision, typedId: body.typedId };
  }

  let record;
  try {
    record = validateRabbitRecord(body.record);
    if (creating && Object.hasOwn(record, PHOTO_GALLERY_FIELD)) throw new TypeError();
    if (mode === "create-kit") validateTypedRelationshipId(body.litterTypedId, "litterTypedId");
    if (creating && kitLinkFields.some(field => Object.hasOwn(record, field))) throw new TypeError();
    if (Object.hasOwn(body, "parentChanges")) {
      const changes = body.parentChanges;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new TypeError();
      for (const [role, change] of Object.entries(changes)) {
        if (!Object.hasOwn(parentRoles, role)) throw new TypeError();
        if (change !== null && typeof change === "object") {
          if (Array.isArray(change) || Object.keys(change).length !== 1 ||
              typeof change.name !== "string" || !change.name.trim()) throw new TypeError();
        } else if (change !== null) validateTypedRelationshipId(change, role);
      }
    }
  } catch {
    return { error: reply({ error: "Invalid rabbit record" }, 400) };
  }
  if (!Object.hasOwn(record, "_id") ||
      (typeof record._id !== "string" && typeof record._id !== "number") ||
      Object.is(record._id, -0)) {
    return { error: reply({ error: "Rabbit ID is invalid" }, 400) };
  }
  return { rabbitryId: body.rabbitryId, baseRevision: body.baseRevision,
    litterTypedId: body.litterTypedId, parentChanges: body.parentChanges, record };
}

async function applyParentChanges(env, input, previous = {}) {
  const { record, rabbitryId, parentChanges } = input;
  if (!parentChanges || !Object.keys(parentChanges).length) return null;
  if (Object.hasOwn(previous, "litterTypedId")) {
    return reply({ error: "Kit relationships cannot be changed" }, 400);
  }
  const guard = await env.DB.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_rabbit_pedigree_guard'"
  ).first();
  if (!guard) return reply({ error: "Versioned pedigree storage unavailable" }, 503);

  for (const [role, change] of Object.entries(parentChanges)) {
    const field = `${role}TypedId`;
    if (change === null) {
      delete record[field];
      delete record[role];
    } else if (typeof change === "object") {
      delete record[field];
      record[role] = change.name.trim();
    } else if (change !== previous[field]) {
      const id = change;
      if (id === encodeRabbitId(record._id)) return reply({ error: "Rabbit cannot be its own parent" }, 400);
      const row = await latestRow(env, rabbitryId, id);
      const parent = row && row.deleted_at === null ? validateStoredLatest(row).record : null;
      const projection = parent && deriveRabbitProjections(parent);
      if (!parent || parent.Archived === true || projection.sex !== parentRoles[role] || !projection.name) {
        return reply({ error: `Invalid ${role.toLowerCase()} selection` }, 400);
      }
      record[field] = id;
      record[role] = projection.name;
    }
  }
  if (record.FatherTypedId != null && record.FatherTypedId === record.MotherTypedId) {
    return reply({ error: "Parents must be different rabbits" }, 400);
  }
  return null;
}

function pedigreeWriteError(error) {
  const message = String(error?.message || error);
  if (message.includes("rabbit_pedigree_cycle")) return reply({ error: "Parent assignment would create an ancestry cycle" }, 409);
  if (message.includes("rabbit_pedigree_changed")) return reply({ error: "Parent selection changed before saving" }, 409);
  return null;
}

export function preparedVersion(record, revision, createdAt, updatedAt) {
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

export function validateStoredLatest(row) {
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

export async function latestRow(env, rabbitryId, typedId) {
  return env.DB.prepare(
    `SELECT typed_id, revision, schema_version, created_at, updated_at, deleted_at, envelope
     FROM rabbit_record_versions
     WHERE rabbitry_id = ? AND typed_id = ?
     ORDER BY revision DESC LIMIT 1`
  ).bind(rabbitryId, typedId).first();
}

export async function insertUpdate(env, rabbitryId, baseRevision, version, photoWrite) {
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
     )
     ${photoWrite ? `AND EXISTS (
       SELECT 1 FROM rabbitry_memberships m JOIN rabbitries r ON r.id = m.rabbitry_id
       WHERE m.rabbitry_id = ? AND m.access_subject = ? AND m.revoked_at IS NULL
         AND r.deleted_at IS NULL AND m.role IN ('owner','admin','editor')
     )` : ""}
     ${photoWrite?.uploadId ? `AND EXISTS (
       SELECT 1 FROM rabbit_photo_uploads u WHERE u.rabbitry_id = ? AND u.rabbit_typed_id = ?
         AND u.photo_id = ? AND u.base_revision = ? AND u.state = 'reserved'
         AND julianday(u.expires_at) > julianday('now')
     )` : ""}`
  ).bind(
    rabbitryId, typedId, envelope.revision, envelope.schemaVersion,
    envelope.createdAt, envelope.updatedAt,
    projections.name, projections.sex, projections.birthDate, JSON.stringify(envelope),
    rabbitryId, typedId, baseRevision,
    ...(photoWrite ? [rabbitryId, photoWrite.subject] : []),
    ...(photoWrite?.uploadId ? [rabbitryId, typedId, photoWrite.uploadId, baseRevision] : [])
  ).run();
}

async function insertTombstone(env, rabbitryId, baseRevision, version, deletedAt) {
  const { envelope, projections, typedId } = version;
  return env.DB.prepare(
    `INSERT INTO rabbit_record_versions
      (rabbitry_id, typed_id, revision, schema_version, created_at, updated_at,
       deleted_at, name_normalized, sex_normalized, birth_date_normalized, envelope)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
    envelope.createdAt, envelope.updatedAt, deletedAt,
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

    if (mode === "create" || mode === "create-kit") {
      let record = input.record;
      if (mode === "create-kit") {
        const guards = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_kit_create_requires_live_litter', 'trg_litter_delete_requires_no_live_kits')"
        ).first();
        if (guards?.count !== 2) return reply({ error: "Versioned kit storage unavailable" }, 503);
        record = await inheritKitRecord(env, input.rabbitryId, input.litterTypedId, record);
        if (!record) return reply({ error: "Live litter not found" }, 404);
      } else {
        const error = await applyParentChanges(env, input);
        if (error) return error;
      }
      const timestamp = new Date().toISOString();
      let version;
      try { version = preparedVersion(record, 0, timestamp, timestamp); }
      catch { return reply({ error: "Invalid rabbit record" }, 400); }
      let inserted;
      try {
        inserted = await insertCreate(env, input.rabbitryId, version);
      } catch (error) {
        const pedigreeError = pedigreeWriteError(error);
        if (pedigreeError) return pedigreeError;
        if (uniquenessConflict(error)) return reply({ error: "Rabbit already exists" }, 409);
        if (mode === "create-kit" && String(error?.message).includes("kit_relationship_changed")) {
          return reply({ error: "Litter or kit parents are no longer valid" }, 409);
        }
        throw error;
      }
      if (!Number.isSafeInteger(inserted.meta?.changes) || inserted.meta.changes < 1) {
        return reply({ error: "Rabbit already exists" }, 409);
      }
      return reply({
        created: true,
        rabbitryId: input.rabbitryId,
        rabbit: responseRabbit(version)
      }, 201);
    }

    const typedId = mode === "delete" ? input.typedId : encodeRabbitId(input.record._id);
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

    const timestamp = new Date().toISOString();
    if (mode === "update") {
      if (Object.hasOwn(previous.record, PHOTO_GALLERY_FIELD)) {
        input.record[PHOTO_GALLERY_FIELD] = previous.record[PHOTO_GALLERY_FIELD];
      } else {
        delete input.record[PHOTO_GALLERY_FIELD];
      }
      const immutable = Object.hasOwn(previous.record, "litterTypedId") ? kitSnapshotFields : kitLinkFields;
      if (immutable.some(field => !Object.is(input.record[field], previous.record[field]))) {
        return reply({ error: "Kit relationships cannot be changed" }, 400);
      }
      for (const role of Object.keys(parentRoles)) {
        if (previous.record[`${role}TypedId`] == null && Object.hasOwn(input.record, role)) continue;
        if (Object.hasOwn(previous.record, role)) input.record[role] = previous.record[role];
        else delete input.record[role];
      }
      const error = await applyParentChanges(env, input, previous.record);
      if (error) return error;
    }
    const version = preparedVersion(
      mode === "delete" ? previous.record : input.record,
      input.baseRevision + 1,
      previous.createdAt,
      timestamp
    );
    let inserted;
    try {
      inserted = mode === "delete"
        ? await insertTombstone(env, input.rabbitryId, input.baseRevision, version, timestamp)
        : await insertUpdate(env, input.rabbitryId, input.baseRevision, version);
    } catch (error) {
      const pedigreeError = pedigreeWriteError(error);
      if (pedigreeError) return pedigreeError;
      if (uniquenessConflict(error)) {
        return reply({ error: "Rabbit changed since the base revision" }, 409);
      }
      throw error;
    }
    if (inserted.meta?.changes !== 1) {
      return reply({ error: "Rabbit changed since the base revision" }, 409);
    }
    return reply(mode === "delete" ? {
      deleted: true,
      rabbitryId: input.rabbitryId,
      deletedAt: timestamp,
      rabbit: responseRabbit(version)
    } : {
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
