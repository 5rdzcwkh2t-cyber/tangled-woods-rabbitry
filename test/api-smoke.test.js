import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { authenticatedEnv, getTestAuth } from "./support/access-test-auth.js";

const apiDirectory = new URL("../functions/api/", import.meta.url);

test("every API module loads and exports a request handler", async () => {
  const files = (await readdir(apiDirectory)).filter((name) => name.endsWith(".js"));
  assert.ok(files.length > 0);

  for (const file of files) {
    const module = await import(new URL(file, apiDirectory));
    const handlers = Object.entries(module).filter(
      ([name, value]) => name.startsWith("onRequest") && typeof value === "function"
    );
    assert.ok(handlers.length > 0, `${file} does not export a request handler`);
  }
});

test("health endpoint reports mocked D1 record counts", async () => {
  const { onRequestGet } = await import("../functions/api/health.js");
  const totals = [730, 288];
  const env = await authenticatedEnv({
    DB: {
      prepare() {
        return { first: async () => ({ total: totals.shift() }) };
      }
    }
  });
  const token = (await getTestAuth()).validToken;

  const response = await onRequestGet({
    request: new Request("https://rabbitry.example/api/health", {
      headers: { "Cf-Access-Jwt-Assertion": token }
    }),
    env
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "Database connected",
    rabbits: 730,
    litters: 288
  });
});

test("rabbit read endpoint converts D1 JSON rows into records", async () => {
  const { onRequestGet } = await import("../functions/api/rabbits.js");
  const rabbit = { _id: "r-1", Name: "Maple", Sex: "Doe" };
  const env = await authenticatedEnv({
    DB: {
      prepare() {
        return { all: async () => ({ results: [{ data: JSON.stringify(rabbit) }] }) };
      }
    }
  });
  const token = (await getTestAuth()).validToken;

  const response = await onRequestGet({
    request: new Request("https://rabbitry.example/api/rabbits", {
      headers: { "Cf-Access-Jwt-Assertion": token }
    }),
    env
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { rabbits: [rabbit] });
});

test("backup endpoint refuses a non-test environment before database access", async () => {
  const { onRequestPost } = await import("../functions/api/test-backup.js");
  const token = (await getTestAuth()).validToken;
  const request = new Request("https://rabbitry.example/api/test-backup", {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      Origin: "https://rabbitry.example"
    }
  });

  const response = await onRequestPost({
    request,
    env: await authenticatedEnv({ TEST_DATABASE: "production", DB: null })
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Test environment not configured" });
});

test("backup endpoint requires Cloudflare Access authentication", async () => {
  const { onRequestPost } = await import("../functions/api/test-backup.js");
  const request = new Request("https://rabbitry.example/api/test-backup", {
    method: "POST",
    headers: { Origin: "https://rabbitry.example" }
  });

  const response = await onRequestPost({
    request,
    env: await authenticatedEnv({ TEST_DATABASE: "tangled-woods-dev-v2", DB: null })
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
});

test("cloud backup endpoint exports authenticated create and retrieval handlers", async () => {
  const module = await import("../functions/api/test-backup.js");
  assert.equal(typeof module.onRequestPost, "function");
  assert.equal(typeof module.onRequestGet, "function");
});

