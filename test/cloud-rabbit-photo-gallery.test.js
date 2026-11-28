import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../cloud-rabbit-photo-gallery.js", import.meta.url), "utf8");
const origin = "https://preview.test";
const scope = { rabbitryId: "dev-auth-test", typedId: 's:"Rabbit / 7"' };
const id = index => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const jpeg = new Blob(["normalized fixture"], { type: "image/jpeg" });
const canvasJpeg = new Blob([await readFile(new URL("../tangled-woods-logo.jpg", import.meta.url))],
  { type: "image/jpeg" });
const gallery = (ids = [], primaryId = ids[0] ?? null) => ({ primaryId, photos: ids.map(id => ({ id })) });
const result = (revision, ids = [], primaryId) => ({ revision, gallery: gallery(ids, primaryId) });
const failure = (status, category = "http") => Object.assign(new Error(category), { status, category });

function load(extra = {}) {
  const context = { window: {}, Blob, URL, URLSearchParams, location: { origin }, ...extra };
  vm.runInNewContext(source, context);
  return context.window.twCloudRabbitPhotos;
}

test("cloud card photos use only qualified cloud metadata and scoped same-origin URLs", () => {
  const { primaryPhotoUrl } = load();
  const record = { cloudPhotoGalleryV1: gallery([id(1)]), localPhoto: "data:image/jpeg;base64,..." };
  const local = { record, metadata: { ...scope, source: { kind: "local" } } };
  assert.equal(primaryPhotoUrl(local), null);
  const entry = { ...local, metadata: { ...scope, source: { kind: "versioned-cloud" } } };
  const parsed = new URL(primaryPhotoUrl(entry), origin);
  assert.equal(parsed.pathname, "/api/test-rabbit-photos");
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { ...scope, photoId: id(1) });
  assert.equal(primaryPhotoUrl({ ...entry, record: { cloudPhotoGalleryV1: gallery([id(1)], id(2)) } }), null);
});

test("photo client uses uncached credentialed reads and sends JPEG bytes with progress and revision", async () => {
  const { createApi } = load();
  const calls = [];
  const api = createApi(scope, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, url: origin + url, text: async () => JSON.stringify(result(4)) };
    },
    upload: async (url, body, progress) => {
      calls.push({ url, body });
      progress(0.5);
      return { status: 200, url: origin + url, text: JSON.stringify(result(5, [id(1)])) };
    }
  });
  assert.equal((await api.load()).revision, 4);
  const progress = [];
  await api.mutate({ action: "add", operationId: id(1), baseRevision: 4, jpeg }, value => progress.push(value));
  assert.deepEqual(progress, [0.5]);
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].body, jpeg);
  assert.deepEqual(Object.fromEntries(new URL(calls[1].url, origin).searchParams), {
    ...scope, action: "add", operationId: id(1), baseRevision: "4"
  });
  await api.mutate({ action: "primary", photoId: id(1), baseRevision: 4 });
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[2].init.body, undefined);
});

test("photo client treats an Access redirect, stale write, and invalid successful response as failures", async () => {
  const { createApi } = load();
  const mock = (status, url, text) => createApi(scope, {
    fetchImpl: async () => ({ status, url, text: async () => text })
  });
  await assert.rejects(mock(200, "https://team.cloudflareaccess.com/login", "").load(),
    { status: 401, category: "auth" });
  await assert.rejects(mock(409, origin, "{}").mutate({ action: "remove", photoId: id(1), baseRevision: 4 }),
    { status: 409 });
  await assert.rejects(mock(200, origin, JSON.stringify(result(4, [id(1), id(1)]))).load(),
    { category: "malformed" });
});

