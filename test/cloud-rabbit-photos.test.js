import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { onRequestGet, onRequestPost } from "../functions/api/test-rabbit-photos.js";
import { onRequestPost as updateRabbit } from "../functions/api/test-update-versioned-rabbit.js";
import { onRequestPost as createRabbit } from "../functions/api/test-create-versioned-rabbit.js";
import { onRequestPost as deleteRabbit } from "../functions/api/test-delete-versioned-rabbit.js";
import { createRabbitEnvelope } from "../rabbit-record-contract.js";
import { encodeRabbitId } from "../rabbit-typed-id.js";
import { createTestDatabase } from "./support/d1-test-database.js";
import { getTestAuth } from "./support/access-test-auth.js";

const origin = "https://photos.test";
const typedId = encodeRabbitId("rabbit");
const jpeg = await readFile(new URL("../tangled-woods-logo.jpg", import.meta.url));
const timestamp = "2026-11-27T08:00:00.000Z";
const galleryField = "cloudPhotoGalleryV1";

async function fixture(t, options) {
  const f = await createTestDatabase(options);
  t.after(f.close);
  const objects = new Map();
  const photos = {
    async put(key, bytes, options) {
      assert.equal(options.onlyIf.get("If-None-Match"), "*");
      assert.equal(options.sha256, options.customMetadata.sha256);
      if (objects.has(key)) return null;
      const object = { bytes: Buffer.from(bytes), size: bytes.length, customMetadata: options.customMetadata };
      objects.set(key, object);
      return object;
    },
    async head(key) { return objects.get(key) ?? null; },
    async get(key) {
      const object = objects.get(key);
      return object ? { ...object, body: object.bytes } : null;
    }
  };
  f.env.PHOTOS = photos;
  for (const rabbitry of ["woods", "other"]) {
    f.database.prepare("INSERT INTO rabbitries VALUES (?,?,'setup',?,?,NULL)").run(rabbitry, rabbitry, timestamp, timestamp);
    f.database.prepare("INSERT INTO rabbitry_memberships VALUES (?,?,?, ?,?,NULL)")
      .run(rabbitry, "integration-test-user", "editor", timestamp, timestamp);
    const envelope = createRabbitEnvelope({ id: "rabbit", revision: 0, createdAt: timestamp,
      updatedAt: timestamp, record: { _id: "rabbit", Name: "Maple", Father: "Historical sire" } });
    f.database.prepare(`INSERT INTO rabbit_record_versions
      (rabbitry_id,typed_id,revision,schema_version,created_at,updated_at,envelope)
      VALUES (?,?,0,1,?,?,?)`).run(rabbitry, typedId, timestamp, timestamp, JSON.stringify(envelope));
  }
  const get = (query = {}, opts = {}) => request(false, query, opts);
  const post = (query, opts = {}) => request(true, query, opts);
  function request(write, query, opts) {
    const params = new URLSearchParams({ rabbitryId: "woods", typedId, ...query });
    const body = opts.body ?? (["add", "replace"].includes(query.action) ? jpeg : undefined);
    const token = opts.token === undefined ? f.accessToken : opts.token;
    const request = new Request(`${origin}/api/test-rabbit-photos?${params}`, {
      method: write ? "POST" : "GET",
      headers: { ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
        ...(write ? { Origin: opts.origin ?? origin } : {}),
        ...(body ? { "Content-Type": opts.type ?? "image/jpeg" } : {}),
        ...opts.headers
      },
      body
    });
    return (write ? onRequestPost : onRequestGet)({ request, env: f.env });
  }
  const rabbitWrite = (handler, payload) => handler({ env: f.env, request: new Request(origin, {
    method: "POST", headers: { Origin: origin, "Cf-Access-Jwt-Assertion": f.accessToken,
      "Content-Type": "application/json" },
    body: JSON.stringify({ rabbitryId: "woods", ...payload })
  }) });
  return { ...f, photos, objects, get, post, rabbitWrite };
}

