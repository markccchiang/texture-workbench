// Types of the glcm_native addon (bindings/node/src/addon.cpp).
// Rejected promises and thrown errors carry `code`: INVALID_ARGUMENT, UNSUPPORTED_IMAGE, IMAGE_TOO_LARGE,
// DECODE_FAILED, INTERNAL_ERROR or (computeFeatureMap with a cancelled token) CANCELLED. Invalid argument types throw a TypeError synchronously.

export type FeatureGroupId = 'regionStatistics' | 'haralick' | 'other' | 'runLength' | 'sizeZone' | 'grayToneDifference' | 'localBinaryPattern' | 'shape';

export interface NativeFeatureInfo {
  id: string;
  name: string;
  group: FeatureGroupId;
  nonStandard: boolean;
  nonStandardReason: string;
  docAnchor: string;
  cost: 'normal' | 'slow';
}

export interface NativeFeaturePreset {
  id: string;
  name: string;
  features: string[];
  enablesScore: boolean;
}

export interface NativeCatalog {
  features: NativeFeatureInfo[];
  presets: NativeFeaturePreset[];
  limits: {
    minGrayLevels: number;
    maxGrayLevels: number;
    defaultGrayLevels: number;
    maxDistance: number;
    directions: number[];
    quantizationMethods: string[];
    aggregations: string[];
    logBases: string[];
    scoreProfiles: string[];
    defaultScoreCoefficients: { age: number; mean: number; entropy: number; contrast: number };
  };
}

export interface DecodedImage {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  /** Slices of a stack (TIFF pages, DICOM frames); 1 for a single image. Width and height are those of one slice. */
  slices: number;
  /** Channels of the file before grayscale conversion (1 or 3) */
  sourceChannels: number;
  /** Millimetres per pixel from the file's resolution metadata (DICOM PixelSpacing, NIfTI voxel size); null when the file has none */
  pixelSpacing: { x: number; y: number } | null;
  /** DICOM and NIfTI: how the file's values became the stored samples; null when they are stored unchanged */
  valueConversion: NativeValueConversion | null;
  warnings: string[];
  /** 0.5th and 99.5th percentiles (nearest rank) over all slices; DICOM: the file's first WindowCenter/WindowWidth when present */
  windowMin: number;
  windowMax: number;
  /** 256 equal bins over the full range of the bit depth, over all slices */
  histogram: number[];
  /** Row-major grayscale samples, slice after slice; 16-bit samples are little-endian */
  pixels: Buffer;
}

export interface NativeRoiStatistics {
  /** Pixels whose centre lies inside the shape, after clipping to the image */
  pixelCount: number;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  /** Original intensities; null for an empty mask */
  min: number | null;
  max: number | null;
  mean: number | null;
  /** Sample standard deviation */
  std: number | null;
  /** Invalid geometry (e.g. non-finite coordinates); the other fields then describe an empty mask */
  error: string | null;
}

export function coreVersion(): string;

export function catalog(): NativeCatalog;

export interface DecodeOptions {
  /**
   * Largest width × height. The size is read from the file header before decoding, so larger images reject with
   * IMAGE_TOO_LARGE without allocating memory for their pixels; files that are not PNG, JPEG, BMP or TIFF then reject
   * with DECODE_FAILED. 0 or absent: no limit.
   */
  maxPixels?: number;
  /** Largest width × height × slices of a stack, checked before its pixels are decoded (IMAGE_TOO_LARGE). 0 or absent: no limit. */
  maxStackPixels?: number;
}

/**
 * Decodes an image file (PNG, JPEG, BMP, 8/16-bit TIFF, DICOM, 2D NIfTI); color is converted to grayscale. Every page of a
 * multi-page TIFF (up to a page of another size or type) and every frame of a DICOM file become the slices of a stack.
 */
export function decodeImageFile(path: string, options?: DecodeOptions): Promise<DecodedImage>;

/** value = stored sample × scale + offset, in the file's values after its rescale slope and intercept */
export interface NativeValueConversion {
  scale: number;
  offset: number;
  /** "HU" for CT; empty when the file does not say */
  unit: string;
  description: string;
}

export type SliceOrientation = 'axial' | 'coronal' | 'sagittal';

/** How every slice of a volume is stored (glcm::StorageChoice); value = stored × scale + offset */
export interface NativeStorage {
  kind: 'identity' | 'offset' | 'linear';
  bitDepth: 8 | 16;
  scale: number;
  offset: number;
}