test("compression draws an oriented decoded image onto a fresh 900-pixel JPEG canvas", async () => {
  const events = [];
  const bitmap = { width: 1600, height: 2400, close: () => events.push("closed") };
  const encodedWithApp1 = new Blob([canvasJpeg.slice(0, 2), Uint8Array.of(0xff, 0xe1, 0, 4, 1, 2),
    canvasJpeg.slice(2)], { type: "image/jpeg" });
  const canvas = {
    getContext: () => ({
      fillRect: (...args) => events.push(["fill", ...args]),
      drawImage: (...args) => events.push(["draw", ...args])
    }),
    toBlob: (callback, type, quality) => { events.push(["encode", type, quality]); callback(encodedWithApp1); }
  };
  const { compressPhoto, photoDimensions } = load({
    createImageBitmap: async (_, options) => { events.push(options.imageOrientation); return bitmap; },
    document: { createElement: tag => { assert.equal(tag, "canvas"); return canvas; } }
  });
  assert.deepEqual(await (await compressPhoto(jpeg)).arrayBuffer(), await canvasJpeg.arrayBuffer());
  assert.deepEqual([canvas.width, canvas.height], [600, 900]);
  assert.deepEqual(events, ["from-image", ["fill", 0, 0, 600, 900], ["draw", bitmap, 0, 0, 600, 900],
    ["encode", "image/jpeg", 0.78], "closed"]);
  assert.equal(photoDimensions(320, 100).width, 320);
  assert.throws(() => photoDimensions(10000, 10000), /too large/);
  await assert.rejects(compressPhoto(new Blob(["abc"], { type: "image/svg+xml" })), { category: "file" });
});

test("APP1 normalization removes one or multiple segments while preserving every other byte", async () => {
  const { stripCanvasApp1 } = load();
  assert.equal(await stripCanvasApp1(canvasJpeg), canvasJpeg);
  const bytes = new Uint8Array(await canvasJpeg.arrayBuffer());
  const app1 = [0xff, 0xe1, 0, 6, 0xff, 0xd9, 0xff, 0xda];
  for (const metadata of [app1, [...app1, ...app1]]) {
    const encoded = new Blob([bytes.subarray(0, 2), Uint8Array.from(metadata), bytes.subarray(2)], { type: "image/jpeg" });
    const normalized = await stripCanvasApp1(encoded);
    assert.equal(normalized.type, "image/jpeg");
    assert.deepEqual(new Uint8Array(await normalized.arrayBuffer()), bytes);
  }
});

test("progressive APP1 normalization preserves scan stuffing, restart markers and color segments", async () => {
  const { stripCanvasApp1 } = load();
  // Marker-walking fixture. Entropy bytes are synthetic, not a decodable image.
  const header = [0xff, 0xd8, 0xff, 0xe2, 0, 3, 0x49, 0xff, 0xee, 0, 3, 0x41,
    0xff, 0xc2, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0];
  const firstScan = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0, 0xff, 0, 0xe1, 0xff, 0xd0, 0x43];
  const secondScan = [0xff, 0xda, 0, 8, 1, 1, 0, 1, 63, 0, 0x7f, 0xff, 0xd9];
  const app1 = [0xff, 0xe1, 0, 4, 0x11, 0x22];
  const encoded = new Blob([Uint8Array.from([...header, ...firstScan, ...app1, ...secondScan])], { type: "image/jpeg" });
  assert.deepEqual(new Uint8Array(await (await stripCanvasApp1(encoded)).arrayBuffer()),
    Uint8Array.from([...header, ...firstScan, ...secondScan]));
});

test("APP1 normalization rejects malformed lengths, marker boundaries and missing or trailing EOI", async () => {
  const { stripCanvasApp1 } = load();
  const bytes = new Uint8Array(await canvasJpeg.arrayBuffer());
  for (const invalid of [
    [0xff, 0xd8, 0xff, 0xe1, 0, 1],
    [0xff, 0xd8, 0xff, 0xe1, 0],
    [0xff, 0xd8, 0xff, 0xe1, 0, 8, 0xff, 0xd9],
    [0xff, 0xd8, 0x11, 0xff, 0xd9],
    bytes.subarray(0, -2),
    [...bytes, 0]
  ]) {
    await assert.rejects(stripCanvasApp1(new Blob([Uint8Array.from(invalid)])), { category: "file" });
  }
});

