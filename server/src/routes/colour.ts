import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ColourConversionRequest, ColourPreviewQuery, colourConversionOption, ErrorResponse, ImageIdParams, ImageInfo, type ColourConversion } from '@glcm/api';
import * as native from '@glcm/native';
import { Type } from 'typebox';
import type { ServerConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { decodedImageInfo } from '../imageInfo.js';
import type { DisplayCache } from '../storage/DisplayCache.js';
import type { ImageStore } from '../storage/ImageStore.js';

export interface ColourRoutesOptions {
  config: ServerConfig;
  store: ImageStore;
  displayCache: DisplayCache;
}

/** Colour decodes running at once: each holds a whole colour image (and a conversion also its TIFF) */
const MAX_COLOUR_DECODES = 2;
/** Bump when previews change, so cached copies are not used */
const PREVIEW_VERSION = 1;

/** The name of a converted image: "slide.jpg [red]" */
export function colourImageName(sourceName: string, conversion: ColourConversion): string {
  return `${sourceName} [${colourConversionOption(conversion).suffix}]`;
}

/** Runs tasks at most `limit` at a time, in the order they came */
class Limiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.running -= 1;
      }
    }
  }
}

export const colourRoutes: FastifyPluginAsyncTypebox<ColourRoutesOptions> = async (app, { config, store, displayCache }) => {
  const withTransfer = (info: ImageInfo): ImageInfo => ({ ...info, transfer: info.width * info.height <= config.rawTransferMaxPixels ? 'raw' : 'server' });
  const decodes = new Limiter(MAX_COLOUR_DECODES);
  /** Conversions in progress, by colour image and conversion, so that requests arriving together make one image */
  const pending = new Map<string, Promise<{ info: ImageInfo; created: boolean }>>();

  /** The colour image an image comes from: itself, or the image it was converted from */
  async function colourImage(id: string): Promise<ImageInfo> {
    const info = await store.info(id);
    if (!info) {
      throw new ApiError(404, 'NotFound', `Image ${id} was not found`);
    }
    if (!info.colourSource) {
      if (info.sourceChannels < 3 || info.madeFrom !== undefined) {
        // A stack made on the server (a DICOM series) keeps only gray slices, whatever its files held
        throw new ApiError(422, 'NotColour', `${info.name} is not a colour image`);
      }
      return info;
    }
    const source = await store.info(info.colourSource.imageId);
    if (!source) {
      throw new ApiError(404, 'NotFound', `The colour image ${info.name} was converted from is no longer stored; open it again`);
    }
    return source;
  }

  async function decode(source: ImageInfo, conversion: ColourConversion, options: { firstSlice?: boolean; tiffDescription?: string }) {
    let decoded: native.DecodedImage & { tiff?: Buffer };
    try {
      decoded = await decodes.run(() =>
        native.decodeImageFile(store.originalPath(source.imageId), {
          maxPixels: config.maxImagePixels,
          maxStackPixels: config.maxStackPixels,
          colour: conversion,
          ...(options.firstSlice ? { firstSlice: true } : {}),
          ...(options.tiffDescription ? { encodeTiff: true, tiffDescription: options.tiffDescription } : {}),
        }),
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!(await store.info(source.imageId))) {
        throw new ApiError(404, 'NotFound', `Image ${source.imageId} was deleted`);
      }
      if (code === 'IMAGE_TOO_LARGE') {
        throw new ApiError(422, 'ImageTooLarge', (error as Error).message);
      }
      if (code === 'UNSUPPORTED_IMAGE') {
        throw new ApiError(422, 'UnsupportedImage', (error as Error).message);
      }
      if (code === 'DECODE_FAILED') {
        // Its message names the stored file's path
        throw new ApiError(422, 'InvalidImage', `The stored file of ${source.name} could not be decoded`);
      }
      throw error;
    }
    if (decoded.sourceChannels < 3) {
      throw new ApiError(422, 'NotColour', `The stored file of ${source.name} has no colour channels`);
    }
    return decoded;
  }

  async function convert(source: ImageInfo, conversion: ColourConversion): Promise<{ info: ImageInfo; created: boolean }> {
    const existing = (await store.list()).find((info) => info.colourSource?.imageId === source.imageId && info.colourSource.conversion === conversion);
    if (existing) {
      return { info: existing, created: false };
    }
    // The description makes the file, and so its SHA-256, differ between conversions that give the same samples
    const decoded = await decode(source, conversion, { tiffDescription: `Texture Workbench: ${source.name}, ${colourConversionOption(conversion).label}` });
    const tiff = decoded.tiff!;
    const info: ImageInfo = {
      ...decodedImageInfo(
        decoded,
        { name: colourImageName(source.name, conversion), sizeBytes: tiff.length, sha256: createHash('sha256').update(tiff).digest('hex') },
        config,
      ),
      colourSource: { imageId: source.imageId, conversion },
    };
    if (!(await store.info(source.imageId))) {
      throw new ApiError(404, 'NotFound', `Image ${source.imageId} was deleted`);
    }
    const tiffPath = store.temporaryUploadPath();
    try {
      await fs.writeFile(tiffPath, tiff);
      await store.save(info, decoded.pixels, tiffPath);
    } finally {
      await fs.rm(tiffPath, { force: true });
    }
    return { info, created: true };
  }

  app.post(
    '/images/:id/colour',
    {
      schema: {
        summary: 'Convert a colour image another way',
        description:
          'Decodes the colour image again with another conversion and stores the result as a new image named "<name> [<conversion>]", whose original file is an uncompressed TIFF of the converted slices (with the conversion in its ImageDescription, so its SHA-256 identifies the image) and whose colourSource names the colour image. The conversion is recorded as the image\'s valueConversion, so results say what was measured. Called on an image that was converted already, it converts its colour image. luminance returns the colour image itself; converting an image the same way again (also while the first request runs) returns the image made the first time. 422 NotColour for gray images and stacks made on the server.',
        tags: ['images'],
        params: ImageIdParams,
        body: ColourConversionRequest,
        response: { 200: ImageInfo, 201: ImageInfo, 400: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request, reply) => {
      const source = await colourImage(request.params.id);
      const { conversion } = request.body;
      if (conversion === 'luminance') {
        return reply.code(200).send(withTransfer(source));
      }
      const key = `${source.imageId}:${conversion}`;
      let running = pending.get(key);
      const joined = running !== undefined;
      if (!running) {
        running = convert(source, conversion);
        pending.set(key, running);
        void running.catch(() => undefined).finally(() => pending.delete(key));
      }
      const { info, created } = await running;
      return reply.code(created && !joined ? 201 : 200).send(withTransfer(info));
    },
  );

  app.get(
    '/images/:id/colour-preview.png',
    {
      schema: {
        summary: 'Preview a colour conversion',
        description:
          'The first slice of the colour image (or of the image it was converted from) converted with conversion, rendered with its own default window (0.5th–99.5th percentiles) and reduced so the long side is at most maxSize. Cached like display.png.',
        tags: ['images'],
        params: ImageIdParams,
        querystring: ColourPreviewQuery,
        response: {
          200: { description: 'PNG image', content: { 'image/png': { schema: Type.Unsafe<Buffer>({ type: 'string', format: 'binary' }) } } },
          400: ErrorResponse,
          404: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const source = await colourImage(request.params.id);
      const { conversion } = request.query;
      const maxSize = Math.min(request.query.maxSize ?? config.displayMaxSize, config.displayMaxSize);
      const key = createHash('sha256').update(`colour-preview:${source.sha256}:${conversion}:${maxSize}:${PREVIEW_VERSION}`).digest('hex');
      let png = await displayCache.get(key);
      if (!png) {
        const decoded = await decode(source, conversion, { firstSlice: true });
        png = await native.renderDisplay(decoded.pixels, decoded.width, decoded.height, decoded.bitDepth, decoded.windowMin, decoded.windowMax, maxSize);
        await displayCache.set(key, png);
      }
      // The stored file never changes
      return reply.header('Cache-Control', 'private, max-age=3600').type('image/png').send(png);
    },
  );
};
