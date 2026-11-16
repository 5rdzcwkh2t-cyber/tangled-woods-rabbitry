(function () {
  "use strict";

  const API = "/api/test-backup";
  const API_LIMIT_BYTES = 1_800_000;
  const DEVICE_KEY = "tangled-woods-cloud-device-id";

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "Unknown size";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatDate(value) {
    if (!value) return "Unknown date";
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function deviceId() {
    try {
      let value = localStorage.getItem(DEVICE_KEY);
      if (!value) {
        value = `browser-${crypto.randomUUID()}`;
        localStorage.setItem(DEVICE_KEY, value);
      }
      return value;
    } catch {
      return "browser-unavailable-storage";
    }
  }

  function readPhotos() {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("tangledwoods-rabbit-photos", 1);
      open.onerror = () => reject(open.error || new Error("Photo storage could not be opened."));
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains("photos")) {
          open.result.createObjectStore("photos");
        }
      };
      open.onsuccess = () => {
        const database = open.result;
        const photos = {};
        const transaction = database.transaction("photos", "readonly");
        const cursor = transaction.objectStore("photos").openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) {
            photos[String(item.key)] = item.value;
            item.continue();
          }
        };
        transaction.oncomplete = () => { database.close(); resolve(photos); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
  }

  async function completeBackup() {
    const photos = await readPhotos();
    return {
      ...db,
      photos,
      photoBackupVersion: 1,
      exportedAt: new Date().toISOString()
    };
  }

  async function apiRequest(url, options = {}) {
    let response;
    try {
      response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json", ...(options.headers || {}) },
        ...options
      });
    } catch {
      throw new Error("Could not connect to cloud backups. Check your internet connection and try again.");
    }
    let body = null;
    try { body = await response.json(); } catch { /* Generic error below. */ }
    if (!response.ok) {
      const error = new Error(body?.error || `Cloud backup request failed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function downloadJson(data, id) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = `tangled-woods-cloud-backup-${id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function localFallback(container, message) {
    container.replaceChildren(element("p", message));
    const button = element("button", "Download complete local backup instead", "primary");
    button.type = "button";
    button.addEventListener("click", () => document.getElementById("twPhotoBackupButton")?.click());
    container.append(button);
  }

  function friendlyError(error) {
    if (error?.status === 401) return "Cloud Backup is unavailable because you are not signed in through Cloudflare Access.";
    if (error?.status === 403) return "Cloud Backup is not available in this environment.";
    if (error?.status === 413) return "This complete backup is too large for cloud backup storage.";
    if (error?.status === 503) return "Cloud authentication is temporarily unavailable. Try again later.";
    return error?.message || "Cloud backup could not be completed.";
  }

  async function activate(section) {
    const gate = section.querySelector("[data-cloud-gate]");
    const controls = section.querySelector("[data-cloud-controls]");
    const history = section.querySelector("[data-cloud-history]");
    const status = section.querySelector("[data-cloud-status]");
    const createButton = section.querySelector("[data-cloud-create]");
    const fallback = section.querySelector("[data-cloud-fallback]");

    async function refresh() {
      history.replaceChildren(element("p", "Loading cloud backup history…", "muted"));
      try {
        const result = await apiRequest(API);
        const backups = Array.isArray(result.backups) ? result.backups : [];
        history.replaceChildren();
        if (!backups.length) {
          history.append(element("p", "No cloud backups yet.", "muted"));
          return;
        }
        for (const backup of backups) {
          const row = element("div", undefined, "card");
          row.style.margin = "8px 0";
          const title = element("strong", formatDate(backup.createdAt));
          const details = element(
            "p",
            `${formatBytes(backup.byteSize)} · ${backup.deviceId || "Unknown device"} · Format ${backup.formatVersion}`,
            "muted"
          );
          const download = element("button", "Download JSON");
          download.type = "button";
          download.addEventListener("click", async () => {
            download.disabled = true;
            status.textContent = "Downloading the selected cloud backup…";
            try {
              const result = await apiRequest(`${API}?id=${encodeURIComponent(backup.id)}`);
              downloadJson(result.backup.data, backup.id);
              status.textContent = "Cloud backup downloaded. No local records were changed.";
            } catch (error) {
              status.textContent = friendlyError(error);
            } finally {
              download.disabled = false;
            }
          });
          row.append(title, details, download);
          history.append(row);
        }
      } catch (error) {
        history.replaceChildren(element("p", friendlyError(error), "muted"));
      }
    }

    createButton.addEventListener("click", async () => {
      createButton.disabled = true;
      fallback.replaceChildren();
      status.textContent = "Collecting local records and photographs…";
      try {
        const backup = await completeBackup();
        const requestBody = JSON.stringify({ deviceId: deviceId(), backup });
        const requestBytes = new TextEncoder().encode(requestBody).byteLength;
        status.textContent = `Prepared ${formatBytes(requestBytes)}. ${
          requestBytes > API_LIMIT_BYTES
            ? "It exceeds the cloud limit and has not been uploaded."
            : "Uploading securely… Browser upload progress is not available."
        }`;
        if (requestBytes > API_LIMIT_BYTES) {
          localFallback(
            fallback,
            "The complete backup exceeds the 1.8 MB cloud limit. Photographs were not omitted. Save the complete local backup instead."
          );
          return;
        }
        const result = await apiRequest(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody
        });
        status.textContent = result.retentionApplied === false
          ? "Cloud backup saved, but older-backup cleanup will be retried later."
          : "Cloud backup saved successfully. Local records were not changed.";
        await refresh();
      } catch (error) {
        status.textContent = friendlyError(error);
        if (error?.status === 413) {
          localFallback(
            fallback,
            "The server rejected this complete backup as too large. Photographs were not omitted. Save the complete local backup instead."
          );
        }
      } finally {
        createButton.disabled = false;
      }
    });

    try {
      const result = await apiRequest(API);
      gate.remove();
      controls.hidden = false;
      const backups = Array.isArray(result.backups) ? result.backups : [];
      history.replaceChildren();
      if (!backups.length) history.append(element("p", "No cloud backups yet.", "muted"));
      else await refresh();
    } catch (error) {
      gate.textContent = friendlyError(error);
      controls.remove();
    }
  }

  function enhanceCloudBackup() {
    if (typeof page === "undefined" || page !== "Backup") return;
    const view = document.getElementById("view");
    if (!view || view.querySelector("#twCloudBackupSection")) return;
    const section = element("section", undefined, "card");
    section.id = "twCloudBackupSection";
    section.innerHTML = `
      <h3>Cloud Backup</h3>
      <p>Manually save a complete, private backup for this signed-in Cloudflare Access account.</p>
      <p class="muted" data-cloud-gate role="status" aria-live="polite">Checking secure cloud access…</p>
      <div data-cloud-controls hidden>
        <button type="button" class="primary" data-cloud-create>Create cloud backup now</button>
        <p class="muted" data-cloud-status role="status" aria-live="polite">Cloud backups never restore or replace local records.</p>
        <div data-cloud-fallback></div>
        <h4>Cloud backup history</h4>
        <div data-cloud-history></div>
      </div>`;
    view.append(section);
    activate(section);
  }

  const previousRender = window.render;
  if (typeof previousRender === "function") {
    window.render = function () {
      const result = previousRender.apply(this, arguments);
      enhanceCloudBackup();
      return result;
    };
  }
  window.twCloudBackupUI = { formatBytes, formatDate, apiLimitBytes: API_LIMIT_BYTES };
  enhanceCloudBackup();
})();
