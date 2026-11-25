import { verifyAccessJwt } from "./access-auth.js";
import { requireTestEnvironment } from "./test-environment.js";
import {
  createLitterEnvelope, validateBreedingEnvelope, validateLitterEnvelope, validateLitterRecord,
  validateTypedRelationshipId
} from "../../../breeding-litter-contracts.js";
import { validateRabbitEnvelope } from "../../../rabbit-record-contract.js";
import { decodeRabbitId, encodeRabbitId } from "../../../rabbit-typed-id.js";

const WRITE_ROLES = new Set(["owner", "admin", "editor"]);
const ALLOWED_ROLES = new Set([...WRITE_ROLES, "viewer"]);
const MAX_REQUEST_BYTES = 300 * 1024;
const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const storageUnavailable = error => /no such table|does not exist/i.test(String(error?.message || error));
const uniquenessConflict = error => /(?:unique|primary key) constraint/i.test(String(error?.message || error)) &&
  /litter_record_versions|breeding_litter_links/i.test(String(error?.message || error));
const wroteRows = result => Number.isSafeInteger(result?.meta?.changes) && result.meta.changes >= 1;

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
  const membership = await env.DB.prepare(`SELECT m.role FROM rabbitry_memberships m
    JOIN rabbitries r ON r.id = m.rabbitry_id
    WHERE m.rabbitry_id = ? AND m.access_subject = ?
      AND m.revoked_at IS NULL AND r.deleted_at IS NULL`).bind(rabbitryId, subject).first();
  if (!membership || !ALLOWED_ROLES.has(membership.role)) return { error: reply({ error: "Rabbitry not found" }, 404) };
  if (!WRITE_ROLES.has(membership.role)) return { error: reply({ error: "Rabbitry write access denied" }, 403) };
  return { role: membership.role };
}

async function requestBody(request, mode) {
  let body;
  try {
    const declared = request.headers.get("Content-Length");
    if (/^\d+$/.test(declared || "") && Number(declared) > MAX_REQUEST_BYTES) {
      return { error: reply({ error: "Litter request exceeds size limit" }, 413) };
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
      return { error: reply({ error: "Litter request exceeds size limit" }, 413) };
    }
    body = JSON.parse(text);
  } catch { return { error: reply({ error: "Invalid litter request" }, 400) }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: reply({ error: "Invalid litter request" }, 400) };
  }
  const allowed = mode === "create"
    ? new Set(["rabbitryId", "breedingTypedId", "record"])
    : mode === "delete" ? new Set(["rabbitryId", "typedId", "baseRevision"])
      : new Set(["rabbitryId", "baseRevision", "record"]);
  if (Object.keys(body).some(key => !allowed.has(key)) || typeof body.rabbitryId !== "string" ||
      !body.rabbitryId.trim() || body.rabbitryId.length > 256 ||
      (mode !== "create" && (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 ||
       body.baseRevision >= Number.MAX_SAFE_INTEGER))) {
    return { error: reply({ error: "Invalid litter request" }, 400) };
  }
  if (mode === "delete") {
    try { validateTypedRelationshipId(body.typedId, "typedId"); }
    catch { return { error: reply({ error: "Invalid litter request" }, 400) }; }
    return { rabbitryId: body.rabbitryId, typedId: body.typedId, baseRevision: body.baseRevision };
  }
  if (!body.record || typeof body.record !== "object" || Array.isArray(body.record) ||
      (typeof body.record._id !== "string" && typeof body.record._id !== "number") || Object.is(body.record._id, -0)) {
    return { error: reply({ error: "Invalid litter record" }, 400) };
  }
  if (mode === "create") {
    try { validateTypedRelationshipId(body.breedingTypedId, "breedingTypedId"); }
    catch { return { error: reply({ error: "Invalid litter request" }, 400) }; }
  } else {
    try { validateLitterRecord(body.record); }
    catch { return { error: reply({ error: "Invalid litter record" }, 400) }; }
  }
  return { rabbitryId: body.rabbitryId, breedingTypedId: body.breedingTypedId,
    baseRevision: body.baseRevision, record: structuredClone(body.record) };
}

