// ImageJ ROI files: single .roi files and the RoiSet.zip archives of ImageJ's ROI Manager, read into ROI sets and
// written from them. The format follows ij/io/RoiDecoder.java and RoiEncoder.java of ImageJ 1.54p; the pixels an ROI
// covers follow ImageJ's own masks (ij/process/PolygonFiller.java, OvalRoi.getMask, ShapeRoi.getMask), checked against
// ImageJ by scripts/imagej-roi/.

import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { EllipseShape, PolygonShape, Roi, RoiShape } from './analysis.js';
import { MAX_POLYGON_VERTICES, MAX_ROIS_PER_REQUEST } from './analysis.js';
import type { RoiSetDocument } from './exports.js';
import { MAX_SLICES } from './schemas.js';
import { imagejPolygonRuns, runsOutline, sameRuns, shapeRuns, type Point, type Runs } from './roiPixels.js';

// Header offsets (RoiDecoder)
const VERSION_OFFSET = 4;
const TYPE = 6;
const TOP = 8;
const LEFT = 10;
const BOTTOM = 12;
const RIGHT = 14;
const N_COORDINATES = 16;
const SIZE = 18;
const SHAPE_ROI_SIZE = 36;
const STROKE_COLOR = 40;
const SUBTYPE = 48;
const OPTIONS = 50;
const ROUNDED_RECT_ARC_SIZE = 54;
const POSITION = 56;
const HEADER2_OFFSET = 60;
const COORDINATES = 64;
const HEADER_SIZE = 64;
const HEADER2_SIZE = 64;
// Header 2 offsets
const Z_POSITION = 8;
const T_POSITION = 12;
const NAME_OFFSET = 16;
const NAME_LENGTH = 20;

const SUB_PIXEL_RESOLUTION = 128;
const SPLINE_FIT = 1;
const SUBTYPE_TEXT = 1;
const SUBTYPE_IMAGE = 4;
/** RoiEncoder.VERSION of ImageJ 1.52t and later */
const WRITTEN_VERSION = 228;

const TYPES = ['polygon', 'rectangle', 'oval', 'line', 'freeline', 'polyline', 'no ROI', 'freehand', 'traced', 'angle', 'point'] as const;
type ImageJType = (typeof TYPES)[number];
const TYPE_CODE: Record<ImageJType, number> = Object.fromEntries(TYPES.map((type, code) => [type, code])) as Record<ImageJType, number>;

export class ImageJRoiError extends Error {}

export interface ImageJRoiImport {
  /** The ROIs with an area, as an ROI set; clip it to the image like any other set */
  document: RoiSetDocument;
  /** What was left out and why, one sentence each */
  warnings: string[];
}

/** File names this module reads: a single ImageJ ROI or an ROI Manager archive */
export function isImageJRoiFileName(name: string): boolean {
  return /\.(roi|zip)$/i.test(name);
}

/** Reads a .roi file or a RoiSet.zip archive (recognised by their content, not the name) */
export function readImageJRois(bytes: Uint8Array, fileName: string): ImageJRoiImport {
  const archive = isZip(bytes);
  const entries = archive ? zipEntries(bytes, fileName) : [{ name: fileName, bytes }];
  const rois: Roi[] = [];
  const withoutArea: string[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    let decoded: Decoded;
    try {
      decoded = decodeImageJRoi(entry.bytes, baseName(entry.name));
    } catch (error) {
      // One damaged entry leaves the rest of an archive readable
      if (!archive || !(error instanceof ImageJRoiError)) {
        throw error;
      }
      warnings.push(error.message);
      continue;
    }
    if ('skipped' in decoded) {
      withoutArea.push(decoded.name);
      continue;
    }
    if (rois.length === MAX_ROIS_PER_REQUEST) {
      warnings.push(`Only the first ${MAX_ROIS_PER_REQUEST} ROIs were read.`);
      break;
    }
    rois.push({
      id: `imagej-${rois.length + 1}`,
      name: decoded.name.slice(0, 200) || `ROI ${rois.length + 1}`,
      ...(decoded.color ? { color: decoded.color } : {}),
      ...(roiSlice(entry.bytes) !== undefined ? { slice: roiSlice(entry.bytes) } : {}),
      shape: decoded.shape,
    });
  }
  if (withoutArea.length > 0) {
    const what = withoutArea.length === 1 ? 'a selection' : `${withoutArea.length} selections`;
    warnings.push(`Skipped ${what} without an area (lines, points or text), which texture cannot be measured in: ${withoutArea.join(', ')}.`);
  }
  return { document: { format: 'glcm-roi-set', version: 1, rois }, warnings };
}

