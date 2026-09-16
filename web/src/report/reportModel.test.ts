import { describe, expect, it } from 'vitest';
import type { ManagedRoi } from '../rois/roiStore';
import { FEATURES, IMAGE_INFO, measurement, rowsOf, run, SETTINGS } from './reportFixtures';
import { buildReportModel, reportSummary, type ReportInput } from './reportModel';

const ROIS: ManagedRoi[] = [
  { id: 'r1', name: 'Tumour', color: '#FF3B3B', visible: true, shape: { type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }, className: 'lesion' },
  { id: 'r2', name: 'Muscle', color: '#00C2FF', visible: true, shape: { type: 'ellipse', cx: 20, cy: 20, rx: 5, ry: 4 } },
];

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  const runs = [run('ana1', 'camera.png', [measurement('r1', 'Tumour', { roiClass: 'lesion' }), measurement('r2', 'Muscle')])];
  return {
    runs,
    rows: rowsOf(runs),
    features: FEATURES,
    openImage: { info: IMAGE_INFO, rois: ROIS },
    title: 'Report',
    notes: '',
    createdAt: '2026-09-16T12:00:00.000Z',
    coreVersion: '0.1.0',
    ...overrides,
  };
}

describe('report model', () => {
  it('groups the runs by image and keeps the ROIs of the open one', () => {
    const model = buildReportModel(input());
    expect(model.images).toHaveLength(1);
    const [image] = model.images;
    expect(image).toMatchObject({ name: 'camera.png', sha256: 'camera.png-sha', open: true, info: IMAGE_INFO });
    expect(image.rows).toHaveLength(2); // meanOnly: one row per ROI
    expect(image.rois).toEqual([
      { id: 'r1', name: 'Tumour', className: 'lesion', color: '#FF3B3B', shape: 'Rectangle', pixelCount: 400, areaMm2: null },
      { id: 'r2', name: 'Muscle', className: '', color: '#00C2FF', shape: 'Ellipse', pixelCount: 400, areaMm2: null },
    ]);
    expect(image.settingsGroups).toEqual([{ settings: SETTINGS, timestamps: ['2026-09-16T10:00:00.000Z'], measurements: 2 }]);
    expect(reportSummary(model)).toEqual({ images: 1, rois: 2, rows: 2, charts: 2 });
  });

  it('describes images measured earlier from their results, with areas when a spacing was used', () => {
    const runs = [
      run('ana1', 'camera.png', [measurement('r1', 'Tumour')]),
      run('ana2', 'ct.png', [measurement('a', 'Lesion', { roiClass: 'lesion', pixelCount: 200 })], {
        imageSha256: 'ct-sha',
        pixelSpacing: { x: 0.5, y: 0.25 },
        timestamp: '2026-09-16T11:00:00.000Z',
      }),
      // A second analysis of the same image, with other settings
      run('ana3', 'ct.png', [measurement('a', 'Lesion')], {
        imageSha256: 'ct-sha',
        settings: { ...SETTINGS, grayLevels: 64 },
        timestamp: '2026-09-16T11:30:00.000Z',
      }),
    ];
    const model = buildReportModel(input({ runs, rows: rowsOf(runs) }));
    expect(model.images.map((image) => image.name)).toEqual(['camera.png', 'ct.png']);
    const ct = model.images[1];
    expect(ct.open).toBe(false);
    expect(ct.info).toBeNull();
    expect(ct.runs).toHaveLength(2);
    expect(ct.settingsGroups.map((group) => group.settings.grayLevels)).toEqual([32, 64]);
    // Known only from the measurements: no colour and no shape
    expect(ct.rois).toEqual([{ id: 'a', name: 'Lesion', className: 'lesion', color: '', shape: '', pixelCount: 200, areaMm2: 25 }]);
  });

  it('skips runs without results and images that are not open have no ROI colours', () => {
    const runs = [run('empty', 'camera.png', []), run('queued', 'other.png', [], { status: 'running', results: [undefined, undefined] })];
    expect(buildReportModel(input({ runs, rows: [] })).images).toEqual([]);
  });

  it('charts every measured feature, plus directions and distances of the first', () => {
    const perDirection = run('ana1', 'camera.png', [measurement('r1', 'Tumour'), measurement('r1', 'Tumour', { distance: 2 })], {
      settings: { ...SETTINGS, aggregation: 'perDirectionAndMean', distances: [1, 2] },
    });
    const model = buildReportModel(input({ runs: [perDirection], rows: rowsOf([perDirection]) }));
    expect(model.images[0].charts.map((chart) => chart.key)).toEqual(['bars:Contrast', 'polar:Contrast', 'distance:Contrast', 'bars:Entropy']);
    expect(model.images[0].charts[0]).toMatchObject({ featureName: 'Contrast', distance: 1, caption: expect.stringContaining('d = 1') });
  });
});