function projections(record) {
  const raw = record["Total Kits"];
  return { breedingTypedId: record.breedingTypedId, damTypedId: record.damTypedId,
    sireTypedId: record.sireTypedId, breedingDate: record.Bred, birthDate: record.Born,
    damName: record.Dam, sireName: record.Sire, totalKits: raw === undefined ? null : Number(raw) };
}
function preparedVersion(record, revision, createdAt, updatedAt) {
  const typedId = encodeRabbitId(record._id);
  const envelope = validateLitterEnvelope(createLitterEnvelope({ id: record._id, revision, createdAt, updatedAt, record }));
  if (encodeRabbitId(envelope.id) !== typedId || !Object.is(decodeRabbitId(typedId), envelope.id)) {
    throw new Error("invalid_prepared_litter_identity");
  }
  return { typedId, envelope, projections: projections(envelope.record) };
}
const responseLitter = version => ({ typedId: version.typedId, envelope: version.envelope, projections: version.projections });

async function latestBreeding(env, rabbitryId, typedId) {
  return env.DB.prepare(`SELECT typed_id, revision, schema_version, created_at, updated_at, deleted_at,
    doe_typed_id, buck_typed_id, breeding_date, envelope FROM breeding_record_versions
    WHERE rabbitry_id = ? AND typed_id = ? ORDER BY revision DESC LIMIT 1`).bind(rabbitryId, typedId).first();
}
function storedBreeding(row, typedId) {
  if (!row || row.deleted_at !== null) return null;
  try {
    const envelope = validateBreedingEnvelope(JSON.parse(row.envelope));
    if (row.typed_id !== typedId || encodeRabbitId(envelope.id) !== typedId || envelope.revision !== row.revision ||
        envelope.schemaVersion !== row.schema_version || envelope.createdAt !== row.created_at ||
        envelope.updatedAt !== row.updated_at || envelope.record.doeTypedId !== row.doe_typed_id ||
        envelope.record.buckTypedId !== row.buck_typed_id || envelope.record.date !== row.breeding_date) return null;
    return envelope;
  } catch { return null; }
}
async function historicalParentName(env, rabbitryId, typedId) {
  const row = await env.DB.prepare(`SELECT typed_id, revision, schema_version, created_at, updated_at, envelope
    FROM rabbit_record_versions WHERE rabbitry_id = ? AND typed_id = ? ORDER BY revision DESC LIMIT 1`
  ).bind(rabbitryId, typedId).first();
  if (!row) return null;
  try {
    const envelope = validateRabbitEnvelope(JSON.parse(row.envelope));
    if (encodeRabbitId(envelope.id) !== typedId || envelope.revision !== row.revision ||
        envelope.schemaVersion !== row.schema_version || envelope.createdAt !== row.created_at ||
        envelope.updatedAt !== row.updated_at) return null;
    const name = envelope.record.Name ?? envelope.record.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch { return null; }
}

const columns = `(rabbitry_id, typed_id, revision, schema_version, created_at, updated_at, deleted_at,
  breeding_typed_id, dam_typed_id, sire_typed_id, breeding_date, birth_date, dam_name, sire_name,
  total_kits, envelope)`;
const placeholders = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
function bindings(rabbitryId, version, deletedAt = null) {
  const p = version.projections;
  return [rabbitryId, version.typedId, version.envelope.revision, version.envelope.schemaVersion,
    version.envelope.createdAt, version.envelope.updatedAt, deletedAt, p.breedingTypedId, p.damTypedId,
    p.sireTypedId, p.breedingDate, p.birthDate, p.damName, p.sireName, p.totalKits,
    JSON.stringify(version.envelope)];
}
async function insertCreate(env, rabbitryId, version) {
  return env.DB.prepare(`INSERT INTO litter_record_versions ${columns}
    SELECT ${placeholders}
    WHERE NOT EXISTS (SELECT 1 FROM litter_record_versions WHERE rabbitry_id = ? AND typed_id = ?)
      AND EXISTS (SELECT 1 FROM breeding_record_versions b WHERE b.rabbitry_id = ? AND b.typed_id = ?
        AND b.revision = (SELECT MAX(x.revision) FROM breeding_record_versions x
          WHERE x.rabbitry_id = b.rabbitry_id AND x.typed_id = b.typed_id)
        AND b.deleted_at IS NULL AND b.doe_typed_id = ? AND b.buck_typed_id = ? AND b.breeding_date = ?)`
  ).bind(...bindings(rabbitryId, version), rabbitryId, version.typedId, rabbitryId,
    version.projections.breedingTypedId, version.projections.damTypedId,
    version.projections.sireTypedId, version.projections.breedingDate).run();
}
async function latestLitter(env, rabbitryId, typedId) {
  return env.DB.prepare(`SELECT typed_id, revision, schema_version, created_at, updated_at, deleted_at,
    breeding_typed_id, dam_typed_id, sire_typed_id, breeding_date, birth_date, dam_name, sire_name,
    total_kits, envelope FROM litter_record_versions WHERE rabbitry_id = ? AND typed_id = ?
    ORDER BY revision DESC LIMIT 1`).bind(rabbitryId, typedId).first();
}
function storedLitter(row) {
  try {
    const envelope = validateLitterEnvelope(JSON.parse(row.envelope));
    const p = projections(envelope.record);
    if (encodeRabbitId(envelope.id) !== row.typed_id || envelope.revision !== row.revision ||
        envelope.schemaVersion !== row.schema_version || envelope.createdAt !== row.created_at ||
        envelope.updatedAt !== row.updated_at || p.breedingTypedId !== row.breeding_typed_id ||
        p.damTypedId !== row.dam_typed_id || p.sireTypedId !== row.sire_typed_id ||
        p.breedingDate !== row.breeding_date || p.birthDate !== row.birth_date ||
        p.damName !== row.dam_name || p.sireName !== row.sire_name || p.totalKits !== row.total_kits) throw new Error();
    return envelope;
  } catch { throw new Error("invalid_stored_litter"); }
}
async function hasLiveKits(env, rabbitryId, typedId) {
  const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kit_record_versions'").first();
  if (!table) return false;
  const row = await env.DB.prepare(`WITH latest AS (SELECT typed_id, MAX(revision) revision FROM kit_record_versions
    WHERE rabbitry_id = ? AND litter_typed_id = ? GROUP BY typed_id)
    SELECT 1 linked FROM kit_record_versions k JOIN latest l ON l.typed_id = k.typed_id AND l.revision = k.revision
    WHERE k.rabbitry_id = ? AND k.deleted_at IS NULL LIMIT 1`).bind(rabbitryId, typedId, rabbitryId).first();
  return Boolean(row);
}
async function insertRevision(env, rabbitryId, baseRevision, version, deletedAt) {
  return env.DB.prepare(`INSERT INTO litter_record_versions ${columns} SELECT ${placeholders}
    WHERE EXISTS (SELECT 1 FROM litter_record_versions current
      WHERE current.rabbitry_id = ? AND current.typed_id = ? AND current.revision = ?
        AND current.deleted_at IS NULL AND current.revision = (SELECT MAX(x.revision)
          FROM litter_record_versions x WHERE x.rabbitry_id = current.rabbitry_id AND x.typed_id = current.typed_id))`
  ).bind(...bindings(rabbitryId, version, deletedAt), rabbitryId, version.typedId, baseRevision).run();
}

export async function handleVersionedLitterWrite({ request, env }, mode) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply({ error: "Invalid request origin" }, 403);
  const input = await requestBody(request, mode);
  if (input.error) return input.error;
  try {
    const access = await authorize(env, input.rabbitryId, auth.subject);
    if (access.error) return access.error;
    if (mode === "create") {
      const breeding = storedBreeding(await latestBreeding(env, input.rabbitryId, input.breedingTypedId), input.breedingTypedId);
      if (!breeding) return reply({ error: "Breeding is not live in this rabbitry" }, 400);
      const [damName, sireName] = await Promise.all([
        historicalParentName(env, input.rabbitryId, breeding.record.doeTypedId),
        historicalParentName(env, input.rabbitryId, breeding.record.buckTypedId)
      ]);
      if (!damName || !sireName) return reply({ error: "Breeding parent history is invalid" }, 409);
      const record = { ...input.record, breedingTypedId: input.breedingTypedId,
        damTypedId: breeding.record.doeTypedId, sireTypedId: breeding.record.buckTypedId,
        Dam: damName, Sire: sireName, Bred: breeding.record.date };
      let version;
      try { const timestamp = new Date().toISOString(); version = preparedVersion(record, 0, timestamp, timestamp); }
      catch { return reply({ error: "Invalid litter record" }, 400); }
      let inserted;
      try { inserted = await insertCreate(env, input.rabbitryId, version); }
      catch (error) {
        if (uniquenessConflict(error)) return reply({ error: "Breeding already has a litter or litter already exists" }, 409);
        throw error;
      }
      // Remote D1 includes the AFTER INSERT link trigger in meta.changes, while local SQLite reports only
      // the outer litter insert. Either positive count means the atomic insert and trigger completed.
      if (!wroteRows(inserted)) return reply({ error: "Breeding changed before litter creation" }, 409);
      return reply({ created: true, rabbitryId: input.rabbitryId, litter: responseLitter(version) }, 201);
    }
    const typedId = mode === "delete" ? input.typedId : encodeRabbitId(input.record._id);
    const latest = await latestLitter(env, input.rabbitryId, typedId);
    if (!latest) return reply({ error: "Litter changed since the base revision" }, 409);
    let previous;
    try { previous = storedLitter(latest); }
    catch { return reply({ error: "Stored litter record is invalid" }, 500); }
    if (previous.revision !== input.baseRevision || latest.deleted_at !== null) {
      return reply({ error: "Litter changed since the base revision" }, 409);
    }
    if (mode === "delete" && await hasLiveKits(env, input.rabbitryId, typedId)) {
      return reply({ error: "Litter has live linked kits" }, 409);
    }
    let record = previous.record;
    if (mode === "update") {
      if (!Object.is(input.record._id, previous.record._id) ||
          ["breedingTypedId", "damTypedId", "sireTypedId", "Dam", "Sire", "Bred"].some(
            field => input.record[field] !== previous.record[field])) {
        return reply({ error: "Historical litter relationships cannot be changed" }, 400);
      }
      try { record = validateLitterRecord({ ...previous.record, ...input.record }); }
      catch { return reply({ error: "Invalid litter record" }, 400); }
    }
    const timestamp = new Date().toISOString();
    const version = preparedVersion(record, input.baseRevision + 1, previous.createdAt, timestamp);
    let inserted;
    try { inserted = await insertRevision(env, input.rabbitryId, input.baseRevision, version,
      mode === "delete" ? timestamp : null); }
    catch (error) {
      if (mode === "delete" && String(error?.message).includes("litter_has_live_kits")) {
        return reply({ error: "Litter has live linked kits" }, 409);
      }
      if (uniquenessConflict(error)) return reply({ error: "Litter changed since the base revision" }, 409);
      throw error;
    }
    if (inserted.meta?.changes !== 1) return reply({ error: "Litter changed since the base revision" }, 409);
    return reply(mode === "delete"
      ? { deleted: true, rabbitryId: input.rabbitryId, deletedAt: timestamp, litter: responseLitter(version) }
      : { updated: true, rabbitryId: input.rabbitryId, litter: responseLitter(version) });
  } catch (error) {
    if (storageUnavailable(error)) return reply({ error: "Versioned litter storage unavailable" }, 503);
    console.error(`Versioned litter ${mode} failed`, error);
    return reply({ error: `Unable to ${mode} versioned litter` }, 500);
  }
}