async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("versioned gallery adds, reads, promotes, replaces and removes without deleting historical bytes", async t => {
  const f = await fixture(t);
  assert.deepEqual((await json(await f.get())).gallery, { photos: [], primaryId: null });
  const first = randomUUID(), second = randomUUID(), replacement = randomUUID();
  const added = await json(await f.post({ action: "add", operationId: first, baseRevision: 0 }));
  assert.equal(added.revision, 1);
  assert.equal(added.gallery.primaryId, first);
  assert.deepEqual([added.gallery.photos[0].width, added.gallery.photos[0].height], [810, 804]);
  const image = await f.get({ photoId: first });
  assert.equal(image.headers.get("Cache-Control"), "private, no-store");
  assert.equal(image.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(image.headers.get("Content-Type"), "image/jpeg");
  assert.equal(image.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'; frame-ancestors 'none'");
  assert.equal(image.headers.get("Content-Disposition"), 'inline; filename="rabbit-photo.jpg"');
  assert.equal(image.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  await json(await f.post({ action: "add", operationId: second, baseRevision: 1 }));
  assert.equal((await json(await f.post({ action: "primary", photoId: second, baseRevision: 2 }))).gallery.primaryId, second);
  const replaced = await json(await f.post({ action: "replace", operationId: replacement, photoId: second, baseRevision: 3 }));
  assert.equal(replaced.gallery.primaryId, replacement);
  assert.equal((await f.get({ photoId: second })).status, 404);
  const removed = await json(await f.post({ action: "remove", photoId: replacement, baseRevision: 4 }));
  assert.equal(removed.gallery.primaryId, first);
  const update = await json(await f.rabbitWrite(updateRabbit, {
    baseRevision: 5, record: { _id: "rabbit", Name: "Edited", [galleryField]: { forged: true } }
  }));
  assert.deepEqual(update.rabbit.envelope.record[galleryField], removed.gallery);
  assert.equal(update.rabbit.envelope.record.Father, "Historical sire");
  await json(await f.rabbitWrite(createRabbit, { record: { _id: "forged", [galleryField]: removed.gallery } }), 400);
  await json(await f.rabbitWrite(deleteRabbit, { typedId, baseRevision: 6 }));
  assert.equal((await f.get({ photoId: first })).status, 404);
  assert.equal(f.objects.size, 3);
  const history = f.database.prepare("SELECT envelope FROM rabbit_record_versions WHERE rabbitry_id='woods' ORDER BY revision").all();
  assert.equal(history.length, 8);
  assert.equal(JSON.parse(history[3].envelope).record[galleryField].primaryId, second);
  assert.equal(JSON.parse(history[4].envelope).record[galleryField].primaryId, replacement);
  assert.equal(JSON.parse(history[7].envelope).record[galleryField].primaryId, first);
});

test("authorization, environment, scoped object access and actual upload limits fail closed", async t => {
  const f = await fixture(t);
  const { token } = await getTestAuth();
  const viewer = await token({ sub: "photo-viewer" });
  f.database.prepare("INSERT INTO rabbitry_memberships VALUES ('woods','photo-viewer','viewer',?,?,NULL)")
    .run(timestamp, timestamp);
  const id = randomUUID(), add = { action: "add", operationId: id, baseRevision: 0 };
  assert.equal((await f.get({}, { token: null })).status, 401);
  assert.equal((await f.get({ rabbitryId: "other" }, { token: viewer })).status, 404);
  assert.equal((await f.post(add, { token: viewer })).status, 403);
  assert.equal((await f.post(add, { origin: "https://elsewhere.test" })).status, 403);
  assert.equal((await f.post({ ...add, typedId: "junk" })).status, 400);
  assert.equal((await f.post(add, { body: Buffer.alloc(2 * 1024 * 1024 + 1), headers: { "Content-Length": "1" } })).status, 413);
  assert.equal((await json(await f.post(add, { body: jpeg, type: "image/png" }), 415)).code, "jpeg_mime");
  assert.equal((await f.post(add, { body: Buffer.from("<svg><script>alert(1)</script></svg>") })).status, 415);
  assert.equal((await f.post(add, { body: jpeg.subarray(0, jpeg.length - 2) })).status, 415);
  assert.equal((await f.post(add, { body: Buffer.concat([jpeg, Buffer.from("payload")]) })).status, 415);
  const app1 = await json(await f.post(add, {
    body: Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 225, 0, 2]), jpeg.subarray(2)])
  }), 415);
  assert.equal(app1.code, "jpeg_marker");
  assert.deepEqual(app1.detail, { reason: "disallowed_marker", marker: "FFE1" });
  const oversizedDimensions = Buffer.from(jpeg);
  const frame = oversizedDimensions.indexOf(Buffer.from([255, 192]));
  assert.notEqual(frame, -1);
  oversizedDimensions.writeUInt16BE(4096, frame + 7);
  assert.equal((await f.post(add, { body: oversizedDimensions })).status, 415);
  assert.equal(f.objects.size, 0);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM rabbit_photo_uploads").get().n, 0);
  await json(await f.post(add));
  assert.equal((await f.get({ photoId: id }, { token: viewer })).status, 200);
  assert.equal((await f.get({ photoId: id, rabbitryId: "other" })).status, 404);
  f.database.prepare("UPDATE rabbitry_memberships SET revoked_at=? WHERE access_subject='photo-viewer'").run(timestamp);
  assert.equal((await f.get({ photoId: id }, { token: viewer })).status, 404);
  f.objects.clear();
  assert.equal((await f.get({ photoId: id })).status, 503);
  delete f.env.PHOTOS;
  assert.equal((await f.get()).status, 503);
});

