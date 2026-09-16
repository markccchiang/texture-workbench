// Writes feature map values as an uncompressed, single-strip, little-endian TIFF with one 32-bit floating-point sample
// per pixel (SampleFormat 3), which image tools such as ImageJ/Fiji read as a 32-bit image.

const SHORT = 3;
const LONG = 4;
const ASCII = 2;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Value for SHORT and LONG entries, or the bytes of an ASCII entry */
  value: number | Uint8Array;
}

export function encodeFloat32Tiff(values: Float32Array, width: number, height: number, description = ''): Uint8Array<ArrayBuffer> {
  if (values.length !== width * height) {
    throw new Error(`${values.length} values do not fill ${width} × ${height} pixels`);
  }
  const text = description ? new TextEncoder().encode(`${description}\0`) : null;
  const entries: Entry[] = [
    { tag: 256, type: LONG, count: 1, value: width }, // ImageWidth
    { tag: 257, type: LONG, count: 1, value: height }, // ImageLength
    { tag: 258, type: SHORT, count: 1, value: 32 }, // BitsPerSample
    { tag: 259, type: SHORT, count: 1, value: 1 }, // Compression: none
    { tag: 262, type: SHORT, count: 1, value: 1 }, // PhotometricInterpretation: BlackIsZero
    ...(text ? [{ tag: 270, type: ASCII, count: text.length, value: text }] : []), // ImageDescription
    { tag: 273, type: LONG, count: 1, value: 0 }, // StripOffsets, set below
    { tag: 277, type: SHORT, count: 1, value: 1 }, // SamplesPerPixel
    { tag: 278, type: LONG, count: 1, value: height }, // RowsPerStrip
    { tag: 279, type: LONG, count: 1, value: values.length * 4 }, // StripByteCounts
    { tag: 284, type: SHORT, count: 1, value: 1 }, // PlanarConfiguration: chunky
    { tag: 339, type: SHORT, count: 1, value: 3 }, // SampleFormat: IEEE floating point
  ];

  const ifdSize = 2 + entries.length * 12 + 4;
  const textOffset = 8 + ifdSize;
  const textSize = text && text.length > 4 ? text.length + (text.length % 2) : 0;
  const dataOffset = textOffset + textSize;
  entries.find((entry) => entry.tag === 273)!.value = dataOffset;

  const bytes = new Uint8Array(dataOffset + values.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4949); // "II": little-endian
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach((entry, index) => {
    const at = 10 + index * 12;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, entry.count, true);
    // Not instanceof: the bytes can come from another realm's TextEncoder (e.g. in jsdom)
    if (typeof entry.value !== 'number') {
      if (entry.value.length > 4) {
        view.setUint32(at + 8, textOffset, true);
        bytes.set(entry.value, textOffset);
      } else {
        bytes.set(entry.value, at + 8);
      }
    } else if (entry.type === SHORT) {
      view.setUint16(at + 8, entry.value, true);
    } else {
      view.setUint32(at + 8, entry.value, true);
    }
  });
  view.setUint32(10 + entries.length * 12, 0, true); // no further IFD

  for (let i = 0; i < values.length; i += 1) {
    view.setFloat32(dataOffset + i * 4, values[i], true);
  }
  return bytes;
}
