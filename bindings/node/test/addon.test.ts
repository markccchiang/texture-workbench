import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { windowLevel as windowLevelTs } from '@glcm/api';
import * as native from '../index.js';
import { encodeDicom, encodeNifti, rampVolume } from './medical.js';
import { encodeTiff } from './tiff.js';

let directory: string;

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-native-test-'));
});

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

async function writeFile(name: string, data: Buffer): Promise<string> {
  const file = path.join(directory, name);
  await fs.writeFile(file, data);
  return file;
}

function nearestRank(values: number[], perMille: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((sorted.length * perMille) / 1000));
  return sorted[rank - 1];
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'resolved';
}

/** The code of the error thrown by a synchronous call, or "no error" when it does not throw */
function codeOf(action: () => void): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'no error';
}

describe('catalog', () => {
  it('reports the core version', () => {
    expect(native.coreVersion()).toBe('0.1.0');
  });

  it('lists every feature with its flags', () => {
    const catalog = native.catalog();
    expect(catalog.features).toHaveLength(105);
    expect(new Set(catalog.features.map((feature) => feature.id)).size).toBe(105);
    expect(new Set(catalog.features.map((feature) => feature.name)).size).toBe(105);

    const nonStandard = catalog.features.filter((feature) => feature.nonStandard).map((feature) => feature.id);
    expect(nonStandard.sort()).toEqual(['CorrelationIII', 'SumOfSquares']);
    expect(catalog.features.find((feature) => feature.id === 'MaximalCorrelationCoefficient')?.cost).toBe('slow');
    expect(catalog.features[0]).toMatchObject({ id: 'Mean', group: 'regionStatistics', docAnchor: 'equations.html#first-order-statistics' });
    expect(catalog.features.filter((feature) => feature.group === 'regionStatistics')).toHaveLength(18);
    expect(catalog.features.filter((feature) => feature.group === 'runLength')).toHaveLength(16);
    expect(catalog.features.filter((feature) => feature.group === 'sizeZone')).toHaveLength(16);
    expect(catalog.features.filter((feature) => feature.group === 'grayToneDifference')).toHaveLength(5);
    expect(catalog.features.filter((feature) => feature.group === 'localBinaryPattern')).toHaveLength(12);
    expect(catalog.features.filter((feature) => feature.group === 'shape')).toHaveLength(9);
    expect(catalog.features.find((feature) => feature.id === 'ShapeSphericity')).toMatchObject({ name: 'Sphericity', docAnchor: 'equations.html#shape-features-2d' });
    expect(catalog.features.find((feature) => feature.id === 'LbpEntropy')).toMatchObject({ docAnchor: 'equations.html#local-binary-pattern-features-lbp' });
    expect(catalog.features.find((feature) => feature.id === 'NgtdmBusyness')).toMatchObject({
      docAnchor: 'equations.html#neighbourhood-gray-tone-difference-features-ngtdm',
    });
    expect(catalog.features.find((feature) => feature.id === 'GlszmZoneEntropy')).toMatchObject({ docAnchor: 'equations.html#size-zone-features-glszm' });
    expect(catalog.features.find((feature) => feature.id === 'GlrlmRunEntropy')).toMatchObject({ docAnchor: 'equations.html#run-length-features-glrlm' });

    expect(catalog.presets.map((preset) => preset.id)).toEqual(['haralick', 'clausi2002', 'basic', 'score', 'firstOrder', 'glrlm', 'glszm', 'ngtdm', 'lbp', 'shape', 'all']);
    expect(catalog.presets[0].features).toHaveLength(14);
    expect(catalog.limits).toMatchObject({
      minGrayLevels: 2,
      maxGrayLevels: 256,
      defaultGrayLevels: 32,
      maxDistance: 64,
      directions: [0, 45, 90, 135],
      quantizationMethods: ['fixedRange', 'roiMinMax', 'fixedBinWidth', 'none'],
      logBases: ['natural', 'log2'],
      defaultScoreCoefficients: { age: 1.138, mean: -1.814, entropy: 1.416, contrast: 1.714 },
    });
  });
});

