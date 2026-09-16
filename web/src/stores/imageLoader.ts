// Opening images: upload, then download the raw samples when the server offers them (doc/ui-design-plan.md, 6.1).

import type { ImageInfo, SliceOrientation, VolumeInfo } from '@glcm/api';
import { notifications } from '@mantine/notifications';
import {
  ApiRequestError,
  deleteVolume,
  downloadSample,
  fetchRawImage,
  openVolumeSliceImage,
  openVolumeStackImage,
  uploadDicomSeries,
  uploadImage,
  uploadVolume,
} from '../api/client';
import type { RawImage } from '../image/raw';
import { isVolumeFile, needsSliceChoice, useVolumeImport } from '../volumes/volumeImport';
import { useViewer } from './viewerStore';

let currentLoad: AbortController | null = null;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function startLoad(): AbortController {
  currentLoad?.abort();
  const controller = new AbortController();
  currentLoad = controller;
  return controller;
}

function finishLoad(controller: AbortController): void {
  if (currentLoad === controller) {
    currentLoad = null;
    useViewer.getState().setLoading(null);
  }
}

export function cancelImageLoad(): void {
  if (currentLoad) {
    const controller = currentLoad;
    controller.abort();
    finishLoad(controller);
  }
}

function progressReporter(controller: AbortController, name: string) {
  return (phase: 'uploading' | 'downloading', progress: number | null) => {
    if (currentLoad === controller) {
      useViewer.getState().setLoading({ name, phase, progress });
    }
  };
}

/** Downloads the raw samples if offered, then shows the image; null if the load was cancelled */
async function showImage(info: ImageInfo, controller: AbortController): Promise<ImageInfo | null> {
  const { signal } = controller;
  const setLoading = progressReporter(controller, info.name);
  let raw: RawImage | null = null;
  if (info.transfer === 'raw') {
    setLoading('downloading', 0);
    try {
      raw = await fetchRawImage(info, (loaded, total) => setLoading('downloading', loaded / total), signal);
    } catch (error) {
      if (isAbort(error)) {
        throw error;
      }
      // display.png and /pixel work for every image, so the image still opens
      console.warn('Raw download failed; using server rendering', error);
      notifications.show({
        color: 'yellow',
        title: 'Using server rendering',
        message: errorMessage(error),
      });
    }
  }

  if (signal.aborted) {
    return null;
  }
  useViewer.getState().openImage({ info, raw });
  for (const warning of info.warnings) {
    notifications.show({
      color: 'yellow',
      title: info.name,
      message: warning,
      autoClose: 8000,
    });
  }
  return info;
}

async function uploadAndShow(file: File, controller: AbortController): Promise<ImageInfo | null> {
  const setLoading = progressReporter(controller, file.name);
  setLoading('uploading', 0);
  const info = await uploadImage(file, (loaded, total) => setLoading('uploading', loaded / total), controller.signal);
  return showImage(info, controller);
}

async function run(name: string, load: (controller: AbortController) => Promise<ImageInfo | null>): Promise<ImageInfo | null> {
  const controller = startLoad();
  try {
    return await load(controller);
  } catch (error) {
    if (!isAbort(error)) {
      notifications.show({
        color: 'red',
        title: `Could not open ${name}`,
        message: errorMessage(error),
        autoClose: 10000,
      });
    }
    return null;
  } finally {
    finishLoad(controller);
  }
}

async function sliceAndShow(volume: VolumeInfo, orientation: SliceOrientation, slice: number, volumeIndex: number, controller: AbortController) {
  if (currentLoad === controller) {
    useViewer.getState().setLoading({ name: volume.name, phase: 'openingSlice', progress: null });
  }
  const info = await openVolumeSliceImage(volume.volumeId, { orientation, slice, volume: volumeIndex }, controller.signal);
  return showImage(info, controller);
}

/** Uploads a NIfTI file: a single 2D image opens directly, a volume opens the slice dialog (resolving to null) */
function uploadVolumeAndChoose(file: File): Promise<ImageInfo | null> {
  return run(file.name, async (controller) => {
    const setLoading = progressReporter(controller, file.name);
    setLoading('uploading', 0);
    const volume = await uploadVolume(file, (loaded, total) => setLoading('uploading', loaded / total), controller.signal);
    if (needsSliceChoice(volume)) {
      useVolumeImport.getState().open(volume);
      return null;
    }
    try {
      return await sliceAndShow(volume, volume.acquisitionOrientation, 0, 0, controller);
    } finally {
      void deleteVolume(volume.volumeId).catch(() => undefined);
    }
  });
}

/** Uploads and opens a file; resolves to its info, or null if it failed, was cancelled or waits for a slice to be chosen */
export function openImageFile(file: File): Promise<ImageInfo | null> {
  if (isVolumeFile(file.name)) {
    return uploadVolumeAndChoose(file);
  }
  return run(file.name, (controller) => uploadAndShow(file, controller));
}

/** Opens one slice of an uploaded volume as the image */
export function openVolumeSlice(volume: VolumeInfo, orientation: SliceOrientation, slice: number, volumeIndex: number): Promise<ImageInfo | null> {
  return run(volume.name, (controller) => sliceAndShow(volume, orientation, slice, volumeIndex, controller));
}

