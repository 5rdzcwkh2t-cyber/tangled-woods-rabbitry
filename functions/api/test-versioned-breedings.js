import { verifyAccessJwt } from "./_shared/access-auth.js";
import { requireTestEnvironment } from "./_shared/test-environment.js";
import { validateBreedingEnvelope } from "../../breeding-litter-contracts.js";
import { decodeRabbitId, encodeRabbitId } from "../../rabbit-typed-id.js";

const ACTIVE_ROLES = new Set(["owner", "admin", "editor", "viewer"]);
const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const storageUnavailable = error => /no such table|does not exist/i.test(String(error?.message || error));

async function authenticatedSubject(request, env) {
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

function parameters(request) {
  const url = new URL(request.url);
  const rabbitryId = url.searchParams.get("rabbitryId");
  if (typeof rabbitryId !== "string" || !rabbitryId.trim() || rabbitryId.length > 256) {
    return { error: reply({ error: "Invalid rabbitry ID" }, 400) };
  }
  const typedId = url.searchParams.get("typedId");
  if (typedId !== null) {
    try {
      if (encodeRabbitId(decodeRabbitId(typedId)) !== typedId) throw new TypeError();
    } catch { return { error: reply({ error: "Invalid typed breeding ID" }, 400) }; }
  }
  return { rabbitryId, typedId };
}

async function membership(env, rabbitryId, subject) {
  const row = await env.DB.prepare(
    `SELECT m.role FROM rabbitry_memberships m
     JOIN rabbitries r ON r.id = m.rabbitry_id
     WHERE m.rabbitry_id = ? AND m.access_subject = ?
       AND m.revoked_at IS NULL AND r.deleted_at IS NULL`
  ).bind(rabbitryId, subject).first();
  return row && ACTIVE_ROLES.has(row.role) ? row : null;
}

function latestQuery(single) {
  return `WITH latest AS (
      SELECT typed_id, MAX(revision) revision FROM breeding_record_versions
      WHERE rabbitry_id = ?${single ? " AND typed_id = ?" : ""}
      GROUP BY typed_id
    )
    SELECT v.typed_id, v.revision, v.schema_version, v.created_at, v.updated_at,
           v.doe_typed_id, v.buck_typed_id, v.breeding_date,
           v.expected_kindling_date, v.kindled_date, v.status, v.outcome, v.envelope
    FROM breeding_record_versions v
    JOIN latest l ON l.typed_id = v.typed_id AND l.revision = v.revision
    WHERE v.rabbitry_id = ? AND v.deleted_at IS NULL
    ORDER BY v.breeding_date DESC, v.typed_id, v.revision DESC`;
}

function validatedResult(row) {
  let envelope;
  try { envelope = validateBreedingEnvelope(JSON.parse(row.envelope)); }
  catch { throw new Error("invalid_versioned_breeding_record"); }
  const record = envelope.record;
  const expectedKindlingDate = record.expectedKindlingDate || null;
  const kindledDate = record.kindledDate || null;
  const outcome = record.outcome ?? null;
  if (encodeRabbitId(envelope.id) !== row.typed_id || !Object.is(decodeRabbitId(row.typed_id), envelope.id) ||
      envelope.revision !== row.revision || envelope.schemaVersion !== row.schema_version ||
      envelope.createdAt !== row.created_at || envelope.updatedAt !== row.updated_at ||
      record.doeTypedId !== row.doe_typed_id || record.buckTypedId !== row.buck_typed_id ||
      record.date !== row.breeding_date || expectedKindlingDate !== row.expected_kindling_date ||
      kindledDate !== row.kindled_date || record.status !== row.status || outcome !== row.outcome) {
    throw new Error("invalid_versioned_breeding_record");
  }
  return {
    typedId: row.typed_id,
    envelope,
    projections: {
      doeTypedId: row.doe_typed_id,
      buckTypedId: row.buck_typed_id,
      breedingDate: row.breeding_date,
      expectedKindlingDate: row.expected_kindling_date,
      kindledDate: row.kindled_date,
      status: row.status,
      outcome: row.outcome
    }
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await authenticatedSubject(request, env);
  if (auth.error) return auth.error;
  const input = parameters(request);
  if (input.error) return input.error;
  try {
    const invalidEnvironment = await requireTestEnvironment(env);
    if (invalidEnvironment) return invalidEnvironment;
    if (!await membership(env, input.rabbitryId, auth.subject)) {
      return reply({ error: "Rabbitry not found" }, 404);
    }
    const statement = env.DB.prepare(latestQuery(input.typedId !== null));
    const bound = input.typedId === null
      ? statement.bind(input.rabbitryId, input.rabbitryId)
      : statement.bind(input.rabbitryId, input.typedId, input.rabbitryId);
    const { results } = await bound.all();
    let breedings;
    try { breedings = results.map(validatedResult); }
    catch { return reply({ error: "Stored breeding record is invalid" }, 500); }
    if (input.typedId !== null) {
      if (breedings.length === 0) return reply({ error: "Breeding not found" }, 404);
      return reply({ rabbitryId: input.rabbitryId, breeding: breedings[0] });
    }
    return reply({ rabbitryId: input.rabbitryId, breedings });
  } catch (error) {
    if (storageUnavailable(error)) return reply({ error: "Versioned breeding storage unavailable" }, 503);
    console.error("Versioned breeding read failed", error);
    return reply({ error: "Unable to load versioned breeding records" }, 500);
  }
}