type Decoded = { name: string; color: string | null; shape: RoiShape } | { name: string; skipped: true };

function decodeImageJRoi(bytes: Uint8Array, fallbackName: string): Decoded {
  const data = new Reader(bytes);
  if (bytes.length < HEADER_SIZE || data.byte(0) !== 73 || data.byte(1) !== 111) {
    throw new ImageJRoiError(`${fallbackName} is not an ImageJ ROI.`);
  }
  const version = data.short(VERSION_OFFSET);
  const typeCode = data.byte(TYPE);
  const type = TYPES[typeCode];
  if (!type) {
    throw new ImageJRoiError(`${fallbackName} has an unknown ImageJ ROI type (${typeCode}).`);
  }
  const subtype = data.short(SUBTYPE);
  const options = data.short(OPTIONS);
  const name = roiName(data, fallbackName);
  const color = version >= 218 ? strokeColor(data.int(STROKE_COLOR)) : null;
  if (subtype === SUBTYPE_TEXT || subtype === SUBTYPE_IMAGE) {
    return { name, skipped: true };
  }

  const top = data.short(TOP);
  const left = data.short(LEFT);
  const width = data.short(RIGHT) - left;
  const height = data.short(BOTTOM) - top;

  const shapeSize = data.int(SHAPE_ROI_SIZE);
  if (shapeSize > 0) {
    if (HEADER_SIZE + shapeSize * 4 > bytes.length) {
      throw new ImageJRoiError(`${fallbackName} is cut short.`);
    }
    const segments = Array.from({ length: shapeSize }, (_, i) => data.float(COORDINATES + i * 4));
    return { name, color, shape: compositeShape(segments, name) };
  }

  switch (type) {
    // ImageJ measures rectangles and ovals on their integer bounds, also when sub-pixel bounds are stored
    case 'rectangle': {
      const arc = data.short(ROUNDED_RECT_ARC_SIZE);
      const shape: RoiShape =
        arc > 0 ? compositeShape(roundedRectanglePath(left, top, width, height, arc), name) : { type: 'rectangle', x: left, y: top, width, height };
      return { name, color, shape };
    }
    case 'oval':
      return { name, color, shape: { type: 'ellipse', cx: left + width / 2, cy: top + height / 2, rx: width / 2, ry: height / 2 } };
    case 'polygon':
    case 'freehand':
    case 'traced': {
      let n = data.unsignedShort(N_COORDINATES);
      if (n === 0) {
        n = data.int(SIZE);
      }
      const subPixel = (options & SUB_PIXEL_RESOLUTION) !== 0 && version >= 222;
      if (n <= 0 || HEADER_SIZE + n * (subPixel ? 12 : 4) > bytes.length) {
        throw new ImageJRoiError(`${fallbackName} is cut short.`);
      }
      const points: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        points.push(
          subPixel
            ? [data.float(COORDINATES + 4 * n + i * 4), data.float(COORDINATES + 8 * n + i * 4)]
            : [left + Math.max(0, data.short(COORDINATES + i * 2)), top + Math.max(0, data.short(COORDINATES + 2 * n + i * 2))],
        );
      }
      const splineFit = (options & SPLINE_FIT) !== 0 && version >= 218;
      const outline = splineFit ? fitSpline(points, type === 'freehand') : points;
      const shape: PolygonShape = { type: 'polygon', points: limitVertices(withImageJTies(outline), name), ...(type === 'polygon' && !splineFit ? {} : { freehand: true }) };
      return { name, color, shape };
    }
    default:
      return { name, skipped: true };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pixels on the edge
// ---------------------------------------------------------------------------------------------------------------------

/** ImageJ's PolygonFiller adds this to every edge crossing before it rounds to pixels */
const IMAGEJ_CROSSING_OFFSET = 1e-8;
/** Moves vertices lying exactly on a pixel-centre row just below it; small enough to leave crossings within 1e-9 */
const HALF_ROW_OFFSET = 1e-10;

/**
 * A polygon that covers exactly the pixels ImageJ fills for these vertices. Both fill the pixels whose centres lie
 * inside, but break ties the other way: a centre exactly on an edge counts as inside here on the left and top edges,
 * and in ImageJ on the right and bottom edges (its crossings carry +1e-8 and its rows start after a vertex on a centre
 * row). Moving the polygon right by that 1e-8, and vertices on a centre row down by a much smaller amount, turns one
 * rule into the other. The offsets are far below the gap between a crossing and the nearest centre when the crossing
 * is not a tie (at least 1/131072 px for integer vertices), and writing the ROI back to ImageJ removes them again.
 */
export function withImageJTies(points: readonly Point[]): Point[] {
  return points.map(([x, y]) => [x + IMAGEJ_CROSSING_OFFSET, Number.isInteger(y - 0.5) ? y + HALF_ROW_OFFSET : y]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Spline fitting (PolygonRoi.fitSpline and ij/measure/SplineFitter.java), in ImageJ's float32 arithmetic
// ---------------------------------------------------------------------------------------------------------------------

const f32 = Math.fround;
/** SplineFitter.EXTEND_BY: points of periodic continuation at both ends of a closed curve */
const SPLINE_EXTEND_BY = 7;

/**
 * The outline ImageJ fills for a spline-fitted ROI: a closed natural cubic spline through the stored points, evaluated
 * at max(100, perimeter / 2) positions. ImageJ keeps coordinates as float32 relative to the ROI's bounds, which this
 * follows, so the vertices come out as ImageJ's do.
 */
function fitSpline(absolute: readonly Point[], freehand: boolean): Point[] {
  const n = absolute.length;
  if (n < 3) {
    return [...absolute];
  }
  // ImageJ keeps the points relative to the ROI's bounds
  const [xBase, yBase] = minima(absolute);
  const xs = absolute.map(([x]) => f32(x - xBase));
  const ys = absolute.map(([, y]) => f32(y - yBase));

  const length = freehand ? smoothedPerimeter(xs, ys) : perimeter(xs, ys);
  const evaluationPoints = Math.max(100, Math.trunc(length / 2));

  const nodes = new Array<number>(n + 1);
  nodes[0] = 0;
  let last = 0;
  const step = (i: number, j: number) => {
    const dx = f32(xs[i] - xs[j]);
    const dy = f32(ys[i] - ys[j]);
    let d = f32(Math.sqrt(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy)))));
    if (d < f32(0.001)) {
      d = f32(0.001);
    }
    last = f32(last + d);
    return last;
  };
  for (let i = 1; i < n; i++) {
    nodes[i] = step(i, i - 1);
  }
  nodes[n] = step(n - 1, 0);
  const xsClosed = [...xs, xs[0]];
  const ysClosed = [...ys, ys[0]];
  const splineX = new SplineFitter(nodes, xsClosed);
  const splineY = new SplineFitter(nodes, ysClosed);
  const scale = last / (evaluationPoints - 1);
  const relative: Point[] = [];
  for (let i = 0; i < evaluationPoints; i++) {
    const t = i * scale;
    relative.push([f32(splineX.eval(t)), f32(splineY.eval(t))]);
  }
  // setSpline moves the spline to its own float bounds (resetSplineFitBoundingRect), again in float32
  const moved = relative.map(([x, y]) => [f32(x + xBase), f32(y + yBase)] as Point);
  const [xBase2, yBase2] = minima(moved);
  return moved.map(([x, y]) => [f32(x - xBase2) + xBase2, f32(y - yBase2) + yBase2]);
}

