// Runs, rows and catalog entries used by the report tests

import type { AnalysisSettings, FeatureInfo, ImageInfo, MeasurementResult } from '@glcm/api';
import type { AnalysisRun } from '../results/resultsStore';
import { rowsForResult, type ResultRow } from '../results/rows';

export const FEATURES: FeatureInfo[] = [
  { id: 'Contrast', name: 'Contrast', group: 'haralick', nonStandard: false, nonStandardReason: '', docAnchor: '', cost: 'normal' },
  { id: 'Entropy', name: 'Entropy', group: 'haralick', nonStandard: false, nonStandardReason: '', docAnchor: '', cost: 'normal' },
];

export const SETTINGS: AnalysisSettings = {
  features: ['Contrast', 'Entropy'],
  grayLevels: 32,
  quantization: { method: 'fixedRange', min: 0, max: 255, binWidth: 0 },
  distances: [1],
  directions: [0, 45, 90, 135],
  aggregation: 'meanOnly',
  logBase: 'natural',
  score: { enabled: false, age: 40, coefficients: [1, 1, 1, 1], profile: 'calibration', intensityMin: 0, intensityMax: 255 },
};

export function measurement(roiId: string, roiName: string, options: Partial<MeasurementResult> = {}): MeasurementResult {
  return {
    roiId,
    roiName,
    distance: 1,
    status: 'ok',
    error: '',
    pixelCount: 400,
    pairCounts: { '0': 1, '45': 1, '90': 1, '135': 1 },
    quantization: { lower: 0, upper: 255 },
    values: {
      Contrast: { '0': 1, '45': 2, '90': 3, '135': 4, mean: 2.5, range: 3 },
      Entropy: { '0': 5, '45': 5, '90': 5, '135': 5, mean: 5, range: 0 },
    },
    score: null,
    warnings: [],
    ...options,
  };
}

export function run(analysisId: string, imageName: string, results: MeasurementResult[], overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  return {
    analysisId,
    imageName,
    imageSha256: `${imageName}-sha`,
    settings: SETTINGS,
    pixelSpacing: null,
    status: 'completed',
    timestamp: '2026-09-16T10:00:00.000Z',
    completed: results.length,
    total: results.length,
    results,
    ...overrides,
  };
}

export function rowsOf(runs: readonly AnalysisRun[]): ResultRow[] {
  return runs.flatMap((entry) =>
    entry.results.flatMap((result, index) =>
      result ? rowsForResult(result, { analysisId: entry.analysisId, index, imageName: entry.imageName, settings: entry.settings, pixelSpacing: entry.pixelSpacing }) : [],
    ),
  );
}

export const IMAGE_INFO: ImageInfo = {
  imageId: `img_${'a'.repeat(32)}`,
  name: 'camera.png',
  sizeBytes: 1000,
  width: 64,
  height: 48,
  bitDepth: 8,
  slices: 1,
  sourceChannels: 1,
  pixelSpacing: null,
  sha256: 'camera.png-sha',
  transfer: 'raw',
  windowMin: 0,
  windowMax: 255,
  histogram: Array.from({ length: 256 }, () => 0),
  warnings: [],
  createdAt: '2026-09-16T09:00:00.000Z',
};
