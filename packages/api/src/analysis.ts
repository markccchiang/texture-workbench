// ROI, ROI statistics and analysis schemas (doc/ui-design-plan.md, sections 6.2, 6.3, 8.4 and 8.5). Field names follow
// the JSON written and read by glcm_core (core/io/Json.cpp).

import { Type, type Static } from 'typebox';
import { IMAGE_ID_PATTERN, PixelSpacing, Slice } from './schemas.js';

// Limits from doc/ui-design-plan.md, section 8.2
export const MAX_ROIS_PER_REQUEST = 1000;
export const MAX_POLYGON_VERTICES = 10000;

const Coordinate = Type.Number({ description: 'Image pixel coordinate; pixel (c, r) covers [c, c + 1) × [r, r + 1)' });

// ---------------------------------------------------------------------------------------------------------------------
// ROIs
// ---------------------------------------------------------------------------------------------------------------------

export const RectangleShape = Type.Object({
  type: Type.Literal('rectangle'),
  x: Coordinate,
  y: Coordinate,
  width: Type.Number(),
  height: Type.Number(),
});
export type RectangleShape = Static<typeof RectangleShape>;

export const EllipseShape = Type.Object({
  type: Type.Literal('ellipse'),
  cx: Coordinate,
  cy: Coordinate,
  rx: Type.Number({ description: 'Semi-axis along the ellipse x axis' }),
  ry: Type.Number({ description: 'Semi-axis along the ellipse y axis' }),
  angle: Type.Optional(Type.Number({ description: 'Rotation in degrees, clockwise on screen' })),
});
export type EllipseShape = Static<typeof EllipseShape>;

export const PolygonShape = Type.Object({
  type: Type.Literal('polygon'),
  points: Type.Array(Type.Tuple([Coordinate, Coordinate]), { maxItems: MAX_POLYGON_VERTICES }),
  freehand: Type.Optional(Type.Boolean()),
});
export type PolygonShape = Static<typeof PolygonShape>;

export const RoiShape = Type.Union([RectangleShape, EllipseShape, PolygonShape]);
export type RoiShape = Static<typeof RoiShape>;

export const Roi = Type.Object({
  id: Type.String({ maxLength: 100 }),
  name: Type.String({ maxLength: 200 }),
  color: Type.Optional(Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' })),
  class: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Class of the ROI, e.g. "lesion"; carried into the results and exports' })),
  slice: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000, description: 'The slice of a stack the ROI lies on, from 1; omitted for a single image (slice 1)' })),
  shape: RoiShape,
});
export type Roi = Static<typeof Roi>;

// ---------------------------------------------------------------------------------------------------------------------
// ROI statistics
// ---------------------------------------------------------------------------------------------------------------------

export const RoiStatsRequest = Type.Object({
  rois: Type.Array(Type.Object({ id: Type.String({ maxLength: 100 }), slice: Type.Optional(Slice), shape: RoiShape }), { maxItems: MAX_ROIS_PER_REQUEST }),
});
export type RoiStatsRequest = Static<typeof RoiStatsRequest>;

const NullableNumber = Type.Union([Type.Number(), Type.Null()]);

export const RoiStatistics = Type.Object({
  roiId: Type.String(),
  pixelCount: Type.Integer({ description: 'Pixels whose centre lies inside the shape, clipped to the image' }),
  boundingBox: Type.Union([
    Type.Object({ x: Type.Integer(), y: Type.Integer(), width: Type.Integer(), height: Type.Integer() }),
    Type.Null(),
  ]),
  min: NullableNumber,
  max: NullableNumber,
  mean: NullableNumber,
  std: NullableNumber,
  error: Type.Union([Type.String(), Type.Null()], { description: 'Invalid geometry' }),
});
export type RoiStatistics = Static<typeof RoiStatistics>;

export const RoiStatsResponse = Type.Object({ stats: Type.Array(RoiStatistics) });
export type RoiStatsResponse = Static<typeof RoiStatsResponse>;

// ---------------------------------------------------------------------------------------------------------------------
// ROIs from pixel values (threshold and magic wand)
// ---------------------------------------------------------------------------------------------------------------------

const Intensity = Type.Integer({ minimum: 0, maximum: 65535 });

