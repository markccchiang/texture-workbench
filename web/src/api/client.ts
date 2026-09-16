// HTTP client of the /api/v1 API (doc/ui-design-plan.md, section 8.5). Every request carries the access token when
// the server requires one (api/auth.ts).

import {
  API_PREFIX,
  type AnalysisInfo,
  type AnalysisRequest,
  type AnalysisResults,
  type BrushRoiRequest,
  type GrowRoiRequest,
  type CombineRoisRequest,
  type EdgeMapQuery,
  type GradientStatsResponse,
  type LivewireRequest,
  type LivewireResponse,
  type RoiShapeResult,
  type FeatureMapInfo,
  type FeatureMapRequest,
  type RoiStatsRequest,
  type RoiStatsResponse,
  type ThresholdRoisRequest,
  type ThresholdRoisResponse,
  type WandRoiRequest,
  type WandRoiResponse,
  type CatalogResponse,
  type ExportFormat,
  type HealthResponse,
  type ImageListResponse,
  type ResultsDocument,
  type RoiImagesExportRequest,
  type ErrorResponse,
  type ImageInfo,
  type PixelResponse,
  type SamplesResponse,
  type VolumeInfo,
  type VolumePreviewQuery,
  type LineProfileRequest,
  type LineProfileResponse,
  type RoiHistogramRequest,
  type RoiHistogramResponse,
  type VolumeSliceRequest,
  type VolumeStackRequest,
} from '@glcm/api';
import { fileNameFromDisposition } from '../files/download';
import { decodeRawSamples, rawFormatFromHeaders, type RawImage } from '../image/raw';
import { apiFetch, authHeaders, useAuth } from './auth';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export type ProgressCallback = (loaded: number, total: number) => void;

async function errorFromResponse(response: Response): Promise<ApiRequestError> {
  try {
    const body = (await response.json()) as Partial<ErrorResponse>;
    return new ApiRequestError(response.status, body.error ?? 'HttpError', body.message ?? response.statusText);
  } catch {
    return new ApiRequestError(response.status, 'HttpError', `${response.status} ${response.statusText}`);
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return (await response.json()) as T;
}

/** Server mode and authentication; never needs the token */
export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${API_PREFIX}/health`, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return (await response.json()) as HealthResponse;
}

export function getCatalog(signal?: AbortSignal): Promise<CatalogResponse> {
  return getJson(`${API_PREFIX}/catalog`, signal);
}

export function getSamples(signal?: AbortSignal): Promise<SamplesResponse> {
  return getJson(`${API_PREFIX}/samples`, signal);
}

export async function downloadSample(samplePath: string, signal?: AbortSignal): Promise<File> {
  const response = await apiFetch(`${API_PREFIX}/samples/file?path=${encodeURIComponent(samplePath)}`, { signal });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const blob = await response.blob();
  return new File([blob], samplePath.split('/').pop() ?? samplePath, { type: blob.type });
}

export function getImageInfo(imageId: string, signal?: AbortSignal): Promise<ImageInfo> {
  return getJson(`${API_PREFIX}/images/${imageId}`, signal);
}

/** Multipart upload with progress (XHR: fetch cannot report upload progress) */
function uploadFile<T>(url: string, file: File, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  return uploadForm(url, form, onProgress, signal);
}

function uploadForm<T>(url: string, form: FormData, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.responseType = 'json';
    request.setRequestHeader('accept', 'application/json');
    for (const [name, value] of Object.entries(authHeaders())) {
      request.setRequestHeader(name, value);
    }

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(event.loaded, event.total);
      }
    };
    request.onload = () => {
      const body = request.response as (T & Partial<ErrorResponse>) | null;
      if (request.status === 201 && body) {
        resolve(body);
        return;
      }
      if (request.status === 401) {
        useAuth.getState().requireToken();
      }
      reject(new ApiRequestError(request.status, body?.error ?? 'HttpError', body?.message ?? `Upload failed with status ${request.status}`));
    };
    request.onerror = () => reject(new ApiRequestError(0, 'NetworkError', 'The server could not be reached'));
    request.onabort = () => reject(new DOMException('The upload was cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => request.abort(), { once: true });

    request.send(form);
  });
}

export function uploadImage(file: File, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<ImageInfo> {
  return uploadFile(`${API_PREFIX}/images`, file, onProgress, signal);
}

/** Uploads the files of a DICOM series, which the server opens as one stack */
export function uploadDicomSeries(files: readonly File[], name: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<ImageInfo> {
  const form = new FormData();
  form.append('name', name);
  for (const file of files) {
    form.append('file', file, file.name);
  }
  return uploadForm(`${API_PREFIX}/images/series`, form, onProgress, signal);
}

/** Uploads a NIfTI volume (.nii, .nii.gz), kept on the server until deleteVolume */
export function uploadVolume(file: File, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<VolumeInfo> {
  return uploadFile(`${API_PREFIX}/volumes`, file, onProgress, signal);
}

export async function fetchVolumePreview(volumeId: string, query: VolumePreviewQuery, signal?: AbortSignal): Promise<Blob> {
  const parameters = new URLSearchParams({ orientation: query.orientation, slice: String(query.slice), volume: String(query.volume ?? 0) });
  if (query.maxSize !== undefined) {
    parameters.set('maxSize', String(query.maxSize));
  }
  const response = await apiFetch(`${API_PREFIX}/volumes/${volumeId}/preview.png?${parameters}`, { signal });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return response.blob();
}

/** Stores every slice of a volume in one orientation as a stack image */
export function openVolumeStackImage(volumeId: string, request: VolumeStackRequest, signal?: AbortSignal): Promise<ImageInfo> {
  return sendJson('POST', `${API_PREFIX}/volumes/${volumeId}/stack`, request, signal);
}

/** Stores one slice of a volume as an image */
export function openVolumeSliceImage(volumeId: string, request: VolumeSliceRequest, signal?: AbortSignal): Promise<ImageInfo> {
  return sendJson('POST', `${API_PREFIX}/volumes/${volumeId}/images`, request, signal);
}

export async function deleteVolume(volumeId: string): Promise<void> {
  const response = await apiFetch(`${API_PREFIX}/volumes/${volumeId}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw await errorFromResponse(response);
  }
}

