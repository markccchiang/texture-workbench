// ROI set files (*.roi.json, doc/ui-design-plan.md, sections 6.4 and 8.4).

import { isImageJRoiFileName, readImageJRois, RoiSetDocument, type ImageInfo, type RoiSetImage, type RoiShape } from '@glcm/api';
import type { ManagedRoi, RoiClass } from '../rois/roiStore';
import type { Size } from '../viewer/viewport';
import { fileStem } from './download';
import { parseAppFile } from './validate';

export function buildRoiSet(info: ImageInfo, rois: readonly ManagedRoi[], classes: readonly RoiClass[] = []): RoiSetDocument {
  return {
    format: 'glcm-roi-set',
    version: 1,
    image: { name: info.name, width: info.width, height: info.height, bitDepth: info.bitDepth, sha256: info.sha256 },
    ...(classes.length > 0 ? { classes: classes.map(({ name, color }) => ({ name, color })) } : {}),
    rois: rois.map(({ id, name, color, shape, className }) => ({ id, name, color, ...(className ? { class: className } : {}), shape })),
  };
}

export function roiSetFileName(imageName: string): string {
  return `${fileStem(imageName)}.roi.json`;
}

export function parseRoiSet(text: string): RoiSetDocument {
  return parseAppFile<RoiSetDocument>(text, RoiSetDocument, 'glcm-roi-set', 'ROI set file');
}

/** File types the ROI set choosers accept: this application's ROI sets, and ImageJ's .roi files and RoiSet.zip archives */
export const ROI_SET_FILE_TYPES = '.json,.roi,.zip,application/json,application/zip';

/** An ROI set file, or ImageJ ROIs as an ROI set with notes on what was left out */
export async function readRoiSetFile(file: File): Promise<{ document: RoiSetDocument; warnings: string[] }> {
  if (isImageJRoiFileName(file.name)) {
    return readImageJRois(new Uint8Array(await file.arrayBuffer()), file.name);
  }
  return { document: parseRoiSet(await file.text()), warnings: [] };
}

/** Why the ROI set may not belong to this image */
export function imageMismatches(reference: RoiSetImage | undefined, info: ImageInfo): string[] {
  if (!reference) {
    return [];
  }
  const messages: string[] = [];
  if (reference.width !== undefined && reference.height !== undefined && (reference.width !== info.width || reference.height !== info.height)) {
    messages.push(`The ROIs were drawn on a ${reference.width}×${reference.height} image; this one is ${info.width}×${info.height}.`);
  }
  if (reference.sha256 && reference.sha256 !== info.sha256) {
    messages.push(`The ROIs were drawn on a different image file${reference.name ? ` (${reference.name})` : ''}.`);
  }
  if (reference.bitDepth !== undefined && reference.bitDepth !== info.bitDepth) {
    messages.push(`The ROIs were drawn on a ${reference.bitDepth}-bit image; this one is ${info.bitDepth}-bit.`);
  }
  return messages;
}

type Point = [number, number];

