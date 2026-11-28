export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 2048;
const MAX_PIXELS = 4_000_000;

export class PhotoInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function readPhotoBytes(request) {
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > MAX_PHOTO_BYTES) throw new PhotoInputError("Photo exceeds byte limit", 413);
  if (request.headers.get("Content-Type")?.toLowerCase() !== "image/jpeg" || !request.body) {
    throw new PhotoInputError("A normalized JPEG body is required", 415);
  }
  const reader = request.body.getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_PHOTO_BYTES) {
        await reader.cancel().catch(() => {});
        throw new PhotoInputError("Photo exceeds byte limit", 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// Validate container structure and dimensions without decoding pixels at the edge.
export function inspectJpeg(bytes) {
  const invalid = () => { throw new PhotoInputError("Invalid or unsupported normalized JPEG", 415); };
  const word = i => (bytes[i] << 8) | bytes[i + 1];
  if (word(0) !== 0xffd8) invalid();
  let offset = 2;
  let dimensions;
  let components = 0;
  let scanned = false;
  let quantization = false;
  let huffman = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!scanned || offset !== bytes.length) invalid();
      return dimensions;
    }
    if (offset + 2 > bytes.length) invalid();
    const size = word(offset);
    const end = offset + size;
    if (size < 2 || end > bytes.length) invalid();
    if (marker === 0xc0 || marker === 0xc2) {
      if (dimensions || size < 11 || bytes[offset + 2] !== 8) invalid();
      const height = word(offset + 3);
      const width = word(offset + 5);
      components = bytes[offset + 7];
      if (![1, 3].includes(components) || size !== 8 + 3 * components ||
          !width || !height || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) invalid();
      dimensions = { width, height };
    } else if (marker === 0xda) {
      const count = bytes[offset + 2];
      if (!dimensions || !quantization || !huffman || count < 1 || count > components || size !== 6 + 2 * count) invalid();
      offset = end;
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) continue;
        const markerStart = offset - 1;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset++; continue; }
        offset = markerStart;
        break;
      }
      if (offset === start) invalid();
      scanned = true;
      continue;
    } else if (marker === 0xdb) {
      if (size < 67) invalid();
      quantization = true;
    } else if (marker === 0xc4) {
      if (size < 20) invalid();
      huffman = true;
    } else if (![0xdd, 0xe0, 0xe2, 0xee].includes(marker)) {
      // EXIF, comments and unfamiliar data segments are not accepted.
      invalid();
    }
    offset = end;
  }
  invalid();
}
