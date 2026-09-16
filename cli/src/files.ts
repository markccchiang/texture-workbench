// The parts of the command line that touch the file system: an image named on the command line, and ROI files.
// Everything else is in @glcm/client, which reads nothing.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ImageJRoiError, isImageJRoiFileName, readImageJRois, writeImageJRois, type Roi, type RoiSetDocument } from '@glcm/api';
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

/**
 * ROIs from an ROI set, a project file, a bare array of ROIs, or ImageJ's .roi files and RoiSet.zip archives. What an
 * ImageJ file holds that cannot be measured (lines, points) is left out and reported through `warn`.
 */
export async function readRois(file: string, warn: (message: string) => void = () => undefined): Promise<Roi[]> {
  if (!isImageJRoiFileName(file)) {
    return roisFromDocument(await readJson(file, 'InvalidRois'), file);
  }
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    throw new ApiError(0, 'InvalidRois', `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { document, warnings } = readImageJRois(bytes, path.basename(file));
    warnings.forEach(warn);
    if (document.rois.length === 0) {
      throw new ApiError(0, 'InvalidRois', `${file} holds no ImageJ ROI with an area`);
    }
    return document.rois;
  } catch (error) {
    throw error instanceof ImageJRoiError ? new ApiError(0, 'InvalidRois', error.message) : error;
  }
}

/**
 * Writes an ROI set: as JSON, or for a name ending in .zip as an ImageJ RoiSet.zip whose ROIs cover the same pixels in
 * ImageJ on an image of this size. Returns notes on the ImageJ file (ROIs written as pixel outlines, or left out).
 */
export async function writeRoiSet(file: string, document: RoiSetDocument, size: { width: number; height: number }): Promise<string[]> {
  if (/\.roi$/i.test(file)) {
    throw new ApiError(0, 'BadOption', 'ROIs for ImageJ are written as a RoiSet.zip archive; give the file a .zip name, e.g. regions.zip');
  }
  if (!/\.zip$/i.test(file)) {
    await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    return [];
  }
  const { bytes, outlined, empty } = writeImageJRois(document.rois, size);
  await fs.writeFile(file, bytes);
  return [
    ...(outlined.length > 0 ? [`written as the outline of their pixels, so ImageJ measures the same pixels: ${outlined.join(', ')}`] : []),
    ...(empty.length > 0 ? [`left out, with no pixel on the image: ${empty.join(', ')}`] : []),
  ];
}

/** Settings from a file holding AnalysisSettings, or a document with a `settings` field (a project, a results file) */
export async function readSettings(file: string): Promise<Record<string, unknown>> {
  const document = (await readJson(file, 'InvalidSettings')) as { settings?: Record<string, unknown> } & Record<string, unknown>;
  return document.settings ?? document;
}
