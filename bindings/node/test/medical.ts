// Minimal DICOM and NIfTI-1 encoders so tests can create medical images with known values without depending on the
// code under test.

import zlib from 'node:zlib';

export interface DicomImage {
  rows: number;
  columns: number;
  bitsAllocated: 8 | 16;
  /** PixelRepresentation 1 */
  signed?: boolean;
  photometric?: 'MONOCHROME1' | 'MONOCHROME2';
  /** Row-major samples, frame after frame */
  data: ArrayLike<number>;
  /** NumberOfFrames; data holds rows × columns × frames samples */
  frames?: number;
  seriesDescription?: string;
  seriesUid?: string;
  instanceNumber?: number;
  /** ImagePositionPatient */
  position?: [number, number, number];
  /** ImageOrientationPatient: row direction, then column direction */
  orientation?: [number, number, number, number, number, number];
  modality?: string;
  /** Row spacing, column spacing (mm), as in PixelSpacing */
  pixelSpacing?: [number, number];
  windowCenter?: number;
  windowWidth?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
  /** Default explicit VR little endian */
  transferSyntax?: string;
}

function element(group: number, tag: number, vr: string, value: Buffer): Buffer {
  const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
  const header = Buffer.alloc(long ? 12 : 8);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(tag, 2);
  header.write(vr, 4, 'latin1');
  if (long) {
    header.writeUInt32LE(value.length, 8);
  } else {
    header.writeUInt16LE(value.length, 6);
  }
  return Buffer.concat([header, value]);
}