export interface NativeSliceGeometry {
  count: number;
  width: number;
  height: number;
  pixelSpacing: { x: number; y: number } | null;
}

export interface NativeVolumeInfo {
  version: 1 | 2;
  /** Voxels along the file's axes i, j, k */
  dimensions: [number, number, number];
  volumes: number;
  dataType: string;
  orientationSource: 'sform' | 'qform' | 'none';
  /** Directions of the i, j and k axes, e.g. "RAS" */
  axisCodes: string;
  /** The orientation of the plane of the i and j axes */
  acquisitionOrientation: SliceOrientation;
  slices: Record<SliceOrientation, NativeSliceGeometry>;
  /** After scl_slope and scl_inter, over the finite voxels of all volumes */
  minimum: number;
  maximum: number;
  storage: NativeStorage;
  valueConversion: NativeValueConversion | null;
  /** 0.5th and 99.5th percentiles of the stored samples of all volumes */
  windowMin: number;
  windowMax: number;
  warnings: string[];
}

/**
 * Reads a NIfTI-1 or NIfTI-2 file (.nii or .nii.gz), writes it uncompressed to copyPath and chooses how its values are
 * stored. Rejects with IMAGE_TOO_LARGE when the voxel data exceeds maxBytes (checked from the header), UNSUPPORTED_IMAGE
 * or DECODE_FAILED.
 */
export function inspectNiftiVolume(path: string, copyPath: string, options?: { maxBytes?: number }): Promise<NativeVolumeInfo>;

export interface SliceRequest {
  orientation: SliceOrientation;
  /** 0-based, from inferior, posterior or left */
  slice: number;
  /** 0-based */
  volume: number;
  storage: NativeStorage;
  maxPixels?: number;
  /** Also encode the slice as a PNG with its pixel spacing */
  encodePng?: boolean;
}

/** One slice of a NIfTI volume in RAS orientation; rejects with INVALID_ARGUMENT when the slice or volume is out of range. */
export function extractNiftiSlice(path: string, request: SliceRequest): Promise<DecodedImage & { png: Buffer | null }>;

export interface StackRequest {
  orientation: SliceOrientation;
  /** 0-based */
  volume: number;
  storage: NativeStorage;
  /** Largest slice */
  maxPixels?: number;
  maxStackPixels?: number;
}

/** A stack made on the server, with an uncompressed multi-page TIFF of it that decodeImageFile reads back with the same samples */
export interface DecodedStack extends DecodedImage {
  tiff: Buffer;
  /** DICOM series: SeriesDescription; otherwise empty */
  seriesDescription: string;
}

/** Every slice of one volume of a NIfTI file in one orientation, slice 0 first, as extractNiftiSlice lays each out. */
export function extractNiftiStack(path: string, request: StackRequest): Promise<DecodedStack>;

/**
 * The files of a DICOM series as one stack: non-DICOM files are left out (with a warning), only the largest series is
 * used, slices are ordered along the image normal (else instance number, else path) and stored with one storage.
 * Rejects with UNSUPPORTED_IMAGE when no file is a DICOM image or the images differ in size, IMAGE_TOO_LARGE or DECODE_FAILED.
 */
export function decodeDicomSeries(paths: string[], options?: DecodeOptions): Promise<DecodedStack>;

export interface NativeLineProfile {
  /** round(length) + 1 samples evenly spaced from the start to the end, bilinearly interpolated; null outside the image */
  values: Array<number | null>;
  /** Length of the line in pixels */
  length: number;
  /** Distance between samples in pixels (0 for a single sample) */
  step: number;
}

/** The intensities along a straight line (glcm::ComputeLineProfile); points in image coordinates */
export function lineProfile(pixels: Uint8Array, width: number, height: number, bitDepth: 8 | 16, fromX: number, fromY: number, toX: number, toY: number): Promise<NativeLineProfile>;

export interface NativeRoiHistogram {
  pixelCount: number;
  /** null for an ROI without pixels */
  min: number | null;
  max: number | null;
  mean: number | null;
  /** Sample standard deviation */
  std: number | null;
  /** The most frequent value (the lowest of equally frequent ones) */
  mode: number | null;
  /** counts[i]: pixels with binStart + i × binWidth <= value < binStart + (i + 1) × binWidth */
  binStart: number;
  binWidth: number;
  counts: number[];
}

