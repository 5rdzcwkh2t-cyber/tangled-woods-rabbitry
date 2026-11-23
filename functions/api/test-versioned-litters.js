import { verifyAccessJwt } from "./_shared/access-auth.js";
import { requireTestEnvironment } from "./_shared/test-environment.js";
import { validateLitterEnvelope } from "../../breeding-litter-contracts.js";
import { decodeRabbitId, encodeRabbitId } from "../../rabbit-typed-id.js";

const ACTIVE_ROLES = new Set(["owner", "admin", "editor", "viewer"]);
const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
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
    try { if (encodeRabbitId(decodeRabbitId(typedId)) !== typedId) throw new TypeError(); }
    catch { return { error: reply({ error: "Invalid typed litter ID" }, 400) }; }
  }
  return { rabbitryId, typedId };
}
async function membership(env, rabbitryId, subject) {
  const row = await env.DB.prepare(`SELECT m.role FROM rabbitry_memberships m JOIN rabbitries r ON r.id = m.rabbitry_id
    WHERE m.rabbitry_id = ? AND m.access_subject = ? AND m.revoked_at IS NULL AND r.deleted_at IS NULL`
  ).bind(rabbitryId, subject).first();
  return row && ACTIVE_ROLES.has(row.role) ? row : null;
}
function query(single) {
  return `WITH latest AS (SELECT typed_id, MAX(revision) revision FROM litter_record_versions
      WHERE rabbitry_id = ?${single ? " AND typed_id = ?" : ""} GROUP BY typed_id)
    SELECT v.typed_id, v.revision, v.schema_version, v.created_at, v.updated_at,
      v.breeding_typed_id, v.dam_typed_id, v.sire_typed_id, v.breeding_date, v.birth_date,
      v.dam_name, v.sire_name, v.total_kits, v.envelope
    FROM litter_record_versions v JOIN latest l ON l.typed_id = v.typed_id AND l.revision = v.revision
    WHERE v.rabbitry_id = ? AND v.deleted_at IS NULL
    ORDER BY v.birth_date DESC, v.typed_id, v.revision DESC`;
}
function validated(row) {
  let envelope;
  try { envelope = validateLitterEnvelope(JSON.parse(row.envelope)); } catch { throw new Error(); }
  const record = envelope.record;
  const totalKits = record["Total Kits"] === undefined ? null : Number(record["Total Kits"]);
  if (encodeRabbitId(envelope.id) !== row.typed_id || !Object.is(decodeRabbitId(row.typed_id), envelope.id) ||
      envelope.revision !== row.revision || envelope.schemaVersion !== row.schema_version ||
      envelope.createdAt !== row.created_at || envelope.updatedAt !== row.updated_at ||
      record.breedingTypedId !== row.breeding_typed_id || record.damTypedId !== row.dam_typed_id ||
      record.sireTypedId !== row.sire_typed_id || record.Bred !== row.breeding_date ||
      record.Born !== row.birth_date || record.Dam !== row.dam_name || record.Sire !== row.sire_name ||
      totalKits !== row.total_kits) throw new Error();
  return { typedId: row.typed_id, envelope, projections: { breedingTypedId: row.breeding_typed_id,
    damTypedId: row.dam_typed_id, sireTypedId: row.sire_typed_id, breedingDate: row.breeding_date,
    birthDate: row.birth_date, damName: row.dam_name, sireName: row.sire_name, totalKits: row.total_kits } };
}

export async function onRequestGet({ request, env }) {
  const auth = await authenticatedSubject(request, env);
  if (auth.error) return auth.error;
  const input = parameters(request);
  if (input.error) return input.error;
  try {
    const invalidEnvironment = await requireTestEnvironment(env);
    if (invalidEnvironment) return invalidEnvironment;
    if (!await membership(env, input.rabbitryId, auth.subject)) return reply({ error: "Rabbitry not found" }, 404);
    const statement = env.DB.prepare(query(input.typedId !== null));
    const bound = input.typedId === null ? statement.bind(input.rabbitryId, input.rabbitryId)
      : statement.bind(input.rabbitryId, input.typedId, input.rabbitryId);
    const { results } = await bound.all();
    let litters;
    try { litters = results.map(validated); }
    catch { return reply({ error: "Stored litter record is invalid" }, 500); }
    if (input.typedId !== null) {
      if (!litters.length) return reply({ error: "Litter not found" }, 404);
      return reply({ rabbitryId: input.rabbitryId, litter: litters[0] });
    }
    return reply({ rabbitryId: input.rabbitryId, litters });
  } catch (error) {
    if (storageUnavailable(error)) return reply({ error: "Versioned litter storage unavailable" }, 503);
    console.error("Versioned litter read failed", error);
    return reply({ error: "Unable to load versioned litter records" }, 500);
  }
}
