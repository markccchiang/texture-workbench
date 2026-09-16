// ImageJ ROI files against ImageJ itself: the reference archives in test/data/imagej were written and measured by
// ImageJ 1.54p (scripts/imagej-roi/), and the pixels here come from the core through the addon.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as native from '@glcm/native';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Roi, RoiShape } from '../src/analysis.js';
import { ImageJRoiError, isImageJRoiFileName, readImageJRois, withImageJTies, writeImageJRois } from '../src/imagejRoi.js';
import { imagejPolygonRuns, runsOutline, runsPixelCount, shapeRuns } from '../src/roiPixels.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'imagej');
const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(DATA, name)));
const json = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')) as T;

interface Described {
  imagej: string;
  width: number;
  height: number;
  rois: Array<{ entry: string; name: string; type: string; color?: string; pixels?: { count: number; sum: number; sumSquares: number } }>;
}

const SIZE = 256;
/** A 16-bit image whose value is the pixel index y * 256 + x, so statistics of an ROI identify its pixels */
const INDEX_IMAGE = new Uint8Array(new Uint16Array(SIZE * SIZE).map((_, i) => i).buffer);

/** Count, index sum and index sum of squares of the pixels the core covers for each shape */
async function corePixels(shapes: readonly RoiShape[]): Promise<Array<{ count: number; sum: number; sumSquares: number }>> {
  const stats = await native.roiStats(INDEX_IMAGE, SIZE, SIZE, 16, JSON.stringify(shapes.map((shape, i) => ({ id: `s${i}`, shape }))));
  return stats.map(({ pixelCount, mean, std }) => {
    const sum = (mean ?? 0) * pixelCount;
    // std is the sample standard deviation
    const sumSquares = pixelCount > 1 ? (std ?? 0) ** 2 * (pixelCount - 1) + (sum * sum) / pixelCount : sum * sum;
    return { count: pixelCount, sum, sumSquares };
  });
}

function expectSamePixels(actual: { count: number; sum: number; sumSquares: number }, expected: { count: number; sum: number; sumSquares: number }, what: string) {
  expect(actual.count, what).toBe(expected.count);
  // One pixel more or less changes the sum by at least 1 in 1e8 and the sum of squares by at least 1 in 1e7
  expect(Math.abs(actual.sum - expected.sum), what).toBeLessThanOrEqual(1e-9 * Math.max(1, expected.sum));
  expect(Math.abs(actual.sumSquares - expected.sumSquares), what).toBeLessThanOrEqual(1e-9 * Math.max(1, expected.sumSquares));
}

function runsPixels(shape: RoiShape): { count: number; sum: number; sumSquares: number } {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  for (const [row, line] of shapeRuns(shape, { width: SIZE, height: SIZE })) {
    for (let k = 0; k < line.length; k += 2) {
      for (let x = line[k]; x < line[k + 1]; x++) {
        const index = row * SIZE + x;
        count += 1;
        sum += index;
        sumSquares += index * index;
      }
    }
  }
  return { count, sum, sumSquares };
}