/** The smallest x and y, in one pass: outlines can have too many points to spread into Math.min */
function minima(points: readonly Point[]): [number, number] {
  let x = Infinity;
  let y = Infinity;
  for (const point of points) {
    x = Math.min(x, point[0]);
    y = Math.min(y, point[1]);
  }
  return [f32(x), f32(y)];
}

function perimeter(xs: readonly number[], ys: readonly number[]): number {
  let length = 0;
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    length += Math.sqrt(f32(xs[j] - xs[i]) ** 2 + f32(ys[j] - ys[i]) ** 2);
  }
  return length;
}

/** PolygonRoi.getFloatSmoothedPerimeter: the length after a 3-point running average, closed by the last point */
function smoothedPerimeter(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const sum3 = (v: readonly number[], a: number, b: number, c: number) => f32(f32(v[a] + v[b]) + v[c]);
  let length = Math.hypot(sum3(xs, 0, 1, 2) / 3 - xs[0], sum3(ys, 0, 1, 2) / 3 - ys[0]);
  for (let i = 1; i < n - 2; i++) {
    const dx = f32(xs[i + 2] - xs[i - 1]) / 3;
    const dy = f32(ys[i + 2] - ys[i - 1]) / 3;
    length += Math.sqrt(dx * dx + dy * dy);
  }
  length += Math.hypot(xs[n - 1] - sum3(xs, n - 3, n - 2, n - 1) / 3, ys[n - 1] - sum3(ys, n - 3, n - 2, n - 1) / 3);
  length += Math.hypot(f32(xs[n - 1] - xs[0]), f32(ys[n - 1] - ys[0]));
  return length;
}

