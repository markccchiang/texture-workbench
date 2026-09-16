import type { AnalysisSettings, FeatureInfo, MeasurementResult } from '@glcm/api';
import { describe, expect, it } from 'vitest';
import { cellText, columnsForRows, formatValue, rowDirections, rowsForResult, rowsToTsv, sortRows, spreadsheetText } from './rows';

const settings: AnalysisSettings = {
  features: ['Contrast', 'CorrelationIII'],
  grayLevels: 32,
  quantization: { method: 'fixedRange', min: 0, max: 255, binWidth: 8 },
  distances: [1],
  directions: [0, 90],
  aggregation: 'perDirectionAndMean',
  logBase: 'natural',
  score: { enabled: true, age: 40, coefficients: [1, 1, 1, 1], profile: 'calibration', intensityMin: 0, intensityMax: 255 },
};

const values = (h: number, v: number) => ({ '0': h, '45': null, '90': v, '135': null, mean: (h + v) / 2, range: Math.abs(h - v) });

const ok: MeasurementResult = {
  roiId: 'a',
  roiName: 'ROI 1',
  distance: 1,
  status: 'ok',
  error: '',
  pixelCount: 100,
  pairCounts: { '0': 90, '45': 0, '90': 90, '135': 0 },
  quantization: { lower: 0, upper: 255 },
  values: { Contrast: values(2, 4), CorrelationIII: values(0.001, 0.003) },
  score: values(70, 72),
  warnings: [],
};

const features: FeatureInfo[] = [
  { id: 'Contrast', name: 'Contrast', group: 'haralick', nonStandard: false, nonStandardReason: '', docAnchor: '', cost: 'normal' },
  { id: 'CorrelationIII', name: 'Correlation III', group: 'other', nonStandard: true, nonStandardReason: 'x', docAnchor: '', cost: 'normal' },
  { id: 'Entropy', name: 'Entropy', group: 'haralick', nonStandard: false, nonStandardReason: '', docAnchor: '', cost: 'normal' },
];

const context = { analysisId: 'ana_1', index: 0, imageName: 'camera.png', settings };

describe('rows', () => {
  it('follows the aggregation', () => {
    expect(rowDirections(settings)).toEqual(['0', '90', 'mean']);
    expect(rowDirections({ ...settings, aggregation: 'meanOnly' })).toEqual(['mean']);
    expect(rowDirections({ ...settings, aggregation: 'meanAndRange' })).toEqual(['mean', 'range']);
  });

  it('creates one row per direction with values and score', () => {
    const rows = rowsForResult(ok, context);
    expect(rows.map((row) => row.direction)).toEqual(['0', '90', 'mean']);
    expect(rows[1]).toMatchObject({ key: 'ana_1:0:90', values: { Contrast: 4, CorrelationIII: 0.003 }, score: 72 });
    expect(rows[2].values.Contrast).toBe(3);
  });

  it('creates a single row for skipped or failed measurements', () => {
    const rows = rowsForResult({ ...ok, status: 'skipped', error: 'The ROI contains fewer than 2 pixels', values: {}, score: null }, context);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: null, status: 'skipped', score: null });
  });
});

