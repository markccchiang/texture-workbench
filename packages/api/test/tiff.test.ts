import { describe, expect, it } from 'vitest';
import { encodeFloat32Tiff } from '../src/tiff.js';

/** Tags of the first IFD: SHORT and LONG values, or the text of ASCII entries */
function readTags(bytes: Uint8Array): Map<number, number | string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint16(0)).toBe(0x4949);
  expect(view.getUint16(2, true)).toBe(42);
  const ifd = view.getUint32(4, true);
  const tags = new Map<number, number | string>();
  const count = view.getUint16(ifd, true);
  for (let i = 0; i < count; i += 1) {
    const at = ifd + 2 + i * 12;
    const tag = view.getUint16(at, true);
    const type = view.getUint16(at + 2, true);
    const length = view.getUint32(at + 4, true);
    if (type === 2) {
      const offset = length > 4 ? view.getUint32(at + 8, true) : at + 8;
      tags.set(tag, new TextDecoder().decode(bytes.subarray(offset, offset + length - 1)));
    } else {
      tags.set(tag, type === 3 ? view.getUint16(at + 8, true) : view.getUint32(at + 8, true));
    }
  }
  expect(view.getUint32(ifd + 2 + count * 12, true)).toBe(0);
  return tags;
}

describe('32-bit float TIFF', () => {
  it('writes the values as one strip of little-endian floats', () => {
    const values = new Float32Array([1.5, -2.25, Number.NaN, 1e30, 0, 7]);
    const bytes = encodeFloat32Tiff(values, 3, 2, '{"feature":"Contrast"}');
    const tags = readTags(bytes);
    expect(tags.get(256)).toBe(3);
    expect(tags.get(257)).toBe(2);
    expect(tags.get(258)).toBe(32);
    expect(tags.get(259)).toBe(1);
    expect(tags.get(277)).toBe(1);
    expect(tags.get(278)).toBe(2);
    expect(tags.get(279)).toBe(24);
    expect(tags.get(339)).toBe(3);
    expect(tags.get(270)).toBe('{"feature":"Contrast"}');

    const offset = tags.get(273) as number;
    expect(offset % 2).toBe(0);
    expect(bytes.length).toBe(offset + 24);
    const decoded = new Float32Array(bytes.slice(offset).buffer);
    expect(Array.from(decoded)).toEqual(Array.from(values));
  });

  it('writes files without a description and refuses a wrong size', () => {
    const tags = readTags(encodeFloat32Tiff(new Float32Array([1]), 1, 1));
    expect(tags.has(270)).toBe(false);
    expect(() => encodeFloat32Tiff(new Float32Array(3), 2, 2)).toThrow(/do not fill/);
  });
});