/** Sutherland–Hodgman clipping of a polygon to the rectangle [0, width] × [0, height] */
function clipPolygon(points: readonly Point[], size: Size): Point[] {
  const edges: Array<{ inside: (p: Point) => boolean; intersect: (a: Point, b: Point) => Point }> = [
    { inside: (p) => p[0] >= 0, intersect: (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= size.width, intersect: (a, b) => [size.width, a[1] + ((b[1] - a[1]) * (size.width - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= 0, intersect: (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0] },
    { inside: (p) => p[1] <= size.height, intersect: (a, b) => [a[0] + ((b[0] - a[0]) * (size.height - a[1])) / (b[1] - a[1]), size.height] },
  ];
  let output: Point[] = [...points];
  for (const edge of edges) {
    const input = output;
    output = [];
    input.forEach((current, i) => {
      const previous = input[(i + input.length - 1) % input.length];
      if (edge.inside(current)) {
        if (!edge.inside(previous)) {
          output.push(edge.intersect(previous, current));
        }
        output.push(current);
      } else if (edge.inside(previous)) {
        output.push(edge.intersect(previous, current));
      }
    });
    if (output.length === 0) {
      break;
    }
  }
  return output;
}

export interface ClipOutcome {
  /** null when nothing of the shape lies on the image */
  shape: RoiShape | null;
  clipped: boolean;
}

/**
 * Clips a shape to the image. Rectangles and polygons are cut at the image border; ellipses are kept whole when they
 * overlap the image (the core only counts pixels on the image). Shapes inside the image are returned unchanged.
 */
export function clipShape(shape: RoiShape, size: Size): ClipOutcome {
  switch (shape.type) {
    case 'rectangle': {
      const left = Math.min(shape.x, shape.x + shape.width);
      const top = Math.min(shape.y, shape.y + shape.height);
      const right = left + Math.abs(shape.width);
      const bottom = top + Math.abs(shape.height);
      if (left >= 0 && top >= 0 && right <= size.width && bottom <= size.height) {
        return { shape, clipped: false };
      }
      const x = Math.max(0, left);
      const y = Math.max(0, top);
      const width = Math.min(size.width, right) - x;
      const height = Math.min(size.height, bottom) - y;
      return width > 0 && height > 0 ? { shape: { type: 'rectangle', x, y, width, height }, clipped: true } : { shape: null, clipped: true };
    }
    case 'ellipse': {
      const extent = Math.max(Math.abs(shape.rx), Math.abs(shape.ry));
      const overlaps = shape.cx + extent > 0 && shape.cy + extent > 0 && shape.cx - extent < size.width && shape.cy - extent < size.height;
      return overlaps ? { shape, clipped: false } : { shape: null, clipped: true };
    }
    case 'polygon': {
      const inside = shape.points.every(([x, y]) => x >= 0 && y >= 0 && x <= size.width && y <= size.height);
      if (inside) {
        return { shape, clipped: false };
      }
      const points = clipPolygon(shape.points, size);
      return points.length >= 3 ? { shape: { ...shape, points }, clipped: true } : { shape: null, clipped: true };
    }
  }
}

export interface PreparedImport {
  rois: Array<{ id: string; name: string; color: string; shape: RoiShape; className?: string }>;
  /** The set's classes, and classes its ROIs use without the set listing them */
  classes: RoiClass[];
  warnings: string[];
}

/** The ROIs of a set, clipped to the image, and warnings to show */
export function prepareRoiImport(document: RoiSetDocument, info: ImageInfo): PreparedImport {
  const warnings = imageMismatches(document.image, info);
  const rois: PreparedImport['rois'] = [];
  const skipped: string[] = [];
  let clipped = 0;
  for (const roi of document.rois) {
    const outcome = clipShape(roi.shape, info);
    if (!outcome.shape) {
      skipped.push(roi.name || roi.id);
      continue;
    }
    if (outcome.clipped) {
      clipped += 1;
    }
    rois.push({ id: roi.id, name: roi.name, color: roi.color ?? '', shape: outcome.shape, ...(roi.class ? { className: roi.class } : {}) });
  }
  if (clipped > 0) {
    warnings.push(`${clipped} ROI${clipped === 1 ? ' was' : 's were'} clipped to the image.`);
  }
  if (skipped.length > 0) {
    warnings.push(`Skipped ${skipped.length} ROI${skipped.length === 1 ? '' : 's'} outside the image: ${skipped.join(', ')}.`);
  }
  const classes: RoiClass[] = (document.classes ?? []).map(({ name, color }) => ({ name, color: color ?? '' }));
  for (const roi of rois) {
    if (roi.className && !classes.some((roiClass) => roiClass.name === roi.className)) {
      classes.push({ name: roi.className, color: roi.color });
    }
  }
  return { rois, classes, warnings };
}