describe('formatting, columns and export', () => {
  it('formats numbers compactly', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(0)).toBe('0');
    expect(formatValue(3.14159265)).toBe('3.14159');
    expect(formatValue(1234.5678)).toBe('1234.57');
    expect(formatValue(0.00001234)).toBe('1.2340e-5');
    expect(formatValue(-2.5e7)).toBe('-2.5000e+7');
  });

  it('builds columns in catalog order with non-standard flags', () => {
    const columns = columnsForRows(rowsForResult(ok, context), features);
    expect(columns.map((column) => column.id)).toEqual(['roi', 'distance', 'direction', 'pixels', 'grayLevels', 'feature:Contrast', 'feature:CorrelationIII', 'score', 'status']);
    expect(columns[6].nonStandard).toBe(true);
    expect(cellText(columns[2], rowsForResult(ok, context)[2])).toBe('Mean');
  });

  it('sorts numerically with empty cells last', () => {
    const rows = [
      ...rowsForResult(ok, context),
      ...rowsForResult({ ...ok, roiId: 'b', roiName: 'ROI 10', values: { Contrast: values(1, 9) } }, { ...context, index: 1 }),
    ];
    const columns = columnsForRows(rows, features);
    const contrast = columns.find((column) => column.id === 'feature:Contrast')!;
    expect(sortRows(rows, contrast, 'asc').map((row) => row.values.Contrast)).toEqual([1, 2, 3, 4, 5, 9]);
    const correlation = columns.find((column) => column.id === 'feature:CorrelationIII')!;
    const sorted = sortRows(rows, correlation, 'desc');
    expect(sorted.slice(-3).every((row) => row.values.CorrelationIII === undefined)).toBe(true);
    const roi = columns[0];
    expect(sortRows(rows, roi, 'desc')[0].roiName).toBe('ROI 10');
  });

  it('exports TSV with full precision and marked non-standard headers', () => {
    const rows = rowsForResult(ok, context);
    const tsv = rowsToTsv(rows, columnsForRows(rows, features)).split('\n');
    expect(tsv[0]).toBe('ROI\td\tDir\tPixels\tNg\tContrast\tCorrelation III [non-standard]\tScore\tStatus');
    expect(tsv[1]).toBe('ROI 1\t1\t0°\t100\t32\t2\t0.001\t70\t');
    expect(tsv).toHaveLength(4);
  });

  it('adds an area column in mm² once a measurement has a pixel spacing', () => {
    expect(columnsForRows(rowsForResult(ok, context), features).some((column) => column.id === 'area')).toBe(false);
    const spaced = rowsForResult(ok, { ...context, pixelSpacing: { x: 0.5, y: 0.25 } });
    const columns = columnsForRows([...rowsForResult(ok, context), ...spaced], features);
    const area = columns.find((column) => column.id === 'area')!;
    expect(area.label).toBe('Area (mm²)');
    expect(columns[columns.indexOf(area) - 1].id).toBe('pixels');
    expect(area.value(spaced[0])).toBe(ok.pixelCount * 0.5 * 0.25);
    expect(area.value(rowsForResult(ok, context)[0])).toBeNull();
  });

  it('adds an Image column only when rows come from several images', () => {
    const one = rowsForResult(ok, context);
    expect(columnsForRows(one, features)[0].id).toBe('roi');
    const two = [...one, ...rowsForResult(ok, { ...context, analysisId: 'ana_2', imageName: 'brick.png' })];
    const columns = columnsForRows(two, features);
    expect(columns[0]).toMatchObject({ id: 'image', label: 'Image' });
    expect(columns[0].value(two[two.length - 1])).toBe('brick.png');
  });

  it('adds a Slice column only for ROIs on the slices of a stack', () => {
    expect(columnsForRows(rowsForResult(ok, context), features).some((column) => column.id === 'slice')).toBe(false);
    const rows = rowsForResult({ ...ok, slice: 4 }, context);
    const slice = columnsForRows(rows, features).find((column) => column.id === 'slice')!;
    expect(slice).toMatchObject({ label: 'Slice', numeric: true });
    expect(slice.value(rows[0])).toBe(4);
  });

  it('keeps pasted text from running as a spreadsheet formula', () => {
    expect(spreadsheetText('=HYPERLINK("http://example.org")')).toBe(`'=HYPERLINK("http://example.org")`);
    for (const text of ['+1', '-left', '@SUM(A1)']) {
      expect(spreadsheetText(text)).toBe(`'${text}`);
    }
    for (const text of ['ROI 1', 'a=b', '', "'quoted"]) {
      expect(spreadsheetText(text)).toBe(text);
    }

    const negative: MeasurementResult = { ...ok, roiName: '=1+1', values: { ...ok.values, CorrelationIII: values(-0.5, -0.25) } };
    const rows = rowsForResult(negative, context);
    const tsv = rowsToTsv(rows, columnsForRows(rows, features)).split('\n');
    const cells = tsv[1].split('\t');
    expect(cells[0]).toBe("'=1+1");
    // Numbers stay numbers, including negative ones
    expect(cells[6]).toBe('-0.5');
  });
});