/** SplineFitter for a closed curve: a natural cubic spline over a periodic continuation of the knots */
class SplineFitter {
  private readonly x: number[];
  private readonly y: number[];
  private readonly y2: number[];

  constructor(knots: readonly number[], values: readonly number[]) {
    let n = knots.length;
    const extend = Math.min(SPLINE_EXTEND_BY, n - 1);
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < extend; i++) {
      x.push(f32(knots[n - (extend - i + 1)] - knots[n - 1]));
      y.push(values[n - (extend - i + 1)]);
    }
    for (let i = 0; i < n; i++) {
      x.push(knots[i]);
      y.push(values[i]);
    }
    for (let i = 0; i < extend; i++) {
      x.push(f32(f32(knots[i + 1] - knots[0]) + knots[n - 1]));
      y.push(values[i + 1]);
    }
    n = x.length;
    const y2 = new Array<number>(n).fill(0);
    const cp = new Array<number>(n).fill(0);
    let newX = x[1];
    let newY = y[1];
    let cj = x[1] - x[0];
    let newDj = (y[1] - y[0]) / cj;
    let j = 1;
    while (j < n - 1) {
      const oldX = newX;
      const oldY = newY;
      const aj = cj;
      const oldDj = newDj;
      newX = x[j + 1];
      newY = y[j + 1];
      cj = newX - oldX;
      newDj = (newY - oldY) / cj;
      const bj = 2.0 * (cj + aj);
      const invDenom = 1.0 / (bj - aj * cp[j - 1]);
      const dj = 6.0 * (newDj - oldDj);
      y2[j] = (dj - aj * y2[j - 1]) * invDenom;
      cp[j] = cj * invDenom;
      j += 1;
    }
    while (j > 0) {
      j -= 1;
      y2[j] = y2[j] - cp[j] * y2[j + 1];
    }
    this.x = x;
    this.y = y;
    this.y2 = y2;
  }

  eval(xp: number): number {
    const { x, y, y2 } = this;
    let ls = 0;
    let rs = x.length - 1;
    while (rs > 1 + ls) {
      const m = Math.floor(0.5 * (ls + rs));
      if (x[m] < xp) {
        ls = m;
      } else {
        rs = m;
      }
    }
    const ba = x[rs] - x[ls];
    const xa = xp - x[ls];
    const bx = x[rs] - xp;
    const ba2 = ba * ba;
    const lower = xa * y[rs] + bx * y[ls];
    const c = (xa * xa - ba2) * xa * y2[rs];
    const d = (bx * bx - ba2) * bx * y2[ls];
    return (lower + (c + d) / 6.0) / ba;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Composite ROIs (ShapeRoi): path segments in image coordinates, filled with the even-odd rule
// ---------------------------------------------------------------------------------------------------------------------

const SEG_MOVETO = 0;
const SEG_LINETO = 1;
const SEG_QUADTO = 2;
const SEG_CUBICTO = 3;
const SEG_CLOSE = 4;
const COORDINATE_COUNT = [2, 2, 4, 6, 0];
/** ShapeRoi.FILL_FLATNESS: how far ImageJ lets a flattened curve deviate from the curve when it computes a mask */
const FILL_FLATNESS = 0.01;
/** java.awt.geom.FlatteningPathIterator's default recursion limit */
const FLATTENING_LIMIT = 10;


/** The subpaths of a composite ROI as closed loops, curves flattened as ImageJ flattens them for its mask */
export function compositeLoops(segments: readonly number[]): Point[][] {
  const loops: Point[][] = [];
  let loop: Point[] = [];
  let current: Point = [0, 0];
  const finish = () => {
    // A loop that returns to its start lists the start once; a polygon closes itself
    if (loop.length > 1 && loop[0][0] === loop[loop.length - 1][0] && loop[0][1] === loop[loop.length - 1][1]) {
      loop.pop();
    }
    if (loop.length >= 3) {
      loops.push(loop);
    }
    loop = [];
  };
  for (let index = 0; index < segments.length; ) {
    const kind = Math.trunc(segments[index]);
    const count = COORDINATE_COUNT[kind];
    if (count === undefined || index + 1 + count > segments.length) {
      break;
    }
    const c = segments.slice(index + 1, index + 1 + count);
    index += 1 + count;
    switch (kind) {
      case SEG_MOVETO:
        finish();
        current = [c[0], c[1]];
        loop.push(current);
        break;
      case SEG_LINETO:
        current = [c[0], c[1]];
        loop.push(current);
        break;
      case SEG_QUADTO:
        flattenQuad([current[0], current[1], c[0], c[1], c[2], c[3]], loop);
        current = [c[2], c[3]];
        break;
      case SEG_CUBICTO:
        flattenCubic([current[0], current[1], c[0], c[1], c[2], c[3], c[4], c[5]], loop);
        current = [c[4], c[5]];
        break;
      case SEG_CLOSE:
        finish();
        break;
    }
  }
  finish();
  return loops;
}

/**
 * One polygon with the pixels of all loops under the even-odd rule: the loops are chained through their first points
 * and the chain is walked back, so every connecting edge is traversed twice and adds no crossings.
 */
export function chainLoops(loops: readonly Point[][]): Point[] {
  const points: Point[] = [];
  for (const loop of loops) {
    points.push(...loop, loop[0]);
  }
  for (let i = loops.length - 2; i >= 1; i--) {
    points.push(loops[i][0]);
  }
  return points;
}

function compositeShape(segments: readonly number[], name: string): PolygonShape {
  return { type: 'polygon', points: limitVertices(withImageJTies(chainLoops(compositeLoops(segments))), name) };
}

// FlatteningPathIterator: subdivide at t = 1/2 until the control points lie within the flatness of the chord
function flattenQuad(curve: number[], out: Point[], level = 0): void {
  const [x1, y1, cx, cy, x2, y2] = curve;
  if (level >= FLATTENING_LIMIT || pointToSegmentDistanceSq(cx, cy, x1, y1, x2, y2) < FILL_FLATNESS * FILL_FLATNESS) {
    out.push([x2, y2]);
    return;
  }
  const ax = (x1 + cx) / 2;
  const ay = (y1 + cy) / 2;
  const bx = (cx + x2) / 2;
  const by = (cy + y2) / 2;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  flattenQuad([x1, y1, ax, ay, mx, my], out, level + 1);
  flattenQuad([mx, my, bx, by, x2, y2], out, level + 1);
}

function flattenCubic(curve: number[], out: Point[], level = 0): void {
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = curve;
  const flatness = Math.max(pointToSegmentDistanceSq(c1x, c1y, x1, y1, x2, y2), pointToSegmentDistanceSq(c2x, c2y, x1, y1, x2, y2));
  if (level >= FLATTENING_LIMIT || flatness < FILL_FLATNESS * FILL_FLATNESS) {
    out.push([x2, y2]);
    return;
  }
  const ax = (x1 + c1x) / 2;
  const ay = (y1 + c1y) / 2;
  const bx = (c1x + c2x) / 2;
  const by = (c1y + c2y) / 2;
  const cx = (c2x + x2) / 2;
  const cy = (c2y + y2) / 2;
  const dx = (ax + bx) / 2;
  const dy = (ay + by) / 2;
  const ex = (bx + cx) / 2;
  const ey = (by + cy) / 2;
  const mx = (dx + ex) / 2;
  const my = (dy + ey) / 2;
  flattenCubic([x1, y1, ax, ay, dx, dy, mx, my], out, level + 1);
  flattenCubic([mx, my, ex, ey, cx, cy, x2, y2], out, level + 1);
}

// Line2D.ptSegDistSq
function pointToSegmentDistanceSq(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const sx = x2 - x1;
  const sy = y2 - y1;
  let qx = px - x1;
  let qy = py - y1;
  let dot = qx * sx + qy * sy;
  let projection: number;
  if (dot <= 0) {
    projection = 0;
  } else {
    qx = sx - qx;
    qy = sy - qy;
    dot = qx * sx + qy * sy;
    projection = dot <= 0 ? 0 : (dot * dot) / (sx * sx + sy * sy);
  }
  return Math.max(0, qx * qx + qy * qy - projection);
}

/** The path of java.awt.geom.RoundRectangle2D, which ImageJ fills for a rectangle with rounded corners */
function roundedRectanglePath(x: number, y: number, w: number, h: number, arc: number): number[] {
  const aw = Math.min(w, Math.abs(arc));
  const ah = Math.min(h, Math.abs(arc));
  const acv = 0.5 - 0.5 * (4 / 3) * (Math.SQRT2 - 1); // RoundRectIterator.acv
  // RoundRectIterator.ctrlpts: each coordinate is x + a*w + b*aw (or y + c*h + d*ah)
  const ctrl: number[][] = [
    [0, 0, 0, 0.5],
    [0, 0, 1, -0.5],
    [0, 0, 1, -acv, 0, acv, 1, 0, 0, 0.5, 1, 0],
    [1, -0.5, 1, 0],
    [1, -acv, 1, 0, 1, 0, 1, -acv, 1, 0, 1, -0.5],
    [1, 0, 0, 0.5],
    [1, 0, 0, acv, 1, -acv, 0, 0, 1, -0.5, 0, 0],
    [0, 0.5, 0, 0],
    [0, acv, 0, 0, 0, 0, 0, acv, 0, 0, 0, 0.5],
  ];
  const kinds = [SEG_MOVETO, SEG_LINETO, SEG_CUBICTO, SEG_LINETO, SEG_CUBICTO, SEG_LINETO, SEG_CUBICTO, SEG_LINETO, SEG_CUBICTO];
  const segments: number[] = [];
  ctrl.forEach((values, i) => {
    segments.push(kinds[i]);
    for (let k = 0; k < values.length; k += 4) {
      segments.push(Math.fround(x + values[k] * w + values[k + 1] * aw), Math.fround(y + values[k + 2] * h + values[k + 3] * ah));
    }
  });
  segments.push(SEG_CLOSE);
  return segments;
}

function limitVertices(points: Point[], name: string): Point[] {
  if (points.length > MAX_POLYGON_VERTICES) {
    throw new ImageJRoiError(`Skipped ${name}: its outline has ${points.length} vertices, and at most ${MAX_POLYGON_VERTICES} can be imported.`);
  }
  return points;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------------

export interface ImageJRoiExport {
  /** A RoiSet.zip archive with one .roi entry per ROI, which ImageJ's ROI Manager opens */
  bytes: Uint8Array;
  /** Names of the ROIs written as the outline of their pixels rather than as the shape drawn here */
  outlined: string[];
  /** Names of the ROIs left out because none of their pixels lies on the image */
  empty: string[];
}

/**
 * Writes ROIs so that ImageJ covers exactly the pixels this application measures on an image of the given size.
 * Rectangles become ImageJ rectangles of their pixels, and ellipses ImageJ ovals when an oval covers the same pixels.
 * Polygons stay polygons (freehand ones freehand ROIs) when ImageJ fills the same pixels for their vertices. Otherwise,
 * and for polygons joined by zero-width cuts, the ROI is written as the outline of its pixels: a traced ROI, or a
 * composite ROI when the outline has several loops (parts or holes).
 */
export function writeImageJRois(rois: readonly Roi[], size: { width: number; height: number }): ImageJRoiExport {
  const files: Zippable = {};
  const outlined: string[] = [];
  const empty: string[] = [];
  const used = new Set<string>();
  for (const roi of rois) {
    const encoded = encodeRoi(roi, size);
    if (!encoded) {
      empty.push(roi.name);
      continue;
    }
    if (encoded.outlined) {
      outlined.push(roi.name);
    }
    files[entryName(roi.name, used)] = encoded.bytes;
  }
  return { bytes: zipSync(files, { level: 6 }), outlined, empty };
}

function encodeRoi(roi: Roi, size: { width: number; height: number }): { bytes: Uint8Array; outlined: boolean } | null {
  const shape = roi.shape;
  const runs = shapeRuns(shape, size);
  if (runs.size === 0) {
    return null;
  }
  const common = { name: roi.name, color: roi.color ?? null, slice: roi.slice ?? 0 };
  if (shape.type === 'rectangle') {
    const rows = [...runs.keys()];
    const [start, end] = runs.get(rows[0]) ?? [0, 0];
    return { bytes: encodeBounds('rectangle', start, rows[0], end - start, rows.length, common), outlined: false };
  }
  if (shape.type === 'ellipse') {
    const oval = ovalBounds(shape);
    if (oval) {
      const ovalShape: RoiShape = { type: 'ellipse', cx: oval.x + oval.width / 2, cy: oval.y + oval.height / 2, rx: oval.width / 2, ry: oval.height / 2 };
      if (sameRuns(runs, shapeRuns(ovalShape, size))) {
        return { bytes: encodeBounds('oval', oval.x, oval.y, oval.width, oval.height, common), outlined: false };
      }
    }
    return { bytes: encodeOutline(runs, common), outlined: true };
  }
  const points = shape.points.map(([x, y]) => [toFileCoordinate(x), toFileCoordinate(y)] as Point);
  if (!hasCuts(shape.points) && points.length <= 65535 && sameRuns(runs, imagejPolygonRuns(points, size))) {
    return { bytes: encodePolygon(shape.freehand ? 'freehand' : 'polygon', points, common), outlined: false };
  }
  return { bytes: encodeOutline(runs, common), outlined: true };
}

/**
 * A coordinate as ImageJ stores it (float32), first rounded to 1/2^20 px. The rounding removes the offsets reading adds
 * (withImageJTies) also near 0, where float32 is fine enough to keep them; the pixel check decides whether the rounded
 * vertices still cover the same pixels in ImageJ.
 */
function toFileCoordinate(value: number): number {
  return Math.fround(Math.round(value * 1048576) / 1048576);
}

/** The integer bounds of the ImageJ oval with this ellipse's geometry, when there is one */
function ovalBounds(shape: EllipseShape): { x: number; y: number; width: number; height: number } | null {
  const turn = (((shape.angle ?? 0) % 180) + 180) % 180;
  if (turn !== 0 && turn !== 90) {
    return null;
  }
  const [rx, ry] = turn === 0 ? [shape.rx, shape.ry] : [shape.ry, shape.rx];
  const bounds = { x: shape.cx - rx, y: shape.cy - ry, width: 2 * rx, height: 2 * ry };
  return Object.values(bounds).every((value) => Number.isInteger(value) && Math.abs(value) <= 32767) ? bounds : null;
}

/** Whether some edge is walked back the way it came: the zero-width cuts that join parts and holes into one polygon */
function hasCuts(points: readonly Point[]): boolean {
  const n = points.length;
  const key = (a: Point, b: Point) => `${a[0]},${a[1]},${b[0]},${b[1]}`;
  const edges = new Set<string>();
  for (let i = 0; i < n; i++) {
    edges.add(key(points[i], points[(i + 1) % n]));
  }
  for (let i = 0; i < n; i++) {
    if (edges.has(key(points[(i + 1) % n], points[i]))) {
      return true;
    }
  }
  return false;
}

interface Common {
  name: string;
  color: string | null;
  /** The ROI's position (stack slice); 0 for none */
  slice: number;
}

function encodeOutline(runs: Runs, common: Common): Uint8Array {
  const loops = runsOutline(runs);
  if (loops.length === 1 && loops[0].length <= 65535) {
    return encodePolygon('traced', loops[0], common);
  }
  const segments: number[] = [];
  for (const loop of loops) {
    loop.forEach(([x, y], i) => segments.push(i === 0 ? SEG_MOVETO : SEG_LINETO, x, y));
    segments.push(SEG_CLOSE);
  }
  const all = loops.flat();
  const writer = new Writer(HEADER_SIZE + segments.length * 4, common);
  writer.header('rectangle', ...bounds(all));
  writer.int(SHAPE_ROI_SIZE, segments.length);
  segments.forEach((value, i) => writer.float(COORDINATES + i * 4, value));
  return writer.finish();
}

function encodeBounds(type: 'rectangle' | 'oval', x: number, y: number, width: number, height: number, common: Common): Uint8Array {
  const writer = new Writer(HEADER_SIZE, common);
  writer.header(type, x, y, x + width, y + height);
  return writer.finish();
}

function encodePolygon(type: 'polygon' | 'freehand' | 'traced', points: readonly Point[], common: Common): Uint8Array {
  const n = points.length;
  const subPixel = points.some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y));
  const [left, top, right, bottom] = bounds(points);
  const writer = new Writer(HEADER_SIZE + n * 4 + (subPixel ? n * 8 : 0), common);
  writer.header(type, left, top, right, bottom);
  writer.short(N_COORDINATES, n);
  if (subPixel) {
    writer.short(OPTIONS, SUB_PIXEL_RESOLUTION);
  }
  points.forEach(([x, y], i) => {
    writer.short(COORDINATES + i * 2, Math.floor(x) - left);
    writer.short(COORDINATES + 2 * n + i * 2, Math.floor(y) - top);
    if (subPixel) {
      writer.float(COORDINATES + 4 * n + i * 4, x);
      writer.float(COORDINATES + 8 * n + i * 4, y);
    }
  });
  return writer.finish();
}

