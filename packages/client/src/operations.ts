// What a program does with the API: open an image, build and check settings, measure, select regions and compute
// feature maps. Everything goes through an ApiClient, and nothing here reads files, so the same code serves the command
// line, the agent server and any other caller.

import {
  adaptToImage,
  checkSettings,
  defaultSettings,
  type AnalysisInfo,
  type AnalysisSettings,
  type CatalogResponse,
  type Direction,
  type FeatureMapInfo,
  type ImageInfo,
  type PixelSpacing,
  type ResultsDocument,
  type Roi,
  type RoiSetDocument,
  type SampleInfo,
} from '@glcm/api';
import { ApiError, requireOk, type ApiClient } from './http.js';

export const IMAGE_ID_PATTERN = /^img_[0-9a-f]{32}$/;
/** Feature maps and analyses are polled until they are done, as the app does */
const POLL_MS = 200;
const POLL_TIMEOUT_MS = 10 * 60_000;

export function getCatalog(client: ApiClient): Promise<CatalogResponse> {
  return client.request('GET', '/catalog').then((result) => requireOk(result, 'The feature catalog could not be read').json<CatalogResponse>());
}

export function listSamples(client: ApiClient): Promise<SampleInfo[]> {
  return client.request('GET', '/samples').then((result) => requireOk(result, 'The samples could not be listed').json<{ samples: SampleInfo[] }>().samples);
}

/** Where an image comes from: one the server has, one it ships, or bytes a caller read */
export type ImageSource =
  | { kind: 'id'; imageId: string }
  | { kind: 'sample'; path: string }
  | { kind: 'bytes'; name: string; data: Uint8Array; contentType?: string };

export interface OpenedImage {
  info: ImageInfo;
  /** The server already had this image, so nothing was uploaded */
  reused: boolean;
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function imageByHash(client: ApiClient, hash: string): Promise<ImageInfo | null> {
  return client
    .request('GET', '/images', { query: { sha256: hash } })
    .then((result) => requireOk(result, 'Stored images could not be listed').json<{ images: ImageInfo[] }>().images[0] ?? null);
}

/** Opens an image; bytes are looked up by their checksum first, so the same file is uploaded only once */
export async function openImage(client: ApiClient, source: ImageSource): Promise<OpenedImage> {
  if (source.kind === 'id') {
    const result = requireOk(await client.request('GET', `/images/${source.imageId}`), `Image ${source.imageId} could not be read`);
    return { info: result.json<ImageInfo>(), reused: true };
  }
  if (source.kind === 'sample') {
    const file = requireOk(await client.request('GET', '/samples/file', { query: { path: source.path }, accept: '*/*' }), `Sample ${source.path}`);
    const name = source.path.split('/').pop() ?? source.path;
    return openImage(client, { kind: 'bytes', name, data: file.body, contentType: file.contentType });
  }

  const known = await imageByHash(client, await sha256(source.data));
  if (known) {
    return { info: known, reused: true };
  }
  const result = requireOk(
    await client.request('POST', '/images', { file: { name: source.name, data: source.data, contentType: source.contentType || 'application/octet-stream' } }),
    `${source.name} could not be opened`,
  );
  return { info: result.json<ImageInfo>(), reused: false };
}

/** An ROI over the whole image, so that a measurement needs no ROI file */
export function wholeImageRoi(info: ImageInfo): Roi {
  return { id: 'whole', name: 'Whole image', shape: { type: 'rectangle', x: 0, y: 0, width: info.width, height: info.height } };
}

/** The ROIs of an ROI set, a project or a bare array, as parsed JSON */
export function roisFromDocument(document: unknown, what = 'The ROIs'): Roi[] {
  const rois = Array.isArray(document) ? document : ((document as { rois?: unknown } | null)?.rois ?? null);
  if (!Array.isArray(rois) || rois.length === 0) {
    throw new ApiError(0, 'InvalidRois', `${what}: expected an ROI set, a project or an array of ROIs`);
  }
  return rois.map((roi, index) => {
    const entry = roi as Partial<Roi> & { class?: string; visible?: boolean };
    if (!entry.shape) {
      throw new ApiError(0, 'InvalidRois', `${what}: ROI ${index + 1} has no shape`);
    }
    return {
      id: entry.id ?? `roi${index + 1}`,
      name: entry.name ?? `ROI ${index + 1}`,
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.class ? { class: entry.class } : {}),
      shape: entry.shape,
    };
  });
}

