// Minimal baseline TIFF encoder (uncompressed, little-endian, one strip) so tests can create images with known pixels
// without depending on the code under test.

export interface TiffImage {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  samplesPerPixel: 1 | 3;
  /** 'float' only for 32 bits per sample */
  sampleFormat?: 'uint' | 'float';
  /** Row-major samples, interleaved for 3 samples per pixel */
  data: ArrayLike<number>;
}

const SHORT = 3;
const LONG = 4;

export function encodeTiff(image: TiffImage): Buffer {
  return encodeTiffPages([image]);
}

/** A multi-page TIFF: each page one IFD with its data, linked in order */
export function encodeTiffPages(images: TiffImage[]): Buffer {
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  const pages: Buffer[] = [];
  let start = 8;
  images.forEach((image, index) => {
    const page = encodePage(image, start, index === images.length - 1);
    pages.push(page);
    start += page.length;
  });
  return Buffer.concat([header, ...pages]);
}

/** One page starting at file offset `start`: IFD, bits array, data; the next IFD follows directly unless last */
function encodePage(image: TiffImage, start: number, last: boolean): Buffer {
  const { width, height, bitsPerSample, samplesPerPixel } = image;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = width * height * samplesPerPixel;
  if (image.data.length !== sampleCount) {
    throw new Error(`expected ${sampleCount} samples, got ${image.data.length}`);
  }

  const entries: Array<[tag: number, type: number, count: number, value: number]> = [];
  const withSampleFormat = samplesPerPixel === 1;
  const entryCount = withSampleFormat ? 11 : 10;
  const ifdLength = 2 + entryCount * 12 + 4;
  const bitsArrayOffset = start + ifdLength;
  const dataOffset = bitsArrayOffset + (samplesPerPixel > 1 ? samplesPerPixel * 2 : 0);
  const dataLength = sampleCount * bytesPerSample;

  entries.push([256, LONG, 1, width]); // ImageWidth
  entries.push([257, LONG, 1, height]); // ImageLength
  entries.push([258, SHORT, samplesPerPixel, samplesPerPixel === 1 ? bitsPerSample : bitsArrayOffset]); // BitsPerSample
  entries.push([259, SHORT, 1, 1]); // Compression: none
  entries.push([262, SHORT, 1, samplesPerPixel === 3 ? 2 : 1]); // Photometric: RGB or BlackIsZero
  entries.push([273, LONG, 1, dataOffset]); // StripOffsets
  entries.push([277, SHORT, 1, samplesPerPixel]); // SamplesPerPixel
  entries.push([278, LONG, 1, height]); // RowsPerStrip
  entries.push([279, LONG, 1, dataLength]); // StripByteCounts
  entries.push([284, SHORT, 1, 1]); // PlanarConfiguration: contiguous
  if (withSampleFormat) {
    entries.push([339, SHORT, 1, image.sampleFormat === 'float' ? 3 : 1]); // SampleFormat
  }

  const buffer = Buffer.alloc(dataOffset + dataLength - start);
  buffer.writeUInt16LE(entryCount, 0);

  let position = 2;
  for (const [tag, type, count, value] of entries) {
    buffer.writeUInt16LE(tag, position);
    buffer.writeUInt16LE(type, position + 2);
    buffer.writeUInt32LE(count, position + 4);
    if (type === SHORT && count === 1) {
      buffer.writeUInt16LE(value, position + 8);
    } else {
      buffer.writeUInt32LE(value, position + 8);
    }
    position += 12;
  }
  buffer.writeUInt32LE(last ? 0 : dataOffset + dataLength, position); // the next IFD

  for (let i = 0; i < samplesPerPixel && samplesPerPixel > 1; i += 1) {
    buffer.writeUInt16LE(bitsPerSample, bitsArrayOffset - start + 2 * i);
  }

  for (let i = 0; i < sampleCount; i += 1) {
    const offset = dataOffset - start + i * bytesPerSample;
    const value = image.data[i];
    if (bitsPerSample === 8) {
      buffer.writeUInt8(value, offset);
    } else if (bitsPerSample === 16) {
      buffer.writeUInt16LE(value, offset);
    } else {
      buffer.writeFloatLE(value, offset);
    }
  }
  return buffer;
}
