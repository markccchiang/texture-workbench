import type { AnalysisSettings, ImageInfo, MeasurementResult } from '@glcm/api';
import { describe, expect, it } from 'vitest';
import type { AnalysisRun } from '../results/resultsStore';
import type { ManagedRoi } from '../rois/roiStore';
import { fileNameFromDisposition, fileStem } from './download';
import { base64ToBytes, buildProject, bytesToBase64, parseProject, projectFileName, runsFromProject } from './project';

const info: ImageInfo = {
  imageId: `img_${'0'.repeat(32)}`,
  name: 'camera.png',
  sizeBytes: 3,
  width: 650,
  height: 366,
  bitDepth: 8,
  slices: 1,
  sourceChannels: 3,
  pixelSpacing: null,
  sha256: 'c'.repeat(64),
  transfer: 'raw',
  windowMin: 28,
  windowMax: 196,
  histogram: new Array<number>(256).fill(0),
  warnings: [],
  createdAt: '2026-09-14T00:00:00.000Z',
};

const settings: AnalysisSettings = {
  features: ['Contrast'],
  grayLevels: 32,
  quantization: { method: 'fixedRange', min: 0, max: 255, binWidth: 8 },
  distances: [1, 2],
  directions: [0, 90],
  aggregation: 'meanAndRange',
  logBase: 'log2',
  score: { enabled: true, age: 52.5, coefficients: [1, 2, 3, 4], profile: 'currentSettings', intensityMin: 0, intensityMax: 255 },
};

const values = { '0': 1.5, '45': null, '90': 0.1 + 0.2, '135': null, mean: 0.9, range: 1.2 };
const result: MeasurementResult = {
  roiId: 'r1',
  roiName: 'ROI 1',
  distance: 1,
  status: 'ok',
  error: '',
  pixelCount: 400,
  pairCounts: { '0': 380, '45': 0, '90': 380, '135': 0 },
  quantization: { lower: 0, upper: 255 },
  values: { Contrast: values },
  score: values,
  warnings: ['a warning'],
};

const rois: ManagedRoi[] = [
  { id: 'r1', name: 'ROI 1', color: '#FFD400', visible: false, shape: { type: 'ellipse', cx: 1 / 3, cy: 2, rx: 3, ry: 4, angle: -12.5 } },
];

const run = (status: AnalysisRun['status'], results: Array<MeasurementResult | undefined>): AnalysisRun => ({ pixelSpacing: null,
  analysisId: `ana_${status}`,
  imageName: 'camera.png',
  imageSha256: 'c'.repeat(64),
  settings,
  status,
  timestamp: '2026-09-14T10:00:00.000Z',
  completed: results.length,
  total: results.length,
  results,
});

describe('project files', () => {
  it('round-trips ROIs, settings and finished results without loss', () => {
    const project = buildProject({
      info,
      rois,
      settings,
      runs: [run('completed', [result, undefined]), run('running', [result])],
      coreVersion: '0.1.0',
      createdAt: '2026-09-14T11:00:00.000Z',
    });
    const parsed = parseProject(JSON.stringify(project));
    expect(parsed).toEqual(project);
    expect(parsed.image.data).toBeUndefined();
    expect(parsed.rois).toEqual(rois);
    expect(parsed.settings).toEqual(settings);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].results).toEqual([result]);

    const [restored] = runsFromProject(parsed);
    expect(restored).toEqual({ ...run('completed', [result]), completed: 1, total: 1 });
    expect(projectFileName(info.name)).toBe('camera.glcmproj');
  });

  it('embeds the image as base64', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7919) % 256);
    const project = buildProject({ info, rois: [], settings: null, runs: [], coreVersion: '0.1.0', imageBytes: bytes });
    const parsed = parseProject(JSON.stringify(project));
    expect(base64ToBytes(parsed.image.data!)).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  it('rejects other files', () => {
    expect(() => parseProject('{"format": "glcm-roi-set", "version": 1, "rois": []}')).toThrow(/not a project file/);
    const project = buildProject({ info, rois, settings, runs: [], coreVersion: '0.1.0' });
    expect(() => parseProject(JSON.stringify({ ...project, image: { ...project.image, bitDepth: 12 } }))).toThrow(/image\.bitDepth/);
  });
});

describe('download names', () => {
  it('reads Content-Disposition and makes safe stems', () => {
    expect(fileNameFromDisposition(`attachment; filename="camera_.csv"; filename*=UTF-8''camera%20%E2%9C%93.csv`, 'x')).toBe('camera ✓.csv');
    expect(fileNameFromDisposition('attachment; filename="rois.zip"', 'x')).toBe('rois.zip');
    expect(fileNameFromDisposition(null, 'fallback.csv')).toBe('fallback.csv');
    expect(fileStem('/tmp/My Image.v2.tif')).toBe('My_Image.v2');
    expect(fileStem('.hidden')).toBe('image');
  });
});