/** Opens every slice of one volume in one orientation as a stack, showing `slice` (from 0, as in the slice dialog) */
export function openVolumeStack(volume: VolumeInfo, orientation: SliceOrientation, volumeIndex: number, slice = 0): Promise<ImageInfo | null> {
  return run(volume.name, async (controller) => {
    if (currentLoad === controller) {
      useViewer.getState().setLoading({
        name: volume.name,
        phase: 'openingSlice',
        progress: null,
      });
    }
    const info = await openVolumeStackImage(volume.volumeId, { orientation, volume: volumeIndex }, controller.signal);
    const shown = await showImage(info, controller);
    if (shown && slice > 0) {
      void showSlice(slice + 1);
    }
    return shown;
  });
}

/** Uploads the files of a DICOM series (a chosen folder) and opens them as one stack */
export function openDicomSeries(files: readonly File[], name: string): Promise<ImageInfo | null> {
  return run(name, async (controller) => {
    const setLoading = progressReporter(controller, name);
    setLoading('uploading', 0);
    const info = await uploadDicomSeries(files, name, (loaded, total) => setLoading('uploading', loaded / total), controller.signal);
    return showImage(info, controller);
  });
}

/** Opens an image the server already has */
export function openStoredImage(info: ImageInfo): Promise<ImageInfo | null> {
  return run(info.name, (controller) => showImage(info, controller));
}

/** Raw samples of recently shown slices of stacks, so going back and forth does not download them again */
const SLICE_CACHE_BYTES = 256 * 1024 * 1024;
const sliceCache = new Map<string, RawImage>();
let sliceCacheBytes = 0;
/** The slice being downloaded: key presses and further requests count from it, not from the slice still on screen */
let sliceLoad: { imageId: string; slice: number; controller: AbortController } | null = null;

/** The slice being shown or, while its samples download, about to be shown (from 1) */
export function targetSlice(): number {
  const { image } = useViewer.getState();
  if (!image) {
    return 1;
  }
  return sliceLoad?.imageId === image.info.imageId ? sliceLoad.slice : (image.slice ?? 1);
}

function rememberSlice(key: string, raw: RawImage): void {
  if (sliceCache.has(key)) {
    return;
  }
  sliceCache.set(key, raw);
  sliceCacheBytes += raw.samples.byteLength;
  for (const [oldest, cached] of sliceCache) {
    if (sliceCacheBytes <= SLICE_CACHE_BYTES || oldest === key) {
      break;
    }
    sliceCache.delete(oldest);
    sliceCacheBytes -= cached.samples.byteLength;
  }
}

/**
 * Shows another slice (from 1) of the open stack. Raw samples are downloaded first, so the canvas changes once they
 * are there; a newer request cancels an older one. Resolves to false when the slice was not shown.
 */
export async function showSlice(slice: number): Promise<boolean> {
  const { image } = useViewer.getState();
  if (!image || slice < 1 || slice > image.info.slices) {
    return false;
  }
  const pending = sliceLoad?.imageId === image.info.imageId ? sliceLoad : null;
  if (pending?.slice === slice) {
    // Already on its way
    return false;
  }
  // Another slice is no longer wanted, also when the one on screen is asked for again
  sliceLoad?.controller.abort();
  sliceLoad = null;
  if (slice === (image.slice ?? 1)) {
    return false;
  }
  const controller = new AbortController();
  sliceLoad = { imageId: image.info.imageId, slice, controller };
  const { info } = image;
  let raw: RawImage | null = null;
  // The slice shown has raw samples when the image offers them and the first download worked
  if (image.raw) {
    const key = `${info.imageId}#${slice}`;
    raw = sliceCache.get(key) ?? null;
    if (!raw) {
      try {
        raw = await fetchRawImage(info, undefined, controller.signal, slice);
      } catch (error) {
        if (sliceLoad?.controller === controller) {
          sliceLoad = null;
        }
        if (!isAbort(error)) {
          notifications.show({
            color: 'red',
            title: `Could not show slice ${slice}`,
            message: errorMessage(error),
          });
        }
        return false;
      }
      rememberSlice(key, raw);
    } else {
      sliceCache.delete(key);
      sliceCache.set(key, raw);
    }
  }
  if (controller.signal.aborted) {
    return false;
  }
  if (sliceLoad?.controller === controller) {
    sliceLoad = null;
  }
  // Keep the first slice's samples for coming back to it
  if (image.raw && (image.slice ?? 1) !== slice) {
    rememberSlice(`${info.imageId}#${image.slice ?? 1}`, image.raw);
  }
  useViewer.getState().showSlice({ info, raw, slice });
  return true;
}

export function openSample(samplePath: string): Promise<ImageInfo | null> {
  const name = samplePath.split('/').pop() ?? samplePath;
  return run(name, async (controller) => {
    useViewer.getState().setLoading({ name, phase: 'downloadingSample', progress: null });
    const file = await downloadSample(samplePath, controller.signal);
    return uploadAndShow(file, controller);
  });
}
