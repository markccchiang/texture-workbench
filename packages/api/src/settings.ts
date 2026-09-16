// Analysis settings: the defaults, the presets and the checks the app, the command line and the agent server share
// (doc/ui-design-plan.md, section 6.3.1).

import type { AnalysisSettings, Direction } from './analysis.js';
import type { CatalogResponse, FeaturePreset } from './schemas.js';

export const GRAY_LEVEL_CHOICES = [8, 16, 32, 64, 128, 256];
export const ALL_DIRECTIONS: Direction[] = [0, 45, 90, 135];
/** MCC costs O(Ng³) per direction */
export const MCC_WARNING_GRAY_LEVELS = 64;
export const CUSTOM_PRESET = 'custom';

export function maxIntensity(bitDepth: 8 | 16): number {
  return bitDepth === 16 ? 65535 : 255;
}

type Catalog = Pick<CatalogResponse, 'presets' | 'limits'>;

export function defaultSettings(catalog: Catalog, bitDepth: 8 | 16): AnalysisSettings {
  const haralick = catalog.presets.find((preset) => preset.id === 'haralick') ?? catalog.presets[0];
  const coefficients = catalog.limits.defaultScoreCoefficients;
  return {
    features: [...(haralick?.features ?? [])],
    grayLevels: catalog.limits.defaultGrayLevels,
    quantization: { method: 'fixedRange', min: 0, max: maxIntensity(bitDepth), binWidth: bitDepth === 16 ? 256 : 8 },
    distances: [1],
    directions: [...ALL_DIRECTIONS],
    aggregation: 'perDirectionAndMean',
    logBase: 'natural',
    score: {
      enabled: haralick?.enablesScore ?? false,
      age: 40,
      coefficients: [coefficients.age, coefficients.mean, coefficients.entropy, coefficients.contrast],
      profile: 'calibration',
      intensityMin: 0,
      intensityMax: maxIntensity(bitDepth),
    },
  };
}

export function applyPreset(settings: AnalysisSettings, preset: FeaturePreset): AnalysisSettings {
  return { ...settings, features: [...preset.features], score: { ...settings.score, enabled: preset.enablesScore } };
}

/** The preset whose features equal the selection, or "custom" */
export function matchingPreset(features: readonly string[], presets: readonly FeaturePreset[]): string {
  const selected = new Set(features);
  const preset = presets.find((candidate) => candidate.features.length === selected.size && candidate.features.every((id) => selected.has(id)));
  return preset?.id ?? CUSTOM_PRESET;
}

/** Settings made from stored values that fit the image: fixed ranges and 16-bit score mapping stay within the bit depth */
export function adaptToImage(settings: AnalysisSettings, bitDepth: 8 | 16): AnalysisSettings {
  const limit = maxIntensity(bitDepth);
  const otherLimit = maxIntensity(bitDepth === 16 ? 8 : 16);
  const clamp = (value: number) => Math.min(limit, Math.max(0, Math.round(value)));
  // The full range of the other bit depth becomes the full range of this one
  const fullRange = (min: number, max: number): [number, number] => (min === 0 && max === otherLimit ? [0, limit] : [clamp(min), clamp(max)]);
  const [quantizationMin, quantizationMax] = fullRange(settings.quantization.min, settings.quantization.max);
  const [scoreMin, scoreMax] = fullRange(settings.score.intensityMin, settings.score.intensityMax);
  return {
    ...settings,
    quantization: { ...settings.quantization, min: quantizationMin, max: quantizationMax },
    score: { ...settings.score, intensityMin: scoreMin, intensityMax: scoreMax },
  };
}

export interface SettingsIssues {
  errors: string[];
  warnings: string[];
}

export function checkSettings(settings: AnalysisSettings, bitDepth: 8 | 16, catalog: Catalog): SettingsIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { limits } = catalog;
  const limit = maxIntensity(bitDepth);

  if (settings.features.length === 0) {
    errors.push('Select at least one feature.');
  }
  if (!Number.isInteger(settings.grayLevels) || settings.grayLevels < limits.minGrayLevels || settings.grayLevels > limits.maxGrayLevels) {
    errors.push(`Gray levels must be an integer from ${limits.minGrayLevels} to ${limits.maxGrayLevels}.`);
  }

  const { quantization } = settings;
  if (quantization.method === 'fixedRange') {
    if (quantization.min < 0 || quantization.max > limit) {
      errors.push(`The quantization range must be within 0–${limit}.`);
    } else if (quantization.min >= quantization.max) {
      errors.push('The quantization minimum must be below the maximum.');
    }
  }
  if (quantization.method === 'fixedBinWidth' && !(quantization.binWidth > 0)) {
    errors.push('The bin width must be greater than 0.');
  }
  if (quantization.method === 'none' && settings.grayLevels <= limit) {
    warnings.push(`Without quantization, ROIs with intensities of ${settings.grayLevels} or more fail.`);
  }

  if (settings.distances.length === 0) {
    errors.push('Add at least one distance.');
  } else if (settings.distances.some((d) => !Number.isInteger(d) || d < 1 || d > limits.maxDistance)) {
    errors.push(`Distances must be integers from 1 to ${limits.maxDistance}.`);
  }
  if (settings.directions.length === 0) {
    errors.push('Select at least one direction.');
  }

  if (settings.features.includes('MaximalCorrelationCoefficient') && settings.grayLevels > MCC_WARNING_GRAY_LEVELS) {
    warnings.push(`The Maximal Correlation Coefficient is slow for Ng > ${MCC_WARNING_GRAY_LEVELS}.`);
  }
  if (settings.score.enabled) {
    if (!Number.isFinite(settings.score.age) || settings.score.age < 0) {
      errors.push('The age must be a number of at least 0.');
    }
    if (settings.score.profile === 'currentSettings') {
      warnings.push('The score coefficients were calibrated with Ng = 256, d = 1 and all directions; they may not apply.');
    } else if (bitDepth === 16 && settings.score.intensityMin >= settings.score.intensityMax) {
      errors.push('The score intensity range must have its minimum below the maximum.');
    }
  }
  return { errors, warnings };
}

/** Distances from text such as "1, 2 4": sorted, unique positive integers; null if any entry is invalid */
export function parseDistances(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const values = parts.map(Number);
  if (values.some((value) => !Number.isInteger(value) || value < 1)) {
    return null;
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/** The settings sent with a request: directions in angle order and, for 16-bit calibration scores, the display window */
export function requestSettings(settings: AnalysisSettings, bitDepth: 8 | 16, window: { min: number; max: number }): AnalysisSettings {
  const directions = ALL_DIRECTIONS.filter((direction) => settings.directions.includes(direction));
  const score =
    bitDepth === 16 && settings.score.profile === 'calibration'
      ? { ...settings.score, intensityMin: window.min, intensityMax: Math.max(window.max, window.min + 1) }
      : settings.score;
  return { ...settings, directions, distances: [...new Set(settings.distances)].sort((a, b) => a - b), score };
}