test("multiple uploads run sequentially and duplicate submission cannot start a second batch", async () => {
  const { createSession } = load();
  const calls = [], states = [], sync = [];
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const session = createSession({
    load: async () => result(4),
    mutate: async (operation, progress) => {
      calls.push(operation);
      if (calls.length === 1) await hold;
      progress(0.35);
      return result(4 + calls.length, calls.map(item => item.operationId));
    }
  }, { compress: async () => jpeg, makeId: () => id(calls.length + 1),
    onChange: state => states.push(state), onSnapshot: state => sync.push(state.revision) });
  await session.load();
  const saving = session.uploadFiles(["first", "second"]);
  assert.equal(await session.uploadFiles(["duplicate"]), false);
  release();
  await saving;
  assert.deepEqual(calls.map(item => item.baseRevision), [4, 5]);
  assert.equal(session.getState().snapshot.revision, 6);
  assert.deepEqual(sync, [4, 6]);
  assert.ok(states.some(state => state.progress === 0.35 && state.busy));
});

test("ambiguous upload retries reuse exact bytes, operation ID and revision, then refresh on replay", async () => {
  const { createSession } = load();
  const calls = [];
  let compressions = 0, reads = 0;
  const session = createSession({
    load: async () => ++reads === 1 ? result(4) : result(5, [id(1)]),
    mutate: async command => {
      calls.push(command);
      if (calls.length === 1) throw failure(0, "network");
      return { revision: 5, replayed: true };
    }
  }, { compress: async () => { compressions++; return jpeg; }, makeId: () => id(1) });
  await session.load();
  await session.uploadFiles(["photo"]);
  assert.equal(session.getState().retry, true);
  assert.equal(await session.uploadFiles(["different photo"]), false);
  await session.retry();
  assert.equal(calls[0], calls[1]);
  assert.equal(calls[1].jpeg, jpeg);
  assert.equal(calls[1].baseRevision, 4);
  assert.equal(compressions, 1);
  assert.equal(reads, 2);
  assert.equal(session.getState().retry, false);
  assert.equal(session.getState().snapshot.gallery.primaryId, id(1));
});

test("revision conflict stops a partial batch and requires an explicit reload", async () => {
  const { createSession } = load();
  const sent = [], synced = [];
  let reads = 0;
  const session = createSession({
    load: async () => ++reads === 1 ? result(4) : result(7, [id(1), id(7)]),
    mutate: async command => {
      sent.push(command);
      if (sent.length === 2) throw failure(409);
      return result(5, [id(1)]);
    }
  }, { compress: async () => jpeg, makeId: () => id(sent.length + 1), onSnapshot: value => synced.push(value.revision) });
  await session.load();
  await session.uploadFiles(["one", "two", "three"]);
  assert.equal(sent.length, 2);
  assert.match(session.getState().message, /1 saved/);
  assert.equal(session.getState().reloadRequired, true);
  assert.equal(await session.retry(), false);
  assert.equal(await session.uploadFiles(["blocked"]), false);
  await session.load();
  assert.deepEqual(synced, [4, 5, 7]);
  assert.equal(session.getState().reloadRequired, false);
});

test("a full gallery still permits single replacement, primary changes and removal at the latest revision", async () => {
  const { createSession } = load();
  const ids = Array.from({ length: 10 }, (_, i) => id(i + 1));
  const calls = [];
  const session = createSession({
    load: async () => result(12, ids),
    mutate: async operation => {
      calls.push(operation);
      if (operation.action === "replace") ids[0] = operation.operationId;
      if (operation.action === "remove") ids.shift();
      return result(operation.baseRevision + 1, ids, operation.action === "primary" ? operation.photoId : ids[0]);
    }
  }, { compress: async () => jpeg, makeId: () => id(11) });
  await session.load();
  assert.equal(await session.uploadFiles(["over limit"]), false);
  assert.equal(await session.uploadFiles(["one", "two"], id(1)), false);
  await session.uploadFiles(["replacement"], id(1));
  await session.change("primary", id(2));
  await session.change("remove", id(11));
  assert.deepEqual(calls.map(item => [item.action, item.photoId, item.baseRevision]),
    [["replace", id(1), 12], ["primary", id(2), 13], ["remove", id(11), 14]]);
  assert.equal(session.getState().snapshot.gallery.photos.length, 9);
});

test("navigating away during compression prevents subsequent upload", async () => {
  const { createSession } = load();
  let current = true, uploads = 0, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const session = createSession({ load: async () => result(1), mutate: async () => { uploads++; } },
    { compress: () => pending, makeId: () => id(1), isCurrent: () => current });
  await session.load();
  const attempt = session.uploadFiles(["first", "second"]);
  current = false;
  finish(jpeg);
  await attempt;
  assert.equal(uploads, 0);
});