describe('decodeImageFile', () => {
  it('decodes a 16-bit TIFF into little-endian samples, window and histogram', async () => {
    const width = 7;
    const height = 5;
    const values = Array.from({ length: width * height }, (_, i) => (i * 9973) % 65536);
    const file = await writeFile('sixteen.tif', encodeTiff({ width, height, bitsPerSample: 16, samplesPerPixel: 1, data: values }));

    const image = await native.decodeImageFile(file);
    expect(image).toMatchObject({ width, height, bitDepth: 16, sourceChannels: 1, warnings: [] });
    expect(image.pixels).toHaveLength(width * height * 2);
    for (let i = 0; i < values.length; i += 1) {
      expect(image.pixels.readUInt16LE(2 * i)).toBe(values[i]);
    }

    expect(image.windowMin).toBe(nearestRank(values, 5));
    expect(image.windowMax).toBe(nearestRank(values, 995));
    const histogram = new Array<number>(256).fill(0);
    for (const value of values) {
      histogram[value >> 8] += 1;
    }
    expect(image.histogram).toEqual(histogram);
  });

  it('decodes an 8-bit TIFF', async () => {
    const values = Array.from({ length: 12 }, (_, i) => i * 20);
    const file = await writeFile('eight.tif', encodeTiff({ width: 4, height: 3, bitsPerSample: 8, samplesPerPixel: 1, data: values }));

    const image = await native.decodeImageFile(file);
    expect(image).toMatchObject({ width: 4, height: 3, bitDepth: 8 });
    expect([...image.pixels]).toEqual(values);
  });

  it('converts RGB images to grayscale with a warning', async () => {
    // Pixels: red, green, blue, white
    const rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    const file = await writeFile('rgb.tif', encodeTiff({ width: 4, height: 1, bitsPerSample: 8, samplesPerPixel: 3, data: rgb }));

    const image = await native.decodeImageFile(file);
    expect(image.sourceChannels).toBe(3);
    expect(image.warnings.join(' ')).toContain('grayscale');
    // ITU-R BT.601 luma as computed by OpenCV's fixed-point conversion
    expect([...image.pixels]).toEqual([76, 150, 29, 255]);
  });

  it('converts colour images with the chosen conversion and encodes the result as a TIFF', async () => {
    const rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    const file = await writeFile('rgb-colour.tif', encodeTiff({ width: 4, height: 1, bitsPerSample: 8, samplesPerPixel: 3, data: rgb }));

    const green = await native.decodeImageFile(file, { colour: 'green', encodeTiff: true });
    expect([...green.pixels]).toEqual([0, 255, 0, 255]);
    expect(green.warnings).toEqual(['Colour image converted: Green channel']);
    expect(green.valueConversion).toEqual({ scale: 1, offset: 0, unit: '', description: 'Green channel; value = stored value' });
    // The TIFF reads back as the converted gray image
    const again = await native.decodeImageFile(await writeFile('green.tif', green.tiff!));
    expect(again).toMatchObject({ sourceChannels: 1, bitDepth: 8, warnings: [] });
    expect([...again.pixels]).toEqual([0, 255, 0, 255]);

    const stain = await native.decodeImageFile(file, { colour: 'hematoxylinHe' });
    expect(stain.bitDepth).toBe(16);
    expect(stain.valueConversion?.unit).toBe('OD');
    expect((await native.decodeImageFile(file)).tiff).toBeUndefined();
    expect(() => native.decodeImageFile(file, { colour: 'purple' as never })).toThrow('colour conversion');
  });

  it('rejects unsupported and unreadable files with an error code', async () => {
    const float = await writeFile(
      'float.tif',
      encodeTiff({ width: 2, height: 2, bitsPerSample: 32, samplesPerPixel: 1, sampleFormat: 'float', data: [0.5, 1, 1.5, 2] }),
    );
    expect(await rejectionCode(native.decodeImageFile(float))).toBe('UNSUPPORTED_IMAGE');

    const garbage = await writeFile('garbage.png', Buffer.from('definitely not an image'));
    expect(await rejectionCode(native.decodeImageFile(garbage))).toBe('DECODE_FAILED');
    expect(await rejectionCode(native.decodeImageFile(path.join(directory, 'missing.png')))).toBe('DECODE_FAILED');

    expect(() => native.decodeImageFile(42 as unknown as string)).toThrow(TypeError);
  });
});

describe('decodeImageFile pixel limit', () => {
  async function rejection(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
    try {
      await promise;
    } catch (error) {
      return error as { code?: string; message: string };
    }
    throw new Error('expected a rejection');
  }

  it('checks the size from the header before decoding', async () => {
    // PNG signature and IHDR declaring 30000 × 30000 pixels, without image data
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(30000, 0);
    ihdr.writeUInt32BE(30000, 4);
    ihdr[8] = 16;
    const bomb = await writeFile(
      'bomb.png',
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]),
    );
    const tooLarge = await rejection(native.decodeImageFile(bomb, { maxPixels: 100_000_000 }));
    expect(tooLarge.code).toBe('IMAGE_TOO_LARGE');
    expect(tooLarge.message).toContain('30000 x 30000');
    // Without a limit the decoder is reached, and it cannot decode the missing image data
    expect((await rejection(native.decodeImageFile(bomb))).code).toBe('DECODE_FAILED');

    const small = await writeFile('limit.tif', encodeTiff({ width: 4, height: 4, bitsPerSample: 8, samplesPerPixel: 1, data: new Array(16).fill(3) }));
    expect((await native.decodeImageFile(small, { maxPixels: 16 })).width).toBe(4);
    expect((await native.decodeImageFile(small, {})).width).toBe(4);
    expect((await rejection(native.decodeImageFile(small, { maxPixels: 15 }))).code).toBe('IMAGE_TOO_LARGE');
    expect(() => native.decodeImageFile(small, { maxPixels: -1 })).toThrow(TypeError);
    expect(() => native.decodeImageFile(small, { maxPixels: 1.5 })).toThrow(TypeError);
    expect(() => native.decodeImageFile(small, 5 as never)).toThrow(TypeError);
  });
});

describe('window/level', () => {
  it('matches the TypeScript implementation used by the browser', () => {
    const windows: Array<[number, number]> = [
      [0, 255],
      [10, 20],
      [100, 100],
      [0, 65535],
      [1000, 3000],
      [65534, 65535],
    ];
    for (const [min, max] of windows) {
      for (let value = 0; value <= 65535; value += 251) {
        expect(native.windowLevel(value, min, max)).toBe(windowLevelTs(value, min, max));
      }
      for (const value of [min - 1, min, min + 1, max - 1, max, max + 1]) {
        expect(native.windowLevel(value, min, max)).toBe(windowLevelTs(value, min, max));
      }
    }
    expect(windowLevelTs(15, 10, 20)).toBe(128);
  });
});

