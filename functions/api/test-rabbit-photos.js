import { decodeRabbitId, encodeRabbitId } from "../../rabbit-typed-id.js";
import {
  authenticate, authorize, insertUpdate, latestRow, PHOTO_GALLERY_FIELD, preparedVersion, validateStoredLatest
} from "./_shared/versioned-rabbit-write.js";
import { inspectJpeg, PhotoInputError, readPhotoBytes } from "./_shared/photo-jpeg.js";

const MAX_PHOTOS = 10;
const RESERVATION_MS = 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (data, status = 200) => Response.json(data, { status, headers });
const conflict = () => reply({ error: "Rabbit or photo operation changed; reload before saving" }, 409);
const closedUpload = () => reply({ error: "This upload has been closed", outcome: "abandoned" }, 409);

function parameters(request, write) {
  const query = new URL(request.url).searchParams;
  const allowed = write ? ["rabbitryId", "typedId", "photoId", "operationId", "action", "baseRevision"]
    : ["rabbitryId", "typedId", "photoId"];
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new PhotoInputError("Invalid photo request");
  }
  const rabbitryId = query.get("rabbitryId");
  const typedId = query.get("typedId");
  const photoId = query.get("photoId");
  const operationId = query.get("operationId");
  const action = query.get("action");
  const revision = query.get("baseRevision");
  if (!rabbitryId?.trim() || rabbitryId.length > 256 || !typedId || typedId.length > 2048 ||
      (photoId !== null && !uuid.test(photoId))) throw new PhotoInputError("Invalid photo identity");
  try {
    const id = decodeRabbitId(typedId);
    if (Object.is(id, -0) || encodeRabbitId(id) !== typedId) throw new Error();
  } catch { throw new PhotoInputError("Invalid typed rabbit ID"); }
  const upload = action === "add" || action === "replace";
  const baseRevision = revision !== null && /^\d+$/.test(revision) ? Number(revision) : null;
  if (write && (
    !["add", "replace", "remove", "primary", "reconcile", "cancel"].includes(action) ||
    ((upload || action === "reconcile" || action === "cancel") ? !uuid.test(operationId || "") : operationId !== null) ||
    (action === "reconcile" ? revision !== null
      : !Number.isSafeInteger(baseRevision) || baseRevision >= Number.MAX_SAFE_INTEGER) ||
    (["replace", "remove", "primary"].includes(action) !== (photoId !== null))
  )) throw new PhotoInputError("Invalid photo operation");
  return { rabbitryId, typedId, photoId, operationId, baseRevision, action, upload };
}

function galleryFor(record) {
  if (!Object.hasOwn(record, PHOTO_GALLERY_FIELD)) return { primaryId: null, photos: [] };
  const gallery = record[PHOTO_GALLERY_FIELD];
  if (!Array.isArray(gallery?.photos) || gallery.photos.length > MAX_PHOTOS ||
      gallery.photos.some(p => !p || !uuid.test(p.id) || !digest.test(p.sha256) ||
        p.contentType !== "image/jpeg" ||
        !Number.isSafeInteger(p.bytes) || p.bytes < 1 ||
        !Number.isSafeInteger(p.width) || p.width < 1 || !Number.isSafeInteger(p.height) || p.height < 1) ||
      new Set(gallery.photos.map(p => p.id)).size !== gallery.photos.length ||
      (gallery.photos.length ? !gallery.photos.some(p => p.id === gallery.primaryId) : gallery.primaryId !== null)) {
    throw new Error("Invalid stored photo gallery");
  }
  return gallery;
}

async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    value => value.toString(16).padStart(2, "0")).join("");
}

async function objectKey(input, id) {
  const scope = await sha256(new TextEncoder().encode(JSON.stringify([input.rabbitryId, input.typedId])));
  return `rabbit-photos/v1/${scope}/${id}.jpg`;
}

const findUpload = (env, input) => env.DB.prepare(
  `SELECT * FROM rabbit_photo_uploads WHERE rabbitry_id = ? AND rabbit_typed_id = ? AND photo_id = ?`
).bind(input.rabbitryId, input.typedId, input.operationId).first();