/** Integer bounds enclosing the points: left, top, right, bottom */
function bounds(points: readonly Point[]): [number, number, number, number] {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return [Math.floor(left), Math.floor(top), Math.ceil(right), Math.ceil(bottom)];
}

/** One .roi file: the 64-byte header, the coordinates, then header 2 and the name (RoiEncoder) */
class Writer {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(
    private readonly header2: number,
    private readonly common: Common,
  ) {
    this.bytes = new Uint8Array(header2 + HEADER2_SIZE + common.name.length * 2);
    this.view = new DataView(this.bytes.buffer);
  }

  header(type: ImageJType, left: number, top: number, right: number, bottom: number): void {
    this.bytes.set([73, 111, 117, 116]); // "Iout"
    this.short(VERSION_OFFSET, WRITTEN_VERSION);
    this.bytes[TYPE] = TYPE_CODE[type];
    this.short(TOP, top);
    this.short(LEFT, left);
    this.short(BOTTOM, bottom);
    this.short(RIGHT, right);
    if (this.common.color) {
      this.int(STROKE_COLOR, 0xff000000 | parseInt(this.common.color.slice(1), 16));
    }
    if (this.common.slice > 0) {
      this.int(POSITION, this.common.slice);
    }
  }

  short(offset: number, value: number): void {
    this.view.setUint16(offset, value & 0xffff);
  }