// Haralick, Shanmugam and Dinstein (1973), figure 2: the 4 x 4 example image with gray levels 0-3
const HARALICK_WIDTH = 4;
const HARALICK_HEIGHT = 4;
const HARALICK_PIXELS = Buffer.from([0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 3, 3]);
const FULL_IMAGE_ROI = { id: 'r1', name: 'Whole image', shape: { type: 'rectangle', x: 0, y: 0, width: 4, height: 4 } };

describe('roiStats', () => {
  it('counts pixels with the pixel-centre rule and reports original intensities', async () => {
    const rois = [
      { id: 'a', shape: { type: 'rectangle', x: 1, y: 1, width: 2, height: 2 } },
      { id: 'b', shape: { type: 'ellipse', cx: 2, cy: 2, rx: 0, ry: 3 } },
      { id: 'c', shape: { type: 'polygon', points: [[0, 0], [4, 0]] } },
      FULL_IMAGE_ROI,
    ];
    const stats = await native.roiStats(HARALICK_PIXELS, HARALICK_WIDTH, HARALICK_HEIGHT, 8, JSON.stringify(rois));
    expect(stats).toHaveLength(4);
    // Pixels (1, 1), (2, 1), (1, 2), (2, 2) = 0, 1, 2, 2
    expect(stats[0]).toMatchObject({ pixelCount: 4, boundingBox: { x: 1, y: 1, width: 2, height: 2 }, min: 0, max: 2, mean: 1.25, error: null });
    expect(stats[0].std).toBeCloseTo(Math.sqrt(((0 - 1.25) ** 2 + (1 - 1.25) ** 2 + 2 * (2 - 1.25) ** 2) / 3), 12);
    for (const empty of [stats[1], stats[2]]) {
      expect(empty).toEqual({ pixelCount: 0, boundingBox: null, min: null, max: null, mean: null, std: null, error: null });
    }
    expect(stats[3]).toMatchObject({ pixelCount: 16, min: 0, max: 3, mean: 1.25 });
  });

  it('reads 16-bit samples', async () => {
    const pixels = Buffer.alloc(8);
    [1000, 60000, 3, 65535].forEach((value, i) => pixels.writeUInt16LE(value, 2 * i));
    const rois = [{ shape: { type: 'rectangle', x: 0, y: 0, width: 2, height: 2 } }];
    const [stats] = await native.roiStats(pixels, 2, 2, 16, JSON.stringify(rois));
    expect(stats).toMatchObject({ pixelCount: 4, min: 3, max: 65535, mean: (1000 + 60000 + 3 + 65535) / 4 });
  });

  it('rejects malformed ROI lists', async () => {
    expect(await rejectionCode(native.roiStats(HARALICK_PIXELS, 4, 4, 8, '[{"shape": {"type": "circle"}}]'))).toBe('INVALID_ARGUMENT');
    expect(await rejectionCode(native.roiStats(HARALICK_PIXELS, 4, 4, 8, 'not json'))).toBe('INVALID_ARGUMENT');
    expect(() => native.roiStats(HARALICK_PIXELS, 4, 4, 8, 42 as unknown as string)).toThrow(TypeError);
  });
});

