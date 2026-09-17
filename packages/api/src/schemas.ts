// Request and response schemas of the /api/v1 HTTP API (doc/ui-design-plan.md, section 8.5). The server validates
// requests and serializes responses with them, the OpenAPI document is generated from them, and the web app uses the
// derived types.

import { Type, type Static } from 'typebox';
import { ColourSource } from './colour.js';

export const API_PREFIX = '/api/v1';

export const ErrorResponse = Type.Object(
  {
    error: Type.String({ description: 'Machine-readable error code, e.g. "NotFound" or "PayloadTooLarge"' }),
    message: Type.String({ description: 'Human-readable description' }),
  },
  { description: 'Error returned by every endpoint for 4xx and 5xx responses' },
);
export type ErrorResponse = Static<typeof ErrorResponse>;

// ---------------------------------------------------------------------------------------------------------------------
// Health and catalog
// ---------------------------------------------------------------------------------------------------------------------

export const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
  coreVersion: Type.String(),
  mode: Type.Union([Type.Literal('local'), Type.Literal('server')], { description: 'local: loopback address; server: any other address' }),
  authentication: Type.Union([Type.Literal('none'), Type.Literal('bearer')], {
    description: 'bearer: every other /api/v1 request needs "Authorization: Bearer <token>"',
  }),
});
export type HealthResponse = Static<typeof HealthResponse>;

// "regionStatistics" is the first-order statistics group (the id predates the other first-order features)
export const FeatureGroup = Type.Union([
  Type.Literal('regionStatistics'),
  Type.Literal('haralick'),
  Type.Literal('other'),
  Type.Literal('runLength'),
  Type.Literal('sizeZone'),
  Type.Literal('grayToneDifference'),
  Type.Literal('localBinaryPattern'),
  Type.Literal('shape'),
]);

export const FeatureInfo = Type.Object({
  id: Type.String({ description: 'Stable identifier used in analysis settings, e.g. "CorrelationII"' }),
  name: Type.String(),
  group: FeatureGroup,
  nonStandard: Type.Boolean({ description: 'Differs from the literature definition; see nonStandardReason' }),
  nonStandardReason: Type.String(),
  docAnchor: Type.String({ description: 'Page and anchor in the Sphinx documentation' }),
  cost: Type.Union([Type.Literal('normal'), Type.Literal('slow')]),
});
export type FeatureInfo = Static<typeof FeatureInfo>;

export const FeaturePreset = Type.Object({
  id: Type.String(),
  name: Type.String(),
  features: Type.Array(Type.String()),
  enablesScore: Type.Boolean(),
});
export type FeaturePreset = Static<typeof FeaturePreset>;

export const ScoreCoefficients = Type.Object({
  age: Type.Number(),
  mean: Type.Number(),
  entropy: Type.Number(),
  contrast: Type.Number(),
});
export type ScoreCoefficients = Static<typeof ScoreCoefficients>;

export const AnalysisLimits = Type.Object({
  minGrayLevels: Type.Integer(),
  maxGrayLevels: Type.Integer(),
  defaultGrayLevels: Type.Integer(),
  maxDistance: Type.Integer(),
  directions: Type.Array(Type.Integer()),
  quantizationMethods: Type.Array(Type.String()),
  aggregations: Type.Array(Type.String()),
  logBases: Type.Array(Type.String()),
  scoreProfiles: Type.Array(Type.String()),
  defaultScoreCoefficients: ScoreCoefficients,
});
export type AnalysisLimits = Static<typeof AnalysisLimits>;

export const UploadLimits = Type.Object({
  maxUploadBytes: Type.Integer(),
  maxImagePixels: Type.Integer(),
  rawTransferMaxPixels: Type.Integer({ description: 'Images up to this many pixels are sent to the browser as raw data' }),
  displayMaxSize: Type.Integer({ description: 'Largest long side of display.png' }),
});
export type UploadLimits = Static<typeof UploadLimits>;