describe('reading ImageJ ROIs', () => {
  const reference = json<Described>('imagej-rois.json');
  const { document, warnings } = readImageJRois(read('imagej-rois.zip'), 'imagej-rois.zip');

  it('covers exactly the pixels ImageJ covers, for every kind of ROI with an area', async () => {
    const withArea = reference.rois.filter((entry) => entry.pixels);
    expect(withArea.length).toBeGreaterThan(50);
    expect(document.rois.map((roi) => roi.name)).toEqual(withArea.map((entry) => entry.name));
    const pixels = await corePixels(document.rois.map((roi) => roi.shape));
    withArea.forEach((entry, i) => expectSamePixels(pixels[i], entry.pixels!, `${entry.name} (${entry.type})`));
  });

  it('keeps names and stroke colours, and says which selections have no area', () => {
    expect(document.rois.find((roi) => roi.name === 'Läsion α')?.color).toBe('#E64B35');
    expect(document.rois.find((roi) => roi.name === 'oval')?.color).toBeUndefined();
    expect(new Set(document.rois.map((roi) => roi.id)).size).toBe(document.rois.length);
    expect(warnings).toEqual(['Skipped 4 selections without an area (lines, points or text), which texture cannot be measured in: line, points, polyline, angle.']);
  });

  it('reads a single .roi file, recognised by its content', () => {
    const single = readImageJRois(read('oval.roi'), 'lesion.roi');
    expect(single.document.rois).toEqual([{ id: 'imagej-1', name: 'Läsion α', color: '#E64B35', shape: { type: 'ellipse', cx: 70, cy: 70, rx: 10, ry: 10 } }]);
    expect(single.warnings).toEqual([]);
    expect(['RoiSet.zip', 'cell.ROI', 'set.roi.json', 'image.png'].map(isImageJRoiFileName)).toEqual([true, true, false, false]);
  });

  it('refuses files that are not ImageJ ROIs, and skips damaged entries of an archive', () => {
    expect(() => readImageJRois(new TextEncoder().encode('{"format": "glcm-roi-set"}'), 'set.roi')).toThrow(ImageJRoiError);
    expect(() => readImageJRois(read('oval.roi').subarray(0, 40), 'cut.roi')).toThrow('cut is not an ImageJ ROI.');
    expect(() => readImageJRois(zipSync({ 'notes.txt': new TextEncoder().encode('hello') }), 'RoiSet.zip')).toThrow('RoiSet.zip contains no ImageJ ROIs (.roi files).');

    const polygon = unzipSync(read('imagej-rois.zip'))['polygon.roi'];
    const damaged = zipSync({ 'cut.roi': polygon.subarray(0, 70), 'whole.roi': polygon, 'other.roi': new Uint8Array([1, 2, 3]) });
    const partly = readImageJRois(damaged, 'RoiSet.zip');
    expect(partly.document.rois.map((roi) => roi.name)).toEqual(['polygon']);
    expect(partly.warnings).toEqual(['cut is cut short.', 'other is not an ImageJ ROI.']);

    // A name longer than the file falls back to the file name, as in ImageJ
    const oval = read('oval.roi').slice();
    const view = new DataView(oval.buffer);
    view.setInt32(view.getInt32(60) + 20, 0x7fffffff);
    expect(readImageJRois(oval, 'lesion.roi').document.rois[0].name).toBe('lesion');
  });

  it('breaks ties on edges as ImageJ does, with offsets that writing removes again', () => {
    // The diagonal from (0, 0) to (4, 4) is the right edge of this triangle and passes through the pixel centres (0.5, 0.5),
    // (1.5, 1.5), ...: outside here, where a centre on a right edge is outside, and inside in ImageJ
    const triangle: Array<[number, number]> = [[0, 0], [4, 4], [0, 4]];
    const size = { width: 8, height: 8 };
    const here = runsPixelCount(shapeRuns({ type: 'polygon', points: triangle }, size));
    const imagej = runsPixelCount(imagejPolygonRuns(triangle, size));
    expect([here, imagej]).toEqual([6, 10]);
    expect(runsPixelCount(shapeRuns({ type: 'polygon', points: withImageJTies(triangle) }, size))).toBe(imagej);
    // Written and read again, the vertices are the original ones with the offsets added once, not twice
    const roi: Roi = { id: 't', name: 'triangle', shape: { type: 'polygon', points: withImageJTies(triangle) } };
    const again = readImageJRois(writeImageJRois([roi], size).bytes, 'RoiSet.zip').document.rois[0].shape;
    expect(again).toEqual({ type: 'polygon', points: withImageJTies(triangle) });
  });
});

describe('writing ImageJ ROIs', () => {
  const source = json<{ width: number; height: number; rois: Roi[] }>('workbench-rois.json');
  const measured = json<Described>('workbench-imagej.json');
  const written = writeImageJRois(source.rois, source);

  it('writes files ImageJ measures on exactly the pixels measured here', async () => {
    const kept = source.rois.filter((roi) => !written.empty.includes(roi.name));
    const pixels = await corePixels(kept.map((roi) => roi.shape));
    expect(measured.rois.map((entry) => entry.name)).toEqual(kept.map((roi) => roi.name));
    measured.rois.forEach((entry, i) => expectSamePixels(pixels[i], entry.pixels!, `${entry.name} (${entry.type})`));
    expect(measured.rois.find((entry) => entry.name === 'ellipse on whole pixels')).toMatchObject({ type: 'Oval', color: '#2F9E44' });
    expect(measured.rois.find((entry) => entry.name === 'square with a hole')?.type).toBe('Composite');
  });

  it('writes the same bytes ImageJ measured, and unique entry names', () => {
    const now = unzipSync(written.bytes);
    const checked = unzipSync(read('workbench-RoiSet.zip'));
    expect(Object.keys(now)).toEqual(measured.rois.map((entry) => entry.entry));
    for (const [entry, bytes] of Object.entries(checked)) {
      expect(Buffer.from(now[entry]).equals(Buffer.from(bytes)), entry).toBe(true);
    }
    expect(written.empty).toEqual(['too small for a pixel']);
    expect(written.outlined).toContain('livewire through pixel centres');
    expect(written.outlined).not.toContain('freehand');
  });

  it('reads back what it writes, with the same pixels, names and colours', async () => {
    const back = readImageJRois(written.bytes, 'RoiSet.zip');
    const kept = source.rois.filter((roi) => !written.empty.includes(roi.name));
    expect(back.document.rois.map(({ name, color }) => ({ name, color }))).toEqual(kept.map(({ name, color }) => ({ name, color })));
    const [before, after] = await Promise.all([corePixels(kept.map((roi) => roi.shape)), corePixels(back.document.rois.map((roi) => roi.shape))]);
    before.forEach((pixels, i) => expectSamePixels(after[i], pixels, kept[i].name));
  });
});