describe('analysis', () => {
  const settings = {
    features: ['Mean', 'Contrast'],
    grayLevels: 4,
    quantization: { method: 'none' },
    distances: [1],
    directions: [0, 45, 90, 135],
  };

  it('validates requests synchronously', () => {
    expect(native.validateAnalysis(JSON.stringify([FULL_IMAGE_ROI]), JSON.stringify(settings))).toBeUndefined();
    expect(codeOf(() => native.validateAnalysis('[]', JSON.stringify({ ...settings, features: ['NoSuchFeature'] })))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => native.validateAnalysis('[]', JSON.stringify({ ...settings, grayLevels: 300 })))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => native.validateAnalysis('[{"shape": {}}]', JSON.stringify(settings)))).toBe('INVALID_ARGUMENT');
    const zeroDistance = () => native.validateAnalysis('[]', JSON.stringify({ ...settings, distances: [0] }));
    expect(codeOf(zeroDistance)).toBe('INVALID_ARGUMENT');
    expect(zeroDistance).toThrow(/distance/i);
  });

  it("reproduces Haralick's worked example", async () => {
    const json = await native.runAnalysis(HARALICK_PIXELS, HARALICK_WIDTH, HARALICK_HEIGHT, 8, JSON.stringify([FULL_IMAGE_ROI]), JSON.stringify(settings));
    const document = JSON.parse(json);
    expect(document).toMatchObject({ format: 'glcm-results', version: 1, coreVersion: '0.1.0' });
    expect(document.results).toHaveLength(1);
    const [result] = document.results;
    expect(result).toMatchObject({ roiId: 'r1', roiName: 'Whole image', distance: 1, status: 'ok', pixelCount: 16 });
    // Symmetric pair counts: 0° and 90° have 24 pairs, the diagonals 18
    expect(result.pairCounts).toEqual({ '0': 24, '45': 18, '90': 24, '135': 18 });
    expect(result.values.Mean.mean).toBe(1.25);
    expect(result.values.Contrast['0']).toBeCloseTo(14 / 24, 12);
    expect(result.values.Contrast['90']).toBeCloseTo(1, 12);
    expect(result.score).toBeNull();
  });

  it('runs every distance and marks unmeasurable ROIs', async () => {
    const rois = [FULL_IMAGE_ROI, { id: 'tiny', name: 'Tiny', shape: { type: 'rectangle', x: 0, y: 0, width: 1, height: 1 } }];
    const document = JSON.parse(
      await native.runAnalysis(HARALICK_PIXELS, 4, 4, 8, JSON.stringify(rois), JSON.stringify({ ...settings, distances: [1, 4] })),
    );
    expect(document.results.map((result: { roiId: string; distance: number; status: string }) => [result.roiId, result.distance, result.status])).toEqual([
      ['r1', 1, 'ok'],
      ['r1', 4, 'ok'],
      ['tiny', 1, 'skipped'],
      ['tiny', 4, 'skipped'],
    ]);
    expect(document.results[1].warnings.join(' ')).toContain('No pixel pairs at distance 4');
  });

  it('computes shape features in pixels, or in millimetres with a pixel spacing', async () => {
    const shape = { ...settings, features: ['ShapePixelSurface', 'ShapePerimeter', 'ShapeSphericity'], aggregation: 'meanOnly' };
    const measure = async (spacing?: { x: number; y: number } | null) =>
      JSON.parse(await native.runAnalysis(HARALICK_PIXELS, 4, 4, 8, JSON.stringify([FULL_IMAGE_ROI]), JSON.stringify(shape), spacing)).results[0].values;
    const pixels = await measure();
    // A 4 × 4 square: the mesh cuts half a pixel off each corner
    expect(pixels.ShapePixelSurface.mean).toBe(16);
    expect(pixels.ShapePerimeter.mean).toBeCloseTo(4 * 3 + 4 * Math.SQRT1_2, 12);
    expect(await measure(null)).toEqual(pixels);
    const millimetres = await measure({ x: 0.5, y: 0.5 });
    expect(millimetres.ShapePixelSurface.mean).toBe(4);
    expect(millimetres.ShapePerimeter.mean).toBeCloseTo(pixels.ShapePerimeter.mean / 2, 12);
    expect(millimetres.ShapeSphericity.mean).toBeCloseTo(pixels.ShapeSphericity.mean, 12);
    expect(() => native.runAnalysis(HARALICK_PIXELS, 4, 4, 8, JSON.stringify([FULL_IMAGE_ROI]), JSON.stringify(shape), { x: 'a' } as never)).toThrow(TypeError);
    expect(await rejectionCode(native.runAnalysis(HARALICK_PIXELS, 4, 4, 8, JSON.stringify([FULL_IMAGE_ROI]), JSON.stringify(shape), { x: 0, y: 1 }))).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('rejects invalid settings with INVALID_ARGUMENT', async () => {
    const invalid = JSON.stringify({ ...settings, grayLevels: 1 });
    expect(await rejectionCode(native.runAnalysis(HARALICK_PIXELS, 4, 4, 8, JSON.stringify([FULL_IMAGE_ROI]), invalid))).toBe('INVALID_ARGUMENT');
  });
});

describe('exports', () => {
  const settings = { features: ['Contrast'], grayLevels: 4, quantization: { method: 'none' } };

  async function haralickDocument() {
    const document = JSON.parse(
      await native.runAnalysis(HARALICK_PIXELS, HARALICK_WIDTH, HARALICK_HEIGHT, 8, JSON.stringify([FULL_IMAGE_ROI]), JSON.stringify(settings)),
    );
    return { ...document, timestamp: '2026-09-14T12:00:00Z', image: { name: 'haralick.tif', sha256: 'abc' } };
  }

  it('writes results documents again as canonical JSON and CSV', async () => {
    const document = await haralickDocument();
    const json = native.formatResults(JSON.stringify(document), 'json');
    expect(JSON.parse(json)).toEqual(document);
    expect(native.formatResults(json, 'json')).toBe(json);

    const lines = native.formatResults(json, 'csv').trimEnd().split('\n');
    expect(lines).toContain('# format=glcm-results-csv');
    expect(lines).toContain('# image=haralick.tif');
    const rows = lines.filter((line) => !line.startsWith('#')).map((line) => line.split(','));
    const header = rows[0];
    expect(rows.slice(1).map((row) => row[header.indexOf('direction')])).toEqual(['0', '45', '90', '135', 'mean']);
    expect(Number(rows[1][header.indexOf('Contrast')])).toBeCloseTo(14 / 24, 12);
  });

  it('rejects invalid documents and formats', () => {
    expect(() => native.formatResults('{"format": "glcm-results", "version": 1, "results": []}', 'csv')).toThrow(/settings is missing/);
    expect(codeOf(() => native.formatResults('{', 'json'))).toBe('INVALID_ARGUMENT');
    expect(() => native.formatResults('{}', 'xml' as 'csv')).toThrow(TypeError);
  });

  it('exports ROI crops, masks, quantized images and a manifest', async () => {
    const rois = JSON.stringify([{ id: 'a', name: 'Top/left', shape: { type: 'rectangle', x: 0, y: 0, width: 2, height: 2 } }]);
    const files = await native.exportRoiImages(HARALICK_PIXELS, 4, 4, 8, rois, '', false, false);
    expect(files.map((file) => file.name)).toEqual(['Top_left.png', 'Top_left_mask.png', 'manifest.json']);
    const crop = PNG.sync.read(files[0].data);
    expect([crop.width, crop.height]).toEqual([2, 2]);
    const manifest = JSON.parse(files[2].data.toString('utf8'));
    expect(manifest).toMatchObject({ format: 'glcm-roi-images', version: 1, entries: [{ pixelCount: 4, image: 'Top_left.png', mask: 'Top_left_mask.png' }] });

    const quantized = await native.exportRoiImages(HARALICK_PIXELS, 4, 4, 8, rois, JSON.stringify(settings), true, true);
    expect(quantized.map((file) => file.name)).toEqual(['Top_left.png', 'Top_left_mask.png', 'Top_left_q4.png', 'manifest.json']);
    expect(await rejectionCode(native.exportRoiImages(HARALICK_PIXELS, 4, 4, 8, rois, '', false, true))).toBe('INVALID_ARGUMENT');
    expect(() => native.exportRoiImages(HARALICK_PIXELS, 4, 4, 8, rois, '', 1 as unknown as boolean, false)).toThrow(TypeError);
  });
});

