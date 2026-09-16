// Batch measurement: one ROI set and the current analysis settings applied to many images, one image at a time, on the
// existing API (POST /images, POST /analyses). The API calls are passed in, so the flow can be tested without a server.

import type { AnalysisInfo, AnalysisRequest, AnalysisResults, AnalysisSettings, CatalogResponse, ImageInfo, PixelSpacing, RoiSetDocument } from '@glcm/api';
import { adaptToImage, checkSettings, requestSettings } from '@glcm/api';
import { prepareRoiImport } from '../files/roiSet';

export type BatchItemStatus = 'waiting' | 'uploading' | 'measuring' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface BatchItem {
  fileName: string;
  status: BatchItemStatus;
  /** Upload progress from 0 to 1 */
  uploaded?: number;
  /** The server already had this image (same SHA-256), so it was not uploaded again */
  reused?: boolean;
  analysisId?: string;
  /** Finished and total measurement jobs */
  completed?: number;
  total?: number;
  /** Why the image was skipped or failed, or notes about its ROIs and results */
  message?: string;
}

export interface BatchDependencies {
  /** Hex SHA-256 of the file, or null when it cannot be computed */
  sha256(file: File): Promise<string | null>;
  findImagesBySha256(sha256: string, signal?: AbortSignal): Promise<ImageInfo[]>;
  uploadImage(file: File, onProgress: (loaded: number, total: number) => void, signal: AbortSignal): Promise<ImageInfo>;
  startAnalysis(request: AnalysisRequest): Promise<AnalysisInfo>;
  /** Resolves with the final results; onProgress reports the number of finished jobs meanwhile */
  waitForResults(analysisId: string, onProgress: (completed: number) => void): Promise<AnalysisResults>;
  cancelAnalysis(analysisId: string): Promise<void>;
  /** Spacing chosen for an image earlier; undefined: the image's own */
  pixelSpacing?(info: ImageInfo): PixelSpacing | null | undefined;
  /** E.g. to show the analysis in the results table */
  onAnalysisStarted?(info: AnalysisInfo): void;
  onAnalysisFinished?(results: AnalysisResults): void;
}

export interface BatchInput {
  files: readonly File[];
  roiSet: RoiSetDocument;
  /** Fitted to each image's bit depth before measuring */
  settings: AnalysisSettings;
  catalog: Pick<CatalogResponse, 'presets' | 'limits'>;
}

/** In a batch the ROIs always come from another image file, so that warning says nothing */
const DIFFERENT_FILE_WARNING = 'The ROIs were drawn on a different image file';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Measures every file in turn; a failing image is recorded and the batch goes on. Returns the final state of each image. */
export async function runBatch(input: BatchInput, deps: BatchDependencies, onChange: (items: BatchItem[]) => void, signal: AbortSignal): Promise<BatchItem[]> {
  let items: BatchItem[] = input.files.map((file) => ({ fileName: file.name, status: 'waiting' }));
  const update = (index: number, change: Partial<BatchItem>) => {
    items = items.map((item, i) => (i === index ? { ...item, ...change } : item));
    onChange(items);
  };
  onChange(items);

  for (const [index, file] of input.files.entries()) {
    if (signal.aborted) {
      break;
    }
    try {
      update(index, { status: 'uploading', uploaded: 0 });
      const sha256 = await deps.sha256(file);
      const [stored] = sha256 ? await deps.findImagesBySha256(sha256, signal) : [];
      const info = stored ?? (await deps.uploadImage(file, (loaded, total) => update(index, { uploaded: total > 0 ? loaded / total : 0 }), signal));
      update(index, { uploaded: 1, reused: Boolean(stored) });

      const prepared = prepareRoiImport(input.roiSet, info);
      const notes = prepared.warnings.filter((warning) => !warning.startsWith(DIFFERENT_FILE_WARNING));
      if (prepared.rois.length === 0) {
        update(index, { status: 'skipped', message: notes.join(' ') || 'No ROI lies on this image.' });
        continue;
      }

      const bitDepth = info.bitDepth as 8 | 16;
      const settings = adaptToImage(input.settings, bitDepth);
      const { errors } = checkSettings(settings, bitDepth, input.catalog, deps.pixelSpacing?.(info) ?? info.pixelSpacing ?? null);
      if (errors.length > 0) {
        update(index, { status: 'failed', message: errors.join(' ') });
        continue;
      }

      const pixelSpacing = deps.pixelSpacing?.(info);
      const started = await deps.startAnalysis({
        imageId: info.imageId,
        // ROIs imported without a colour have an empty one, which the API does not accept
        rois: prepared.rois.map(({ id, name, color, shape, className, slice }) => ({
          id,
          name,
          ...(color ? { color } : {}),
          ...(className ? { class: className } : {}),
          ...(slice !== undefined ? { slice } : {}),
          shape,
        })),
        settings: requestSettings(settings, bitDepth, { min: info.windowMin, max: info.windowMax }),
        ...(pixelSpacing !== undefined ? { pixelSpacing } : {}),
      });
      deps.onAnalysisStarted?.(started);
      update(index, { status: 'measuring', analysisId: started.analysisId, completed: 0, total: started.total, message: notes.join(' ') || undefined });

      const cancel = () => void deps.cancelAnalysis(started.analysisId).catch(() => undefined);
      signal.addEventListener('abort', cancel, { once: true });
      let final: AnalysisResults;
      try {
        final = await deps.waitForResults(started.analysisId, (completed) => update(index, { completed }));
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      deps.onAnalysisFinished?.(final);

      const unmeasured = final.results.filter((result) => result.status !== 'ok').length;
      if (unmeasured > 0) {
        notes.push(`${unmeasured} of ${final.results.length} results were skipped or failed.`);
      }
      update(index, {
        status: final.status === 'completed' ? 'done' : final.status === 'cancelled' ? 'cancelled' : 'failed',
        completed: final.results.length,
        message: notes.join(' ') || undefined,
      });
    } catch (error) {
      update(index, signal.aborted ? { status: 'cancelled' } : { status: 'failed', message: errorMessage(error) });
    }
  }

  if (signal.aborted) {
    items = items.map((item) => (item.status === 'waiting' ? { ...item, status: 'cancelled' } : item));
    onChange(items);
  }
  return items;
}