test("upload retry survives an ambiguous R2 put and never overwrites committed bytes", async t => {
  const f = await fixture(t);
  const put = f.photos.put;
  const id = randomUUID(), add = { action: "add", operationId: id, baseRevision: 0 };
  f.photos.put = async (...args) => {
    await put(...args);
    f.photos.put = put;
    throw new Error("Lost R2 response");
  };
  await json(await f.post(add), 503);
  const reconcile = { action: "reconcile", operationId: id };
  assert.deepEqual(await json(await f.post(reconcile)), { state: "reserved", objectPresent: true, committedRevision: null });
  assert.equal((await json(await f.post(add))).revision, 1);
  assert.deepEqual(await json(await f.post(add)), { revision: 1, replayed: true });
  const different = Buffer.from(jpeg);
  different[13] ^= 1; // Change JFIF metadata without changing JPEG structure.
  await json(await f.post(add, { body: different }), 409);
  assert.deepEqual(await json(await f.post(reconcile)), { state: "committed", objectPresent: true, committedRevision: 1 });
  assert.equal(f.objects.size, 1);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM rabbit_record_versions WHERE rabbitry_id='woods'").get().n, 2);
});

test("concurrent uploads at the gallery limit leave a tracked orphan and preserve committed history", async t => {
  const f = await fixture(t);
  for (let baseRevision = 0; baseRevision < 9; baseRevision++) {
    await json(await f.post({ action: "add", baseRevision, operationId: randomUUID() }));
  }
  const put = f.photos.put;
  let arrived = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  f.photos.put = async (...args) => {
    const object = await put(...args);
    if (++arrived === 2) release();
    await ready;
    return object;
  };
  const ids = [randomUUID(), randomUUID()];
  const results = await Promise.all(ids.map(operationId => f.post({ action: "add", operationId, baseRevision: 9 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const gallery = await json(await f.get());
  assert.equal(gallery.gallery.photos.length, 10);
  assert.equal(gallery.revision, 10);
  await json(await f.post({ action: "add", operationId: randomUUID(), baseRevision: 10 }), 409);
  const orphan = ids[results.findIndex(r => r.status === 409)];
  assert.equal((await f.get({ photoId: orphan })).status, 404);
  f.database.prepare("UPDATE rabbit_photo_uploads SET expires_at=? WHERE photo_id=?").run(timestamp, orphan);
  assert.deepEqual(await json(await f.post({ action: "reconcile", operationId: orphan })),
    { state: "abandoned", objectPresent: true, committedRevision: null });
  await json(await f.post({ action: "add", operationId: orphan, baseRevision: 10 }), 409);
  assert.equal(f.objects.size, 11);
});

test("missing migration fails before R2 writes while old rabbit revisions remain readable", async t => {
  const f = await fixture(t, { through: 8 });
  await json(await f.post({ action: "add", operationId: randomUUID(), baseRevision: 0 }), 503);
  assert.equal(f.objects.size, 0);
  const original = f.database.prepare("SELECT envelope FROM rabbit_record_versions WHERE rabbitry_id='woods'").get().envelope;
  f.database.exec(await readFile(new URL("../migrations/009_versioned_rabbit_photos.sql", import.meta.url), "utf8"));
  assert.equal(f.database.prepare("SELECT envelope FROM rabbit_record_versions WHERE rabbitry_id='woods'").get().envelope, original);
  assert.deepEqual((await json(await f.get())).gallery, { photos: [], primaryId: null });
});

test("revocation during upload prevents the revision from committing", async t => {
  const f = await fixture(t);
  const put = f.photos.put;
  f.photos.put = async (...args) => {
    const object = await put(...args);
    f.database.prepare("UPDATE rabbitry_memberships SET revoked_at=? WHERE rabbitry_id='woods'").run(timestamp);
    return object;
  };
  const id = randomUUID();
  await json(await f.post({ action: "add", baseRevision: 0, operationId: id }), 409);
  assert.equal(f.database.prepare("SELECT max(revision) AS revision FROM rabbit_record_versions WHERE rabbitry_id='woods'").get().revision, 0);
  assert.deepEqual({ ...f.database.prepare("SELECT state, committed_revision FROM rabbit_photo_uploads WHERE photo_id=?").get(id) },
    { state: "reserved", committed_revision: null });
  assert.equal(f.objects.size, 1);
});

test("a failed ledger update rolls back the photo revision and allows exact retry", async t => {
  const f = await fixture(t);
  f.database.exec(`CREATE TRIGGER test_fail_receipt BEFORE UPDATE ON rabbit_photo_uploads
    WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END;`);
  const add = { action: "add", baseRevision: 0, operationId: randomUUID() };
  await json(await f.post(add), 503);
  assert.equal((await json(await f.get())).revision, 0);
  assert.equal(f.database.prepare("SELECT state FROM rabbit_photo_uploads WHERE photo_id=?").get(add.operationId).state, "reserved");
  assert.equal(f.objects.size, 1);
  f.database.exec("DROP TRIGGER test_fail_receipt");
  assert.equal((await json(await f.post(add))).revision, 1);
  assert.equal(f.database.prepare("SELECT state FROM rabbit_photo_uploads WHERE photo_id=?").get(add.operationId).state, "committed");
  assert.equal(f.objects.size, 1);
});

test("canceling a missing reservation is idempotent and blocks a delayed upload", async t => {
  const f = await fixture(t);
  const operationId = randomUUID();
  const cancel = { action: "cancel", baseRevision: 0, operationId };
  const upload = { action: "add", baseRevision: 0, operationId };
  const result = { state: "abandoned", committedRevision: null };
  assert.deepEqual(await json(await f.post(cancel)), result);
  assert.deepEqual(await json(await f.post(cancel)), result);
  assert.equal((await json(await f.post(upload), 409)).outcome, "abandoned");
  assert.equal((await json(await f.get())).revision, 0);
  assert.equal(f.objects.size, 0);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM rabbit_photo_uploads").get().n, 1);
});

test("cancellation during an R2 write prevents a concurrent commit and preserves the private object", async t => {
  const f = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const put = f.photos.put;
  f.photos.put = async (...args) => { entered(); await pause; return put(...args); };
  const operationId = randomUUID();
  const upload = f.post({ action: "add", baseRevision: 0, operationId });
  await started;
  try {
    assert.deepEqual(await json(await f.post({ action: "cancel", baseRevision: 0, operationId })),
      { state: "abandoned", committedRevision: null });
  } finally { release(); }
  assert.equal((await json(await upload, 409)).outcome, "abandoned");
  assert.equal((await json(await f.get())).revision, 0);
  assert.equal((await f.get({ photoId: operationId })).status, 404);
  assert.equal(f.objects.size, 1);
});

test("cancellation after a committed upload returns its receipt even after photo removal", async t => {
  const f = await fixture(t);
  const operationId = randomUUID();
  await json(await f.post({ action: "add", baseRevision: 0, operationId }));
  await json(await f.post({ action: "remove", baseRevision: 1, photoId: operationId }));
  const cancel = { action: "cancel", baseRevision: 0, operationId };
  const response = { state: "committed", committedRevision: 1 };
  delete f.env.PHOTOS;
  assert.deepEqual(await json(await f.post(cancel)), response);
  assert.deepEqual(await json(await f.post(cancel)), response);
  assert.equal((await f.post({ ...cancel, baseRevision: 1 })).status, 404);
  assert.equal(f.objects.size, 1);
  assert.equal(f.database.prepare("SELECT max(revision) AS n FROM rabbit_record_versions WHERE rabbitry_id='woods'").get().n, 2);
});

test("cancellation is scoped to the authorized uploader and rejected JPEGs have an explicit outcome", async t => {
  const f = await fixture(t);
  const { token } = await getTestAuth();
  const editor = await token({ sub: "another-editor" });
  f.database.prepare("INSERT INTO rabbitry_memberships VALUES ('woods','another-editor','editor',?,?,NULL)")
    .run(timestamp, timestamp);
  const operationId = randomUUID();
  const add = { action: "add", baseRevision: 0, operationId };
  const cancel = { ...add, action: "cancel" };
  assert.equal((await json(await f.post(add, { body: Buffer.from("not JPEG") }), 415)).outcome, "rejected");
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM rabbit_photo_uploads").get().n, 0);
  f.photos.put = async () => { throw new Error("Interrupted upload"); };
  await json(await f.post(add), 503);
  assert.equal((await f.post(cancel, { token: editor })).status, 404);
  assert.equal((await f.post(cancel, { origin: "https://other.test" })).status, 403);
  assert.equal((await f.post(cancel, { token: null })).status, 401);
  assert.equal(f.database.prepare("SELECT state FROM rabbit_photo_uploads").get().state, "reserved");
  assert.equal((await json(await f.post({ ...cancel, rabbitryId: "other" }))).state, "abandoned");
  assert.equal(f.database.prepare("SELECT state FROM rabbit_photo_uploads WHERE rabbitry_id='woods'").get().state, "reserved");
});
