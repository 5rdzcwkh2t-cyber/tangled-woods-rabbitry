import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const uiUrl = new URL("../cloud-backup-ui.js", import.meta.url);

test("cloud backup browser enhancement loads without changing non-backup pages", async () => {
  const source = await readFile(uiUrl, "utf8");
  const context = {
    window: {},
    page: "Home",
    document: {},
    console,
    TextEncoder,
    URL,
    Blob,
    setTimeout
  };

  vm.runInNewContext(source, context, { filename: "cloud-backup-ui.js" });
  assert.equal(context.window.twCloudBackupUI.apiLimitBytes, 1_800_000);
  assert.equal(context.window.twCloudBackupUI.formatBytes(1024), "1.0 KB");
  assert.equal(context.window.twCloudBackupUI.formatBytes(1_800_000), "1.72 MB");
});

test("cloud backup UI preserves complete photos and exposes download-only history", async () => {
  const [source, html] = await Promise.all([
    readFile(uiUrl, "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8")
  ]);

  assert.match(html, /<script src="cloud-backup-ui\.js"><\/script>/);
  assert.match(source, /indexedDB\.open\("tangledwoods-rabbit-photos", 1\)/);
  assert.match(source, /photoBackupVersion: 1/);
  assert.match(source, /Create cloud backup now/);
  assert.match(source, /Cloud backup history/);
  assert.match(source, /Download JSON/);
  assert.match(source, /Photographs were not omitted/);
  assert.match(source, /twPhotoBackupButton/);
  assert.doesNotMatch(source, /localStorage\.setItem\(KEY/);
  assert.doesNotMatch(source, /restoreFull\s*\(/);
});
