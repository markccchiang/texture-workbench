// Plot Profile and Histogram (Analyze menu): the rows of the charts and of their CSV files, from the server's answers

import type { ImageInfo, LineProfileResponse, PixelSpacing, RoiHistogramResponse, RoiShape } from '@glcm/api';
import { isOnSlice, type ManagedRoi } from '../rois/roiStore';
import { measureRuler, type RulerLine } from '../viewer/ruler';

export interface ProfilePoint {
  /** From the start of the line, in pixels, or in millimetres with a pixel spacing */
  distance: number;
  /** null outside the image */
  value: number | null;
}

export interface Profile {
  points: ProfilePoint[];
  unit: 'px' | 'mm';
}

/** The samples of a line profile against their distance along the line, in millimetres when the image has a spacing */
export function profileOf(response: LineProfileResponse, ruler: RulerLine, spacing: PixelSpacing | null): Profile {
  const measured = measureRuler(ruler, spacing);
  // With a spacing, every pixel step along the line is the same physical length: the line's length in mm over its length in px
  const scale = measured.lengthMm !== null && measured.lengthPx > 0 ? measured.lengthMm / measured.lengthPx : 1;
  return {
    points: response.values.map((value, index) => ({ distance: index * response.step * scale, value })),
    unit: measured.lengthMm !== null ? 'mm' : 'px',
  };
}

export interface HistogramBin {
  /** The first value in the bin */
  start: number;
  /** The last value in the bin (bins hold whole values) */
  end: number;
  count: number;
}

export function binsOf(response: RoiHistogramResponse): HistogramBin[] {
  return response.counts.map((count, index) => {
    const start = response.binStart + index * response.binWidth;
    return { start, end: start + response.binWidth - 1, count };
  });
}

/** CSV of a profile: distance and value, empty where there is no value */
export function profileCsv(profile: Profile): string {
  return [`distance_${profile.unit},value`, ...profile.points.map(({ distance, value }) => `${distance},${value ?? ''}`)].join('\n') + '\n';
}

/** CSV of a histogram: the first and last value of each bin and its count */
export function histogramCsv(bins: readonly HistogramBin[]): string {
  return ['bin_start,bin_end,count', ...bins.map(({ start, end, count }) => `${start},${end},${count}`)].join('\n') + '\n';
}

export interface HistogramTarget {
  label: string;
  shape: RoiShape;
  /** The slice of a stack to count, from 1 */
  slice: number;
}

/**
 * What Histogram counts: the one selected ROI, else the drawn ROI not yet added, else the whole image (the slice shown,
 * for a stack), as ImageJ does without a selection
 */
export function histogramTarget(
  info: Pick<ImageInfo, 'width' | 'height'>,
  shownSlice: number,
  rois: readonly ManagedRoi[],
  selectedIds: readonly string[],
  activeShape: RoiShape | null,
  currentSlice: number | null,
): HistogramTarget {
  const selected = selectedIds.length === 1 ? rois.find((roi) => roi.id === selectedIds[0] && isOnSlice(roi, currentSlice)) : undefined;
  if (selected) {
    return { label: selected.name, shape: selected.shape, slice: selected.slice ?? shownSlice };
  }
  if (activeShape) {
    return { label: 'the drawn ROI', shape: activeShape, slice: shownSlice };
  }
  return { label: 'the whole image', shape: { type: 'rectangle', x: 0, y: 0, width: info.width, height: info.height }, slice: shownSlice };
}