export const SelectedRegion = Type.Object({
  points: Type.Array(Type.Tuple([Coordinate, Coordinate]), {
    description: 'Polygon along the pixel edges around the region with its holes filled, clockwise on screen; its pixels (pixel-centre rule) are exactly the region',
  }),
  pixelCount: Type.Integer({ description: 'Pixels of the region, holes included' }),
  boundingBox: Type.Object({ x: Type.Integer(), y: Type.Integer(), width: Type.Integer(), height: Type.Integer() }),
});
export type SelectedRegion = Static<typeof SelectedRegion>;

export const ThresholdRoisRequest = Type.Object({
  slice: Type.Optional(Slice),
  min: Intensity,
  max: Intensity,
  minPixels: Type.Integer({ minimum: 1, description: 'Regions with fewer pixels (holes included) are left out' }),
  maxRegions: Type.Integer({ minimum: 0, maximum: MAX_ROIS_PER_REQUEST, description: 'Regions returned, largest first; 0 returns only the total' }),
  maxPixels: Type.Optional(Type.Integer({ minimum: 1, description: 'Regions with more pixels (holes included) are left out' })),
  minSphericity: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1, description: 'Regions with a lower sphericity (the shape feature, in pixel units) are left out' }),
  ),
});
export type ThresholdRoisRequest = Static<typeof ThresholdRoisRequest>;

export const ThresholdRoisResponse = Type.Object({
  regions: Type.Array(SelectedRegion),
  total: Type.Integer({ description: 'Regions that pass the size and sphericity filters, including those not returned' }),
});
export type ThresholdRoisResponse = Static<typeof ThresholdRoisResponse>;

export const WandRoiRequest = Type.Object({
  slice: Type.Optional(Slice),
  x: Type.Integer({ description: 'Column of the clicked pixel' }),
  y: Type.Integer({ description: 'Row of the clicked pixel' }),
  tolerance: Type.Integer({ minimum: 0, maximum: 65535, description: 'Largest difference from the clicked pixel value' }),
});
export type WandRoiRequest = Static<typeof WandRoiRequest>;

export const WandRoiResponse = Type.Object({
  region: Type.Union([SelectedRegion, Type.Null()], { description: 'null when the pixel lies outside the image' }),
});
export type WandRoiResponse = Static<typeof WandRoiResponse>;

// ---------------------------------------------------------------------------------------------------------------------
// Editing ROIs on the pixel grid (brush, eraser, union, subtract, intersect, xor, enlarge, shrink and band)
// ---------------------------------------------------------------------------------------------------------------------

export const RoiOperation = Type.Union([Type.Literal('union'), Type.Literal('subtract'), Type.Literal('intersect'), Type.Literal('xor')]);
export type RoiOperation = Static<typeof RoiOperation>;

export const CombineRoisRequest = Type.Object({
  operation: RoiOperation,
  shapes: Type.Array(RoiShape, {
    minItems: 2,
    maxItems: MAX_ROIS_PER_REQUEST,
    description:
      'union: the pixels of any shape; subtract: the pixels of the first shape that no other shape covers; intersect: the pixels every shape covers; xor: the pixels an odd number of shapes cover',
  }),
});
export type CombineRoisRequest = Static<typeof CombineRoisRequest>;

export const GrowOperation = Type.Union([Type.Literal('enlarge'), Type.Literal('shrink'), Type.Literal('band')]);
export type GrowOperation = Static<typeof GrowOperation>;

export const GrowRoiRequest = Type.Object({
  shape: RoiShape,
  operation: GrowOperation,
  distance: Type.Number({
    exclusiveMinimum: 0,
    maximum: 100000,
    description: 'Between pixel centres: in pixels, or in millimetres when pixelSpacing is given',
  }),
  pixelSpacing: Type.Optional(PixelSpacing),
});
export type GrowRoiRequest = Static<typeof GrowRoiRequest>;

export const BrushRoiRequest = Type.Object({
  shape: Type.Union([RoiShape, Type.Null()], { description: 'The ROI to paint into or erase from; null paints a new shape' }),
  path: Type.Array(Type.Tuple([Coordinate, Coordinate]), { minItems: 1, maxItems: MAX_POLYGON_VERTICES, description: 'The stroke; one point paints a disc' }),
  radius: Type.Number({ exclusiveMinimum: 0, maximum: 1000, description: 'Pixels whose centres lie within this distance of the path are painted' }),
  erase: Type.Boolean(),
});
export type BrushRoiRequest = Static<typeof BrushRoiRequest>;

