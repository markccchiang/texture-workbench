// What the command line and the agent server both do: open an image, build settings, measure, select regions and
// compute feature maps. Everything goes through the API (cli/src/client.ts), so both reach the same code as the app.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
import { ApiError, requireOk, type ApiClient } from './client.js';

const IMAGE_ID = /^img_[0-9a-f]{32}$/;
/** Feature maps are polled until they are done, as the app does */
const POLL_MS = 200;
const POLL_TIMEOUT_MS = 10 * 60_000;

export function getCatalog(client: ApiClient): Promise<CatalogResponse> {
  return client.request('GET', '/catalog').then((result) => requireOk(result, 'The feature catalog could not be read').json<CatalogResponse>());
}

export function listSamples(client: ApiClient): Promise<SampleInfo[]> {
  return client
    .request('GET', '/samples')
    .then((result) => requireOk(result, 'The samples could not be listed').json<{ samples: SampleInfo[] }>().samples);
}

export interface OpenedImage {
  info: ImageInfo;
  /** The server already had this file, so nothing was uploaded */
  reused: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.dcm': 'application/dicom',
};

/**
 * Opens an image given as an image id, a sample path (`sample:textures/camera.png`) or a file. Files are looked up by
 * their checksum first, so measuring the same file again uploads nothing.
 */
export async function openImage(client: ApiClient, target: string): Promise<OpenedImage> {
  if (IMAGE_ID.test(target)) {
    const result = requireOk(await client.request('GET', `/images/${target}`), `Image ${target} could not be read`);
    return { info: result.json<ImageInfo>(), reused: true };
  }

  let data: Buffer;
  let name: string;
  if (target.startsWith('sample:')) {
    const samplePath = target.slice('sample:'.length);
    const result = requireOk(await client.request('GET', '/samples/file', { query: { path: samplePath }, accept: '*/*' }), `Sample ${samplePath}`);
    data = result.body;
    name = path.basename(samplePath);
  } else {
    try {
      data = await fs.readFile(target);
    } catch (error) {
      throw new ApiError(0, 'FileNotFound', `${target} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    name = path.basename(target);
  }

  const sha256 = createHash('sha256').update(data).digest('hex');
  const known = requireOk(await client.request('GET', '/images', { query: { sha256 } }), 'Stored images could not be listed').json<{ images: ImageInfo[] }>();
  if (known.images.length > 0) {
    return { info: known.images[0], reused: true };
  }

  const contentType = CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
  const result = requireOk(await client.request('POST', '/images', { file: { name, data, contentType } }), `${name} could not be opened`);
  return { info: result.json<ImageInfo>(), reused: false };
}

/** An ROI over the whole image, so that a measurement needs no ROI file */
export function wholeImageRoi(info: ImageInfo): Roi {
  return { id: 'whole', name: 'Whole image', shape: { type: 'rectangle', x: 0, y: 0, width: info.width, height: info.height } };
}

/** ROIs from an ROI set, a project file or a bare array of ROIs */
export async function readRois(file: string): Promise<Roi[]> {
  let document: unknown;
  try {
    document = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new ApiError(0, 'InvalidRois', `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rois = Array.isArray(document) ? document : ((document as { rois?: unknown }).rois ?? null);
  if (!Array.isArray(rois) || rois.length === 0) {
    throw new ApiError(0, 'InvalidRois', `${file} holds no ROIs; expected an ROI set, a project or an array of ROIs`);
  }
  return rois.map((roi, index) => {
    const entry = roi as Partial<Roi> & { class?: string; visible?: boolean };
    if (!entry.shape) {
      throw new ApiError(0, 'InvalidRois', `ROI ${index + 1} in ${file} has no shape`);
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
  /** A file holding AnalysisSettings, or a document with a `settings` field (a project or a results file) */
  file?: string;
  preset?: string;
  features?: string[];
  grayLevels?: number;
  distances?: number[];
  directions?: Direction[];
  aggregation?: AnalysisSettings['aggregation'];
  logBase?: AnalysisSettings['logBase'];
  quantization?: Partial<AnalysisSettings['quantization']>;
  score?: boolean;
}

export async function buildSettings(catalog: CatalogResponse, bitDepth: 8 | 16, overrides: SettingsOverrides): Promise<AnalysisSettings> {
  let settings = defaultSettings(catalog, bitDepth);
  if (overrides.file) {
    const text = await fs.readFile(overrides.file, 'utf8').catch((error: Error) => {
      throw new ApiError(0, 'InvalidSettings', `${overrides.file} could not be read: ${error.message}`);
    });
    const document = JSON.parse(text) as AnalysisSettings | { settings?: AnalysisSettings };
    const stored = 'settings' in document && document.settings ? document.settings : (document as AnalysisSettings);
    settings = adaptToImage({ ...settings, ...stored }, bitDepth);
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
      throw new ApiError(0, 'UnknownFeature', `Unknown features: ${unknown.join(', ')}. "glcm features" lists them all.`);
    }
    settings = { ...settings, features: overrides.features };
  }
  settings = {
    ...settings,
    ...(overrides.grayLevels !== undefined ? { grayLevels: overrides.grayLevels } : {}),
    ...(overrides.distances ? { distances: overrides.distances } : {}),
    ...(overrides.directions ? { directions: overrides.directions } : {}),
    ...(overrides.aggregation ? { aggregation: overrides.aggregation } : {}),
    ...(overrides.logBase ? { logBase: overrides.logBase } : {}),
    ...(overrides.quantization ? { quantization: { ...settings.quantization, ...overrides.quantization } } : {}),
    ...(overrides.score !== undefined ? { score: { ...settings.score, enabled: overrides.score } } : {}),
  };
  return settings;
}

/** The checks of the Analysis Settings panel, so a command fails with the same words the app would show */
export function validateSettings(settings: AnalysisSettings, bitDepth: 8 | 16, catalog: CatalogResponse): { errors: string[]; warnings: string[] } {
  return checkSettings(settings, bitDepth, catalog);
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

  // Reading the event stream to its end is the wait; it closes after the "finished" event
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
  query: { min: number; max: number; minPixels: number; maxRegions: number },
): Promise<{ regions: RegionResult[]; total: number }> {
  const result = requireOk(await client.request('POST', `/images/${imageId}/threshold-rois`, { json: query }), 'The regions could not be selected');
  return result.json<{ regions: RegionResult[]; total: number }>();
}

export async function selectRegionAt(
  client: ApiClient,
  imageId: string,
  query: { x: number; y: number; tolerance: number },
): Promise<RegionResult | null> {
  const result = requireOk(await client.request('POST', `/images/${imageId}/wand-roi`, { json: query }), 'The region could not be selected');
  return result.json<{ region: RegionResult | null }>().region;
}

/** The regions as an ROI set file, the format the app reads and writes */
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
