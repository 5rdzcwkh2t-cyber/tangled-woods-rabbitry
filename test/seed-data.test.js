import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("seed data provides usable rabbit and litter collections", async () => {
  const source = await readFile(new URL("../seed.js", import.meta.url), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context, { filename: "seed.js" });

  const seed = context.window.SEED;
  assert.ok(seed && typeof seed === "object");
  assert.ok(Array.isArray(seed.rabbits));
  assert.ok(Array.isArray(seed.litters));
  assert.ok(seed.rabbits.length > 0);

  const ids = seed.rabbits.map((rabbit) => rabbit._id);
  assert.equal(new Set(ids).size, ids.length, "rabbit IDs must be unique");

  for (const rabbit of seed.rabbits) {
    assert.equal(typeof rabbit._id, "string");
    assert.ok(rabbit._id.length > 0);
    assert.equal(typeof rabbit.Name, "string");
    assert.ok(rabbit.Name.trim().length > 0);
  }
});