/** Histogram of the pixels of one ROI over its min–max in at most `bins` bins of whole width (glcm::ComputeRoiHistogram) */
export function roiHistogram(pixels: Uint8Array, width: number, height: number, bitDepth: 8 | 16, roisJson: string, bins: number): Promise<NativeRoiHistogram>;

/** 8-bit PNG of the pixels with the window/level mapping, downscaled so the long side is at most maxSize (0 = no limit). */
export function renderDisplay(
  pixels: Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  windowMin: number,
  windowMax: number,
  maxSize: number,
): Promise<Buffer>;

/**
 * Pixel count, bounding box and intensity statistics of each ROI.
 * @param roisJson JSON array of ROI objects in the ROI set format (doc/ui-design-plan.md, section 8.4)
 */
export function roiStats(pixels: Uint8Array, width: number, height: number, bitDepth: 8 | 16, roisJson: string): Promise<NativeRoiStatistics[]>;

/** Parses and validates an analysis request; throws an Error with code INVALID_ARGUMENT describing the first problem. */
export function validateAnalysis(roisJson: string, settingsJson: string): void;

export interface NativeFeatureMapGrid {
  /** Grid spacing in image pixels (chosen automatically when the settings have no step) */
  step: number;
  columns: number;
  rows: number;
  /** Estimated computing work of one row (glcm::FeatureMapRowWork), in units roughly proportional to the time */
  workPerRow: number;
}

/** Stops the computeFeatureMap calls that received it after their current point; they reject with code CANCELLED */
export class CancelToken {
  constructor();
  cancel(): void;
  readonly cancelled: boolean;
}

/**
 * Parses and validates feature map settings for an image of this size (glcm::ValidateFeatureMapSettings and
 * glcm::ResolveFeatureMapGrid); throws an Error with code INVALID_ARGUMENT describing the first problem.
 */
export function featureMapGrid(settingsJson: string, width: number, height: number): NativeFeatureMapGrid;

/**
 * Rows [firstRow, firstRow + rowCount) of a feature map (glcm::ComputeFeatureMapRows): rowCount × columns values,
 * row-major, NaN where a window has no pixel pairs. Rejects with INVALID_ARGUMENT when the image cannot be quantized
 * with the settings.
 */
export function computeFeatureMap(
  pixels: Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  settingsJson: string,
  firstRow: number,
  rowCount: number,
  cancelToken?: CancelToken,
): Promise<Float32Array>;