export async function deleteImage(imageId: string): Promise<void> {
  const response = await apiFetch(`${API_PREFIX}/images/${imageId}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw await errorFromResponse(response);
  }
}

/**
 * Downloads the raw samples of an image with transfer "raw". Progress counts decoded bytes against the size implied
 * by the image info, because Content-Length is the compressed size.
 */
export async function fetchRawImage(info: ImageInfo, onProgress?: ProgressCallback, signal?: AbortSignal, slice = 1): Promise<RawImage> {
  const response = await apiFetch(`${API_PREFIX}/images/${info.imageId}/raw${slice > 1 ? `?slice=${slice}` : ''}`, { signal });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const format = rawFormatFromHeaders(response.headers);
  const total = format.width * format.height * (format.bitDepth / 8);

  if (!response.body) {
    return decodeRawSamples(await response.arrayBuffer(), format);
  }

  // Read into one preallocated buffer; a longer body than expected is an error, a shorter one fails in decodeRawSamples
  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  let loaded = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (loaded + value.length > total) {
      await reader.cancel();
      throw new Error(`Raw data is longer than the expected ${total} bytes`);
    }
    bytes.set(value, loaded);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  return decodeRawSamples(loaded === total ? buffer : buffer.slice(0, loaded), format);
}

export interface DisplayOptions {
  min: number;
  max: number;
  maxSize?: number;
  /** Slice of a stack, from 1 */
  slice?: number;
}

export function displayUrl(imageId: string, { min, max, maxSize, slice }: DisplayOptions): string {
  const query = new URLSearchParams({ min: String(min), max: String(max) });
  if (slice !== undefined && slice > 1) {
    query.set('slice', String(slice));
  }
  if (maxSize !== undefined) {
    query.set('maxSize', String(maxSize));
  }
  return `${API_PREFIX}/images/${imageId}/display.png?${query}`;
}

export async function fetchDisplayBlob(imageId: string, options: DisplayOptions, signal?: AbortSignal): Promise<Blob> {
  const response = await apiFetch(displayUrl(imageId, options), { signal });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return response.blob();
}

export function getPixel(imageId: string, x: number, y: number, signal?: AbortSignal, slice = 1): Promise<PixelResponse> {
  return getJson(`${API_PREFIX}/images/${imageId}/pixel?x=${x}&y=${y}${slice > 1 ? `&slice=${slice}` : ''}`, signal);
}

async function sendJson<T>(method: 'POST' | 'DELETE', url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(url, {
    method,
    signal,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export function getRoiStats(imageId: string, rois: RoiStatsRequest['rois'], signal?: AbortSignal): Promise<RoiStatsResponse> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/roi-stats`, { rois }, signal);
}

/** The largest regions of the pixels in an intensity range, as polygon outlines (maxRegions 0: only the total) */
export function selectThresholdRois(imageId: string, request: ThresholdRoisRequest, signal?: AbortSignal): Promise<ThresholdRoisResponse> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/threshold-rois`, request, signal);
}

/** The connected region around a pixel within a tolerance of its value */
export function selectWandRoi(imageId: string, request: WandRoiRequest, signal?: AbortSignal): Promise<WandRoiResponse> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/wand-roi`, request, signal);
}

/** Union of ROIs, or the first ROI without the others, computed on the pixel grid */
export function combineRois(imageId: string, request: CombineRoisRequest): Promise<RoiShapeResult> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/combine-rois`, request);
}

/** A brush stroke painted into (or erased from) a shape, computed on the pixel grid */
export function brushRoi(imageId: string, request: BrushRoiRequest): Promise<RoiShapeResult> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/brush-roi`, request);
}