export const CatalogResponse = Type.Object({
  features: Type.Array(FeatureInfo),
  presets: Type.Array(FeaturePreset),
  limits: AnalysisLimits,
  uploads: UploadLimits,
});
export type CatalogResponse = Static<typeof CatalogResponse>;

// ---------------------------------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------------------------------

export const IMAGE_ID_PATTERN = '^img_[0-9a-f]{32}$';

/** The largest number of slices of a stack (glcm::MAX_SLICES) */
export const MAX_SLICES = 100_000;

/** A slice of a stack, from 1 (ImageJ's numbering) */
export const Slice = Type.Integer({ minimum: 1, maximum: MAX_SLICES, description: 'Slice of a stack, from 1; default 1' });

/** The optional slice of a query of an image */
export const SliceQuery = Type.Object({ slice: Type.Optional(Slice) });
export type SliceQuery = Static<typeof SliceQuery>;

export const ImageIdParams = Type.Object({
  id: Type.String({ pattern: IMAGE_ID_PATTERN, description: 'Image id returned by POST /images' }),
});
export type ImageIdParams = Static<typeof ImageIdParams>;

export const PixelSpacing = Type.Object(
  {
    x: Type.Number({ exclusiveMinimum: 0, maximum: 1e6, description: 'Millimetres per pixel, horizontally' }),
    y: Type.Number({ exclusiveMinimum: 0, maximum: 1e6, description: 'Millimetres per pixel, vertically' }),
  },
  { additionalProperties: false, description: 'Physical size of one pixel' },
);
export type PixelSpacing = Static<typeof PixelSpacing>;

export const ValueConversion = Type.Object(
  {
    scale: Type.Number(),
    offset: Type.Number(),
    unit: Type.String({ description: 'HU for CT; empty when the file does not say' }),
    description: Type.String({ description: 'e.g. "Rescale slope 1, intercept -1024; values stored + 1024; HU = stored value - 1024"' }),
  },
  { description: "DICOM, NIfTI and colour conversions: how the file's values became the stored samples; value = stored sample × scale + offset" },
);
export type ValueConversion = Static<typeof ValueConversion>;

export const ImageInfo = Type.Object({
  imageId: Type.String({ pattern: IMAGE_ID_PATTERN }),
  name: Type.String({ description: 'File name of the upload' }),
  sizeBytes: Type.Integer({ description: 'Size of the uploaded file' }),
  width: Type.Integer(),
  height: Type.Integer(),
  bitDepth: Type.Union([Type.Literal(8), Type.Literal(16)]),
  slices: Type.Integer({
    minimum: 1,
    maximum: MAX_SLICES,
    description: 'Slices of a stack (TIFF pages, DICOM frames or series files, NIfTI slices), each width × height; 1 for a single image',
  }),
  sourceChannels: Type.Integer({ description: 'Channels before grayscale conversion (1, 3 or 4)' }),
  colourSource: Type.Optional(ColourSource),
  madeFrom: Type.Optional(
    Type.Union([Type.Literal('niftiVolume'), Type.Literal('dicomSeries')], {
      description: 'Present on images the server made from several files or a volume (their name is not the name of a file)',
    }),
  ),
  pixelSpacing: Type.Union([PixelSpacing, Type.Null()], {
    description:
      "From the file's metadata (PNG pHYs, JPEG JFIF, BMP, TIFF resolution, DICOM PixelSpacing or ImagerPixelSpacing, NIfTI voxel size); null when the file has none, or only the 72/96 dpi default of image editors",
  }),
  valueConversion: Type.Optional(
    Type.Unsafe<ValueConversion>({ ...ValueConversion, description: "Absent when the stored samples are the file's values (or a colour image's luminance)" }),
  ),
  sha256: Type.String({
    description: 'SHA-256 of the uploaded file (hex); for a stack made from a NIfTI volume or a DICOM series, of the TIFF that stands for it',
  }),
  transfer: Type.Union([Type.Literal('raw'), Type.Literal('server')], {
    description: '"raw": GET /raw is available and the browser renders the image; "server": use display.png and /pixel',
  }),
  windowMin: Type.Integer({ description: "Default display window: 0.5th percentile of all slices, or the DICOM file's WindowCenter/WindowWidth" }),
  windowMax: Type.Integer({ description: 'Default display window: 99.5th percentile of all slices' }),
  histogram: Type.Array(Type.Integer(), { minItems: 256, maxItems: 256, description: '256 equal bins over 0-255 or 0-65535, over all slices' }),
  warnings: Type.Array(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
});
export type ImageInfo = Static<typeof ImageInfo>;

export const DisplayQuery = Type.Object({
  slice: Type.Optional(Slice),
  min: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535, description: 'Window minimum; default windowMin' })),
  max: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535, description: 'Window maximum; default windowMax' })),
  maxSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384, description: 'Largest long side; capped by the server limit' })),
});
export type DisplayQuery = Static<typeof DisplayQuery>;

