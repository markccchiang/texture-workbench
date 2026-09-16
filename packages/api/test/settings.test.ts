import type { CatalogResponse } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import { adaptToImage, applyPreset, checkSettings, defaultSettings, matchingPreset, parseDistances, requestSettings } from '../src/settings.js';

const catalog: Pick<CatalogResponse, 'presets' | 'limits'> = {
  presets: [
    { id: 'haralick', name: 'Haralick F1–F14', features: ['Energy', 'Contrast', 'CorrelationII'], enablesScore: false },
    { id: 'score', name: 'Score', features: ['Mean', 'Entropy', 'Contrast'], enablesScore: true },
  ],
  limits: {
    minGrayLevels: 2,
    maxGrayLevels: 256,
    defaultGrayLevels: 32,
    maxDistance: 64,
    directions: [0, 45, 90, 135],
    quantizationMethods: ['fixedRange', 'roiMinMax', 'fixedBinWidth', 'none'],
    aggregations: ['perDirectionAndMean', 'meanOnly', 'meanAndRange'],
    logBases: ['natural', 'log2'],
    scoreProfiles: ['calibration', 'currentSettings'],
    defaultScoreCoefficients: { age: 1.138, mean: -1.814, entropy: 1.416, contrast: 1.714 },
  },
};

describe('defaults and presets', () => {
  it('uses the Haralick preset, Ng 32 and the full intensity range', () => {
    const settings = defaultSettings(catalog, 16);
    expect(settings).toMatchObject({
      features: ['Energy', 'Contrast', 'CorrelationII'],
      grayLevels: 32,
      quantization: { method: 'fixedRange', min: 0, max: 65535 },
      distances: [1],
      directions: [0, 45, 90, 135],
      score: { enabled: false, age: 40, coefficients: [1.138, -1.814, 1.416, 1.714], profile: 'calibration' },
    });
    expect(defaultSettings(catalog, 8).quantization.max).toBe(255);
  });

  it('applies presets and recognizes them', () => {
    const score = applyPreset(defaultSettings(catalog, 8), catalog.presets[1]);
    expect(score.score.enabled).toBe(true);
    expect(matchingPreset(score.features, catalog.presets)).toBe('score');
    expect(matchingPreset(['Contrast', 'Entropy', 'Mean'], catalog.presets)).toBe('score');
    expect(matchingPreset(['Contrast'], catalog.presets)).toBe('custom');
  });

  it('adapts stored ranges to the bit depth of the image', () => {
    const adapted = adaptToImage(defaultSettings(catalog, 16), 8);
    expect(adapted.quantization).toMatchObject({ min: 0, max: 255 });
    expect(adapted.score.intensityMax).toBe(255);
    // The full 8-bit range becomes the full 16-bit range; other ranges are kept
    expect(adaptToImage(defaultSettings(catalog, 8), 16).quantization).toMatchObject({ min: 0, max: 65535 });
    const custom = defaultSettings(catalog, 16);
    custom.quantization = { ...custom.quantization, min: 100, max: 4000 };
    expect(adaptToImage(custom, 16).quantization).toMatchObject({ min: 100, max: 4000 });
    expect(adaptToImage(custom, 8).quantization).toMatchObject({ min: 100, max: 255 });
  });
});

describe('checkSettings', () => {
  const valid = defaultSettings(catalog, 8);

  it('asks for a pixel spacing when resampling', () => {
    const resampled = { ...valid, resampling: { x: 0.5, y: 0.5 } };
    expect(checkSettings(resampled, 8, catalog, { x: 0.5, y: 0.8 }).errors).toEqual([]);
    expect(checkSettings(resampled, 8, catalog).errors).toEqual([]);
    expect(checkSettings(resampled, 8, catalog, null).errors).toEqual(['Resampling needs a pixel spacing: set it in Image Info, or turn resampling off.']);
    expect(checkSettings({ ...valid, resampling: { x: 0, y: 0.5 } }, 8, catalog, { x: 1, y: 1 }).errors).toEqual(['The resampled pixel spacing must be greater than 0.']);
  });

  it('accepts the defaults', () => {
    expect(checkSettings(valid, 8, catalog)).toEqual({ errors: [], warnings: [] });
  });

  it('reports errors', () => {
    const issues = checkSettings(
      {
        ...valid,
        features: [],
        grayLevels: 300,
        quantization: { ...valid.quantization, min: 100, max: 50 },
        distances: [0],
        directions: [],
      },
      8,
      catalog,
    );
    expect(issues.errors).toHaveLength(5);
    expect(checkSettings({ ...valid, quantization: { ...valid.quantization, max: 300 } }, 8, catalog).errors[0]).toContain('0–255');
    expect(checkSettings({ ...valid, quantization: { ...valid.quantization, method: 'fixedBinWidth', binWidth: 0 } }, 8, catalog).errors).toHaveLength(1);
  });

  it('warns about slow or uncalibrated settings', () => {
    const slow = checkSettings({ ...valid, features: ['MaximalCorrelationCoefficient'], grayLevels: 128 }, 8, catalog);
    expect(slow.warnings[0]).toContain('slow');
    const uncalibrated = checkSettings({ ...valid, score: { ...valid.score, enabled: true, profile: 'currentSettings' } }, 8, catalog);
    expect(uncalibrated.warnings[0]).toContain('calibrated');
    expect(checkSettings({ ...valid, quantization: { ...valid.quantization, method: 'none' } }, 8, catalog).warnings[0]).toContain('quantization');
  });
});

describe('request helpers', () => {
  it('parses distance lists', () => {
    expect(parseDistances('3, 1 2,2')).toEqual([1, 2, 3]);
    expect(parseDistances('')).toEqual([]);
    expect(parseDistances('1, x')).toBeNull();
    expect(parseDistances('0')).toBeNull();
  });

  it('orders directions and maps the 16-bit calibration score to the window', () => {
    const settings = { ...defaultSettings(catalog, 16), directions: [90, 0] as Array<0 | 90>, distances: [2, 1, 2] };
    const request = requestSettings(settings, 16, { min: 1000, max: 3000 });
    expect(request.directions).toEqual([0, 90]);
    expect(request.distances).toEqual([1, 2]);
    expect(request.score).toMatchObject({ intensityMin: 1000, intensityMax: 3000 });
    expect(requestSettings(settings, 8, { min: 10, max: 20 }).score.intensityMin).toBe(0);
  });
});
