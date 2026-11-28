import assert from "node:assert/strict";
import test from "node:test";
import { inspectJpeg, readPhotoBytes } from "../functions/api/_shared/photo-jpeg.js";

function segment(marker, payload) {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

// One 8x8 grayscale block. The DC category-zero and AC end-of-block
// Huffman symbols both use a single zero bit. Unused scan bits are ones.
function jpeg({ frame = 0xc0, height = 8, metadata = [], scans } = {}) {
  const table = [1, ...Array(15).fill(0), 0];
  return Uint8Array.from([
    0xff, 0xd8, ...metadata,
    ...segment(0xdb, [0, ...Array(64).fill(1)]),
    ...segment(frame, [8, 0, height, 0, 8, 1, 1, 0x11, 0]),
    ...segment(0xc4, [0, ...table, 0x10, ...table]),
    ...(scans ?? [...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x3f]),
    0xff, 0xd9
  ]);
}

const dimensions = { width: 8, height: 8 };
const rejected = (bytes, code = "jpeg_marker") => assert.throws(() => inspectJpeg(bytes), { status: 415, code });

test("JPEG inspector accepts baseline JFIF and multiple progressive scans", () => {
  const jfif = segment(0xe0, [74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  assert.deepEqual(inspectJpeg(jpeg({ metadata: jfif })), dimensions);
  assert.deepEqual(inspectJpeg(jpeg({
    frame: 0xc2,
    scans: [
      ...segment(0xda, [1, 1, 0, 0, 0, 0]), 0x7f,
      ...segment(0xda, [1, 1, 0, 1, 63, 0]), 0x7f
    ]
  })), dimensions);
});

test("JPEG inspector documents the current SOF1 and DNL compatibility limits", () => {
  rejected(jpeg({ frame: 0xc1 }), "jpeg_frame");
  rejected(jpeg({
    height: 0,
    scans: [...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x3f, ...segment(0xdc, [0, 8])]
  }), "jpeg_dimension");
});

test("JPEG inspector rejects APP1, comments, unknown APP segments and trailing bytes", () => {
  for (const marker of [0xe1, 0xed, 0xef, 0xfe]) {
    rejected(jpeg({ metadata: segment(marker, [65, 0]) }));
  }
  rejected(Uint8Array.from([...jpeg(), 0]), "jpeg_eoi");
  rejected(jpeg().subarray(0, -1), "jpeg_eoi");
});

test("photo body requires an explicit unparameterized JPEG media type independently of bytes", async () => {
  const bytes = jpeg();
  const request = type => new Request("https://photos.test", {
    method: "POST", body: bytes, headers: type ? { "Content-Type": type } : {}
  });
  assert.deepEqual(await readPhotoBytes(request("IMAGE/JPEG")), bytes);
  for (const type of [null, "image/jpg", "image/jpeg; charset=binary", "image/png"]) {
    await assert.rejects(readPhotoBytes(request(type)), { status: 415, code: "jpeg_mime" });
  }
  const mislabeled = new Request("https://photos.test", {
    method: "POST", body: "not JPEG", headers: { "Content-Type": "image/jpeg" }
  });
  rejected(await readPhotoBytes(mislabeled));
});

test("JPEG inspector distinguishes table and scan failures", () => {
  const shortTable = jpeg();
  shortTable[5] = 2;
  rejected(shortTable, "jpeg_table");
  rejected(jpeg({ scans: [...segment(0xda, [0, 1, 0, 0, 63, 0]), 0x3f] }), "jpeg_scan");
});

test("JPEG marker diagnostics distinguish every rejection branch without segment contents", () => {
  const cases = [
    [[0x01, 0x02], { reason: "missing_soi" }],
    [[0xff, 0xd8, 0x41], { reason: "missing_marker_prefix" }],
    [[0xff, 0xd8, 0xff, 0xff], { reason: "missing_marker_code" }],
    [[0xff, 0xd8, 0xff, 0xe1, 0], { reason: "truncated_segment_length", marker: "FFE1" }],
    [[0xff, 0xd8, 0xff, 0xe1, 0, 1], { reason: "invalid_segment_length", marker: "FFE1" }],
    [[0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x41], { reason: "segment_past_end", marker: "FFE1" }],
    [jpeg({ metadata: segment(0xfe, [0x41, 0x42]) }), { reason: "disallowed_marker", marker: "FFFE" }]
  ];
  for (const [bytes, detail] of cases) {
    assert.throws(() => inspectJpeg(Uint8Array.from(bytes)), error => {
      assert.equal(error.status, 415);
      assert.equal(error.code, "jpeg_marker");
      assert.deepEqual(error.detail, detail);
      return true;
    });
  }
});