export const EdgeMethod = Type.Union([Type.Literal('sobel'), Type.Literal('canny')]);
export type EdgeMethod = Static<typeof EdgeMethod>;

export const MAX_EDGE_SIGMA = 10;
const EdgeSigma = Type.Number({ minimum: 0, maximum: MAX_EDGE_SIGMA, description: 'Gaussian smoothing before the derivatives, in pixels (0: none)' });

export const EdgeMapQuery = Type.Object({
  slice: Type.Optional(Slice),
  method: EdgeMethod,
  sigma: EdgeSigma,
  low: Type.Number({ minimum: 0, description: 'sobel: gradient magnitude shown black; canny: lower hysteresis threshold' }),
  high: Type.Number({ minimum: 0, description: 'sobel: gradient magnitude shown white; canny: upper hysteresis threshold' }),
  maxSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384, description: 'Largest long side; capped by the server limit' })),
});
export type EdgeMapQuery = Static<typeof EdgeMapQuery>;

export const GradientStatsQuery = Type.Object({ sigma: EdgeSigma, slice: Type.Optional(Slice) });
export type GradientStatsQuery = Static<typeof GradientStatsQuery>;

export const GradientStatsResponse = Type.Object({
  sigma: Type.Number(),
  percentiles: Type.Object(
    { '50': Type.Number(), '90': Type.Number(), '95': Type.Number(), '99': Type.Number() },
    { description: 'Nearest-rank percentiles of the gradient magnitude, in intensity units per pixel' },
  ),
  max: Type.Number(),
});
export type GradientStatsResponse = Static<typeof GradientStatsResponse>;

export const PixelQuery = Type.Object({
  x: Type.Integer({ minimum: 0 }),
  y: Type.Integer({ minimum: 0 }),
  slice: Type.Optional(Slice),
});
export type PixelQuery = Static<typeof PixelQuery>;

export const PixelResponse = Type.Object({
  x: Type.Integer(),
  y: Type.Integer(),
  value: Type.Integer({ description: 'Grayscale value of the stored image' }),
});
export type PixelResponse = Static<typeof PixelResponse>;

// ---------------------------------------------------------------------------------------------------------------------
// Sample images
// ---------------------------------------------------------------------------------------------------------------------

export const SAMPLE_PATH_PATTERN = '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*\\.[A-Za-z0-9]+$';

export const SampleInfo = Type.Object({
  path: Type.String({ pattern: SAMPLE_PATH_PATTERN, description: 'Path relative to the samples directory, e.g. "textures/brick.png"' }),
  name: Type.String({ description: 'File name' }),
  group: Type.String({ description: 'Sub-directory, or "" for the top level' }),
  sizeBytes: Type.Integer(),
});
export type SampleInfo = Static<typeof SampleInfo>;

export const SamplesResponse = Type.Object({
  samples: Type.Array(SampleInfo),
  defaultSample: Type.Union([Type.String(), Type.Null()], { description: 'Sample opened by "Open sample image"' }),
});
export type SamplesResponse = Static<typeof SamplesResponse>;

// Headers of GET /images/{id}/raw
export const RAW_HEADERS = {
  width: 'x-image-width',
  height: 'x-image-height',
  bitDepth: 'x-image-bit-depth',
  byteOrder: 'x-image-byte-order',
} as const;
