// Feature map schemas: a co-occurrence feature computed in a sliding window over the whole image
// (glcm::ComputeFeatureMapRows in core/pipeline/FeatureMap.hpp). Field names follow core/io/Json.cpp.

import { Type, type Static } from 'typebox';
import { AnalysisSettings, Direction } from './analysis.js';
import { IMAGE_ID_PATTERN, Slice } from './schemas.js';

// Limits of core/pipeline/FeatureMap.hpp
export const FEATURE_MAP_MIN_WINDOW = 3;
export const FEATURE_MAP_MAX_WINDOW = 127;
export const FEATURE_MAP_AUTOMATIC_POINTS_PER_SIDE = 512;
export const FEATURE_MAP_MAX_POINTS_PER_SIDE = 2048;
/** The feature that is too slow to compute in every window */
export const FEATURE_MAP_EXCLUDED_FEATURES: readonly string[] = ['MaximalCorrelationCoefficient'];

export const FeatureMapSettings = Type.Object({
  feature: Type.String({
    description: 'Id of a Haralick or other co-occurrence feature from GET /catalog, except MaximalCorrelationCoefficient',
  }),
  window: Type.Integer({
    minimum: FEATURE_MAP_MIN_WINDOW,
    maximum: FEATURE_MAP_MAX_WINDOW,
    description: 'Odd side of the square window in pixels; windows are clipped at the image edges',
  }),
  step: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
    description: `Grid spacing in image pixels; null chooses the smallest step that gives at most ${FEATURE_MAP_AUTOMATIC_POINTS_PER_SIDE} points per side`,
  }),
  grayLevels: AnalysisSettings.properties.grayLevels,
  quantization: Type.Object(AnalysisSettings.properties.quantization.properties, {
    description: 'Applied to the whole image: roiMinMax uses the image minimum and maximum, fixedBinWidth starts at the image minimum',
  }),
  distance: Type.Integer({ minimum: 1, maximum: 64, description: 'Pixel pair distance; smaller than the window' }),
  directions: Type.Array(Direction, { minItems: 1, maxItems: 4, description: 'The map shows the mean over these directions' }),
  logBase: AnalysisSettings.properties.logBase,
});
export type FeatureMapSettings = Static<typeof FeatureMapSettings>;

export const FeatureMapRequest = Type.Object({
  imageId: Type.String({ pattern: IMAGE_ID_PATTERN }),
  slice: Type.Optional(Slice),
  settings: FeatureMapSettings,
});
export type FeatureMapRequest = Static<typeof FeatureMapRequest>;

export const FEATURE_MAP_ID_PATTERN = '^fmap_[0-9a-f]{32}$';

export const FeatureMapIdParams = Type.Object({ id: Type.String({ pattern: FEATURE_MAP_ID_PATTERN }) });
export type FeatureMapIdParams = Static<typeof FeatureMapIdParams>;

export const FeatureMapStatus = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
  Type.Literal('failed'),
]);
export type FeatureMapStatus = Static<typeof FeatureMapStatus>;

export const FeatureMapInfo = Type.Object({
  featureMapId: Type.String({ pattern: FEATURE_MAP_ID_PATTERN }),
  imageId: Type.String({ pattern: IMAGE_ID_PATTERN }),
  imageName: Type.String(),
  slice: Type.Integer({ minimum: 1, description: 'The slice of the image the map covers' }),
  status: FeatureMapStatus,
  settings: FeatureMapSettings,
  step: Type.Integer({ minimum: 1, description: 'Grid spacing used, also when the settings chose it automatically' }),
  columns: Type.Integer({ description: 'ceil(image width / step)' }),
  rows: Type.Integer({ description: 'ceil(image height / step)' }),
  completedRows: Type.Integer(),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  finishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  coreVersion: Type.String(),
});
export type FeatureMapInfo = Static<typeof FeatureMapInfo>;
