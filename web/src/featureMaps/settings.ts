// Choices of the Feature Map dialog and the settings sent to POST /feature-maps. Gray levels, quantization, directions
// and log base come from the analysis settings; the rules mirror core/pipeline/FeatureMap.cpp.

import {
  FEATURE_MAP_AUTOMATIC_POINTS_PER_SIDE,
  FEATURE_MAP_EXCLUDED_FEATURES,
  FEATURE_MAP_MAX_POINTS_PER_SIDE,
  FEATURE_MAP_MAX_WINDOW,
  FEATURE_MAP_MIN_WINDOW,
  type AnalysisSettings,
  type CatalogResponse,
  type FeatureInfo,
  type FeatureMapSettings,
} from '@glcm/api';
import { ALL_DIRECTIONS } from '@glcm/api';

export const DEFAULT_MAP_FEATURE = 'Contrast';
export const DEFAULT_MAP_WINDOW = 15;

export interface FeatureMapChoice {
  feature: string;
  window: number;
  /** null: chosen automatically */
  step: number | null;
  distance: number;
}

export interface MapGrid {
  step: number;
  columns: number;
  rows: number;
}

/** Smallest step that gives at most 512 points along each side */
export function automaticStep(width: number, height: number): number {
  return Math.ceil(Math.max(width, height, 1) / FEATURE_MAP_AUTOMATIC_POINTS_PER_SIDE);
}

export function mapGrid(width: number, height: number, step: number | null): MapGrid {
  const used = step ?? automaticStep(width, height);
  return { step: used, columns: Math.ceil(width / used), rows: Math.ceil(height / used) };
}

/** Haralick and other co-occurrence features, except the Maximal Correlation Coefficient */
export function mappableFeatures(catalog: CatalogResponse): FeatureInfo[] {
  return catalog.features.filter((feature) => (feature.group === 'haralick' || feature.group === 'other') && !FEATURE_MAP_EXCLUDED_FEATURES.includes(feature.id));
}

/** The first problem of a choice for an image of this size, or null */
export function choiceProblem(choice: FeatureMapChoice, width: number, height: number): string | null {
  const { window, distance, step } = choice;
  if (!Number.isInteger(window) || window < FEATURE_MAP_MIN_WINDOW || window > FEATURE_MAP_MAX_WINDOW || window % 2 === 0) {
    return `The window must be an odd number of pixels between ${FEATURE_MAP_MIN_WINDOW} and ${FEATURE_MAP_MAX_WINDOW}`;
  }
  if (distance >= window) {
    return 'The distance must be smaller than the window';
  }
  if (step !== null) {
    if (!Number.isInteger(step) || step < 1) {
      return 'The step must be a whole number of pixels';
    }
    const { columns, rows } = mapGrid(width, height, step);
    if (Math.max(columns, rows) > FEATURE_MAP_MAX_POINTS_PER_SIDE) {
      return `A step of ${step} gives more than ${FEATURE_MAP_MAX_POINTS_PER_SIDE} points along a side; use at least ${Math.ceil(Math.max(width, height) / FEATURE_MAP_MAX_POINTS_PER_SIDE)}`;
    }
  }
  return null;
}

export function buildFeatureMapSettings(analysis: AnalysisSettings, choice: FeatureMapChoice): FeatureMapSettings {
  return {
    feature: choice.feature,
    window: choice.window,
    step: choice.step,
    grayLevels: analysis.grayLevels,
    quantization: analysis.quantization,
    distance: choice.distance,
    directions: ALL_DIRECTIONS.filter((direction) => analysis.directions.includes(direction)),
    logBase: analysis.logBase,
  };
}

/** How the whole image is quantized, e.g. "fixed range 0–255" */
export function describeQuantization({ method, min, max, binWidth }: AnalysisSettings['quantization']): string {
  switch (method) {
    case 'fixedRange':
      return `fixed range ${min}–${max}`;
    case 'roiMinMax':
      return 'image minimum–maximum';
    case 'fixedBinWidth':
      return `bin width ${binWidth} from the image minimum`;
    case 'none':
      return 'no quantization';
  }
}