export const RoiShapeResult = Type.Object({
  shape: Type.Union([PolygonShape, Type.Null()], {
    description: 'One polygon along the pixel edges whose pixels are exactly the result, with separate parts and holes joined by zero-width cuts (even-odd rule); null when no pixel is left',
  }),
  pixelCount: Type.Integer(),
  boundingBox: Type.Union([Type.Object({ x: Type.Integer(), y: Type.Integer(), width: Type.Integer(), height: Type.Integer() }), Type.Null()]),
});
export type RoiShapeResult = Static<typeof RoiShapeResult>;

// ---------------------------------------------------------------------------------------------------------------------
// Livewire
// ---------------------------------------------------------------------------------------------------------------------

/** Largest distance between the two points of a livewire segment along either axis (core/roi/Livewire.hpp) */
export const MAX_LIVEWIRE_SPAN = 1024;

const PixelPoint = Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }) });

export const LivewireRequest = Type.Object({
  slice: Type.Optional(Slice),
  from: PixelPoint,
  to: PixelPoint,
  sigma: Type.Number({ minimum: 0, maximum: 10, description: 'Gaussian smoothing before the gradient, in pixels' }),
});
export type LivewireRequest = Static<typeof LivewireRequest>;

// ---------------------------------------------------------------------------------------------------------------------
// Line profile and ROI histogram
// ---------------------------------------------------------------------------------------------------------------------

export const MAX_PROFILE_LENGTH = 100_000;
export const MAX_HISTOGRAM_BINS = 65_536;

export const LineProfileRequest = Type.Object({
  slice: Type.Optional(Slice),
  from: Type.Object({ x: Coordinate, y: Coordinate }),
  to: Type.Object({ x: Coordinate, y: Coordinate }),
});
export type LineProfileRequest = Static<typeof LineProfileRequest>;

export const LineProfileResponse = Type.Object({
  values: Type.Array(Type.Union([Type.Number(), Type.Null()]), {
    description:
      'round(length) + 1 samples evenly spaced from `from` to `to`, each interpolated bilinearly between the nearest pixel centres; null outside the image',
  }),
  length: Type.Number({ description: 'Length of the line in pixels' }),
  step: Type.Number({ description: 'Distance between samples in pixels (0 for a single sample)' }),
});
export type LineProfileResponse = Static<typeof LineProfileResponse>;

export const RoiHistogramRequest = Type.Object({
  slice: Type.Optional(Slice),
  shape: RoiShape,
  bins: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HISTOGRAM_BINS, description: 'Most bins; default 256' })),
});
export type RoiHistogramRequest = Static<typeof RoiHistogramRequest>;

export const RoiHistogramResponse = Type.Object({
  pixelCount: Type.Integer(),
  min: NullableNumber,
  max: NullableNumber,
  mean: NullableNumber,
  std: Type.Union([Type.Number(), Type.Null()], { description: 'Sample standard deviation' }),
  mode: Type.Union([Type.Number(), Type.Null()], { description: 'The most frequent value (the lowest of equally frequent ones)' }),
  binStart: Type.Integer(),
  binWidth: Type.Integer({ description: 'The smallest whole width that covers min–max in at most `bins` bins' }),
  counts: Type.Array(Type.Integer(), { description: 'counts[i]: pixels with binStart + i × binWidth ≤ value < binStart + (i + 1) × binWidth' }),
});
export type RoiHistogramResponse = Static<typeof RoiHistogramResponse>;

export const LivewireResponse = Type.Object({
  points: Type.Array(Type.Tuple([Coordinate, Coordinate]), {
    description: 'Pixel centres of the path from `from` to `to`, where it changes direction, both ends included',
  }),
});
export type LivewireResponse = Static<typeof LivewireResponse>;

// ---------------------------------------------------------------------------------------------------------------------
// Analysis settings
// ---------------------------------------------------------------------------------------------------------------------

export const QuantizationMethod = Type.Union([
  Type.Literal('fixedRange'),
  Type.Literal('roiMinMax'),
  Type.Literal('fixedBinWidth'),
  Type.Literal('none'),
]);
export type QuantizationMethod = Static<typeof QuantizationMethod>;

export const Direction = Type.Union([Type.Literal(0), Type.Literal(45), Type.Literal(90), Type.Literal(135)]);
export type Direction = Static<typeof Direction>;