export interface NativeSelectedRegion {
  /** Polygon along the pixel edges around the region, holes filled; rasterizing it gives exactly the region's pixels */
  points: Array<[number, number]>;
  /** Pixels of the region, holes included */
  pixelCount: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

/**
 * Regions of the pixels with min ≤ value ≤ max (glcm::SelectThresholdRegions): 8-connected parts with their holes filled,
 * at least minPixels pixels each, the largest maxRegions first; total counts every region of that size.
 */
export function selectThresholdRegions(
  pixels: Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  min: number,
  max: number,
  minPixels: number,
  maxRegions: number,
  /** Regions with more pixels are left out */
  maxPixels?: number | null,
  /** Regions whose sphericity (in pixel units) is lower are left out */
  minSphericity?: number | null,
): Promise<{ regions: NativeSelectedRegion[]; total: number }>;

/**
 * The 8-connected region around pixel (x, y) whose values are within tolerance of its value, holes filled
 * (glcm::SelectWandRegion); null when (x, y) lies outside the image.
 */
export function selectWandRegion(
  pixels: Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  x: number,
  y: number,
  tolerance: number,
): Promise<NativeSelectedRegion | null>;

export interface NativeRoiShapeResult {
  /** One polygon along the pixel edges whose pixels are exactly the result: parts and holes joined by zero-width cuts; empty when no pixel is left */
  points: Array<[number, number]>;
  pixelCount: number;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

/**
 * The pixels of any ROI (union), of the first ROI without those of the others (subtract), of every ROI (intersect), or of an
 * odd number of ROIs (xor) (glcm::CombineShapes)
 */
export function combineRois(roisJson: string, operation: 'union' | 'subtract' | 'intersect' | 'xor', width: number, height: number): Promise<NativeRoiShapeResult>;

/**
 * The one ROI in roisJson enlarged (pixels within the distance of it), shrunk (its pixels farther than the distance from every
 * pixel outside it, also beyond the image) or as a band (enlarged without the ROI). Distances between pixel centres use
 * spacingX between columns and spacingY between rows: 1, 1 for pixels, or the pixel spacing in mm (glcm::GrowShape).
 */
export function growRoi(
  roisJson: string,
  operation: 'enlarge' | 'shrink' | 'band',
  distance: number,
  spacingX: number,
  spacingY: number,
  width: number,
  height: number,
): Promise<NativeRoiShapeResult>;

/**
 * A brush stroke of the given radius along path ([x0, y0, x1, y1, ...]) added to, or with erase removed from, the ROI in
 * roisJson (an array with at most one ROI; empty: the stroke alone) (glcm::PaintStroke)
 */
export function brushRoi(roisJson: string, path: Float64Array, radius: number, erase: boolean, width: number, height: number): Promise<NativeRoiShapeResult>;

export interface NativeGradientStatistics {
  sigma: number;
  /** Nearest-rank percentiles of the gradient magnitude, in intensity units per pixel */
  percentiles: { '50': number; '90': number; '95': number; '99': number };
  max: number;
}

/** Percentiles and maximum of the gradient magnitude after Gaussian smoothing (glcm::ComputeGradientStatistics) */
export function gradientStatistics(pixels: Uint8Array, width: number, height: number, bitDepth: 8 | 16, sigma: number): Promise<NativeGradientStatistics>;

/**
 * 8-bit PNG edge map (glcm::RenderEdgeMap): for "sobel" the gradient magnitude between low and high, for "canny" 255 on the
 * edges found with the hysteresis thresholds low and high; the long side is reduced to maxSize (0: full size)
 */
export function renderEdgeMap(
  pixels: Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  method: 'sobel' | 'canny',
  sigma: number,
  low: number,
  high: number,
  maxSize: number,
): Promise<Buffer>;

/** Livewire path from one pixel to another along strong edges, as pixel centres where it turns (glcm::LivewirePath) */
export function livewirePath(
  pixels: Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  sigma: number,
): Promise<Array<[number, number]>>;

/**
 * Measures every ROI at every distance (glcm::RunAnalysis).
 * @returns the "glcm-results" JSON document (without image name, SHA-256 or timestamp)
 */
export function runAnalysis(
  pixels: Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  roisJson: string,
  settingsJson: string,
  /** Millimetres per pixel; shape features are in mm with it and in pixels without it */
  pixelSpacing?: { x: number; y: number } | null,
): Promise<string>;

/**
 * Reads a "glcm-results" document and writes it again with glcm_core: "csv" (glcm::ResultsToCsv) or canonical "json"
 * (glcm::ResultsToJson). Throws an Error with code INVALID_ARGUMENT for invalid documents.
 */
export function formatResults(resultsJson: string, format: 'csv' | 'json'): string;

export interface ExportedFile {
  name: string;
  data: Buffer;
}

/**
 * ROI crops, masks, optional quantized images and manifest.json (glcm::ExportRoiImages).
 * @param settingsJson analysis settings, or "" when includeQuantized is false
 */
export function exportRoiImages(
  pixels: Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  roisJson: string,
  settingsJson: string,
  transparentOutside: boolean,
  includeQuantized: boolean,
): Promise<ExportedFile[]>;

/** glcm::WindowLevel: the 8-bit display value of one intensity. */
export function windowLevel(value: number, windowMin: number, windowMax: number): number;

declare const native: {
  coreVersion: typeof coreVersion;
  catalog: typeof catalog;
  decodeImageFile: typeof decodeImageFile;
  inspectNiftiVolume: typeof inspectNiftiVolume;
  extractNiftiSlice: typeof extractNiftiSlice;
  renderDisplay: typeof renderDisplay;
  roiStats: typeof roiStats;
  validateAnalysis: typeof validateAnalysis;
  runAnalysis: typeof runAnalysis;
  formatResults: typeof formatResults;
  exportRoiImages: typeof exportRoiImages;
  windowLevel: typeof windowLevel;
  featureMapGrid: typeof featureMapGrid;
  computeFeatureMap: typeof computeFeatureMap;
  CancelToken: typeof CancelToken;
  selectThresholdRegions: typeof selectThresholdRegions;
  selectWandRegion: typeof selectWandRegion;
  combineRois: typeof combineRois;
  brushRoi: typeof brushRoi;
  growRoi: typeof growRoi;
  gradientStatistics: typeof gradientStatistics;
  renderEdgeMap: typeof renderEdgeMap;
  livewirePath: typeof livewirePath;
};
export default native;