describe('renderDisplay', () => {
  const width = 40;
  const height = 20;
  const values = Array.from({ length: width * height }, (_, i) => (i % width) * 1000 + Math.floor(i / width) * 7);
  const pixels = Buffer.alloc(width * height * 2);
  values.forEach((value, i) => pixels.writeUInt16LE(value, 2 * i));

  it('renders the window/level mapping as a PNG', async () => {
    const png = PNG.sync.read(await native.renderDisplay(pixels, width, height, 16, 5000, 30000, 0));
    expect([png.width, png.height]).toEqual([width, height]);
    for (let i = 0; i < values.length; i += 1) {
      expect(png.data[i * 4]).toBe(windowLevelTs(values[i], 5000, 30000));
    }
  });

  it('downscales to the maximum size', async () => {
    const png = PNG.sync.read(await native.renderDisplay(pixels, width, height, 16, 0, 65535, 10));
    expect([png.width, png.height]).toEqual([10, 5]);
  });

  it('validates its arguments', async () => {
    expect(() => native.renderDisplay(pixels.subarray(1), width, height, 16, 0, 1, 0)).toThrow(TypeError);
    expect(() => native.renderDisplay(pixels, width, height, 12 as 16, 0, 1, 0)).toThrow(TypeError);
    expect(await rejectionCode(native.renderDisplay(pixels, width, height, 16, 10, 5, 0))).toBe('INVALID_ARGUMENT');
  });
});

