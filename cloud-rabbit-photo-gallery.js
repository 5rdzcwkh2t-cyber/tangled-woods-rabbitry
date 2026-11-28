(function () {
  "use strict";

  const API = "/api/test-rabbit-photos";
  const FIELD = "cloudPhotoGalleryV1";
  const LIMIT = 10;
  const MAX_UPLOAD = 2 * 1024 * 1024;
  const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function urlFor(scope, params = {}) {
    return `${API}?${new URLSearchParams({ rabbitryId: scope.rabbitryId, typedId: scope.typedId, ...params })}`;
  }

  function validGallery(gallery) {
    return Array.isArray(gallery?.photos) && gallery.photos.length <= LIMIT &&
      gallery.photos.every(photo => typeof photo?.id === "string" && PHOTO_ID.test(photo.id)) &&
      new Set(gallery.photos.map(photo => photo.id)).size === gallery.photos.length &&
      (gallery.photos.length ? gallery.photos.some(photo => photo.id === gallery.primaryId) : gallery.primaryId === null);
  }

  function primaryPhotoUrl(entry) {
    const gallery = entry?.record?.[FIELD];
    return entry?.metadata?.source?.kind === "versioned-cloud" && validGallery(gallery) && gallery.primaryId
      ? urlFor(entry.metadata, { photoId: gallery.primaryId }) : null;
  }

  function requestError(status, category, message) {
    return Object.assign(new Error(message || "Cloud photo request failed"), { status, category });
  }

  function explain(error) {
    if (error?.category === "file") return error.message;
    if (error?.outcome === "abandoned") return "The earlier upload is closed and cannot be saved.";
    if (error?.category === "network") return "Cloud photos could not be reached. Check your connection and Cloudflare Access session.";
    if (error?.status === 401 || error?.category === "auth") return "Sign in to Cloudflare Access and try again.";
    if (error?.status === 403) return "You do not have permission to change this cloud gallery.";
    if (error?.status === 404) return "This cloud rabbit or photo is no longer available.";
    if (error?.status === 409) return "This gallery or rabbit changed. Reload and review the gallery before trying again.";
    if (error?.status === 413) return "The JPEG is too large for cloud upload. Choose a smaller photo.";
    if (error?.status === 415) return "The server could not validate the prepared JPEG. Try a different photo.";
    if (error?.status === 400) return "The server rejected the upload request. Reload the gallery and try again.";
    if (error?.status === 503) return "Cloud photo storage is temporarily unavailable.";
    return "The cloud photo request could not be confirmed.";
  }

  function uploadTransport(url, body, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.timeout = 60_000;
      xhr.setRequestHeader("Content-Type", "image/jpeg");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.onprogress = event => {
        if (event.lengthComputable && event.total > 0) progress(Math.min(1, event.loaded / event.total));
      };
      xhr.onload = () => resolve({ status: xhr.status, url: xhr.responseURL, text: xhr.responseText });
      const network = reason => () => reject(Object.assign(requestError(0, "network"), { networkError: reason }));
      xhr.onerror = network("transport");
      xhr.ontimeout = network("timeout");
      xhr.onabort = network("aborted");
      xhr.send(body);
    });
  }

  function parseReply(response, baseRevision) {
    if (response.url && new URL(response.url, location.origin).origin !== location.origin) {
      throw Object.assign(requestError(401, "auth"), { httpStatus: response.status || null });
    }
    if (response.status === 0) throw Object.assign(requestError(0, "network"), { networkError: "transport" });
    if (response.status !== 200) {
      const error = requestError(response.status, "http");
      try {
        const outcome = JSON.parse(response.text)?.outcome;
        if (([400, 413, 415].includes(response.status) && outcome === "rejected") ||
            (response.status === 409 && outcome === "abandoned")) error.outcome = outcome;
      } catch { /* A proxy error can be an HTML response. */ }
      throw error;
    }
    let result;
    try { result = JSON.parse(response.text); }
    catch { throw requestError(200, "malformed"); }
    const validRevision = Number.isSafeInteger(result?.revision) && result.revision >= 0;
    const validRange = baseRevision === undefined || [baseRevision, baseRevision + 1].includes(result?.revision);
    if (!validRevision || !validRange || (Object.hasOwn(result, "replayed") && result.replayed !== true) ||
        (!validGallery(result.gallery) &&
        !(baseRevision !== undefined && result.replayed === true && result.revision === baseRevision + 1))) {
      throw requestError(200, "malformed");
    }
    return result;
  }

  function createApi(scope, { fetchImpl = (...args) => fetch(...args), upload = uploadTransport } = {}) {
    async function jsonRequest(params, method) {
      let response;
      try {
        response = await fetchImpl(urlFor(scope, params), {
          method, credentials: "same-origin", cache: "no-store", redirect: "manual", headers: { Accept: "application/json" }
        });
        if (response.type !== "opaqueredirect" && ![301, 302, 303, 307, 308].includes(response.status)) {
          return { status: response.status, url: response.url, text: await response.text() };
        }
      } catch { throw Object.assign(requestError(0, "network"), { networkError: "transport" }); }
      throw Object.assign(requestError(401, "auth"), { httpStatus: response.status || null });
    }
    async function operationReceipt(params, allowed) {
      const raw = await jsonRequest(params, "POST");
      if (raw.url && new URL(raw.url, location.origin).origin !== location.origin) throw requestError(401, "auth");
      if (raw.status !== 200) throw requestError(raw.status, "http");
      let receipt;
      try { receipt = JSON.parse(raw.text); } catch { throw requestError(200, "malformed"); }
      if (!allowed.includes(receipt?.state) ||
          (receipt.state === "committed" ? !Number.isSafeInteger(receipt.committedRevision) || receipt.committedRevision < 1
            : receipt.committedRevision !== null)) throw requestError(200, "malformed");
      return receipt;
    }
    return {
      load: async () => parseReply(await jsonRequest({}, "GET")),
      reconcile: operationId => operationReceipt({ action: "reconcile", operationId }, ["reserved", "committed", "abandoned"]),
      cancel: ({ operationId, baseRevision }) =>
        operationReceipt({ action: "cancel", operationId, baseRevision }, ["committed", "abandoned"]),
      mutate: async (operation, progress = () => {}) => {
        const { jpeg, ...params } = operation;
        let raw;
        if (jpeg) {
          try { raw = await upload(urlFor(scope, params), jpeg, progress); }
          catch (error) {
            if (error?.category === "network") throw error;
            throw Object.assign(requestError(0, "network"), { networkError: "transport" });
          }
        } else {
          raw = await jsonRequest(params, "POST");
        }
        const result = parseReply(raw, params.baseRevision);
        if (jpeg ? result.revision !== params.baseRevision + 1 : result.replayed === true) {
          throw requestError(200, "malformed");
        }
        return result;
      }
    };
  }

  // Persist only recovery metadata, never the selected file or encoded JPEG.
  function createJournal(scope, getStorage = () => window.localStorage) {
    const prefix = `tw-cloud-photo-upload:v1:${JSON.stringify([scope.rabbitryId, scope.typedId])}:`;
    return {
      list() {
        const storage = getStorage();
        if (!storage) return [];
        return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(key => key?.startsWith(prefix))
          .map(key => JSON.parse(storage.getItem(key)))
          .filter(item => PHOTO_ID.test(item?.operationId || "") && Number.isSafeInteger(item.baseRevision) &&
            /^[0-9a-f]{64}$/.test(item.sha256) && ["add", "replace"].includes(item.action))
          .sort((a, b) => a.baseRevision - b.baseRevision);
      },
      save(receipt) {
        const storage = getStorage();
        if (!storage) throw requestError(0, "file", "Upload recovery storage is unavailable. No upload was sent.");
        storage.setItem(prefix + receipt.operationId, JSON.stringify(receipt));
      },
      remove(operationId) { getStorage()?.removeItem(prefix + operationId); }
    };
  }

  async function photoHash(blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function photoDimensions(width, height) {
    if (!width || !height || width * height > 40_000_000) {
      throw requestError(0, "file", "The photograph is empty or too large to process safely.");
    }
    const scale = Math.min(1, 900 / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  async function decodePhoto(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch { /* Try the browser's oriented image element decoder. */ }
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw requestError(0, "file", "This device could not decode the photograph. Try JPEG or PNG.");
    }
  }

  async function compressPhoto(file, report = () => {}) {
    if (!file.size || file.size > 20 * 1024 * 1024 || file.type === "image/svg+xml" ||
        (file.type && !file.type.startsWith("image/"))) {
      throw requestError(0, "file", "Choose an image smaller than 20 MiB.");
    }
    report({ stage: "decoding" });
    const decoded = await decodePhoto(file);
    try {
      const { width, height } = photoDimensions(decoded.width, decoded.height);
      report({ stage: "encoding", width, height });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw requestError(0, "file", "Image compression is unavailable on this device.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(decoded.image, 0, 0, width, height);
      // Canvas re-encoding writes a new JPEG without copying source EXIF or GPS metadata.
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.78));
      if (!jpeg || jpeg.type !== "image/jpeg" || !jpeg.size || jpeg.size > MAX_UPLOAD) {
        throw requestError(0, "file", "Could not create a JPEG within the upload limit.");
      }
      report({ stage: "encoded", bytes: jpeg.size });
      return jpeg;
    } finally { decoded.close(); }
  }

  function createSession(api, { compress = compressPhoto, makeId = () => crypto.randomUUID(),
    onChange = () => {}, onSnapshot = async () => {}, isCurrent = () => true,
    journal, hash = photoHash } = {}) {
    let snapshot = null;
    let busy = false;
    let message = "";
    let progress = null;
    let batch = null;
    let reloadRequired = false;
    let recovery = null;
    let diagnostic = null;
    const state = () => ({ snapshot, busy, message, progress, retry: !!batch, recovery, reloadRequired, diagnostic });
    const draw = () => { if (isCurrent()) onChange(state()); };
    const say = value => { message = value; draw(); };
    function report(data) {
      diagnostic = { ...diagnostic, ...data };
      draw();
    }
    function beginDiagnostic(operationId, file) {
      const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
      diagnostic = null;
      report({ operationId, sourceFormat: /^image\/[a-z0-9.+-]{1,40}$/.test(type) ? type : "unknown",
        encodedFormat: "image/jpeg", width: null, height: null, bytes: null,
        stage: "preparing", httpStatus: null, networkError: null, outcome: null });
    }
    async function perform(work) {
      if (busy || !isCurrent()) return false;
      busy = true;
      draw();
      try { await work(); return true; }
      finally { busy = false; progress = null; draw(); }
    }
    async function sync() {
      if (snapshot) {
        try { await onSnapshot(snapshot); }
        catch { message += " Reload the rabbit profile before editing other fields."; }
      }
    }
    function reviewJournal() {
      let recovered = 0, remaining = 0;
      for (const receipt of journal?.list() || []) {
        if (snapshot.gallery.photos.some(photo => photo.id === receipt.operationId)) {
          journal.remove(receipt.operationId);
          recovered++;
          remaining += receipt.remaining || 0;
        }
      }
      recovery = journal?.list()[0] || null;
      if (recovery && !diagnostic) beginDiagnostic(recovery.operationId);
      if (recovered) message = `${recovered} interrupted upload(s) confirmed in the gallery.` +
        (remaining ? ` Select the ${remaining} remaining photo(s) again if you still want to add them.` : "");
      if (recovery) message += " An earlier upload is unresolved. Check its status, cancel it, or reselect the same photo.";
    }
    async function load() {
      return perform(async () => {
        batch = null;
        say("Loading cloud photographs…");
        try {
          snapshot = await api.load();
          reloadRequired = false;
          message = `${snapshot.gallery.photos.length} of ${LIMIT} cloud photos`;
          reviewJournal();
          await sync();
        } catch (error) { reloadRequired = true; message = explain(error); }
      });
    }
    async function sendBatch() {
      let saved = 0;
      let attemptWasRetry = false;
      try {
        while (isCurrent() && batch.files.length) {
          attemptWasRetry = false;
          const number = batch.total - batch.files.length + 1;
          if (!batch.pending) {
            const operationId = makeId();
            beginDiagnostic(operationId, batch.files[0]);
            say(`Preparing photo ${number} of ${batch.total}…`);
            const jpeg = await compress(batch.files[0], report);
            report({ bytes: jpeg.size, stage: "encoded" });
            batch.pending = { action: batch.photoId ? "replace" : "add", baseRevision: snapshot.revision,
              ...(batch.photoId ? { photoId: batch.photoId } : {}), operationId, jpeg };
          }
          if (journal && !batch.receipt) {
            const { jpeg, ...operation } = batch.pending;
            batch.receipt = { ...operation, sha256: await hash(jpeg), remaining: batch.files.length - 1 };
          }
          if (!isCurrent()) break;
          if (batch.receipt) {
            try { journal.save(batch.receipt); }
            catch { throw requestError(0, "file", "Could not record upload recovery information. No upload was sent."); }
            if (batch.confirmedId && batch.confirmedId !== batch.receipt.operationId) {
              journal.remove(batch.confirmedId);
              batch.confirmedId = null;
            }
          }
          progress = 0;
          attemptWasRetry = !!batch.sent;
          batch.sent = true;
          report({ stage: "sending", httpStatus: null, networkError: null, outcome: null });
          say(`Uploading photo ${number} of ${batch.total}…`);
          const result = await api.mutate(batch.pending, value => {
            progress = value;
            if (value === 1) report({ stage: "awaiting-response" });
            else draw();
          });
          report({ stage: "confirmed", httpStatus: 200, outcome: "committed" });
          if (!isCurrent()) {
            // The reopened gallery will verify the receipt and report any unsent selections.
            if (!result.replayed) { snapshot = result; saved++; }
            batch = null;
            return;
          }
          // Mark the file complete immediately. A replay's follow-up GET can fail independently.
          batch.files.shift();
          batch.pending = null;
          batch.sent = false;
          saved++;
          if (result.replayed) {
            reloadRequired = true;
            snapshot = await api.load();
            reloadRequired = false;
            // A later revision may change capacity or the intended target.
            if (snapshot.revision !== result.revision && batch.files.length) {
              if (batch.receipt) journal.remove(batch.receipt.operationId);
              batch = null;
              recovery = journal?.list()[0] || null;
              say("The upload was saved. The gallery changed afterward; review it before adding more photos.");
              return;
            }
          } else {
            snapshot = result;
          }
          // Keep the last committed receipt until the next photo has its own,
          // so a close between requests still reports any unsent selections.
          batch.confirmedId = batch.receipt?.operationId;
          batch.receipt = null;
          progress = null;
        }
        if (!isCurrent()) { batch = null; return; }
        if (batch.confirmedId) journal.remove(batch.confirmedId);
        batch = null;
        recovery = journal?.list()[0] || null;
        say("Cloud photographs saved.");
      } catch (error) {
        const rejected = error?.outcome === "rejected" && !attemptWasRetry;
        const abandoned = error?.outcome === "abandoned";
        const uncertain = !rejected && !abandoned && !!batch?.pending && !!batch.sent;
        if ((rejected || abandoned) && batch?.receipt) journal.remove(batch.receipt.operationId);
        if (diagnostic && diagnostic.outcome !== "committed") {
          const networkError = error?.category === "network"
            ? (["transport", "timeout", "aborted"].includes(error.networkError) ? error.networkError : "transport") : null;
          report({ httpStatus: error?.httpStatus ?? (error?.status || null), networkError,
            outcome: abandoned ? "abandoned" : rejected ? "rejected" : uncertain ? "uncertain" : "not-sent" });
        }
        const retry = uncertain && !reloadRequired &&
          (["network", "malformed", "auth"].includes(error?.category) || error?.status === 401 || error?.status >= 500);
        if (!retry) {
          if (isCurrent() && batch?.confirmedId) journal.remove(batch.confirmedId);
          batch = null;
          recovery = journal?.list()[0] || null;
          if (error?.status === 409) reloadRequired = true;
        }
        const guidance = retry ? " Retry with the same photo or cancel the pending upload."
          : uncertain ? " The earlier delivery is unconfirmed. Check its status or cancel it." : "";
        say(`${saved ? `${saved} saved. ` : ""}${explain(error)}${guidance}`);
      } finally { if (saved) await sync(); }
    }
    function uploadFiles(files, photoId = null) {
      if (busy || batch || recovery || reloadRequired || !snapshot || !isCurrent()) return Promise.resolve(false);
      if (journal?.list().length) {
        reviewJournal();
        draw();
        return Promise.resolve(false);
      }
      const list = Array.from(files);
      if (!list.length) return Promise.resolve(false);
      if (photoId ? list.length !== 1 || !snapshot.gallery.photos.some(photo => photo.id === photoId)
        : list.length + snapshot.gallery.photos.length > LIMIT) {
        say(photoId ? "Choose one replacement for an existing photograph." : "A rabbit can have at most 10 photos.");
        return Promise.resolve(false);
      }
      batch = { files: list, total: list.length, photoId, pending: null };
      return perform(sendBatch);
    }
    function change(action, photoId) {
      if (batch || recovery || reloadRequired || !snapshot || !["remove", "primary"].includes(action) ||
          !snapshot.gallery.photos.some(photo => photo.id === photoId)) return Promise.resolve(false);
      if (journal?.list().length) {
        reviewJournal();
        draw();
        return Promise.resolve(false);
      }
      return perform(async () => {
        say(action === "remove" ? "Removing cloud photograph…" : "Saving primary photograph…");
        try {
          snapshot = await api.mutate({ action, photoId, baseRevision: snapshot.revision });
          message = action === "remove" ? "Photograph removed from the gallery." : "Primary photograph saved.";
          await sync();
        } catch (error) {
          if (error.status === 409 || !error.status || error.status >= 500 || error.category === "malformed") reloadRequired = true;
          say(explain(error) + (reloadRequired && error.status !== 409 ? " Reload the gallery to check the result." : ""));
        }
      });
    }
    function checkRecovery() {
      if (!recovery || batch) return Promise.resolve(false);
      return perform(async () => {
        const receipt = recovery;
        try {
          snapshot = await api.load();
          const present = snapshot.gallery.photos.some(photo => photo.id === receipt.operationId);
          let outcome = present ? "committed" : null;
          if (!outcome) {
            try { outcome = (await api.reconcile(receipt.operationId)).state; }
            catch (error) {
              if (error.status !== 404) throw error;
              if (snapshot.revision > receipt.baseRevision) outcome = "superseded";
            }
          }
          reloadRequired = false;
          if (["committed", "abandoned", "superseded"].includes(outcome)) {
            journal.remove(receipt.operationId);
            message = outcome === "committed" ? "The earlier upload was saved." : "The earlier upload did not commit.";
            if (receipt.remaining) message += " Other selected photos were not sent. Select them again if needed.";
            reviewJournal();
          } else {
            message = "The earlier upload is still unresolved. Cancel it or reselect the same photo to retry safely.";
          }
          await sync();
        } catch (error) { say(explain(error)); }
      });
    }
    function cancelRecovery() {
      const pending = batch?.receipt || recovery;
      if (!pending) return Promise.resolve(false);
      return perform(async () => {
        say("Checking whether the pending upload can be canceled…");
        try {
          const receipt = await api.cancel(pending);
          if (receipt.state === "committed" && receipt.committedRevision !== pending.baseRevision + 1) {
            throw requestError(200, "malformed");
          }
          journal.remove(pending.operationId);
          batch = null;
          recovery = journal.list()[0] || null;
          reloadRequired = true;
          const committed = receipt.state === "committed";
          const result = committed ? "The photo was already saved and has been kept."
            : "Pending upload canceled. You can choose another photo.";
          message = result + (pending.remaining ? " Other selected photos were not sent." : "");
          try {
            snapshot = await api.load();
            reloadRequired = false;
            reviewJournal();
            await sync();
          } catch { message += " Reload the gallery to see its current photos."; }
        } catch (error) {
          say(`${explain(error)} Cancellation was not confirmed. Check the status or try canceling again.`);
        }
      });
    }
    function recoverFile(file) {
      if (!recovery || batch || !snapshot) return Promise.resolve(false);
      return perform(async () => {
        const receipt = recovery;
        try {
          say("Checking the selected photograph against the earlier upload…");
          beginDiagnostic(receipt.operationId, file);
          const jpeg = await compress(file, report);
          report({ bytes: jpeg.size, stage: "encoded" });
          if (await hash(jpeg) !== receipt.sha256) {
            say("This photo does not match the earlier upload. Choose the same original or check its status.");
            return;
          }
          if (!isCurrent()) return;
          const { sha256, remaining, ...operation } = receipt;
          batch = { files: [file], total: 1, pending: { ...operation, jpeg }, receipt, sent: true };
          reloadRequired = false;
          await sendBatch();
          if (!batch && !recovery && remaining) say(message + " Select any remaining photos again.");
        } catch (error) { say(explain(error)); }
      });
    }
    return { getState: state, load, uploadFiles, change,
      checkRecovery, cancelRecovery, recoverFile, retry: () => batch?.pending ? perform(sendBatch) : Promise.resolve(false) };
  }

  window.twCloudRabbitPhotos = { createApi, createJournal, createSession, primaryPhotoUrl, photoDimensions, compressPhoto, mount };

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(text, click) {
    const element = node("button", text);
    element.type = "button";
    element.onclick = click;
    return element;
  }

  function fileControl(text, { capture, multiple, change }) {
    const label = node("label", text, "tw-cloud-photo-picker");
    const input = node("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = !!multiple;
    if (capture) input.setAttribute("capture", "environment");
    input.onchange = () => {
      const files = Array.from(input.files);
      input.value = "";
      if (files.length) change(files);
    };
    label.append(input);
    return { label, input };
  }

  function photograph(scope, id, alt, className) {
    const image = node("img", null, className);
    image.alt = alt;
    image.onerror = () => image.replaceWith(node("span", "Photo unavailable", "muted"));
    image.src = urlFor(scope, { photoId: id });
    return image;
  }

  function openViewer(panel, scope, photos, index, trigger) {
    const dialog = node("dialog", null, "tw-cloud-photo-dialog");
    const imageSlot = node("div", null, "tw-cloud-photo-view-image");
    const caption = node("p", null, "muted");
    const controls = node("div", null, "tw-cloud-photo-actions");
    const close = button("Close", () => dialog.close());
    const step = delta => { index = (index + delta + photos.length) % photos.length; update(); };
    const previous = button("Previous", () => step(-1));
    const next = button("Next", () => step(1));
    previous.disabled = next.disabled = photos.length < 2;
    function update() {
      caption.textContent = `Photo ${index + 1} of ${photos.length}`;
      imageSlot.replaceChildren(photograph(scope, photos[index].id, caption.textContent));
    }
    dialog.setAttribute("aria-label", "Cloud photograph viewer");
    dialog.addEventListener("keydown", event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        step(event.key === "ArrowRight" ? 1 : -1);
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (trigger.isConnected) trigger.focus();
    });
    controls.append(previous, next, close);
    dialog.append(imageSlot, caption, controls);
    panel.append(dialog);
    update();
    dialog.showModal();
    close.focus();
  }

  function mount(panel, entry, { onSnapshot, onBusy = () => {} } = {}) {
    const scope = entry.metadata;
    const heading = node("h3", "Cloud photographs");
    const status = node("p", "", "tw-gallery-status");
    status.setAttribute("role", "status");
    const progress = node("progress");
    progress.setAttribute("aria-label", "Photo upload progress");
    progress.max = 1;
    const hero = node("div");
    const grid = node("div", null, "tw-gallery-grid");
    const controls = node("div", null, "tw-cloud-photo-actions");
    const take = fileControl("Take photo", { capture: true, change: files => session.uploadFiles(files) });
    const choose = fileControl("Choose photos", { multiple: true, change: files => session.uploadFiles(files) });
    const retry = button("Retry upload", () => session.retry());
    const check = button("Check prior upload", () => session.checkRecovery());
    const cancel = button("Cancel pending upload", () => {
      if (window.confirm("Cancel this unresolved upload? A photo that was already saved will be kept.")) {
        session.cancelRecovery();
      }
    });
    const recover = fileControl("Reselect original photo", { change: files => session.recoverFile(files[0]) });
    const reload = button("Reload gallery", () => {
      if (!session.getState().retry || window.confirm("Reload and keep the pending upload receipt? You may need to reselect the original photo.")) session.load();
    });
    controls.append(take.label, choose.label, retry, check, cancel, recover.label, reload);
    const diagnostics = node("details");
    const report = node("pre");
    report.style.whiteSpace = "pre-wrap";
    report.style.overflowWrap = "anywhere";
    diagnostics.append(node("summary", "Upload diagnostics"), report);
    panel.className = "tw-gallery tw-cloud-photo-gallery";
    panel.append(heading, status, progress, hero, controls, diagnostics, grid);
    let renderedGallery;
    let lastBusy = false;
    const session = createSession(createApi(scope), {
      onSnapshot, journal: createJournal(scope), isCurrent: () => panel.isConnected, onChange: draw
    });
    function draw(state) {
      const gallery = state.snapshot?.gallery;
      const disabled = state.busy || state.reloadRequired || state.retry || state.recovery || !gallery;
      if (lastBusy !== state.busy) { lastBusy = state.busy; onBusy(state.busy); }
      status.textContent = state.message;
      progress.hidden = state.progress === null;
      if (!progress.hidden) progress.value = state.progress;
      retry.hidden = !state.retry;
      retry.disabled = state.busy;
      cancel.hidden = !state.recovery && !state.retry;
      cancel.disabled = state.busy;
      check.hidden = recover.label.hidden = !state.recovery || state.retry;
      check.disabled = recover.input.disabled = state.busy;
      reload.disabled = state.busy;
      diagnostics.hidden = !state.diagnostic;
      if (state.diagnostic) report.textContent = JSON.stringify(state.diagnostic, null, 2);
      take.input.disabled = choose.input.disabled = disabled || gallery.photos.length >= LIMIT;
      if (renderedGallery !== gallery && gallery) {
        renderedGallery = gallery;
        hero.replaceChildren();
        grid.replaceChildren();
        const { photos, primaryId } = gallery;
        if (primaryId) hero.append(photograph(scope, primaryId, "Primary rabbit photograph", "tw-gallery-main"));
        photos.forEach((photo, index) => {
          const tile = node("div", null, "tw-gallery-tile");
          const view = button(`View photo ${index + 1}`, () => openViewer(panel, scope, photos, index, view));
          view.className = "tw-cloud-photo-thumb";
          view.append(photograph(scope, photo.id, ""));
          const replace = fileControl("Replace", { change: files => session.uploadFiles(files, photo.id) });
          const remove = button("Remove", () => {
            if (window.confirm("Remove this photograph from the current gallery?")) session.change("remove", photo.id);
          });
          tile.append(view, photo.id === primaryId ? node("p", "Primary")
            : button("Make primary", () => session.change("primary", photo.id)), replace.label, remove);
          grid.append(tile);
        });
      }
      for (const control of grid.querySelectorAll("button:not(.tw-cloud-photo-thumb), input")) control.disabled = disabled;
    }
    draw(session.getState());
    session.load();
    return session;
  }
})();