test("mounted gallery exposes separate camera and multi-select inputs and keyboard viewer navigation", async () => {
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {};
      this.className = ""; this.textContent = ""; this.isConnected = true; this.style = {};
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children.length = 0; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close(); }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelectorAll() {
      return this.descendants().filter(child => child.tag === "input" ||
        (child.tag === "button" && child.className !== "tw-cloud-photo-thumb"));
    }
  }
  const { mount } = load({
    document: { createElement: tag => new Element(tag) },
    fetch: async url => ({ status: 200, url: origin + url, text: async () => JSON.stringify(result(3, [id(1), id(2)])) })
  });
  const panel = new Element("section");
  mount(panel, { metadata: scope });
  await new Promise(resolve => setImmediate(resolve));
  const control = text => panel.descendants().find(item => item.textContent === text);
  const take = control("Take photo").children[0];
  const choose = control("Choose photos").children[0];
  assert.equal(take.attributes.capture, "environment");
  assert.equal(take.multiple, false);
  assert.equal(choose.attributes.capture, undefined);
  assert.equal(choose.multiple, true);
  assert.equal(control("Replace").children[0].multiple, false);
  const view = control("View photo 1");
  view.onclick();
  const dialog = panel.children.find(child => child.tag === "dialog");
  assert.equal(dialog.open, true);
  assert.ok(control("Photo 1 of 2"));
  dialog.listeners.keydown({ key: "ArrowRight", preventDefault() {} });
  assert.ok(control("Photo 2 of 2"));
  control("Close").onclick();
  assert.equal(dialog.isConnected, false);
  assert.equal(view.focused, true);
});

function storageFixture() {
  const items = new Map();
  return {
    get length() { return items.size; },
    key: index => [...items.keys()][index] ?? null,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key)
  };
}

test("closing during a batch preserves its receipt and reopening confirms the committed photo", async () => {
  const { createSession, createJournal } = load();
  const storage = storageFixture();
  const journal = createJournal(scope, () => storage);
  const hash = async () => "c".repeat(64);
  let current = true, finish, started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const original = createSession({
    load: async () => result(4),
    mutate: async () => { calls++; started(); return response; }
  }, { compress: async () => jpeg, makeId: () => id(3), journal, hash, isCurrent: () => current });
  await original.load();
  const saving = original.uploadFiles(["first", "second"]);
  await dispatched;
  current = false;
  finish(result(5, [id(3)]));
  await saving;
  assert.equal(calls, 1);
  assert.equal(journal.list()[0].remaining, 1);
  assert.ok(!storage.getItem(storage.key(0)).includes("normalized fixture"));
  const reopened = createSession({ load: async () => result(5, [id(3)]) }, {
    journal: createJournal(scope, () => storage)
  });
  await reopened.load();
  assert.equal(journal.list().length, 0);
  assert.match(reopened.getState().message, /confirmed in the gallery.*remaining photo/);
  assert.equal(reopened.getState().snapshot.gallery.photos.length, 1);
});

test("reopening an unresolved upload blocks new IDs and retries only matching bytes", async () => {
  const { createSession, createJournal } = load();
  const storage = storageFixture();
  const journal = createJournal(scope, () => storage);
  let sent = [];
  const hash = async bytes => bytes === jpeg ? "c".repeat(64) : "d".repeat(64);
  const original = createSession({
    load: async () => result(4),
    mutate: async command => { sent.push(command); throw failure(0, "network"); }
  }, { compress: async () => jpeg, makeId: () => id(4), journal, hash });
  await original.load();
  await original.uploadFiles(["original"]);
  const reopened = createSession({
    load: async () => result(4),
    reconcile: async () => { throw failure(404); },
    mutate: async command => { sent.push(command); return result(5, [id(4)]); }
  }, { compress: async file => file === "original" ? jpeg : new Blob(["other"]), journal, hash });
  await reopened.load();
  await reopened.checkRecovery();
  assert.equal(journal.list().length, 1, "a missing receipt at the same revision may still arrive");
  assert.equal(await reopened.uploadFiles(["new photo"]), false);
  await reopened.recoverFile("wrong photo");
  assert.match(reopened.getState().message, /does not match/);
  assert.equal(sent.length, 1);
  await reopened.recoverFile("original");
  assert.equal(sent[1].operationId, sent[0].operationId);
  assert.equal(sent[1].baseRevision, sent[0].baseRevision);
  assert.equal(sent[1].jpeg, jpeg);
  assert.equal(journal.list().length, 0);
});