export const Aggregation = Type.Union([Type.Literal('perDirectionAndMean'), Type.Literal('meanOnly'), Type.Literal('meanAndRange')]);
export type Aggregation = Static<typeof Aggregation>;

export const ScoreProfile = Type.Union([Type.Literal('calibration'), Type.Literal('currentSettings')]);
export type ScoreProfile = Static<typeof ScoreProfile>;

export const AnalysisSettings = Type.Object({
  features: Type.Array(Type.String(), { minItems: 1, maxItems: 512, description: 'Feature ids from GET /catalog' }),
  grayLevels: Type.Integer({ minimum: 2, maximum: 256 }),
  quantization: Type.Object({
    method: QuantizationMethod,
    min: Type.Integer({ minimum: 0, maximum: 65535, description: 'fixedRange: lowest intensity' }),
    max: Type.Integer({ minimum: 0, maximum: 65535, description: 'fixedRange: highest intensity' }),
    binWidth: Type.Number({ minimum: 0, description: 'fixedBinWidth: intensities per gray level' }),
  }),
  distances: Type.Array(Type.Integer({ minimum: 1, maximum: 64 }), { minItems: 1, maxItems: 64 }),
  directions: Type.Array(Direction, { minItems: 1, maxItems: 4 }),
  aggregation: Aggregation,
  logBase: Type.Union([Type.Literal('natural'), Type.Literal('log2')]),
  score: Type.Object({
    enabled: Type.Boolean(),
    age: Type.Number(),
    coefficients: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()], {
      description: 'Age, mean, entropy and contrast coefficients',
    }),
    profile: ScoreProfile,
    intensityMin: Type.Integer({ minimum: 0, maximum: 65535, description: 'Calibration profile on 16-bit images: mapped to 0' }),
    intensityMax: Type.Integer({ minimum: 0, maximum: 65535, description: 'Calibration profile on 16-bit images: mapped to 255' }),
  }),
  resampling: Type.Optional(
    Type.Object(
      {
        x: Type.Number({ exclusiveMinimum: 0, maximum: 1e6, description: 'Millimetres per pixel, horizontally' }),
        y: Type.Number({ exclusiveMinimum: 0, maximum: 1e6, description: 'Millimetres per pixel, vertically' }),
      },
      {
        additionalProperties: false,
        description:
          "Resample the image (cubic B-spline) and the ROIs to this pixel spacing before measuring; needs the image's pixel spacing. Pixel counts, areas and shape features then refer to the resampled pixels.",
      },
    ),
  ),
  filter: Type.Optional(
    Type.Union(
      [
        Type.Object(
          {
            type: Type.Literal('laplacianOfGaussian'),
            sigma: Type.Number({ exclusiveMinimum: 0, maximum: 1000, description: 'Millimetres with a pixel spacing, pixels without one' }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            type: Type.Literal('wavelet'),
            wavelet: Type.Optional(Type.Literal('coif1')),
            band: Type.Union([Type.Literal('LL'), Type.Literal('LH'), Type.Literal('HL'), Type.Literal('HH')], {
              description: 'First letter along x (between columns), second along y: L low-pass, H high-pass',
            }),
          },
          { additionalProperties: false },
        ),
      ],
      {
        description:
          'Measure a filtered image (after resampling), as PyRadiomics computes it: the Laplacian of Gaussian, or one sub-band of the Coiflet 1 stationary wavelet transform. Its values are real, so quantization must be fixedBinWidth or roiMinMax (binned as PyRadiomics bins), and local binary patterns and the score are not available.',
      },
    ),
  ),
});
export type AnalysisSettings = Static<typeof AnalysisSettings>;

// ---------------------------------------------------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------------------------------------------------

export const ANALYSIS_ID_PATTERN = '^ana_[0-9a-f]{32}$';

export const AnalysisIdParams = Type.Object({ id: Type.String({ pattern: ANALYSIS_ID_PATTERN }) });
export type AnalysisIdParams = Static<typeof AnalysisIdParams>;

export const AnalysisRequest = Type.Object({
  imageId: Type.String({ pattern: IMAGE_ID_PATTERN }),
  rois: Type.Array(Roi, { minItems: 1, maxItems: MAX_ROIS_PER_REQUEST }),
  settings: AnalysisSettings,
  pixelSpacing: Type.Optional(
    Type.Union([PixelSpacing, Type.Null()], {
      description: "Pixel spacing for the ROI areas in the results, e.g. entered by the user; null for none. Omitted: the image's own pixelSpacing",
    }),
  ),
});
export type AnalysisRequest = Static<typeof AnalysisRequest>;

