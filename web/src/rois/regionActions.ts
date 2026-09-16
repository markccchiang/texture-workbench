// The magic wand and Threshold ROI flows: ask the server for regions and turn them into ROIs.

import { MAX_POLYGON_VERTICES } from '@glcm/api';
import { notifications } from '@mantine/notifications';
import { selectThresholdRois, selectWandRoi } from '../api/client';
import { shownSlice, sliceField, useViewer } from '../stores/viewerStore';
import { regionShape } from './regions';
import { useRois } from './roiStore';

function notifySimplified(count: number): void {
  if (count > 0) {
    notifications.show({
      color: 'yellow',
      title: count === 1 ? 'Outline simplified' : `${count} outlines simplified`,
      message: `An ROI may have at most ${MAX_POLYGON_VERTICES.toLocaleString()} vertices, so longer outlines were simplified and their edges no longer follow the pixels exactly.`,
    });
  }
}

/** Makes the region around an image pixel the active ROI */
export async function wandAt(imageId: string, x: number, y: number): Promise<void> {
  const tolerance = useViewer.getState().wandTolerance;
  const slice = shownSlice();
  try {
    const { region } = await selectWandRoi(imageId, { x, y, tolerance, ...sliceField(slice) });
    // The image or its slice may have changed while the request ran
    if (!region || useViewer.getState().image?.info.imageId !== imageId || shownSlice() !== slice) {
      return;
    }
    const { shape, simplified } = regionShape(region);
    useRois.getState().setActiveShape(shape);
    notifySimplified(simplified ? 1 : 0);
  } catch (error) {
    notifications.show({ color: 'red', title: 'Magic wand failed', message: (error as Error).message });
  }
}

/** Adds the largest regions inside the display window to the ROI Manager; resolves to the number added */
/** Filters of Threshold ROI besides the display window */
export interface ThresholdFilters {
  minPixels: number;
  /** null: no largest size */
  maxPixels: number | null;
  /** 0: any shape */
  minSphericity: number;
}

/** The request fields of the filters, leaving out those that filter nothing */
export function thresholdFilterFields({ minPixels, maxPixels, minSphericity }: ThresholdFilters) {
  return { minPixels, ...(maxPixels !== null ? { maxPixels } : {}), ...(minSphericity > 0 ? { minSphericity } : {}) };
}

export async function addThresholdRois(imageId: string, filters: ThresholdFilters, count: number): Promise<number> {
  const { min, max } = useViewer.getState().window;
  const slice = shownSlice();
  const { regions } = await selectThresholdRois(imageId, { min, max, ...thresholdFilterFields(filters), maxRegions: count, ...sliceField(slice) });
  if (useViewer.getState().image?.info.imageId !== imageId || shownSlice() !== slice || regions.length === 0) {
    return 0;
  }
  const rois = useRois.getState();
  const shapes = regions.map((region) => regionShape(region));
  rois.importRois(shapes.map(({ shape }, i) => ({ name: `ROI ${rois.nextNumber + i}`, color: '', shape })));
  notifySimplified(shapes.filter(({ simplified }) => simplified).length);
  return regions.length;
}
