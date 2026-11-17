"use strict";

const STRING_PREFIX = "s:";
const NUMBER_PREFIX = "n:";
const NUMBER_HEX_LENGTH = 16;

export function encodeRabbitId(id) {
  if (typeof id === "string") return STRING_PREFIX + JSON.stringify(id);
  if (typeof id !== "number" || !Number.isFinite(id)) {
    throw new TypeError("Rabbit ID must be a string or finite number.");
  }

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, id, false);
  let encoded = NUMBER_PREFIX;
  for (let index = 0; index < 8; index += 1) {
    encoded += view.getUint8(index).toString(16).padStart(2, "0");
  }
  return encoded;
}

export function decodeRabbitId(encoded) {
  if (typeof encoded !== "string") throw new TypeError("Encoded rabbit ID must be a string.");
  if (encoded.startsWith(STRING_PREFIX)) {
    try {
      const value = JSON.parse(encoded.slice(STRING_PREFIX.length));
      if (typeof value !== "string" || encodeRabbitId(value) !== encoded) throw new Error();
      return value;
    } catch {
      throw new TypeError("Encoded rabbit ID has an invalid string representation.");
    }
  }
  if (encoded.startsWith(NUMBER_PREFIX)) {
    const hex = encoded.slice(NUMBER_PREFIX.length);
    if (!new RegExp(`^[0-9a-f]{${NUMBER_HEX_LENGTH}}$`).test(hex)) {
      throw new TypeError("Encoded rabbit ID has an invalid number representation.");
    }
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    for (let index = 0; index < 8; index += 1) {
      view.setUint8(index, Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
    }
    const value = view.getFloat64(0, false);
    if (!Number.isFinite(value)) throw new TypeError("Encoded rabbit ID must decode to a finite number.");
    return value;
  }
  throw new TypeError("Encoded rabbit ID has an unknown type tag.");
}
