// The pixels of an ROI as runs per row, under this application's rule (core/roi/Roi.cpp, RasterizeMask) and under
// ImageJ's PolygonFiller, and the outline of a set of runs. Used to write ImageJ ROI files that cover exactly the pixels
// measured here; memory grows with the outline, not the area, so large ROIs stay cheap.

import type { RoiShape } from './analysis.js';

export type Point = [number, number];

/** Row → sorted, disjoint, non-adjacent pixel runs [start0, end0, start1, end1, ...] with end exclusive */
export type Runs = Map<number, number[]>;

interface Size {
  width: number;
  height: number;
}

function clampIndex(index: number, size: number): number {
  return Number.isNaN(index) ? 0 : Math.trunc(Math.min(Math.max(index, 0), size));
}

/** core FirstCentreAtOrAfter: the first pixel whose centre lies at or after the edge */
function firstCentreAtOrAfter(edge: number, size: number): number {
  return clampIndex(Math.ceil(edge - 0.5), size);
}

function addRun(runs: Runs, row: number, start: number, end: number): void {
  if (start >= end) {
    return;
  }
  const line = runs.get(row);
  if (!line) {
    runs.set(row, [start, end]);
    return;
  }
  line.push(start, end);
}

/** Sorts and merges each row's runs, so equal pixel sets give equal Runs */
function normalize(runs: Runs): Runs {
  const result: Runs = new Map();
  for (const row of [...runs.keys()].sort((a, b) => a - b)) {
    const pairs: Array<[number, number]> = [];
    const line = runs.get(row) ?? [];
    for (let i = 0; i < line.length; i += 2) {
      pairs.push([line[i], line[i + 1]]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const merged: number[] = [];
    for (const [start, end] of pairs) {
      if (merged.length > 0 && start <= merged[merged.length - 1]) {
        merged[merged.length - 1] = Math.max(merged[merged.length - 1], end);
      } else {
        merged.push(start, end);
      }
    }
    if (merged.length > 0) {
      result.set(row, merged);
    }
  }
  return result;
}

/** Pixels whose centres the shape covers, clipped to the image: the core's RasterizeMask */
export function shapeRuns(shape: RoiShape, size: Size): Runs {
  switch (shape.type) {
    case 'rectangle':
      return rectangleRuns(shape.x, shape.y, shape.width, shape.height, size);
    case 'ellipse':
      return ellipseRuns(shape.cx, shape.cy, shape.rx, shape.ry, shape.angle ?? 0, size);
    case 'polygon':
      return polygonRuns(shape.points, size);
  }
}

function rectangleRuns(x: number, y: number, width: number, height: number, size: Size): Runs {
  const runs: Runs = new Map();
  const start = firstCentreAtOrAfter(Math.min(x, x + width), size.width);
  const end = firstCentreAtOrAfter(Math.max(x, x + width), size.width);
  const firstRow = firstCentreAtOrAfter(Math.min(y, y + height), size.height);
  const endRow = firstCentreAtOrAfter(Math.max(y, y + height), size.height);
  for (let row = firstRow; row < endRow && start < end; row++) {
    runs.set(row, [start, end]);
  }
  return runs;
}

function ellipseRuns(cx: number, cy: number, rx: number, ry: number, angle: number, size: Size): Runs {
  const runs: Runs = new Map();
  if (rx <= 0 || ry <= 0) {
    return runs;
  }
  const theta = (angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const halfWidth = Math.hypot(rx * cos, ry * sin);
  const halfHeight = Math.hypot(rx * sin, ry * cos);
  const firstCol = clampIndex(Math.floor(cx - halfWidth), size.width);
  const endCol = clampIndex(Math.ceil(cx + halfWidth) + 1, size.width);
  const firstRow = clampIndex(Math.floor(cy - halfHeight), size.height);
  const endRow = clampIndex(Math.ceil(cy + halfHeight) + 1, size.height);
  for (let row = firstRow; row < endRow; row++) {
    const dy = row + 0.5 - cy;
    let start = -1;
    for (let col = firstCol; col < endCol; col++) {
      const dx = col + 0.5 - cx;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      const inside = (u * u) / rx2 + (v * v) / ry2 <= 1;
      if (inside && start < 0) {
        start = col;
      } else if (!inside && start >= 0) {
        addRun(runs, row, start, col);
        start = -1;
      }
    }
    if (start >= 0) {
      addRun(runs, row, start, endCol);
    }
  }
  return normalize(runs);
}

/** Even-odd rule at pixel-centre rows; an edge crosses row y when y lies in [min(ya, yb), max(ya, yb)) */
function polygonRuns(points: readonly Point[], size: Size): Runs {
  const crossings = new Map<number, number[]>();
  const count = points.length;
  if (count < 3) {
    return new Map();
  }
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % count];
    if (a[1] === b[1]) {
      continue;
    }
    const low = Math.min(a[1], b[1]);
    const high = Math.max(a[1], b[1]);
    const firstRow = Math.max(0, Math.floor(low) - 1);
    const endRow = Math.min(size.height, Math.ceil(high) + 1);
    for (let row = firstRow; row < endRow; row++) {
      const y = row + 0.5;
      if ((a[1] <= y && y < b[1]) || (b[1] <= y && y < a[1])) {
        let x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        if (!Number.isFinite(x)) {
          const t = (y - a[1]) / (b[1] - a[1]);
          x = a[0] * (1 - t) + b[0] * t;
        }
        const line = crossings.get(row);
        if (line) {
          line.push(x);
        } else {
          crossings.set(row, [x]);
        }
      }
    }
  }
  const runs: Runs = new Map();
  for (const [row, line] of crossings) {
    line.sort((p, q) => p - q);
    for (let k = 0; k + 1 < line.length; k += 2) {
      addRun(runs, row, firstCentreAtOrAfter(line[k], size.width), firstCentreAtOrAfter(line[k + 1], size.width));
    }
  }
  return normalize(runs);
}

/**
 * The pixels ImageJ fills for a polygon with these (float32) vertices: ij/process/PolygonFiller.java. Rows start at
 * Math.round of the upper vertex, and a pixel is filled from (int)(x + 0.5) to (int)(x + 0.5) of the next crossing,
 * where every crossing carries +1e-8.
 */
export function imagejPolygonRuns(points: readonly Point[], size: Size): Runs {
  const count = points.length;
  const crossings = new Map<number, number[]>();
  const javaRound = (value: number) => Math.floor(value + 0.5);
  for (let i = 0; i < count; i++) {
    let [x1f, y1f] = points[i];
    let [x2f, y2f] = points[(i + 1) % count];
    let y1 = javaRound(y1f);
    let y2 = javaRound(y2f);
    if (y1 === y2 || (y1 <= 0 && y2 <= 0)) {
      continue;
    }
    if (y1 > y2) {
      [y1, y2] = [y2, y1];
      [y1f, y2f] = [y2f, y1f];
      [x1f, x2f] = [x2f, x1f];
    }
    const slope = (x2f - x1f) / (y2f - y1f);
    const x0 = x1f + (y1 - y1f + 0.5) * slope + 1e-8;
    for (let row = Math.max(y1, 0); row < Math.min(y2, size.height); row++) {
      const x = x0 + slope * (row - y1);
      const line = crossings.get(row);
      if (line) {
        line.push(x);
      } else {
        crossings.set(row, [x]);
      }
    }
  }
  const runs: Runs = new Map();
  for (const [row, line] of crossings) {
    line.sort((p, q) => p - q);
    for (let k = 0; k + 1 < line.length; k += 2) {
      const start = Math.min(Math.max(Math.trunc(line[k] + 0.5), 0), size.width);
      const end = Math.min(Math.max(Math.trunc(line[k + 1] + 0.5), 0), size.width);
      addRun(runs, row, start, end);
    }
  }
  return normalize(runs);
}

export function sameRuns(a: Runs, b: Runs): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [row, line] of a) {
    const other = b.get(row);
    if (!other || other.length !== line.length || other.some((value, i) => value !== line[i])) {
      return false;
    }
  }
  return true;
}