  int(offset: number, value: number): void {
    this.view.setInt32(offset, value | 0);
  }

  float(offset: number, value: number): void {
    this.view.setFloat32(offset, value);
  }

  finish(): Uint8Array {
    this.int(HEADER2_OFFSET, this.header2);
    const { name } = this.common;
    if (name.length > 0) {
      const offset = this.header2 + HEADER2_SIZE;
      this.int(this.header2 + NAME_OFFSET, offset);
      this.int(this.header2 + NAME_LENGTH, name.length);
      for (let i = 0; i < name.length; i++) {
        this.short(offset + i * 2, name.charCodeAt(i));
      }
    }
    return this.bytes;
  }
}

/** A unique .roi entry name for the archive, from the ROI's name */
function entryName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').trim() || 'ROI';
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${base}-${n}`;
  }
  used.add(candidate.toLowerCase());
  return `${candidate}.roi`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------------------------------------------------

class Reader {
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  private has(offset: number, length: number): boolean {
    return offset >= 0 && offset + length <= this.bytes.length;
  }

  byte(offset: number): number {
    return this.has(offset, 1) ? this.bytes[offset] : 0;
  }

  /** RoiDecoder.getShort: signed, except that values below -5000 are taken as unsigned (coordinates above 32767) */
  short(offset: number): number {
    if (!this.has(offset, 2)) {
      return 0;
    }
    const value = this.view.getInt16(offset);
    return value < -5000 ? this.view.getUint16(offset) : value;
  }

  unsignedShort(offset: number): number {
    return this.has(offset, 2) ? this.view.getUint16(offset) : 0;
  }

  int(offset: number): number {
    return this.has(offset, 4) ? this.view.getInt32(offset) : 0;
  }

  float(offset: number): number {
    return this.has(offset, 4) ? this.view.getFloat32(offset) : 0;
  }
}

/**
 * The stack slice of an ROI (from 1): its position, else the z or t position of a hyperstack (RoiDecoder reads both);
 * undefined for an ROI on every slice (position 0)
 */
function roiSlice(bytes: Uint8Array): number | undefined {
  const data = new Reader(bytes);
  const candidates = [data.int(POSITION)];
  const header2 = data.int(HEADER2_OFFSET);
  if (header2 > 0 && header2 + 16 <= data.length) {
    candidates.push(data.int(header2 + Z_POSITION), data.int(header2 + T_POSITION));
  }
  const slice = candidates.find((value) => value > 0);
  return slice !== undefined && slice <= MAX_SLICES ? slice : undefined;
}

function roiName(data: Reader, fallback: string): string {
  const header2 = data.int(HEADER2_OFFSET);
  if (header2 <= 0) {
    return fallback;
  }
  const offset = data.int(header2 + NAME_OFFSET);
  const length = data.int(header2 + NAME_LENGTH);
  // As RoiDecoder.getRoiName: a name that does not fit in the file is ignored
  if (offset <= 0 || length <= 0 || offset + length * 2 > data.length) {
    return fallback;
  }
  const codes: number[] = [];
  for (let i = 0; i < length; i++) {
    codes.push(data.unsignedShort(offset + i * 2));
  }
  return String.fromCharCode(...codes);
}

function strokeColor(argb: number): string | null {
  return argb === 0 ? null : `#${((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

function baseName(entry: string): string {
  return (entry.split('/').pop() ?? entry).replace(/\.roi$/i, '');
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function zipEntries(bytes: Uint8Array, fileName: string): Array<{ name: string; bytes: Uint8Array }> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => /\.roi$/i.test(file.name) });
  } catch (error) {
    throw new ImageJRoiError(`${fileName} could not be unpacked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = Object.entries(files).map(([name, data]) => ({ name, bytes: data }));
  if (entries.length === 0) {
    throw new ImageJRoiError(`${fileName} contains no ImageJ ROIs (.roi files).`);
  }
  return entries;
}