/** A shape enlarged, shrunk or turned into a band around it, computed on the pixel grid */
export function growRoi(imageId: string, request: GrowRoiRequest): Promise<RoiShapeResult> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/grow-roi`, request);
}

/** The 8-bit edge map PNG of an image */
export async function fetchEdgeMap(imageId: string, query: EdgeMapQuery, signal?: AbortSignal): Promise<Blob> {
  const parameters = new URLSearchParams({ method: query.method, sigma: String(query.sigma), low: String(query.low), high: String(query.high) });
  if (query.maxSize !== undefined) {
    parameters.set('maxSize', String(query.maxSize));
  }
  if (query.slice !== undefined && query.slice > 1) {
    parameters.set('slice', String(query.slice));
  }
  const response = await apiFetch(`${API_PREFIX}/images/${imageId}/edges.png?${parameters}`, { signal });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return response.blob();
}

export function getGradientStats(imageId: string, sigma: number, signal?: AbortSignal, slice = 1): Promise<GradientStatsResponse> {
  return getJson(`${API_PREFIX}/images/${imageId}/gradient-stats?sigma=${sigma}${slice > 1 ? `&slice=${slice}` : ''}`, signal);
}

/** The intensities along a line (Analyze ▸ Plot Profile) */
export function getLineProfile(imageId: string, request: LineProfileRequest, signal?: AbortSignal): Promise<LineProfileResponse> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/line-profile`, request, signal);
}

/** The histogram of an ROI (Analyze ▸ Histogram) */
export function getRoiHistogram(imageId: string, request: RoiHistogramRequest, signal?: AbortSignal): Promise<RoiHistogramResponse> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/roi-histogram`, request, signal);
}

/** Livewire path between two pixels along strong edges */
export function livewirePath(imageId: string, request: LivewireRequest, signal?: AbortSignal): Promise<LivewireResponse> {
  return sendJson('POST', `${API_PREFIX}/images/${imageId}/livewire`, request, signal);
}

export function startAnalysis(request: AnalysisRequest): Promise<AnalysisInfo> {
  return sendJson('POST', `${API_PREFIX}/analyses`, request);
}

export function getAnalysisResults(analysisId: string, signal?: AbortSignal): Promise<AnalysisResults> {
  return getJson(`${API_PREFIX}/analyses/${analysisId}/results`, signal);
}

export function cancelAnalysis(analysisId: string): Promise<void> {
  return sendJson('DELETE', `${API_PREFIX}/analyses/${analysisId}`);
}

/** The results CSV written by glcm_core for one analysis */
export async function getAnalysisCsv(analysisId: string): Promise<string> {
  const response = await apiFetch(`${API_PREFIX}/analyses/${analysisId}/results.csv`);
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return response.text();
}

export function startFeatureMap(request: FeatureMapRequest): Promise<FeatureMapInfo> {
  return sendJson('POST', `${API_PREFIX}/feature-maps`, request);
}

export function getFeatureMap(featureMapId: string, signal?: AbortSignal): Promise<FeatureMapInfo> {
  return getJson(`${API_PREFIX}/feature-maps/${featureMapId}`, signal);
}

/** The rows × columns values of a completed feature map, sent as little-endian 32-bit floats */
export async function getFeatureMapValues(info: FeatureMapInfo, signal?: AbortSignal): Promise<Float32Array> {
  const response = await apiFetch(`${API_PREFIX}/feature-maps/${info.featureMapId}/values`, { signal });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const buffer = await response.arrayBuffer();
  const count = info.columns * info.rows;
  if (buffer.byteLength !== count * 4) {
    throw new Error(`The feature map values have ${buffer.byteLength} bytes, expected ${count * 4}`);
  }
  const view = new DataView(buffer);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    values[i] = view.getFloat32(i * 4, true);
  }
  return values;
}

/** Cancels a running feature map or forgets a finished one */
export async function deleteFeatureMap(featureMapId: string): Promise<void> {
  const response = await apiFetch(`${API_PREFIX}/feature-maps/${featureMapId}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw await errorFromResponse(response);
  }
}

export function analysisEventsUrl(analysisId: string): string {
  return `${API_PREFIX}/analyses/${analysisId}/events`;
}

export interface DownloadedFile {
  blob: Blob;
  fileName: string;
}

async function postForFile(url: string, body: unknown, fallbackName: string): Promise<DownloadedFile> {
  const response = await apiFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return { blob: await response.blob(), fileName: fileNameFromDisposition(response.headers.get('content-disposition'), fallbackName) };
}

export function exportResults(format: ExportFormat, documents: ResultsDocument[]): Promise<DownloadedFile> {
  return postForFile(`${API_PREFIX}/exports/results`, { format, documents }, `results.${format}`);
}

export function exportRoiImages(request: RoiImagesExportRequest): Promise<DownloadedFile> {
  return postForFile(`${API_PREFIX}/exports/roi-images`, request, 'rois.zip');
}

export async function findImagesBySha256(sha256: string, signal?: AbortSignal): Promise<ImageInfo[]> {
  return (await getJson<ImageListResponse>(`${API_PREFIX}/images?sha256=${sha256}`, signal)).images;
}

/** The uploaded file of an image */
export async function downloadOriginal(imageId: string): Promise<Uint8Array> {
  const response = await apiFetch(`${API_PREFIX}/images/${imageId}/original`);
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function getCoreVersion(): Promise<string> {
  return (await getHealth()).coreVersion;
}