export function runsPixelCount(runs: Runs): number {
  let count = 0;
  for (const line of runs.values()) {
    for (let i = 0; i < line.length; i += 2) {
      count += line[i + 1] - line[i];
    }
  }
  return count;
}

/**
 * The outline of the pixels as closed loops along pixel edges, with the pixels on the right when walking clockwise on
 * screen: outer boundaries run clockwise, holes counter-clockwise. Under the even-odd rule the loops cover exactly the
 * pixels. Collinear vertices are left out.
 */
export function runsOutline(runs: Runs): Point[][] {
  // Directed unit-free edges keyed by their start vertex
  const edges = new Map<string, Point[]>();
  const add = (from: Point, to: Point) => {
    const key = `${from[0]},${from[1]}`;
    const list = edges.get(key);
    if (list) {
      list.push(to);
    } else {
      edges.set(key, [to]);
    }
  };
  const rows = [...runs.keys()].sort((a, b) => a - b);
  const empty: number[] = [];
  // Vertical edges: up along the left end of a run, down along the right end
  for (const row of rows) {
    const line = runs.get(row) ?? empty;
    for (let i = 0; i < line.length; i += 2) {
      add([line[i], row + 1], [line[i], row]);
      add([line[i + 1], row], [line[i + 1], row + 1]);
    }
  }
  // Horizontal edges on the line y = row: where exactly one of the rows above and below is covered
  const lines = new Set<number>();
  for (const row of rows) {
    lines.add(row);
    lines.add(row + 1);
  }
  for (const y of lines) {
    const above = runs.get(y - 1) ?? empty;
    const below = runs.get(y) ?? empty;
    const cuts = [...new Set([...above, ...below])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const middle = (cuts[i] + cuts[i + 1]) / 2;
      const inAbove = covers(above, middle);
      const inBelow = covers(below, middle);
      if (inBelow && !inAbove) {
        add([cuts[i], y], [cuts[i + 1], y]); // top boundary, pixels below: walk right
      } else if (inAbove && !inBelow) {
        add([cuts[i + 1], y], [cuts[i], y]); // bottom boundary, pixels above: walk left
      }
    }
  }

  const loops: Point[][] = [];
  const starts = [...edges.keys()].sort(compareKeys);
  for (const startKey of starts) {
    while ((edges.get(startKey)?.length ?? 0) > 0) {
      const start = parseKey(startKey);
      const loop: Point[] = [start];
      let key = startKey;
      for (;;) {
        const next = edges.get(key)?.pop();
        if (!next) {
          break;
        }
        key = `${next[0]},${next[1]}`;
        if (key === startKey) {
          break;
        }
        loop.push(next);
      }
      loops.push(withoutCollinear(loop));
    }
  }
  return loops;
}

function covers(line: readonly number[], x: number): boolean {
  for (let i = 0; i < line.length; i += 2) {
    if (line[i] <= x && x < line[i + 1]) {
      return true;
    }
  }
  return false;
}

function parseKey(key: string): Point {
  const [x, y] = key.split(',').map(Number);
  return [x, y];
}

function compareKeys(a: string, b: string): number {
  const [ax, ay] = parseKey(a);
  const [bx, by] = parseKey(b);
  return ay - by || ax - bx;
}

function withoutCollinear(loop: readonly Point[]): Point[] {
  return loop.filter((point, i) => {
    const previous = loop[(i + loop.length - 1) % loop.length];
    const next = loop[(i + 1) % loop.length];
    return !((previous[0] === point[0] && point[0] === next[0]) || (previous[1] === point[1] && point[1] === next[1]));
  });
}
