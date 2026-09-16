// The parts of the command line that touch the file system: an image named on the command line, and an ROI file.
// Everything else is in @glcm/client, which reads nothing.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Roi } from '@glcm/api';
import { ApiError, IMAGE_ID_PATTERN, openImage, roisFromDocument, type ApiClient, type OpenedImage } from '@glcm/client';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.dcm': 'application/dicom',
};

/** An image named as a file, a sample (`sample:textures/brick.png`) or an image id */
export async function openImageTarget(client: ApiClient, target: string): Promise<OpenedImage> {
  if (IMAGE_ID_PATTERN.test(target)) {
    return openImage(client, { kind: 'id', imageId: target });
  }
  if (target.startsWith('sample:')) {
    return openImage(client, { kind: 'sample', path: target.slice('sample:'.length) });
  }
  let data: Uint8Array;
  try {
    data = await fs.readFile(target);
  } catch (error) {
    throw new ApiError(0, 'FileNotFound', `${target} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const name = path.basename(target);
  return openImage(client, { kind: 'bytes', name, data, contentType: CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream' });
}

async function readJson(file: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new ApiError(0, what, `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** ROIs from an ROI set, a project file or a bare array of ROIs */
export async function readRois(file: string): Promise<Roi[]> {
  return roisFromDocument(await readJson(file, 'InvalidRois'), file);
}

/** Settings from a file holding AnalysisSettings, or a document with a `settings` field (a project, a results file) */
export async function readSettings(file: string): Promise<Record<string, unknown>> {
  const document = (await readJson(file, 'InvalidSettings')) as { settings?: Record<string, unknown> } & Record<string, unknown>;
  return document.settings ?? document;
}