function text(value: string, pad = ' '): Buffer {
  return Buffer.from(value.length % 2 === 1 ? value + pad : value, 'latin1');
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

export function encodeDicom(image: DicomImage): Buffer {
  const bytes = image.bitsAllocated / 8;
  const samples = image.rows * image.columns * (image.frames ?? 1);
  const pixels = Buffer.alloc(samples * bytes);
  for (let i = 0; i < samples; i += 1) {
    if (bytes === 1) {
      pixels.writeUInt8(image.data[i] & 0xff, i);
    } else {
      pixels.writeUInt16LE(image.data[i] & 0xffff, 2 * i);
    }
  }
  const parts = [Buffer.alloc(128), Buffer.from('DICM', 'latin1'), element(0x0002, 0x0010, 'UI', text(image.transferSyntax ?? '1.2.840.10008.1.2.1', '\0'))];
  if (image.modality) {
    parts.push(element(0x0008, 0x0060, 'CS', text(image.modality)));
  }
  if (image.seriesDescription !== undefined) {
    parts.push(element(0x0008, 0x103e, 'LO', text(image.seriesDescription)));
  }
  if (image.seriesUid !== undefined) {
    parts.push(element(0x0020, 0x000e, 'UI', text(image.seriesUid, '\0')));
  }
  if (image.instanceNumber !== undefined) {
    parts.push(element(0x0020, 0x0013, 'IS', text(String(image.instanceNumber))));
  }
  if (image.position) {
    parts.push(element(0x0020, 0x0032, 'DS', text(image.position.join('\\'))));
  }
  if (image.orientation) {
    parts.push(element(0x0020, 0x0037, 'DS', text(image.orientation.join('\\'))));
  }
  parts.push(
    element(0x0028, 0x0002, 'US', uint16(1)),
    element(0x0028, 0x0004, 'CS', text(image.photometric ?? 'MONOCHROME2')),
    ...(image.frames !== undefined ? [element(0x0028, 0x0008, 'IS', text(String(image.frames)))] : []),
    element(0x0028, 0x0010, 'US', uint16(image.rows)),
    element(0x0028, 0x0011, 'US', uint16(image.columns)),
  );
  if (image.pixelSpacing) {
    parts.push(element(0x0028, 0x0030, 'DS', text(image.pixelSpacing.join('\\'))));
  }
  parts.push(
    element(0x0028, 0x0100, 'US', uint16(image.bitsAllocated)),
    element(0x0028, 0x0101, 'US', uint16(image.bitsAllocated)),
    element(0x0028, 0x0102, 'US', uint16(image.bitsAllocated - 1)),
    element(0x0028, 0x0103, 'US', uint16(image.signed ? 1 : 0)),
  );
  if (image.windowCenter !== undefined && image.windowWidth !== undefined) {
    parts.push(element(0x0028, 0x1050, 'DS', text(String(image.windowCenter))), element(0x0028, 0x1051, 'DS', text(String(image.windowWidth))));
  }
  if (image.rescaleIntercept !== undefined) {
    parts.push(element(0x0028, 0x1052, 'DS', text(String(image.rescaleIntercept))));
  }
  if (image.rescaleSlope !== undefined) {
    parts.push(element(0x0028, 0x1053, 'DS', text(String(image.rescaleSlope))));
  }
  parts.push(element(0x7fe0, 0x0010, bytes === 1 ? 'OB' : 'OW', pixels));
  return Buffer.concat(parts);
}

export interface NiftiVolume {
  /** Voxels along i, j, k, and optionally the number of volumes */
  dimensions: [number, number, number] | [number, number, number, number];
  dataType: 'uint8' | 'int16' | 'float32';
  /** Voxel values in file order: i fastest, then j, k and volume */
  data: ArrayLike<number>;
  /** Millimetres along i, j, k; the sform is diagonal (RAS) with these sizes, negated where `flip` says so */
  voxelSize?: [number, number, number];
  flip?: [boolean, boolean, boolean];
  slope?: number;
  intercept?: number;
  gzip?: boolean;
}

const DATA_TYPES = { uint8: [2, 8], int16: [4, 16], float32: [16, 32] } as const;

export function encodeNifti(volume: NiftiVolume): Buffer {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  const dims = volume.dimensions;
  header.writeInt16LE(dims.length, 40);
  dims.forEach((size, d) => header.writeInt16LE(size, 42 + 2 * d));
  const [code, bits] = DATA_TYPES[volume.dataType];
  header.writeInt16LE(code, 70);
  header.writeInt16LE(bits, 72);
  const size = volume.voxelSize ?? [1, 1, 1];
  header.writeFloatLE(1, 76);
  size.forEach((mm, d) => header.writeFloatLE(mm, 80 + 4 * d));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(volume.slope ?? 0, 112);
  header.writeFloatLE(volume.intercept ?? 0, 116);
  header.writeUInt8(2, 123); // millimetres
  header.writeInt16LE(1, 254); // sform_code
  size.forEach((mm, d) => header.writeFloatLE(volume.flip?.[d] ? -mm : mm, 280 + 16 * d + 4 * d));
  header.write('n+1\0', 344, 'latin1');

  const voxelBytes = bits / 8;
  const data = Buffer.alloc(volume.data.length * voxelBytes);
  for (let v = 0; v < volume.data.length; v += 1) {
    if (volume.dataType === 'uint8') {
      data.writeUInt8(volume.data[v], v);
    } else if (volume.dataType === 'int16') {
      data.writeInt16LE(volume.data[v], 2 * v);
    } else {
      data.writeFloatLE(volume.data[v], 4 * v);
    }
  }
  const file = Buffer.concat([header, data]);
  return volume.gzip ? zlib.gzipSync(file) : file;
}

/** int16 voxels i + 10 j + 100 k + 1000 volume */
export function rampVolume(ni: number, nj: number, nk: number, volumes = 1): number[] {
  const values: number[] = [];
  for (let t = 0; t < volumes; t += 1) {
    for (let k = 0; k < nk; k += 1) {
      for (let j = 0; j < nj; j += 1) {
        for (let i = 0; i < ni; i += 1) {
          values.push(i + 10 * j + 100 * k + 1000 * t);
        }
      }
    }
  }
  return values;
}
