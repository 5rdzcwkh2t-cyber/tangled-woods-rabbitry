import { verifyAccessJwt } from "./_shared/access-auth.js";
import { requireTestEnvironment } from "./_shared/test-environment.js";
import { validateRabbitEnvelope } from "../../rabbit-record-contract.js";
import { decodeRabbitId, encodeRabbitId } from "../../rabbit-typed-id.js";

const ACTIVE_ROLES = new Set(["owner", "admin", "editor", "viewer"]);

const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function storageUnavailable(error) {
  return /no such table|does not exist/i.test(String(error?.message || error));
}

async function authenticatedSubject(request, env) {
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

function requestParameters(request) {
  const url = new URL(request.url);
  const rabbitryId = url.searchParams.get("rabbitryId");
  if (typeof rabbitryId !== "string" || !rabbitryId.trim() || rabbitryId.length > 256) {
    return { error: reply({ error: "Invalid rabbitry ID" }, 400) };
  }
  const typedId = url.searchParams.get("typedId");
  if (typedId !== null) {
    try {
      const decoded = decodeRabbitId(typedId);
      if (encodeRabbitId(decoded) !== typedId) throw new TypeError("Non-canonical typed ID");
    } catch {
      return { error: reply({ error: "Invalid typed rabbit ID" }, 400) };
    }
  }
  return { rabbitryId, typedId };
}

async function activeMembership(env, rabbitryId, subject) {
  const membership = await env.DB.prepare(
    `SELECT m.role
     FROM rabbitry_memberships m
     JOIN rabbitries r ON r.id = m.rabbitry_id
     WHERE m.rabbitry_id = ? AND m.access_subject = ?
       AND m.revoked_at IS NULL AND r.deleted_at IS NULL`
  ).bind(rabbitryId, subject).first();
  return membership && ACTIVE_ROLES.has(membership.role) ? membership : null;
}

function latestQuery(singleRecord) {
  return `WITH latest AS (
      SELECT typed_id, MAX(revision) AS revision
      FROM rabbit_record_versions
      WHERE rabbitry_id = ?${singleRecord ? " AND typed_id = ?" : ""}
      GROUP BY typed_id
    )
    SELECT v.typed_id, v.revision, v.schema_version, v.created_at, v.updated_at,
           v.name_normalized, v.sex_normalized, v.birth_date_normalized, v.envelope
    FROM rabbit_record_versions v
    JOIN latest l ON l.typed_id = v.typed_id AND l.revision = v.revision
    WHERE v.rabbitry_id = ? AND v.deleted_at IS NULL
    ORDER BY v.name_normalized IS NULL, v.name_normalized COLLATE NOCASE,
             v.typed_id, v.revision DESC`;
}

function validatedResult(row) {
  let envelope;
  let decodedId;
  try {
    envelope = validateRabbitEnvelope(JSON.parse(row.envelope));
    decodedId = decodeRabbitId(row.typed_id);
  } catch {
    throw new Error("invalid_versioned_rabbit_record");
  }
  if (encodeRabbitId(envelope.id) !== row.typed_id || !Object.is(decodedId, envelope.id) ||
      envelope.revision !== row.revision || envelope.schemaVersion !== row.schema_version ||
      envelope.createdAt !== row.created_at || envelope.updatedAt !== row.updated_at) {
    throw new Error("invalid_versioned_rabbit_record");
  }
  return {
    typedId: row.typed_id,
    envelope,
    projections: {
      name: row.name_normalized,
      sex: row.sex_normalized,
      birthDate: row.birth_date_normalized
    }
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await authenticatedSubject(request, env);
  if (auth.error) return auth.error;
  const parameters = requestParameters(request);
  if (parameters.error) return parameters.error;

  try {
    const invalidEnvironment = await requireTestEnvironment(env);
    if (invalidEnvironment) return invalidEnvironment;

    const membership = await activeMembership(env, parameters.rabbitryId, auth.subject);
    if (!membership) return reply({ error: "Rabbitry not found" }, 404);

    const statement = env.DB.prepare(latestQuery(parameters.typedId !== null));
    const bound = parameters.typedId === null
      ? statement.bind(parameters.rabbitryId, parameters.rabbitryId)
      : statement.bind(parameters.rabbitryId, parameters.typedId, parameters.rabbitryId);
    const { results } = await bound.all();
    let rabbits;
    try {
      rabbits = results.map(validatedResult);
    } catch {
      return reply({ error: "Stored rabbit record is invalid" }, 500);
    }

    if (parameters.typedId !== null) {
      if (rabbits.length === 0) return reply({ error: "Rabbit not found" }, 404);
      return reply({ rabbitryId: parameters.rabbitryId, rabbit: rabbits[0] });
    }
    return reply({ rabbitryId: parameters.rabbitryId, rabbits });
  } catch (error) {
    if (storageUnavailable(error)) {
      return reply({ error: "Versioned rabbit storage unavailable" }, 503);
    }
    console.error("Versioned rabbit read failed", error);
    return reply({ error: "Unable to load versioned rabbit records" }, 500);
  }
}