export const FeatureValues = Type.Object(
  {
    '0': NullableNumber,
    '45': NullableNumber,
    '90': NullableNumber,
    '135': NullableNumber,
    mean: NullableNumber,
    range: NullableNumber,
  },
  { description: 'Per direction, plus mean and range over the selected directions; null for unselected directions' },
);
export type FeatureValues = Static<typeof FeatureValues>;

export const MeasurementStatus = Type.Union([Type.Literal('ok'), Type.Literal('skipped'), Type.Literal('failed')]);
export type MeasurementStatus = Static<typeof MeasurementStatus>;

export const MeasurementResult = Type.Object({
  roiId: Type.String(),
  roiName: Type.String(),
  roiClass: Type.Optional(Type.String({ description: "The ROI's class; omitted when it has none" })),
  slice: Type.Optional(Type.Integer({ minimum: 1, description: "The ROI's slice of a stack; omitted for ROIs without one" })),
  distance: Type.Integer(),
  status: MeasurementStatus,
  error: Type.String({ description: 'Reason for skipped or failed results' }),
  pixelCount: Type.Integer(),
  pairCounts: Type.Object({ '0': Type.Integer(), '45': Type.Integer(), '90': Type.Integer(), '135': Type.Integer() }),
  quantization: Type.Object({ lower: Type.Number(), upper: Type.Number() }, { description: 'Whole numbers, except on a filtered image' }),
  values: Type.Record(Type.String(), FeatureValues),
  score: Type.Union([FeatureValues, Type.Null()]),
  warnings: Type.Array(Type.String()),
});
export type MeasurementResult = Static<typeof MeasurementResult>;

export const AnalysisStatus = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
  Type.Literal('failed'),
]);
export type AnalysisStatus = Static<typeof AnalysisStatus>;

export const AnalysisInfo = Type.Object({
  analysisId: Type.String({ pattern: ANALYSIS_ID_PATTERN }),
  imageId: Type.String({ pattern: IMAGE_ID_PATTERN }),
  imageName: Type.String(),
  imageSha256: Type.String(),
  status: AnalysisStatus,
  total: Type.Integer({ description: 'Jobs: ROIs × distances' }),
  completed: Type.Integer(),
  error: Type.Union([Type.String(), Type.Null()], { description: 'Why the whole analysis failed' }),
  createdAt: Type.String({ format: 'date-time' }),
  finishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  coreVersion: Type.String(),
  settings: AnalysisSettings,
  pixelSpacing: Type.Union([PixelSpacing, Type.Null()], { description: 'Spacing of the analysis: from the request, else from the image' }),
  valueConversion: Type.Optional(Type.String({ description: "The image's value conversion (DICOM, NIfTI), written into exports" })),
});
export type AnalysisInfo = Static<typeof AnalysisInfo>;

export const AnalysisResults = Type.Object({
  format: Type.Literal('glcm-results'),
  version: Type.Literal(1),
  analysisId: Type.String({ pattern: ANALYSIS_ID_PATTERN }),
  status: AnalysisStatus,
  coreVersion: Type.String(),
  timestamp: Type.String({ format: 'date-time' }),
  image: Type.Object({
    id: Type.String(),
    name: Type.String(),
    sha256: Type.String(),
    pixelSpacing: Type.Optional(PixelSpacing),
    valueConversion: Type.Optional(Type.String()),
  }),
  settings: AnalysisSettings,
  results: Type.Array(MeasurementResult, { description: 'Ordered by ROI, then distance; only finished jobs' }),
});
export type AnalysisResults = Static<typeof AnalysisResults>;

// Server-Sent Events of GET /analyses/{id}/events
export interface AnalysisProgressEvent {
  completed: number;
  total: number;
}
export interface AnalysisResultEvent {
  /** Position in the final result order (ROI index × distance count + distance index) */
  index: number;
  result: MeasurementResult;
}
export interface AnalysisFinishedEvent {
  status: AnalysisStatus;
  completed: number;
  total: number;
  error: string | null;
}
export type AnalysisEvent =
  | { event: 'progress'; data: AnalysisProgressEvent }
  | { event: 'result'; data: AnalysisResultEvent }
  | { event: 'finished'; data: AnalysisFinishedEvent };