test("a failed receipt write prevents an upload from being dispatched", async () => {
  const { createSession, createJournal } = load();
  const storage = storageFixture();
  storage.setItem = () => { throw new Error("Storage denied"); };
  const journal = createJournal(scope, () => storage);
  let calls = 0;
  const session = createSession({ load: async () => result(4), mutate: async () => { calls++; } }, {
    compress: async () => jpeg, makeId: () => id(1), journal, hash: async () => "e".repeat(64)
  });
  await session.load();
  await session.uploadFiles(["photo"]);
  assert.equal(calls, 0);
  assert.match(session.getState().message, /No upload was sent/);
});

test("the image-element decoder revokes temporary object URLs on success and failure", async () => {
  const events = [];
  let shouldFail = false;
  class Image {
    naturalWidth = 600;
    naturalHeight = 1200;
    set src(value) {
      events.push(value);
      if (shouldFail) this.onerror();
      else this.onload();
    }
  }
  const canvas = {
    getContext: () => ({ fillRect() {}, drawImage() {} }),
    toBlob: done => done(canvasJpeg)
  };
  const { compressPhoto } = load({
    Image, URL: { createObjectURL: () => "blob:temporary", revokeObjectURL: url => events.push("revoked " + url) },
    document: { createElement: () => canvas }
  });
  await compressPhoto(jpeg);
  shouldFail = true;
  await assert.rejects(compressPhoto(jpeg), { category: "file" });
  assert.deepEqual(events, ["blob:temporary", "revoked blob:temporary", "blob:temporary", "revoked blob:temporary"]);
});

test("cancellation sends no image or checksum and validates the returned receipt", async () => {
  const { createApi } = load();
  let call;
  const api = createApi(scope, { fetchImpl: async (url, init) => {
    call = [url, init];
    return { status: 200, url: origin + url, text: async () => '{"state":"abandoned","committedRevision":null}' };
  } });
  const receipt = await api.cancel({ operationId: id(4), baseRevision: 7, sha256: "private", jpeg });
  assert.equal(receipt.state, "abandoned");
  assert.deepEqual(Object.fromEntries(new URL(call[0], origin).searchParams),
    { ...scope, action: "cancel", operationId: id(4), baseRevision: "7" });
  assert.equal(call[1].method, "POST");
  assert.equal(call[1].body, undefined);
});

test("a confirmed first JPEG rejection removes its receipt and retains sanitized diagnostics", async () => {
  const { createApi, createSession, createJournal } = load();
  const journal = createJournal(scope, () => storage);
  const storage = storageFixture();
  const api = createApi(scope, {
    fetchImpl: async url => ({ status: 200, url: origin + url, text: async () => JSON.stringify(result(4)) }),
    upload: async url => ({
      status: 415, url: origin + url,
      text: JSON.stringify({ error: "raw server details must not appear", outcome: "rejected" })
    })
  });
  const image = { type: "image/heic", name: "private-key-looking-filename.heic" };
  const session = createSession(api, { journal, hash: async () => "a".repeat(64), makeId: () => id(1),
    compress: async (_, report) => { report({ stage: "encoding", width: 600, height: 900 }); return jpeg; } });
  await session.load();
  await session.uploadFiles([image]);
  const state = session.getState();
  assert.equal(journal.list().length, 0);
  assert.equal(state.recovery, null);
  assert.equal(state.retry, false);
  assert.match(state.message, /could not validate the prepared JPEG/);
  assert.deepEqual({ ...state.diagnostic }, {
    operationId: id(1), sourceFormat: "image/heic", encodedFormat: "image/jpeg",
    width: 600, height: 900, bytes: jpeg.size, stage: "sending", httpStatus: 415,
    networkError: null, outcome: "rejected"
  });
  assert.doesNotMatch(JSON.stringify(state), /raw server details|private-key-looking|normalized fixture/);
});