describe('feature maps', () => {
  const width = 21;
  const height = 13;
  const pixels = Buffer.from(Array.from({ length: width * height }, (_, i) => (i * 37 + Math.floor(i / width) * 11) % 256));
  const quantization = { method: 'fixedRange', min: 0, max: 255, binWidth: 1 };
  const settings = { feature: 'Contrast', window: 5, step: 4, grayLevels: 16, quantization, distance: 1, directions: [0, 45, 90, 135], logBase: 'natural' };
  /** Centre pixel of a grid block, as in glcm::ComputeFeatureMapRows */
  const centre = (index: number, step: number, size: number) => Math.floor((index * step + Math.min(index * step + step, size) - 1) / 2);

  it('gives the grid of an image and validates the settings', () => {
    expect(native.featureMapGrid(JSON.stringify(settings), width, height)).toMatchObject({ step: 4, columns: 6, rows: 4 });
    expect(native.featureMapGrid(JSON.stringify({ ...settings, step: null }), 1100, 20)).toMatchObject({ step: 3, columns: 367, rows: 7 });
    expect(native.featureMapGrid(JSON.stringify(settings), width, height).workPerRow).toBeGreaterThan(0);
    for (const invalid of [{ feature: 'MaximalCorrelationCoefficient' }, { window: 4 }, { distance: 5 }, { step: 0.5 }]) {
      expect(() => native.featureMapGrid(JSON.stringify({ ...settings, ...invalid }), width, height)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
    }
  });

  it('gives each point the analysis of its window with a fixed quantization range', async () => {
    const values = await native.computeFeatureMap(pixels, width, height, 8, JSON.stringify(settings), 0, 4);
    expect(values).toBeInstanceOf(Float32Array);
    expect(values).toHaveLength(24);
    const band = await native.computeFeatureMap(pixels, width, height, 8, JSON.stringify(settings), 2, 1);
    expect(Array.from(band)).toEqual(Array.from(values.subarray(12, 18)));

    for (const [column, row] of [[0, 0], [2, 1], [5, 3]]) {
      const x = centre(column, 4, width);
      const y = centre(row, 4, height);
      const [x0, x1, y0, y1] = [Math.max(0, x - 2), Math.min(width, x + 3), Math.max(0, y - 2), Math.min(height, y + 3)];
      const rois = [{ id: 'w', name: 'Window', shape: { type: 'rectangle', x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }];
      const analysis = { features: ['Contrast'], grayLevels: 16, quantization, distances: [1], directions: [0, 45, 90, 135], logBase: 'natural' };
      const json = await native.runAnalysis(pixels, width, height, 8, JSON.stringify(rois), JSON.stringify(analysis));
      const mean = (JSON.parse(json) as { results: Array<{ values: { Contrast: { mean: number } } }> }).results[0].values.Contrast.mean;
      expect(values[row * 6 + column]).toBeCloseTo(mean, 4);
    }
  });

  it('stops computations whose token was cancelled', async () => {
    const token = new native.CancelToken();
    expect(token.cancelled).toBe(false);
    const values = await native.computeFeatureMap(pixels, width, height, 8, JSON.stringify(settings), 0, 4, token);
    expect(values).toHaveLength(24);
    token.cancel();
    expect(token.cancelled).toBe(true);
    expect(await rejectionCode(native.computeFeatureMap(pixels, width, height, 8, JSON.stringify(settings), 0, 4, token))).toBe('CANCELLED');
    expect(() => native.computeFeatureMap(pixels, width, height, 8, JSON.stringify(settings), 0, 4, {} as native.CancelToken)).toThrow(TypeError);
  });

  it('rejects rows outside the map and images that cannot be quantized', async () => {
    expect(await rejectionCode(native.computeFeatureMap(pixels, width, height, 8, JSON.stringify(settings), 3, 2))).toBe('INVALID_ARGUMENT');
    const none = JSON.stringify({ ...settings, quantization: { ...quantization, method: 'none' } });
    expect(await rejectionCode(native.computeFeatureMap(pixels, width, height, 8, none, 0, 1))).toBe('INVALID_ARGUMENT');
  });
});

describe('region selection', () => {
  // A ring with a pixel in its hole, and a diagonal chain of three pixels
  const rows = ['..........', '.####.....', '.##.#.....', '.#..#.#...', '.####..#..', '........#.', '..........'];
  const width = rows[0].length;
  const height = rows.length;
  const pixels = Buffer.from(rows.flatMap((row) => [...row].map((character) => (character === '#' ? 255 : 0))));

  it('outlines the parts in an intensity range with their holes filled', async () => {
    const { regions, total } = await native.selectThresholdRegions(pixels, width, height, 8, 200, 255, 1, 10);
    expect(total).toBe(2);
    expect(regions.map((region) => region.pixelCount)).toEqual([16, 3]);
    expect(regions[0]).toEqual({ points: [[1, 1], [5, 1], [5, 5], [1, 5]], pixelCount: 16, boundingBox: { x: 1, y: 1, width: 4, height: 4 } });

    // The outlines contain exactly the region's pixels, counted by the core rasterizer
    const stats = await native.roiStats(pixels, width, height, 8, JSON.stringify(regions.map((region, i) => ({ id: `r${i}`, shape: { type: 'polygon', points: region.points } }))));
    expect(stats.map((statistics) => statistics.pixelCount)).toEqual([16, 3]);

    expect(await native.selectThresholdRegions(pixels, width, height, 8, 200, 255, 4, 0)).toEqual({ regions: [], total: 1 });
    expect(await rejectionCode(native.selectThresholdRegions(pixels, width, height, 8, 10, 9, 1, 10))).toBe('INVALID_ARGUMENT');
  });

  it('selects the connected region around a pixel within a tolerance', async () => {
    const chain = await native.selectWandRegion(pixels, width, height, 8, 8, 5, 0);
    expect(chain).toMatchObject({ pixelCount: 3, boundingBox: { x: 6, y: 3, width: 3, height: 3 } });
    expect((await native.selectWandRegion(pixels, width, height, 8, 1, 1, 255))?.pixelCount).toBe(width * height);
    expect(await native.selectWandRegion(pixels, width, height, 8, width, 0, 0)).toBeNull();
    expect(await rejectionCode(native.selectWandRegion(pixels, width, height, 8, 0, 0, -1))).toBe('INVALID_ARGUMENT');
  });
});

describe('ROI editing', () => {
  const roisJson = (...shapes: object[]) => JSON.stringify(shapes.map((shape, i) => ({ id: `r${i}`, name: `R${i}`, shape })));
  const pixelCount = async (points: Array<[number, number]>) => {
    const pixels = Buffer.alloc(40 * 30);
    const [statistics] = await native.roiStats(pixels, 40, 30, 8, JSON.stringify([{ id: 'p', shape: { type: 'polygon', points } }]));
    return statistics.pixelCount;
  };
  const outer = { type: 'rectangle', x: 2, y: 3, width: 20, height: 15 };
  const inner = { type: 'rectangle', x: 8, y: 7, width: 6, height: 5 };

  it('unites, subtracts, intersects and xors ROIs into one polygon', async () => {
    const union = await native.combineRois(roisJson(outer, { type: 'rectangle', x: 10, y: 10, width: 20, height: 10 }), 'union', 40, 30);
    expect(union.pixelCount).toBe(300 + 200 - 96);
    expect(await pixelCount(union.points)).toBe(union.pixelCount);

    // A hole: the polygon joins the outer outline and the hole's outline with a cut
    const hole = await native.combineRois(roisJson(outer, inner), 'subtract', 40, 30);
    expect(hole).toMatchObject({ pixelCount: 270, boundingBox: { x: 2, y: 3, width: 20, height: 15 } });
    expect(await pixelCount(hole.points)).toBe(270);

    expect(await native.combineRois(roisJson(inner, outer), 'subtract', 40, 30)).toEqual({ points: [], pixelCount: 0, boundingBox: null });

    const crossing = { type: 'rectangle', x: 10, y: 10, width: 20, height: 10 };
    const both = await native.combineRois(roisJson(outer, crossing), 'intersect', 40, 30);
    expect(both).toMatchObject({ pixelCount: 12 * 8, boundingBox: { x: 10, y: 10, width: 12, height: 8 } });
    expect(await pixelCount(both.points)).toBe(96);
    const either = await native.combineRois(roisJson(outer, crossing), 'xor', 40, 30);
    expect(either.pixelCount).toBe(300 + 200 - 2 * 96);
    expect(await pixelCount(either.points)).toBe(either.pixelCount);
    expect(() => native.combineRois(roisJson(outer, inner), 'and' as 'union', 40, 30)).toThrow(TypeError);
  });

  it('enlarges, shrinks and makes bands in pixels or millimetres', async () => {
    // The 20 × 15 rectangle: enlarged by 1 it gains a pixel on every side but not the corners (they are √2 away)
    const enlarged = await native.growRoi(roisJson(outer), 'enlarge', 1, 1, 1, 40, 30);
    expect(enlarged.pixelCount).toBe(22 * 17 - 4);
    expect(await pixelCount(enlarged.points)).toBe(enlarged.pixelCount);
    expect(await native.growRoi(roisJson(outer), 'shrink', 2, 1, 1, 40, 30)).toMatchObject({ pixelCount: 16 * 11, boundingBox: { x: 4, y: 5, width: 16, height: 11 } });
    const band = await native.growRoi(roisJson(outer), 'band', 1, 1, 1, 40, 30);
    expect(band.pixelCount).toBe(22 * 17 - 4 - 300);
    expect(await pixelCount(band.points)).toBe(band.pixelCount);

    // 0.5 mm wide and 1 mm high pixels: 1 mm reaches two columns but only one row
    expect((await native.growRoi(roisJson(inner), 'band', 1, 0.5, 1, 40, 30)).boundingBox).toEqual({ x: 6, y: 6, width: 10, height: 7 });

    expect(await native.growRoi(roisJson(inner), 'shrink', 3, 1, 1, 40, 30)).toEqual({ points: [], pixelCount: 0, boundingBox: null });
    expect(await rejectionCode(native.growRoi(roisJson(outer), 'enlarge', -1, 1, 1, 40, 30))).toBe('INVALID_ARGUMENT');
    expect(await rejectionCode(native.growRoi(roisJson(outer, inner), 'enlarge', 1, 1, 1, 40, 30))).toBe('INVALID_ARGUMENT');
    expect(() => native.growRoi(roisJson(outer), 'grow' as 'band', 1, 1, 1, 40, 30)).toThrow(TypeError);
    expect(() => native.growRoi(roisJson(outer), 'band', Number.NaN, 1, 1, 40, 30)).toThrow(TypeError);
  });

  it('paints and erases brush strokes', async () => {
    // Only pixel (5, 5) has its centre within 0.6 of (5.5, 5.5)
    const dot = await native.brushRoi('[]', new Float64Array([5.5, 5.5]), 0.6, false, 40, 30);
    expect(dot).toEqual({ points: [[5, 5], [6, 5], [6, 6], [5, 6]], pixelCount: 1, boundingBox: { x: 5, y: 5, width: 1, height: 1 } });

    const erased = await native.brushRoi(roisJson(outer), new Float64Array([12, 0, 12, 29]), 1.5, true, 40, 30);
    // Pixel centres 10.5 to 13.5 lie within 1.5 of x = 12: four columns
    expect(erased.pixelCount).toBe(300 - 4 * 15);
    expect(await pixelCount(erased.points)).toBe(erased.pixelCount);

    expect(await rejectionCode(native.brushRoi('[]', new Float64Array([1, 1]), 0, false, 40, 30))).toBe('INVALID_ARGUMENT');
    expect(() => native.brushRoi('[]', new Float64Array([1]), 1, false, 40, 30)).toThrow(TypeError);
  });
});

describe('edge detection', () => {
  // Dark background with a bright square [10, 30) x [10, 30)
  const size = 40;
  const pixels = Buffer.from(Array.from({ length: size * size }, (_, i) => {
    const [x, y] = [i % size, Math.floor(i / size)];
    return x >= 10 && x < 30 && y >= 10 && y < 30 ? 220 : 20;
  }));

  it('describes the gradient and renders Sobel and Canny edge maps', async () => {
    const statistics = await native.gradientStatistics(pixels, size, size, 8, 0);
    expect(statistics.sigma).toBe(0);
    expect(statistics.percentiles['50']).toBe(0);
    expect(statistics.max).toBeGreaterThan(statistics.percentiles['99'] - 1e-9);

    const canny = PNG.sync.read(await native.renderEdgeMap(pixels, size, size, 8, 'canny', 1, 20, 60, 0));
    expect([canny.width, canny.height]).toEqual([size, size]);
    // RGBA from pngjs: one edge pixel on each side of the square in a middle row
    const row = Array.from({ length: size }, (_, x) => canny.data[(20 * size + x) * 4]);
    expect(row.filter((value) => value === 255)).toHaveLength(2);

    const sobel = PNG.sync.read(await native.renderEdgeMap(pixels, size, size, 8, 'sobel', 0, 0, 100, 20));
    expect([sobel.width, sobel.height]).toEqual([20, 20]);

    expect(await rejectionCode(native.renderEdgeMap(pixels, size, size, 8, 'sobel', 0, 5, 5, 0))).toBe('INVALID_ARGUMENT');
    expect(await rejectionCode(native.gradientStatistics(pixels, size, size, 8, 11))).toBe('INVALID_ARGUMENT');
    expect(() => native.renderEdgeMap(pixels, size, size, 8, 'prewitt' as 'sobel', 0, 0, 1, 0)).toThrow(TypeError);
  });

  it('finds livewire paths along edges', async () => {
    const flat = Buffer.alloc(size * size, 90);
    expect(await native.livewirePath(flat, size, size, 8, 5, 5, 25, 5, 1)).toEqual([
      [5.5, 5.5],
      [25.5, 5.5],
    ]);
    const path = await native.livewirePath(pixels, size, size, 8, 10, 20, 29, 20, 0);
    expect(path[0]).toEqual([10.5, 20.5]);
    expect(path.at(-1)).toEqual([29.5, 20.5]);
    expect(path.length).toBeGreaterThan(2);
    expect(await rejectionCode(native.livewirePath(pixels, size, size, 8, 0, 0, size, 0, 0))).toBe('INVALID_ARGUMENT');
  });
});

describe('DICOM and NIfTI', () => {
  it('decodes a CT DICOM file with its rescale, spacing and window', async () => {
    const file = await writeFile(
      'ct.dcm',
      encodeDicom({
        rows: 2,
        columns: 2,
        bitsAllocated: 16,
        signed: true,
        data: [-2000, 0, 1000, 3000],
        modality: 'CT',
        rescaleSlope: 1,
        rescaleIntercept: -1024,
        pixelSpacing: [0.8, 0.6],
        windowCenter: 40,
        windowWidth: 400,
      }),
    );
    const image = await native.decodeImageFile(file, { maxPixels: 100 });
    expect(image).toMatchObject({ width: 2, height: 2, bitDepth: 16, pixelSpacing: { x: 0.6, y: 0.8 }, windowMin: 864, windowMax: 1263 });
    expect(image.valueConversion).toEqual({ scale: 1, offset: -1024, unit: 'HU', description: 'Rescale slope 1, intercept -1024; values stored + 1024; HU = stored value - 1024' });
    // -2000 - 1024 HU is below -1024 and stored as 0
    expect([...new Uint16Array(image.pixels.buffer, image.pixels.byteOffset, 4)]).toEqual([0, 0, 1000, 3000]);
    expect(image.warnings).toEqual(['1 pixels below -1024 HU are stored as 0']);

    const png = await native.decodeImageFile(await writeFile('plain.tif', encodeTiff({ width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 1, data: [5] })));
    expect(png.valueConversion).toBeNull();
  });

  it('refuses compressed DICOM files as unsupported', async () => {
    const file = await writeFile('jpeg.dcm', encodeDicom({ rows: 1, columns: 1, bitsAllocated: 8, data: [1], transferSyntax: '1.2.840.10008.1.2.4.50' }));
    await expect(native.decodeImageFile(file)).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE', message: expect.stringMatching(/^Compressed DICOM images/) });
  });

  it('inspects a NIfTI volume and extracts slices in RAS orientation', async () => {
    const source = await writeFile(
      'ramp.nii.gz',
      encodeNifti({ dimensions: [4, 3, 2, 2], dataType: 'int16', data: rampVolume(4, 3, 2, 2), voxelSize: [2, 3, 4], gzip: true }),
    );
    const copy = path.join(directory, 'ramp-copy.nii');
    const info = await native.inspectNiftiVolume(source, copy, { maxBytes: 1000 });
    expect(info).toMatchObject({
      version: 1,
      dimensions: [4, 3, 2],
      volumes: 2,
      dataType: 'int16',
      orientationSource: 'sform',
      axisCodes: 'RAS',
      acquisitionOrientation: 'axial',
      slices: {
        axial: { count: 2, width: 4, height: 3, pixelSpacing: { x: 2, y: 3 } },
        coronal: { count: 3, width: 4, height: 2, pixelSpacing: { x: 2, y: 4 } },
        sagittal: { count: 4, width: 3, height: 2, pixelSpacing: { x: 3, y: 4 } },
      },
      minimum: 0,
      maximum: 1123,
      storage: { kind: 'identity', bitDepth: 16, scale: 1, offset: 0 },
      valueConversion: null,
      windowMin: 0,
      windowMax: 1123,
      warnings: [],
    });
    expect((await fs.stat(copy)).size).toBe(352 + 48 * 2);

    const slice = await native.extractNiftiSlice(copy, { orientation: 'coronal', slice: 1, volume: 1, storage: info.storage, encodePng: true });
    expect(slice).toMatchObject({ width: 4, height: 2, bitDepth: 16, pixelSpacing: { x: 2, y: 4 }, valueConversion: null });
    // Rows from superior: row 0 is k = 1
    expect([...new Uint16Array(slice.pixels.buffer, slice.pixels.byteOffset, 8)]).toEqual([1110, 1111, 1112, 1113, 1010, 1011, 1012, 1013]);
    const decoded = PNG.sync.read(slice.png!, { skipRescale: true });
    expect([decoded.width, decoded.height]).toEqual([4, 2]);

    await expect(native.extractNiftiSlice(copy, { orientation: 'axial', slice: 2, volume: 0, storage: info.storage })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(native.inspectNiftiVolume(source, copy, { maxBytes: 95 })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    expect(() => native.extractNiftiSlice(copy, { orientation: 'oblique' as never, slice: 0, volume: 0, storage: info.storage })).toThrow(/orientation/);
    expect(await rejectionCode(native.inspectNiftiVolume(await writeFile('not.nii', Buffer.alloc(400)), copy))).toBe('DECODE_FAILED');
  });
});
