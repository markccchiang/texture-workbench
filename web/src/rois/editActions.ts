// Brush, eraser, union, subtract, intersect, xor, enlarge, shrink and band: the server computes the result on the pixel grid and
// the ROIs are updated with it.

import { MAX_POLYGON_VERTICES, type GrowOperation, type PolygonShape, type RoiOperation, type RoiShape } from '@glcm/api';
import { notifications } from '@mantine/notifications';
import { brushRoi, combineRois, growRoi } from '../api/client';
import { useViewer } from '../stores/viewerStore';
import { simplifyPolyline } from './geometry';
import { regionShape } from './regions';
import { useRois } from './roiStore';

function notify(title: string, message: string, color = 'yellow'): void {
  notifications.show({ color, title, message });
}

function notifySimplified(simplified: boolean): void {
  if (simplified) {
    notify(
      'Outline simplified',
      `An ROI may have at most ${MAX_POLYGON_VERTICES.toLocaleString()} vertices, so the outline was simplified and its edges no longer follow the pixels exactly.`,
    );
  }
}

/** Strokes run one after another, so each one starts from the result of the previous stroke */
let strokes: Promise<void> = Promise.resolve();

/** A stroke path that fits into a request */
export function strokePath(path: ReadonlyArray<readonly [number, number]>, maxPoints = MAX_POLYGON_VERTICES): Array<[number, number]> {
  let points = path.map(([x, y]): [number, number] => [x, y]);
  for (let tolerance = 0.25; points.length > maxPoints; tolerance *= 2) {
    points = simplifyPolyline(path, tolerance);
  }
  return points;
}

/**
 * Paints (or erases) a stroke into the one selected ROI; painting without a selection creates a new ROI, which is then
 * selected, so further strokes add to it. Each stroke is one undo step.
 */
export function applyBrushStroke(path: ReadonlyArray<readonly [number, number]>, erase: boolean): Promise<void> {
  const next = strokes.then(() => runBrushStroke(path, erase));
  strokes = next.catch(() => undefined);
  return next;
}

async function runBrushStroke(path: ReadonlyArray<readonly [number, number]>, erase: boolean): Promise<void> {
  const image = useViewer.getState().image;
  if (!image || path.length === 0) {
    return;
  }
  const { rois, selectedIds } = useRois.getState();
  if (selectedIds.length > 1) {
    notify(erase ? 'Select one ROI to erase from' : 'Select one ROI to paint into', 'The brush and the eraser change a single selected ROI; with no ROI selected, the brush starts a new one.');
    return;
  }
  const target = selectedIds.length === 1 ? rois.find((roi) => roi.id === selectedIds[0]) : undefined;
  if (erase && !target) {
    notify('Select an ROI to erase from', 'The eraser removes pixels from the selected ROI.');
    return;
  }
  try {
    const result = await brushRoi(image.info.imageId, {
      shape: target?.shape ?? null,
      path: strokePath(path),
      radius: useViewer.getState().brushSize / 2,
      erase,
    });
    if (useViewer.getState().image?.info.imageId === image.info.imageId) {
      applyResult(target ? { id: target.id, shape: target.shape } : null, result.shape);
    }
  } catch (error) {
    notify(erase ? 'Eraser failed' : 'Brush failed', (error as Error).message, 'red');
  }
}

/** Replaces the target's shape (or adds a new ROI); the target is left alone if it changed while the request ran */
function applyResult(target: { id: string; shape: RoiShape } | null, result: PolygonShape | null): void {
  const store = useRois.getState();
  const current = target ? store.rois.find((roi) => roi.id === target.id) : undefined;
  if (target && current?.shape !== target.shape) {
    return;
  }
  if (!result) {
    if (current) {
      store.deleteRois([current.id]);
      notify('ROI removed', `Nothing was left of ${current.name}, so it was deleted. Undo brings it back.`);
    }
    return;
  }
  const { shape, simplified } = regionShape(result);
  if (current) {
    store.replaceShape(current.id, shape);
  } else {
    store.addRoi(shape);
  }
  notifySimplified(simplified);
}

const OPERATION_NAMES: Record<RoiOperation, string> = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', xor: 'XOR' };

/**
 * Union, intersect and XOR: the selected ROIs become one, which keeps the first selected ROI's name and colour. Subtract: the
 * other selected ROIs are removed from the first selected ROI, and stay. Each is one undo step.
 */