test("a rejection on retry preserves uncertainty until cancellation is confirmed without the original file", async () => {
  const { createSession, createJournal } = load();
  const storage = storageFixture();
  const journal = createJournal(scope, () => storage);
  let attempts = 0, cancellations = 0;
  const api = {
    load: async () => result(4),
    mutate: async () => {
      if (++attempts === 1) throw Object.assign(failure(0, "network"), { networkError: "timeout" });
      throw Object.assign(failure(415), { outcome: "rejected" });
    },
    cancel: async receipt => {
      assert.equal(receipt.operationId, id(2));
      if (++cancellations === 1) throw failure(0, "network");
      return { state: "abandoned", committedRevision: null };
    }
  };
  const initial = createSession(api, { journal, hash: async () => "a".repeat(64),
    makeId: () => id(2), compress: async () => jpeg });
  await initial.load();
  await initial.uploadFiles(["camera photo"]);
  assert.equal(initial.getState().diagnostic.networkError, "timeout");
  assert.equal(initial.getState().diagnostic.outcome, "uncertain");
  await initial.retry();
  assert.equal(initial.getState().diagnostic.outcome, "uncertain");
  const reopened = createSession(api, { journal, compress: async () => { throw Error("Image unavailable"); } });
  await reopened.load();
  await reopened.cancelRecovery();
  assert.equal(journal.list().length, 1);
  assert.match(reopened.getState().message, /Cancellation was not confirmed/);
  await reopened.cancelRecovery();
  assert.equal(journal.list().length, 0);
  assert.equal(reopened.getState().recovery, null);
  assert.equal(reopened.getState().reloadRequired, false);
  assert.match(reopened.getState().message, /upload canceled/);
  assert.equal(attempts, 2);
});

test("cancel recovery confirms a completed upload and retains the committed image", async () => {
  const { createSession, createJournal } = load();
  const storage = storageFixture();
  const journal = createJournal(scope, () => storage);
  journal.save({ action: "add", operationId: id(9), baseRevision: 4, sha256: "b".repeat(64) });
  let reads = 0;
  const session = createSession({
    load: async () => ++reads === 1 ? result(4) : result(5, [id(9)]),
    cancel: async () => ({ state: "committed", committedRevision: 5 })
  }, { journal });
  await session.load();
  await session.cancelRecovery();
  assert.match(session.getState().message, /already saved and has been kept/);
  assert.equal(session.getState().snapshot.gallery.primaryId, id(9));
  assert.equal(journal.list().length, 0);
});

test("development capture pauses before persistence or upload and sends the same hashed Blob", async () => {
  const { createApi, createSession, createJournal } = load({ crypto: webcrypto });
  const storage = storageFixture();
  const journal = createJournal(scope, () => storage);
  const operationId = id(7);
  let sent;
  const api = createApi(scope, {
    fetchImpl: async url => ({ status: 200, url: origin + url, text: async () => JSON.stringify(result(4)) }),
    upload: async (url, body) => {
      sent = body;
      return { status: 415, url: origin + url,
        text: JSON.stringify({ outcome: "rejected", code: "jpeg_marker", error: "private detail",
          detail: { reason: "disallowed_marker", marker: "FFE1", payload: "private metadata" } }) };
    }
  });
  const session = createSession(api, { journal, canCapture: () => true,
    makeId: () => operationId, compress: async () => jpeg });
  await session.load();
  await session.uploadFiles([jpeg]);
  assert.equal(sent, undefined);
  assert.equal(journal.list().length, 0);
  assert.equal(await session.retry(), false);
  assert.equal(await session.cancelRecovery(), false);
  assert.equal(session.preparedJpeg(), jpeg);
  const digest = createHash("sha256").update(Buffer.from(await jpeg.arrayBuffer())).digest("hex");
  assert.equal(session.getState().diagnostic.sha256, digest);
  await session.sendPrepared();
  assert.equal(sent, jpeg);
  assert.equal(session.preparedJpeg(), null);
  assert.equal(journal.list().length, 0);
  assert.equal(session.getState().diagnostic.rejectionCode, "jpeg_marker");
  assert.deepEqual({ ...session.getState().diagnostic.rejectionDetail }, { reason: "disallowed_marker", marker: "FFE1" });
  assert.doesNotMatch(JSON.stringify(session.getState()), /private detail|private metadata/);
});
