// Building the info of a decoded image, and checking slices of stacks: shared by the image, volume and analysis routes

import type { ImageInfo } from '@glcm/api';
import type * as native from '@glcm/native';
import type { ServerConfig } from './config.js';
import { ApiError } from './errors.js';
import { newImageId } from './storage/ImageStore.js';

export interface ImageSource {
  name: string;
  sizeBytes: number;
  sha256: string;
}

export function decodedImageInfo(decoded: native.DecodedImage, source: ImageSource, config: ServerConfig): ImageInfo {
  const pixelCount = decoded.width * decoded.height;
  return {
    imageId: newImageId(),
    name: source.name,
    sizeBytes: source.sizeBytes,
    width: decoded.width,
    height: decoded.height,
    bitDepth: decoded.bitDepth,
    slices: decoded.slices,
    sourceChannels: decoded.sourceChannels,
    pixelSpacing: decoded.pixelSpacing,
    ...(decoded.valueConversion ? { valueConversion: decoded.valueConversion } : {}),
    sha256: source.sha256,
    transfer: pixelCount <= config.rawTransferMaxPixels ? 'raw' : 'server',
    windowMin: decoded.windowMin,
    windowMax: decoded.windowMax,
    histogram: decoded.histogram,
    warnings: decoded.warnings,
    createdAt: new Date().toISOString(),
  };
}

/** The slice of a request (default 1), refused with 400 beyond the image's slices */
export function requireSlice(info: Pick<ImageInfo, 'slices'>, slice: number | undefined): number {
  const value = slice ?? 1;
  if (value > info.slices) {
    throw new ApiError(400, 'BadRequest', `The image has ${info.slices} ${info.slices === 1 ? 'slice' : 'slices'}; slice ${value} does not exist`);
  }
  return value;
}