export async function combineSelectedRois(operation: RoiOperation): Promise<void> {
  const image = useViewer.getState().image;
  if (!image) {
    return;
  }
  const { rois, selectedIds } = useRois.getState();
  const selected = selectedIds.flatMap((id) => rois.filter((roi) => roi.id === id));
  if (selected.length < 2) {
    const what: Record<RoiOperation, string> = {
      union: 'Union merges the selected ROIs into one.',
      subtract: 'Subtract removes the other selected ROIs from the first one you selected.',
      intersect: 'Intersect keeps the pixels all selected ROIs have in common.',
      xor: 'XOR keeps the pixels that only one of two selected ROIs covers.',
    };
    notify('Select at least two ROIs', what[operation]);
    return;
  }
  const [first, ...others] = selected;
  try {
    const result = await combineRois(image.info.imageId, { operation, shapes: selected.map((roi) => roi.shape) });
    const store = useRois.getState();
    const unchanged = selected.every((roi) => store.rois.find((candidate) => candidate.id === roi.id)?.shape === roi.shape);
    if (useViewer.getState().image?.info.imageId !== image.info.imageId || !unchanged) {
      return;
    }
    if (!result.shape) {
      const empty: Record<RoiOperation, [string, string]> = {
        union: ['Nothing to combine', 'The selected ROIs cover no pixel of the image.'],
        subtract: ['Nothing would be left', `The other ROIs cover all of ${first.name}, so it was not changed.`],
        intersect: ['Nothing in common', 'The selected ROIs share no pixel, so they were not changed.'],
        xor: ['Nothing would be left', 'The selected ROIs cover the same pixels, so they were not changed.'],
      };
      notify(...empty[operation]);
      return;
    }
    const { shape, simplified } = regionShape(result.shape);
    if (operation === 'subtract') {
      store.replaceShape(first.id, shape);
      store.select([first.id]);
    } else {
      store.mergeRois(first.id, shape, others.map((roi) => roi.id));
    }
    notifySimplified(simplified);
  } catch (error) {
    notify(`${OPERATION_NAMES[operation]} failed`, (error as Error).message, 'red');
  }
}

export type DistanceUnit = 'px' | 'mm';

export interface GrowRequest {
  operation: GrowOperation;
  distance: number;
  /** Millimetres need the image's pixel spacing */
  unit: DistanceUnit;
}

/** "5 px", "2.5 mm" */
export function formatDistance(distance: number, unit: DistanceUnit): string {
  return `${Number(distance.toPrecision(6))} ${unit}`;
}

/**
 * Enlarge and shrink change the selected ROIs, as one undo step; Band adds a new ROI around each selected ROI, named after
 * it, and keeps the ROI. An ROI that would lose all its pixels is left unchanged. Returns the number of ROIs changed or added.
 */
export async function growSelectedRois({ operation, distance, unit }: GrowRequest): Promise<number> {
  const image = useViewer.getState().image;
  if (!image) {
    return 0;
  }
  const spacing = useViewer.getState().pixelSpacing;
  if (unit === 'mm' && !spacing) {
    notify('No pixel spacing', 'Set the pixel spacing in Image Info to use millimetres, or use pixels.');
    return 0;
  }
  const { rois, selectedIds } = useRois.getState();
  const selected = selectedIds.flatMap((id) => rois.filter((roi) => roi.id === id));
  if (selected.length === 0) {
    notify('Select ROIs first', 'Enlarge, Shrink and Band work on the selected ROIs.');
    return 0;
  }
  let results: Awaited<ReturnType<typeof growRoi>>[];
  try {
    results = await Promise.all(
      selected.map((roi) =>
        growRoi(image.info.imageId, { shape: roi.shape, operation, distance, ...(unit === 'mm' && spacing ? { pixelSpacing: spacing } : {}) }),
      ),
    );
  } catch (error) {
    notify(`${operation === 'band' ? 'Band' : operation === 'enlarge' ? 'Enlarge' : 'Shrink'} failed`, (error as Error).message, 'red');
    return 0;
  }
  const store = useRois.getState();
  const unchanged = selected.every((roi) => store.rois.find((candidate) => candidate.id === roi.id)?.shape === roi.shape);
  if (useViewer.getState().image?.info.imageId !== image.info.imageId || !unchanged) {
    return 0;
  }

  const emptied = selected.filter((_, i) => !results[i].shape).map((roi) => roi.name);
  let simplified = false;
  const outcomes = selected.flatMap((roi, i) => {
    const polygon = results[i].shape;
    if (!polygon) {
      return [];
    }
    const outline = regionShape(polygon);
    simplified ||= outline.simplified;
    return [{ roi, shape: outline.shape }];
  });
  if (operation === 'band') {
    store.importRois(outcomes.map(({ roi, shape }) => ({ name: `${roi.name} band ${formatDistance(distance, unit)}`, color: '', shape })));
  } else {
    store.replaceShapes(outcomes.map(({ roi, shape }) => ({ id: roi.id, shape })));
  }
  if (emptied.length > 0) {
    const reasons: Record<GrowOperation, string> = {
      enlarge: 'no pixel lies on the image',
      shrink: `shrinking by ${formatDistance(distance, unit)} would leave no pixel`,
      band: 'the image has no pixel around it',
    };
    const reason = reasons[operation];
    notify(`${emptied.length === 1 ? '1 ROI' : `${emptied.length} ROIs`} left unchanged`, `For ${emptied.join(', ')}, ${reason}.`);
  }
  notifySimplified(simplified);
  return outcomes.length;
}
