import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../local-backup-format.js", import.meta.url);

async function format() {
  const source = await readFile(sourceUrl, "utf8");
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "local-backup-format.js" });
  return context.twLocalBackupFormat;
}

function completeBackup(overrides = {}) {
  return {
    rabbits: [{ _id: "r-1", Name: "Maple", kitPayments: [{ amountCents: 2500 }] }],
    litters: [{ _id: "l-1", kits: [{ rabbitId: "r-1" }] }],
    breedings: [{ _id: "b-1", doeId: "r-1" }],
    parentLinks: { "r-1|Father": { kind: "text", label: "Clover" } },
    expenses: [{ id: "exp-1", amountCents: 1299 }],
    photos: {
      "r-1": "data:image/png;base64,aGVsbG8=",
      "gallery:r-1": JSON.stringify(["data:image/jpeg;base64,aGVsbG8="])
    },
    photoBackupVersion: 1,
    exportedAt: "2026-11-16T12:00:00.000Z",
    ...overrides
  };
}

test("complete restore preserves every supported record collection and photos", async () => {
  const helper = await format();
  const backup = completeBackup();
  const candidate = helper.prepareRestoreCandidate(backup);

  assert.deepEqual(JSON.parse(JSON.stringify(candidate.records)), {
    rabbits: backup.rabbits,
    litters: backup.litters,
    breedings: backup.breedings,
    parentLinks: backup.parentLinks,
    expenses: backup.expenses
  });
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.photos)), backup.photos);
  assert.equal(helper.photoCount(candidate.photos), 2);
});

test("older backups default optional supported collections without changing photos", async () => {
  const helper = await format();
  const candidate = helper.prepareRestoreCandidate({ rabbits: [], litters: [] });

  assert.deepEqual(JSON.parse(JSON.stringify(candidate.records)), {
    rabbits: [], litters: [], breedings: [], parentLinks: {}, expenses: []
  });
  assert.equal(candidate.photos, undefined);
});

test("restore validation rejects unknown or malformed data instead of discarding it", async () => {
  const helper = await format();

  assert.throws(
    () => helper.prepareRestoreCandidate(completeBackup({ customers: [] })),
    /Unsupported backup data: customers/
  );
  assert.throws(
    () => helper.prepareRestoreCandidate(completeBackup({ expenses: "lost" })),
    /Expenses must be an array of records/
  );
  assert.throws(
    () => helper.prepareRestoreCandidate(completeBackup({ photos: { "r-1": "invalid" } })),
    /Photographs are invalid/
  );
});
