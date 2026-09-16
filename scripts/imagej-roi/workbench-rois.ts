// Writes the ROIs the workbench exports for the ImageJ check (see README.md in this folder):
// packages/api/test/data/imagej/workbench-rois.json (the ROIs as drawn here) and workbench-RoiSet.zip (as written for
// ImageJ). ImageJRoiReference.java then measures the archive in ImageJ.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Roi } from '@glcm/api';
import { writeImageJRois } from '../../packages/api/src/imagejRoi.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'api', 'test', 'data', 'imagej');
export const SIZE = { width: 256, height: 256 };

const square = (x: number, y: number, size: number): Array<[number, number]> => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

export const WORKBENCH_ROIS: Roi[] = [
  { id: 'r1', name: 'rectangle', shape: { type: 'rectangle', x: 10, y: 10, width: 40, height: 25 } },
  { id: 'r2', name: 'rectangle sub-pixel', shape: { type: 'rectangle', x: 10.3, y: 200.6, width: 30.4, height: 20.2 } },
  { id: 'r3', name: 'rectangle drawn leftwards', shape: { type: 'rectangle', x: 120, y: 40, width: -30, height: -20 } },
  { id: 'e1', name: 'ellipse on whole pixels', color: '#2F9E44', shape: { type: 'ellipse', cx: 60.5, cy: 80, rx: 20.5, ry: 12 } },
  { id: 'e2', name: 'ellipse', shape: { type: 'ellipse', cx: 150.2, cy: 60.7, rx: 18.3, ry: 9.6 } },
  { id: 'e3', name: 'rotated ellipse', shape: { type: 'ellipse', cx: 200, cy: 200, rx: 30, ry: 12, angle: 30 } },
  { id: 'e4', name: 'ellipse turned 90 degrees', shape: { type: 'ellipse', cx: 220, cy: 40, rx: 15, ry: 7, angle: 90 } },
  { id: 'p1', name: 'polygon', shape: { type: 'polygon', points: [[20, 120], [70, 110], [90, 160], [50, 180], [15, 150]] } },
  {
    id: 'p2',
    name: 'livewire through pixel centres',
    shape: { type: 'polygon', points: [[100.5, 100.5], [130.5, 110.5], [150.5, 140.5], [120.5, 170.5], [95.5, 150.5]] },
  },
  {
    id: 'p3',
    name: 'freehand',
    shape: { type: 'polygon', freehand: true, points: Array.from({ length: 40 }, (_, i) => [180 + 25.37 * Math.cos(i / 6.37), 120 + 17.91 * Math.sin(i / 6.37)] as [number, number]) },
  },
  {
    id: 'p4',
    name: 'square with a hole',
    // As union and subtract return it: the outer loop, a zero-width cut to the hole, the hole backwards, and the cut back
    shape: { type: 'polygon', points: [...square(220, 210, 30), [220, 210], ...square(230, 218, 10).reverse(), [230, 228]] },
  },
  { id: 'p5', name: 'polygon over the edge', shape: { type: 'polygon', points: [[-10, 230], [30, 225], [25, 270], [-5, 262]] } },
  { id: 'p6', name: 'thin diagonal', shape: { type: 'polygon', points: [[60, 200], [61.2, 200], [101.2, 240], [100, 240]] } },
  { id: 'n1', name: 'Läsion α', color: '#E64B35', shape: { type: 'rectangle', x: 150, y: 150, width: 12, height: 12 } },
  { id: 'n2', name: 'Läsion α', shape: { type: 'rectangle', x: 170, y: 150, width: 12, height: 12 } },
  { id: 'x1', name: 'too small for a pixel', shape: { type: 'ellipse', cx: 5.5, cy: 250, rx: 0.2, ry: 0.2 } },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const { bytes, outlined, empty } = writeImageJRois(WORKBENCH_ROIS, SIZE);
  fs.writeFileSync(path.join(DATA, 'workbench-rois.json'), `${JSON.stringify({ ...SIZE, rois: WORKBENCH_ROIS }, null, 2)}\n`);
  fs.writeFileSync(path.join(DATA, 'workbench-RoiSet.zip'), bytes);
  console.log(`Wrote ${WORKBENCH_ROIS.length - empty.length} ROIs; outlined: ${outlined.join(', ')}; empty: ${empty.join(', ')}`);
}
