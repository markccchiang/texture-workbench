import type { RoiShape } from '@glcm/api';
import { describe, expect, it } from 'vitest';
import type { ManagedRoi } from '../rois/roiStore';
import { binsOf, histogramCsv, histogramTarget, profileCsv, profileOf } from './intensityPlots';

describe('line profiles', () => {
  const ruler = { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } };
  const response = { values: [1, 2, null, 4, 5, 6], length: 5, step: 1 };

  it('puts the samples at their distance along the line, in millimetres with a spacing', () => {
    expect(profileOf(response, ruler, null)).toEqual({
      unit: 'px',
      points: [0, 1, 2, 3, 4, 5].map((distance, index) => ({ distance, value: response.values[index] })),
    });
    // 3 px × 2 mm and 4 px × 1 mm: 7.2111 mm over 5 px
    const inMm = profileOf(response, ruler, { x: 2, y: 1 });
    expect(inMm.unit).toBe('mm');
    expect(inMm.points[5].distance).toBeCloseTo(Math.hypot(6, 4), 12);
    expect(
      profileCsv({
        unit: 'px',
        points: [
          { distance: 0, value: 3 },
          { distance: 1, value: null },
        ],
      }),
    ).toBe('distance_px,value\n0,3\n1,\n');
  });
});

describe('histograms', () => {
  it('turns counts into bins of whole values', () => {
    const bins = binsOf({ pixelCount: 6, min: 0, max: 21, mean: 10.5, std: 8, mode: 0, binStart: 0, binWidth: 6, counts: [2, 2, 0, 2] });
    expect(bins[1]).toEqual({ start: 6, end: 11, count: 2 });
    expect(histogramCsv(bins.slice(0, 2))).toBe('bin_start,bin_end,count\n0,5,2\n6,11,2\n');
  });

  it('counts the selected ROI, else the drawn one, else the whole image', () => {
    const shape: RoiShape = { type: 'rectangle', x: 1, y: 1, width: 3, height: 3 };
    const roi: ManagedRoi = { id: 'a', name: 'Lesion', color: '#FF0000', visible: true, shape, slice: 4 };
    const info = { width: 40, height: 30 };
    expect(histogramTarget(info, 4, [roi], ['a'], null, 4)).toEqual({ label: 'Lesion', shape, slice: 4 });
    // An ROI of another slice is not what is shown
    expect(histogramTarget(info, 2, [roi], ['a'], null, 2).label).toBe('the whole image');
    expect(histogramTarget(info, 1, [roi], [], shape, null)).toEqual({ label: 'the drawn ROI', shape, slice: 1 });
    expect(histogramTarget(info, 1, [], [], null, null).shape).toEqual({ type: 'rectangle', x: 0, y: 0, width: 40, height: 30 });
  });
});