describe('stack positions', () => {
  it('writes the slice as the ROI position and reads it back, also from hyperstack positions', () => {
    const shape: RoiShape = { type: 'rectangle', x: 2, y: 3, width: 5, height: 4 };
    const rois: Roi[] = [
      { id: 'a', name: 'On 3', slice: 3, shape },
      { id: 'b', name: 'Everywhere', shape },
    ];
    const written = writeImageJRois(rois, { width: 32, height: 32 });
    const files = unzipSync(written.bytes);
    const position = (name: string) => new DataView(files[name].buffer, files[name].byteOffset).getInt32(56);
    expect(position('On 3.roi')).toBe(3);
    expect(position('Everywhere.roi')).toBe(0);
    expect(readImageJRois(written.bytes, 'RoiSet.zip').document.rois.map((roi) => roi.slice)).toEqual([3, undefined]);

    // A hyperstack ROI keeps its slice in header 2 (z, else t) with position 0
    const hyperstack = new Uint8Array(files['Everywhere.roi']);
    const view = new DataView(hyperstack.buffer);
    view.setInt32(view.getInt32(60) + 8, 7);
    expect(readImageJRois(hyperstack, 'z.roi').document.rois[0].slice).toBe(7);
  });
});

describe('pixels as runs', () => {
  it('match the core for rectangles, ellipses and polygons, also where they leave the image', async () => {
    const random = mulberry32(7);
    const shapes: RoiShape[] = [...json<{ rois: Roi[] }>('workbench-rois.json').rois.map((roi) => roi.shape)];
    for (let i = 0; i < 150; i++) {
      const cx = random() * 300 - 22;
      const cy = random() * 300 - 22;
      if (i % 3 === 0) {
        shapes.push({ type: 'rectangle', x: cx, y: cy, width: random() * 80 - 40, height: random() * 80 - 40 });
      } else if (i % 3 === 1) {
        shapes.push({ type: 'ellipse', cx, cy, rx: random() * 40, ry: random() * 40, angle: random() * 360 });
      } else {
        const n = 3 + Math.floor(random() * 12);
        const points = Array.from({ length: n }, () => [cx + random() * 80 - 40, cy + random() * 80 - 40] as [number, number]);
        shapes.push({ type: 'polygon', points: i % 2 === 0 ? points.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number]) : points });
      }
    }
    const pixels = await corePixels(shapes);
    shapes.forEach((shape, i) => expectSamePixels(runsPixels(shape), pixels[i], JSON.stringify(shape)));
  });

  it('outline the pixels with loops that cover them exactly, holes and diagonal touches included', () => {
    const size = { width: 16, height: 16 };
    // A ring, and two squares touching at a corner
    const ring: RoiShape = { type: 'polygon', points: [[2, 2], [10, 2], [10, 10], [2, 10], [2, 2], [4, 4], [4, 8], [8, 8], [8, 4], [4, 4]] };
    const touching: RoiShape = { type: 'polygon', points: [[11, 11], [13, 11], [13, 13], [15, 13], [15, 15], [13, 15], [13, 13], [11, 13]] };
    for (const shape of [ring, touching]) {
      const runs = shapeRuns(shape, size);
      const loops = runsOutline(runs);
      const chained: RoiShape = { type: 'polygon', points: loops.flatMap((loop) => [...loop, loop[0]]).concat(loops.slice(0, -1).reverse().map((loop) => loop[0])) };
      expect(shapeRuns(chained, size)).toEqual(runs);
    }
    expect(runsOutline(shapeRuns(ring, size)).map((loop) => loop.length)).toEqual([4, 4]);
  });
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