export interface SettingsOverrides {
  /** Settings to start from, e.g. read from a file or a project */
  settings?: Partial<AnalysisSettings>;
  preset?: string;
  features?: string[];
  grayLevels?: number;
  distances?: number[];
  directions?: Direction[];
  aggregation?: AnalysisSettings['aggregation'];
  logBase?: AnalysisSettings['logBase'];
  quantization?: Partial<AnalysisSettings['quantization']>;
  score?: boolean;
  /** Resample to this pixel spacing (mm) before measuring */
  resampling?: { x: number; y: number };
  /** Measure the Laplacian of Gaussian with this sigma (mm with a pixel spacing, pixels without) */
  logSigma?: number;
  /** Measure this sub-band of the Coiflet 1 wavelet transform */
  waveletBand?: 'LL' | 'LH' | 'HL' | 'HH';
}

/** The defaults, then stored settings, then a preset, then single options — the order the app applies them in */
export function buildSettings(catalog: CatalogResponse, bitDepth: 8 | 16, overrides: SettingsOverrides): AnalysisSettings {
  let settings = defaultSettings(catalog, bitDepth);
  if (overrides.settings) {
    settings = adaptToImage({ ...settings, ...overrides.settings }, bitDepth);
  }
  if (overrides.preset) {
    const preset = catalog.presets.find((candidate) => candidate.id === overrides.preset);
    if (!preset) {
      throw new ApiError(0, 'UnknownPreset', `There is no preset "${overrides.preset}". Known presets: ${catalog.presets.map((p) => p.id).join(', ')}`);
    }
    settings = { ...settings, features: [...preset.features], score: { ...settings.score, enabled: preset.enablesScore } };
  }
  if (overrides.features) {
    const known = new Set(catalog.features.map((feature) => feature.id));
    const unknown = overrides.features.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ApiError(0, 'UnknownFeature', `Unknown features: ${unknown.join(', ')}`);
    }
    settings = { ...settings, features: overrides.features };
  }
  return {
    ...settings,
    ...(overrides.grayLevels !== undefined ? { grayLevels: overrides.grayLevels } : {}),
    ...(overrides.distances ? { distances: overrides.distances } : {}),
    ...(overrides.directions ? { directions: overrides.directions } : {}),
    ...(overrides.aggregation ? { aggregation: overrides.aggregation } : {}),
    ...(overrides.logBase ? { logBase: overrides.logBase } : {}),
    ...(overrides.quantization ? { quantization: { ...settings.quantization, ...overrides.quantization } } : {}),
    ...(overrides.score !== undefined ? { score: { ...settings.score, enabled: overrides.score } } : {}),
    ...(overrides.resampling ? { resampling: overrides.resampling } : {}),
    ...(overrides.logSigma !== undefined ? { filter: { type: 'laplacianOfGaussian' as const, sigma: overrides.logSigma } } : {}),
    ...(overrides.waveletBand !== undefined ? { filter: { type: 'wavelet' as const, band: overrides.waveletBand } } : {}),
  };
}

/** The checks of the Analysis Settings panel, so a caller fails with the same words the app would show */
export function validateSettings(
  settings: AnalysisSettings,
  bitDepth: 8 | 16,
  catalog: CatalogResponse,
  pixelSpacing?: { x: number; y: number } | null,
): { errors: string[]; warnings: string[] } {
  return checkSettings(settings, bitDepth, catalog, pixelSpacing);
}

export interface Measurement {
  analysis: AnalysisInfo;
  document: ResultsDocument & { analysisId: string };
  csv: string;
}