async function reserveUpload(env, input, subject, photo) {
  const { rabbitryId, typedId, operationId, baseRevision, photoId } = input;
  const expiresAt = new Date(Date.now() + RESERVATION_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO rabbit_photo_uploads
       (rabbitry_id, rabbit_typed_id, photo_id, subject, base_revision, replace_photo_id, sha256, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT count(*) FROM rabbit_photo_uploads WHERE rabbitry_id = ? AND rabbit_typed_id = ?
       AND state = 'reserved' AND julianday(expires_at) > julianday('now')) < ?
     ON CONFLICT(rabbitry_id, rabbit_typed_id, photo_id) DO NOTHING`
  ).bind(rabbitryId, typedId, operationId, subject, baseRevision, photoId, photo.sha256,
    expiresAt, rabbitryId, typedId, MAX_PHOTOS).run();
  return findUpload(env, input);
}

async function reconcile(env, input, subject, role) {
  const row = await findUpload(env, input);
  if (!row || (row.subject !== subject && !["owner", "admin"].includes(role))) {
    return reply({ error: "Photo operation not found" }, 404);
  }
  await env.DB.prepare(
    `UPDATE rabbit_photo_uploads SET state = 'abandoned'
     WHERE rabbitry_id = ? AND rabbit_typed_id = ? AND photo_id = ? AND state = 'reserved'
       AND julianday(expires_at) <= julianday('now')`
  ).bind(input.rabbitryId, input.typedId, input.operationId).run();
  const current = await findUpload(env, input);
  const object = await env.PHOTOS.head(await objectKey(input, input.operationId));
  return reply({ state: current.state, objectPresent: !!object, committedRevision: current.committed_revision });
}

async function cancelUpload(env, input, subject) {
  const { rabbitryId, typedId, operationId, baseRevision } = input;
  // The same unique key serializes reservation and cancellation. The photo
  // revision insert requires a reserved row in its own atomic SQL statement.
  // An absent operation gets a permanent abandoned receipt with no image hash.
  await env.DB.prepare(
    `INSERT INTO rabbit_photo_uploads
       (rabbitry_id, rabbit_typed_id, photo_id, subject, base_revision, sha256, state, expires_at)
     SELECT v.rabbitry_id, v.typed_id, ?, ?, v.revision, ?, 'abandoned', ?
     FROM rabbit_record_versions v
     WHERE v.rabbitry_id = ? AND v.typed_id = ? AND v.revision = ?
       AND EXISTS (
         SELECT 1 FROM rabbitry_memberships m JOIN rabbitries r ON r.id = m.rabbitry_id
         WHERE m.rabbitry_id = v.rabbitry_id AND m.access_subject = ?
           AND m.revoked_at IS NULL AND r.deleted_at IS NULL AND m.role IN ('owner','admin','editor')
       )
     ON CONFLICT(rabbitry_id, rabbit_typed_id, photo_id) DO UPDATE SET state = 'abandoned'
     WHERE rabbit_photo_uploads.state = 'reserved' AND rabbit_photo_uploads.subject = excluded.subject
       AND rabbit_photo_uploads.base_revision = excluded.base_revision`
  ).bind(operationId, subject, "0".repeat(64), new Date().toISOString(),
    rabbitryId, typedId, baseRevision, subject).run();
  const row = await findUpload(env, input);
  if (!row || row.subject !== subject || row.base_revision !== baseRevision) {
    return reply({ error: "Photo operation not found" }, 404);
  }
  if (row.state === "reserved") return conflict();
  return reply({ state: row.state, committedRevision: row.committed_revision });
}

async function saveGallery(env, input, subject, previous, gallery) {
  const version = preparedVersion({ ...previous.record, [PHOTO_GALLERY_FIELD]: gallery },
    input.baseRevision + 1, previous.createdAt, new Date().toISOString());
  const inserted = await insertUpdate(env, input.rabbitryId, input.baseRevision, version,
    { subject, uploadId: input.operationId });
  return inserted.meta?.changes > 0 ? reply({ revision: version.envelope.revision, gallery }) : conflict();
}

async function uploadPhoto(env, input, subject, previous, gallery, deleted) {
  const bytes = await readPhotoBytes(input.request);
  const photo = { id: input.operationId, ...inspectJpeg(bytes), contentType: "image/jpeg",
    bytes: bytes.length, sha256: await sha256(bytes) };
  const matches = row => row.subject === subject && row.sha256 === photo.sha256 &&
    row.base_revision === input.baseRevision && row.replace_photo_id === input.photoId;
  let row = await findUpload(env, input);
  const abandoned = row => row?.state === "abandoned" && row.subject === subject &&
    row.base_revision === input.baseRevision;
  if (abandoned(row)) return closedUpload();
  if (row && !matches(row)) return conflict();
  if (row?.state === "committed") return reply({ revision: row.committed_revision, replayed: true });
  if (deleted || previous.revision !== input.baseRevision) return conflict();
  const index = gallery.photos.findIndex(item => item.id === input.photoId);
  if (input.action === "replace" && index < 0) return reply({ error: "Photo not found" }, 404);
  if (input.action === "add" && gallery.photos.length >= MAX_PHOTOS) return reply({ error: "Gallery is full" }, 409);
  row ||= await reserveUpload(env, input, subject, photo);
  if (abandoned(row)) return closedUpload();
  if (!row || !matches(row)) return conflict();
  if (row.state === "committed") return reply({ revision: row.committed_revision, replayed: true });
  if (row.state !== "reserved" || Date.parse(row.expires_at) <= Date.now()) return conflict();

  const key = await objectKey(input, photo.id);
  const stored = await env.PHOTOS.put(key, bytes, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: photo.contentType },
    sha256: photo.sha256,
    customMetadata: { sha256: photo.sha256 }
  });
  const object = stored ?? await env.PHOTOS.head(key);
  if (object?.customMetadata?.sha256 !== photo.sha256 || object.size !== photo.bytes) {
    return reply({ error: "Photo object verification failed" }, 503);
  }
  const photos = [...gallery.photos];
  if (index < 0) photos.push(photo);
  else photos[index] = photo;
  const primaryId = !gallery.primaryId || gallery.primaryId === input.photoId ? photo.id : gallery.primaryId;
  const result = await saveGallery(env, input, subject, previous, { photos, primaryId });
  if (result.status === 409) {
    const receipt = await findUpload(env, input);
    if (receipt?.state === "committed") return reply({ revision: receipt.committed_revision, replayed: true });
    if (abandoned(receipt)) return closedUpload();
  }
  return result;
}

async function handle({ request, env }, write) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  if (write && request.headers.get("Origin") !== new URL(request.url).origin) {
    return reply({ error: "Invalid request origin" }, 403);
  }
  try {
    const input = { ...parameters(request, write), request };
    const access = await authorize(env, input.rabbitryId, auth.subject, write);
    if (access.error) return access.error;
    if (write && !await env.DB.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_rabbit_photo_upload_commit'"
    ).first()) return reply({ error: "Cloud photo ledger unavailable" }, 503);
    if (input.action === "cancel") return await cancelUpload(env, input, auth.subject);
    if (!env.PHOTOS) return reply({ error: "Cloud photo storage unavailable" }, 503);
    if (input.action === "reconcile") return await reconcile(env, input, auth.subject, access.role);
    const row = await latestRow(env, input.rabbitryId, input.typedId);
    if (!row || (!write && row.deleted_at !== null)) return reply({ error: "Rabbit not found" }, 404);
    const previous = validateStoredLatest(row);
    const gallery = galleryFor(previous.record);
    if (input.upload) return await uploadPhoto(env, input, auth.subject, previous, gallery, row.deleted_at !== null);
    const photo = gallery.photos.find(item => item.id === input.photoId);
    if (!write) {
      if (!input.photoId) return reply({ revision: previous.revision, gallery });
      if (!photo) return reply({ error: "Photo not found" }, 404);
      const object = await env.PHOTOS.get(await objectKey(input, photo.id));
      if (!object) return reply({ error: "Photo bytes unavailable" }, 503);
      if (object.size !== photo.bytes || object.customMetadata?.sha256 !== photo.sha256) {
        return reply({ error: "Photo object verification failed" }, 503);
      }
      return new Response(object.body, { headers: { ...headers, "Content-Type": "image/jpeg",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
        "Content-Disposition": "inline; filename=\"rabbit-photo.jpg\"" } });
    }
    if (row.deleted_at !== null || previous.revision !== input.baseRevision) return conflict();
    if (!photo) return reply({ error: "Photo not found" }, 404);
    if (input.action === "primary" && gallery.primaryId === photo.id) {
      return reply({ revision: previous.revision, gallery });
    }
    const photos = input.action === "remove" ? gallery.photos.filter(p => p.id !== photo.id) : gallery.photos;
    const primaryId = input.action === "primary" ? photo.id
      : gallery.primaryId === photo.id ? photos[0]?.id ?? null : gallery.primaryId;
    return await saveGallery(env, input, auth.subject, previous, { photos, primaryId });
  } catch (error) {
    if (error instanceof PhotoInputError) return reply({ error: error.message, outcome: "rejected" }, error.status);
    if (/UNIQUE constraint failed: rabbit_record_versions/i.test(String(error?.message))) return conflict();
    return reply({ error: "Cloud photo operation unavailable" }, 503);
  }
}

export const onRequestGet = context => handle(context, false);
export const onRequestPost = context => handle(context, true);
