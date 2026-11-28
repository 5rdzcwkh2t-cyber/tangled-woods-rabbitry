import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("application shell contains the critical local-first features", async () => {
  const html = await read("index.html");

  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<script src="seed\.js"><\/script>/);
  assert.match(html, /<script src="local-backup-format\.js"><\/script>/);
  assert.match(html, /<script src="cloud-backup-ui\.js"><\/script>/);
  assert.match(html, /<script src="rabbit-management-controller\.js"><\/script>/);
  assert.match(html, /<script src="cloud-rabbit-source\.js"><\/script>/);
  assert.match(html, /<script src="cloud-rabbit-photo-gallery\.js"><\/script>\s*<script src="cloud-rabbit-source\.js"><\/script>/);
  assert.match(html, /<script src="versioned-breeding-cloud-client\.js"><\/script>/);
  assert.match(html, /<script src="cloud-breeding-source\.js"><\/script>/);
  assert.match(html, /<script src="versioned-litter-cloud-client\.js"><\/script>/);
  assert.match(html, /<script src="cloud-litter-source\.js"><\/script>/);
  assert.ok(
    html.indexOf('<script src="rabbit-management-controller.js"></script>') <
      html.indexOf('<script src="cloud-rabbit-source.js"></script>'),
    "rabbit management controller must load before the cloud adapter"
  );
  assert.ok(
    html.indexOf('<script src="versioned-breeding-cloud-client.js"></script>') <
      html.indexOf('<script src="cloud-breeding-source.js"></script>'),
    "versioned breeding client must load before the breeding adapter"
  );
  assert.match(html, /\.tabs\{flex-wrap:wrap;overflow:visible/);
  assert.match(html, /@media\(min-width:1024px\)/);
  assert.match(html, /@media\(max-width:600px\)/);
  assert.match(html, /const KEY='tangledwoods-data-v2'/);
  assert.match(html, /localStorage\.getItem\(KEY\)/);
  assert.match(html, /indexedDB\.open/);
  assert.match(html, /Edit \$\{type==='rabbits'\?'Rabbit':'Litter'\}/);
  assert.match(html, /\['\+ Add','Edit','Edit Rabbit','Delete'/);
  assert.match(html, /<h3>Verify a backup<\/h3>/);
  assert.match(html, /id="twBackupVerifyFile"/);
  assert.match(html, /serviceWorker\.register\('\.\/sw\.js'\)/);

  for (const section of [
    "Home",
    "Rabbits",
    "Litters",
    "Breeding",
    "Pedigrees",
    "Import",
    "Backup",
    "Financials"
  ]) {
    assert.ok(html.includes(`'${section}'`), `missing ${section} application section`);
  }
});

test("PWA manifest references the current application and available icons", async () => {
  const manifest = JSON.parse(await read("manifest.webmanifest"));

  assert.equal(manifest.name, "Tangled Woods Rabbitry Manager");
  assert.equal(manifest.start_url, "./index.html");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(
    manifest.icons.map((icon) => icon.src),
    ["icon-192.png", "icon-512.png"]
  );

  await Promise.all(manifest.icons.map((icon) => read(icon.src)));
});

test("service worker caches the application shell", async () => {
  const worker = await read("sw.js");

  for (const asset of [
    "./index.html",
    "./seed.js",
    "./local-backup-format.js",
    "./cloud-backup-ui.js",
    "./rabbit-management-controller.js",
    "./cloud-rabbit-source.js",
    "./cloud-rabbit-photo-gallery.js",
    "./versioned-breeding-cloud-client.js",
    "./cloud-breeding-source.js",
    "./versioned-litter-cloud-client.js",
    "./cloud-litter-source.js",
    "./manifest.webmanifest",
    "./icon-192.png",
    "./icon-512.png"
  ]) {
    assert.ok(worker.includes(`'${asset}'`), `service worker does not cache ${asset}`);
  }
  assert.match(worker, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /v4e6e-safari-jpeg-marker-details/);
});