/** Starts an analysis, waits for it (the event stream ends when it finishes) and reads the results back */
export async function measure(
  client: ApiClient,
  request: { imageId: string; rois: Roi[]; settings: AnalysisSettings; pixelSpacing?: PixelSpacing | null },
): Promise<Measurement> {
  const started = requireOk(
    await client.request('POST', '/analyses', {
      json: {
        imageId: request.imageId,
        rois: request.rois,
        settings: request.settings,
        ...(request.pixelSpacing !== undefined ? { pixelSpacing: request.pixelSpacing } : {}),
      },
    }),
    'The analysis was refused',
  ).json<AnalysisInfo>();

  await client.request('GET', `/analyses/${started.analysisId}/events`, { accept: 'text/event-stream' });
  let analysis = requireOk(await client.request('GET', `/analyses/${started.analysisId}`), 'The analysis could not be read').json<AnalysisInfo>();
  // A dropped stream leaves it unfinished: fall back to polling, as the app does
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (analysis.status === 'queued' || analysis.status === 'running') {
    if (Date.now() > deadline) {
      throw new ApiError(0, 'Timeout', `The analysis did not finish within ${Math.round(POLL_TIMEOUT_MS / 1000)} s`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    analysis = requireOk(await client.request('GET', `/analyses/${started.analysisId}`), 'The analysis could not be read').json<AnalysisInfo>();
  }
  if (analysis.status !== 'completed') {
    throw new ApiError(0, 'AnalysisFailed', `The analysis ${analysis.status}${analysis.error ? `: ${analysis.error}` : ''}`);
  }

  const document = requireOk(await client.request('GET', `/analyses/${analysis.analysisId}/results`), 'The results could not be read').json<
    ResultsDocument & { analysisId: string }
  >();
  const csv = requireOk(await client.request('GET', `/analyses/${analysis.analysisId}/results.csv`, { accept: 'text/csv' }), 'The CSV could not be read').text();
  return { analysis, document, csv };
}

export interface RegionResult {
  points: Array<[number, number]>;
  pixelCount: number;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

export async function selectThresholdRegions(
  client: ApiClient,
  imageId: string,
  query: { min: number; max: number; minPixels: number; maxRegions: number; maxPixels?: number; minSphericity?: number },
): Promise<{ regions: RegionResult[]; total: number }> {
  const result = requireOk(await client.request('POST', `/images/${imageId}/threshold-rois`, { json: query }), 'The regions could not be selected');
  return result.json<{ regions: RegionResult[]; total: number }>();
}

export async function selectRegionAt(client: ApiClient, imageId: string, query: { x: number; y: number; tolerance: number }): Promise<RegionResult | null> {
  const result = requireOk(await client.request('POST', `/images/${imageId}/wand-roi`, { json: query }), 'The region could not be selected');
  return result.json<{ region: RegionResult | null }>().region;
}

/** The regions as an ROI set, the format the app reads and writes */
export function roiSetOf(image: ImageInfo, regions: readonly RegionResult[], namePrefix = 'Region'): RoiSetDocument {
  return {
    format: 'glcm-roi-set',
    version: 1,
    image: { name: image.name, width: image.width, height: image.height, bitDepth: image.bitDepth, sha256: image.sha256 },
    rois: regions.map((region, index) => ({
      id: `region${index + 1}`,
      name: `${namePrefix} ${index + 1}`,
      shape: { type: 'polygon', points: region.points },
    })),
  };
}

export interface ValueRange {
  minimum: number | null;
  maximum: number | null;
  /** Windows with no pixel pairs, which hold no value */
  empty: number;
}

/** The range of a map, in one pass: a map has hundreds of thousands of values, too many to spread into Math.min */
export function valueRange(values: Float32Array): ValueRange {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let empty = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    } else {
      empty += 1;
    }
  }
  return minimum <= maximum ? { minimum, maximum, empty } : { minimum: null, maximum: null, empty };
}

export interface FeatureMapResult {
  info: FeatureMapInfo;
  values: Float32Array;
}

/** Starts a feature map, waits for it and reads its values */
export async function computeFeatureMap(client: ApiClient, imageId: string, settings: Record<string, unknown>): Promise<FeatureMapResult> {
  let info = requireOk(await client.request('POST', '/feature-maps', { json: { imageId, settings } }), 'The feature map was refused').json<FeatureMapInfo>();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (info.status === 'queued' || info.status === 'running') {
    if (Date.now() > deadline) {
      throw new ApiError(0, 'Timeout', 'The feature map did not finish in time');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    info = requireOk(await client.request('GET', `/feature-maps/${info.featureMapId}`), 'The feature map could not be read').json<FeatureMapInfo>();
  }
  if (info.status !== 'completed') {
    throw new ApiError(0, 'FeatureMapFailed', `The feature map ${info.status}${info.error ? `: ${info.error}` : ''}`);
  }
  const values = requireOk(
    await client.request('GET', `/feature-maps/${info.featureMapId}/values`, { accept: 'application/octet-stream' }),
    'The feature map values could not be read',
  ).body;
  return { info, values: new Float32Array(values.buffer, values.byteOffset, values.length / 4) };
}
