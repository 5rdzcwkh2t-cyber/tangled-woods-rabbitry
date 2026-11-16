import { verifyAccessJwt } from "./_shared/access-auth.js";

const BACKUP_FORMAT_VERSION = 1;
const MAX_BACKUP_BYTES = 1_800_000;
const MAX_RECORDS_PER_COLLECTION = 10_000;
const RETAIN_PER_OWNER = 20;

const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function ownerFromRequest(request, env) {
  const result = await verifyAccessJwt(request, env);
  if (!result.ok) {
    return { error: result.reason === "configuration"
      ? reply({ error: "Authentication service unavailable" }, 503)
      : reply({ error: "Authentication required" }, 401) };
  }
  const ownerId = result.payload?.sub;
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 512) {
    return { error: reply({ error: "Authentication required" }, 401) };
  }
  return { ownerId };
}

async function verifyTestDatabase(env) {
  if (env.TEST_DATABASE !== "tangled-woods-dev-v2") return false;
  const marker = await env.DB.prepare(
    "SELECT marker FROM test_environment WHERE marker = ?"
  ).bind("tangled-woods-dev-v2").first();
  return Boolean(marker);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordCollection(value) {
  return Array.isArray(value) && value.length <= MAX_RECORDS_PER_COLLECTION &&
    value.every(plainObject);
}

function photoData(value) {
  if (typeof value !== "string") return false;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  return Boolean(match) && match[2].length % 4 === 0;
}

function validPhotos(photos) {
  if (!plainObject(photos) || Object.keys(photos).length > 10_000) return false;
  return Object.entries(photos).every(([key, value]) => {
    if (!key || key.length > 256) return false;
    if (!key.startsWith("gallery:")) return photoData(value);
    if (typeof value !== "string") return false;
    try {
      const gallery = JSON.parse(value);
      return Array.isArray(gallery) && gallery.length <= 9 && gallery.every(photoData);
    } catch {
      return false;
    }
  });
}

function validBackup(backup) {
  if (!plainObject(backup)) return false;
  if (!recordCollection(backup.rabbits) || !recordCollection(backup.litters)) return false;
  if (backup.breedings !== undefined && !recordCollection(backup.breedings)) return false;
  if (backup.expenses !== undefined && !recordCollection(backup.expenses)) return false;
  if (backup.parentLinks !== undefined && !plainObject(backup.parentLinks)) return false;
  if (backup.photos !== undefined && !validPhotos(backup.photos)) return false;
  if (backup.photoBackupVersion !== undefined &&
      (!Number.isInteger(backup.photoBackupVersion) || backup.photoBackupVersion < 1)) return false;
  if (backup.exportedAt !== undefined &&
      (typeof backup.exportedAt !== "string" || Number.isNaN(Date.parse(backup.exportedAt)))) return false;
  return true;
}

function metadata(row) {
  return {
    id: Number(row.id), createdAt: row.created_at, deviceId: row.device_id,
    formatVersion: Number(row.format_version), byteSize: Number(row.byte_size)
  };
}

export async function onRequestPost({ request, env }) {
  const auth = await ownerFromRequest(request, env);
  if (auth.error) return auth.error;
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    return reply({ error: "Invalid request origin" }, 403);
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BACKUP_BYTES) {
    return reply({ error: "Backup exceeds the size limit" }, 413);
  }

  try {
    if (!(await verifyTestDatabase(env))) {
      return reply({ error: "Test environment not configured" }, 403);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES) {
      return reply({ error: "Backup exceeds the size limit" }, 413);
    }
    let body;
    try { body = JSON.parse(raw); }
    catch { return reply({ error: "Invalid backup request" }, 400); }
    if (!plainObject(body) || typeof body.deviceId !== "string" ||
        !body.deviceId.trim() || body.deviceId.length > 128 || !validBackup(body.backup)) {
      return reply({ error: "Invalid backup request" }, 400);
    }

    const backupData = JSON.stringify(body.backup);
    const byteSize = new TextEncoder().encode(backupData).byteLength;
    if (byteSize > MAX_BACKUP_BYTES) return reply({ error: "Backup exceeds the size limit" }, 413);
    const inserted = await env.DB.prepare(
      `INSERT INTO cloud_backups
        (owner_id, device_id, backup_data, format_version, byte_size)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(auth.ownerId, body.deviceId.trim(), backupData, BACKUP_FORMAT_VERSION, byteSize).run();
    if (inserted.meta?.changes !== 1 || !inserted.meta?.last_row_id) {
      return reply({ error: "Unable to create backup" }, 500);
    }

    const id = Number(inserted.meta.last_row_id);
    const row = await env.DB.prepare(
      `SELECT id, created_at, device_id, format_version, byte_size
       FROM cloud_backups WHERE id = ? AND owner_id = ?`
    ).bind(id, auth.ownerId).first();
    if (!row) return reply({ error: "Unable to create backup" }, 500);

    let retentionApplied = true;
    try {
      await env.DB.prepare(
        `DELETE FROM cloud_backups
         WHERE owner_id = ? AND id NOT IN (
           SELECT id FROM cloud_backups WHERE owner_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
         )`
      ).bind(auth.ownerId, auth.ownerId, RETAIN_PER_OWNER).run();
    } catch (error) {
      retentionApplied = false;
      console.error("Cloud backup retention failed", error);
    }
    return reply({ created: true, backup: metadata(row), retentionApplied }, 201);
  } catch (error) {
    console.error("Cloud backup creation failed", error);
    return reply({ error: "Unable to create backup" }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  const auth = await ownerFromRequest(request, env);
  if (auth.error) return auth.error;
  try {
    if (!(await verifyTestDatabase(env))) {
      return reply({ error: "Test environment not configured" }, 403);
    }
    const requestedId = new URL(request.url).searchParams.get("id");
    if (requestedId === null) {
      const { results } = await env.DB.prepare(
        `SELECT id, created_at, device_id, format_version, byte_size
         FROM cloud_backups WHERE owner_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
      ).bind(auth.ownerId, RETAIN_PER_OWNER).all();
      return reply({ backups: results.map(metadata) });
    }
    if (!/^[1-9]\d*$/.test(requestedId)) return reply({ error: "Invalid backup ID" }, 400);
    const row = await env.DB.prepare(
      `SELECT id, created_at, device_id, format_version, byte_size, backup_data
       FROM cloud_backups WHERE id = ? AND owner_id = ?`
    ).bind(Number(requestedId), auth.ownerId).first();
    if (!row) return reply({ error: "Backup not found" }, 404);
    let backup;
    try { backup = JSON.parse(row.backup_data); }
    catch { return reply({ error: "Stored backup is unavailable" }, 500); }
    return reply({ backup: { ...metadata(row), data: backup } });
  } catch (error) {
    console.error("Cloud backup retrieval failed", error);
    return reply({ error: "Unable to load backups" }, 500);
  }
}
