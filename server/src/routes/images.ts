import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  DisplayQuery,
  EdgeMapQuery,
  ErrorResponse,
  GradientStatsQuery,
  GradientStatsResponse,
  ImageIdParams,
  ImageInfo,
  ImageListResponse,
  ImagesQuery,
  PixelQuery,
  PixelResponse,
  RAW_HEADERS,
  SliceQuery,
} from '@glcm/api';
import * as native from '@glcm/native';
import { Type } from 'typebox';
import type { ServerConfig } from '../config.js';
import { negotiateEncoding } from '../encoding.js';
import { ApiError } from '../errors.js';
import { attachment } from '../files.js';
import type { DisplayCache } from '../storage/DisplayCache.js';
import { newImageId, type ImageStore } from '../storage/ImageStore.js';
import { decodedImageInfo, requireSlice } from '../imageInfo.js';
import { uploadName, withUpload } from '../uploads.js';

export interface ImageRoutesOptions {
  config: ServerConfig;
  store: ImageStore;
  displayCache: DisplayCache;
}

/** Bump when the rendering of display.png changes, so cached copies and ETags are invalidated */
const RENDERER_VERSION = 1;
/** Bump when the edge maps of edges.png change */
const EDGE_RENDERER_VERSION = 1;

function nativeError(error: unknown): never {
  if ((error as { code?: string }).code === 'INVALID_ARGUMENT') {
    throw new ApiError(400, 'BadRequest', (error as Error).message);
  }
  throw error;
}

const Binary = (contentType: string, description: string) => ({
  description,
  // Unsafe<Buffer>: documented as a binary string, typed as the Buffer the handler sends
  content: { [contentType]: { schema: Type.Unsafe<Buffer>({ type: 'string', format: 'binary' }) } },
});

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate === etag || candidate === `W/${etag}`);
}

export const imageRoutes: FastifyPluginAsyncTypebox<ImageRoutesOptions> = async (app, { config, store, displayCache }) => {
  /** Stored info, with the transfer mode for the current server limits */
  async function requireImage(id: string): Promise<ImageInfo> {
    const info = await store.info(id);
    if (!info) {
      throw new ApiError(404, 'NotFound', `Image ${id} was not found`);
    }
    return { ...info, transfer: info.width * info.height <= config.rawTransferMaxPixels ? 'raw' : 'server' };
  }

  /** Cache keys and ETags of a slice of a stack name the slice; those of single images stay as they were */
  const sliceKey = (info: ImageInfo, slice: number) => (info.slices > 1 ? `${info.sha256}#${slice}` : info.sha256);

  app.post(
    '/images',
    {
      schema: {
        summary: 'Upload an image',
        description:
          'multipart/form-data with one file field. PNG, JPEG, BMP, 8/16-bit TIFF, uncompressed DICOM and 2D NIfTI are decoded on the server; colour images are converted to their luminance (POST /images/{id}/colour converts them another way). The pages of a multi-page TIFF and the frames of a DICOM file become the slices of a stack. Upload NIfTI volumes to POST /volumes and DICOM series to POST /images/series.',
        tags: ['images'],
        consumes: ['multipart/form-data'],
        response: { 201: ImageInfo, 400: ErrorResponse, 413: ErrorResponse, 415: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request, reply) =>
      withUpload(request, store, config, 'image', async (upload) => {
        let decoded: native.DecodedImage;
        try {
          // The size is checked from the header, before the decoder allocates memory for the pixels
          decoded = await native.decodeImageFile(upload.path, { maxPixels: config.maxImagePixels, maxStackPixels: config.maxStackPixels });
        } catch (error) {
          if ((error as { code?: string }).code === 'IMAGE_TOO_LARGE') {
            throw new ApiError(422, 'ImageTooLarge', (error as Error).message);
          }
          const unsupported = (error as { code?: string }).code === 'UNSUPPORTED_IMAGE';
          throw new ApiError(
            422,
            unsupported ? 'UnsupportedImage' : 'InvalidImage',
            unsupported ? (error as Error).message : 'The file could not be decoded as an image',
          );
        }

        const pixelCount = decoded.width * decoded.height;
        if (pixelCount > config.maxImagePixels) {
          throw new ApiError(422, 'ImageTooLarge', `The image has ${pixelCount} pixels, more than the limit of ${config.maxImagePixels}`);
        }
        const info = decodedImageInfo(decoded, { name: upload.name, sizeBytes: upload.sizeBytes, sha256: upload.sha256 }, config);
        await store.save(info, decoded.pixels, upload.path);
        return reply.code(201).send(info);
      }),
  );

  app.post(
    '/images/series',
    {
      schema: {
        summary: 'Upload a DICOM series as a stack',
        description:
          'multipart/form-data with the files of a DICOM series (single-frame images) in file fields, and optionally a name field. Files that are not DICOM images are left out, only the series with the most files is used, and the slices are ordered along the image normal (ImagePositionPatient and ImageOrientationPatient), else by InstanceNumber, else by file name. The values of all files are stored alike. The image\'s original file is an uncompressed multi-page TIFF of the slices, whose SHA-256 identifies the image.',
        tags: ['images'],
        consumes: ['multipart/form-data'],
        response: { 201: ImageInfo, 400: ErrorResponse, 413: ErrorResponse, 415: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw new ApiError(415, 'UnsupportedMediaType', 'Send the series as multipart/form-data with one file field per file');
      }
      const paths: Array<{ path: string; name: string }> = [];
      let name = '';
      let totalBytes = 0;
      try {
        const parts = request.parts({
          limits: { fileSize: config.maxUploadBytes, files: config.maxSeriesFiles, fields: 10, parts: config.maxSeriesFiles + 10 },
        });
        for await (const part of parts) {
          if (part.type === 'field') {
            if (part.fieldname === 'name' && typeof part.value === 'string') {
              name = uploadName(part.value, '');
            }
            continue;
          }
          const target = store.temporaryUploadPath();
          paths.push({ path: target, name: part.filename ?? '' });
          const counting = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              totalBytes += chunk.length;
              callback(totalBytes > config.maxVolumeBytes ? new ApiError(413, 'PayloadTooLarge', `The series is larger than the limit of ${config.maxVolumeBytes} bytes`) : null, chunk);
            },
          });
          await pipeline(part.file, counting, createWriteStream(target));
          if (part.file.truncated) {
            throw new ApiError(413, 'PayloadTooLarge', `A file is larger than the limit of ${config.maxUploadBytes} bytes`);
          }
        }
      } catch (error) {
        await Promise.all(paths.map((file) => fs.rm(file.path, { force: true })));
        const code = (error as { code?: string }).code;
        if (code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new ApiError(413, 'PayloadTooLarge', `A file is larger than the limit of ${config.maxUploadBytes} bytes`);
        }
        if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
          throw new ApiError(413, 'PayloadTooLarge', `The series has more files than the limit of ${config.maxSeriesFiles}`);
        }
        throw error;
      }

      const tiffPath = store.temporaryUploadPath();
      try {
        if (paths.length === 0) {
          throw new ApiError(400, 'BadRequest', 'The request contains no file');
        }
        // Files without a name sort by the order they were sent in
        const ordered = paths.map((file, i) => ({ ...file, key: `${file.name}\u0000${String(i).padStart(8, '0')}` }));
        let stack: native.DecodedStack;
        try {
          stack = await native.decodeDicomSeries(
            ordered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((file) => file.path),
            { maxPixels: config.maxImagePixels, maxStackPixels: config.maxStackPixels },
          );
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'IMAGE_TOO_LARGE') {
            throw new ApiError(422, 'ImageTooLarge', (error as Error).message);
          }
          throw new ApiError(422, code === 'UNSUPPORTED_IMAGE' ? 'UnsupportedImage' : 'InvalidImage', (error as Error).message);
        }
        const info = decodedImageInfo(
          stack,
          {
            name: name || stack.seriesDescription || 'DICOM series',
            sizeBytes: stack.tiff.length,
            sha256: createHash('sha256').update(stack.tiff).digest('hex'),
          },
          config,
        );
        await fs.writeFile(tiffPath, stack.tiff);
        await store.save(info, stack.pixels, tiffPath);
        return reply.code(201).send(info);
      } finally {
        await Promise.all([...paths.map((file) => fs.rm(file.path, { force: true })), fs.rm(tiffPath, { force: true })]);
      }
    },
  );

  app.get(
    '/images/:id',
    {
      schema: {
        summary: 'Image metadata',
        tags: ['images'],
        params: ImageIdParams,
        response: { 200: ImageInfo, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => requireImage(request.params.id),
  );

  app.delete(
    '/images/:id',
    {
      schema: {
        summary: 'Delete an image',
        tags: ['images'],
        params: ImageIdParams,
        response: { 204: Type.Unsafe<undefined>({ type: 'null', description: 'Deleted (no body)' }), 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      if (!(await store.remove(request.params.id))) {
        throw new ApiError(404, 'NotFound', `Image ${request.params.id} was not found`);
      }
      return reply.code(204).send(undefined);
    },
  );

  app.get(
    '/images/:id/display.png',
    {
      schema: {
        summary: '8-bit rendering with window/level',
        description:
          'Intensities are mapped with the integer window/level formula shared with the browser renderer (doc/ui-design-plan.md, section 6.1) and downscaled so the long side is at most maxSize.',
        tags: ['images'],
        params: ImageIdParams,
        querystring: DisplayQuery,
        response: {
          200: Binary('image/png', 'PNG image'),
          304: Type.Unsafe<undefined>({ type: 'null', description: 'Not modified (no body)' }),
          400: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const info = await requireImage(request.params.id);
      const slice = requireSlice(info, request.query.slice);
      const windowMin = request.query.min ?? info.windowMin;
      const windowMax = request.query.max ?? info.windowMax;
      if (windowMin > windowMax) {
        throw new ApiError(400, 'BadRequest', 'min must not be greater than max');
      }
      const maxSize = Math.min(request.query.maxSize ?? config.displayMaxSize, config.displayMaxSize);

      const key = createHash('sha256').update(`${sliceKey(info, slice)}:${windowMin}:${windowMax}:${maxSize}:${RENDERER_VERSION}`).digest('hex');
      const etag = `"${key}"`;
      reply.header('ETag', etag).header('Cache-Control', 'private, max-age=86400');
      if (etagMatches(request.headers['if-none-match'], etag)) {
        return reply.code(304).send(undefined);
      }

      let png = await displayCache.get(key);
      if (!png) {
        png = await native.renderDisplay(await store.pixels(info, slice), info.width, info.height, info.bitDepth, windowMin, windowMax, maxSize);
        await displayCache.set(key, png);
      }
      return reply.type('image/png').send(png);
    },
  );

  app.get(
    '/images/:id/edges.png',
    {
      schema: {
        summary: 'Edge map',
        description:
          'An 8-bit PNG of the gradient magnitude after Gaussian smoothing (intensity units per pixel, on the original values). sobel: the magnitude mapped linearly from low (black) to high (white); canny: 255 on the thin edges found with the hysteresis thresholds low and high, 0 elsewhere. Reduced so the long side is at most maxSize (for canny, a reduced pixel is 255 when it covers any edge). Cached like display.png.',
        tags: ['images'],
        params: ImageIdParams,
        querystring: EdgeMapQuery,
        response: {
          200: Binary('image/png', 'PNG image'),
          304: Type.Unsafe<undefined>({ type: 'null', description: 'Not modified (no body)' }),
          400: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const info = await requireImage(request.params.id);
      const { method, sigma, low, high } = request.query;
      const slice = requireSlice(info, request.query.slice);
      const maxSize = Math.min(request.query.maxSize ?? config.displayMaxSize, config.displayMaxSize);

      const key = createHash('sha256')
        .update(`edges:${sliceKey(info, slice)}:${method}:${sigma}:${low}:${high}:${maxSize}:${EDGE_RENDERER_VERSION}`)
        .digest('hex');
      const etag = `"${key}"`;
      if (etagMatches(request.headers['if-none-match'], etag)) {
        return reply.header('ETag', etag).header('Cache-Control', 'private, max-age=86400').code(304).send(undefined);
      }

      let png = await displayCache.get(key);
      if (!png) {
        const pixels = await store.pixels(info, slice);
        png = await native.renderEdgeMap(pixels, info.width, info.height, info.bitDepth, method, sigma, low, high, maxSize).catch(nativeError);
        await displayCache.set(key, png);
      }
      return reply.header('ETag', etag).header('Cache-Control', 'private, max-age=86400').type('image/png').send(png);
    },
  );

  app.get(
    '/images/:id/gradient-stats',
    {
      schema: {
        summary: 'Gradient magnitude statistics',
        description: 'Percentiles (from at most about a million pixels on a regular grid) and the maximum of the gradient magnitude after smoothing, for choosing edge map limits.',
        tags: ['images'],
        params: ImageIdParams,
        querystring: GradientStatsQuery,
        response: { 200: GradientStatsResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const info = await requireImage(request.params.id);
      const pixels = await store.pixels(info, requireSlice(info, request.query.slice));
      reply.header('Cache-Control', 'private, max-age=86400');
      return native.gradientStatistics(pixels, info.width, info.height, info.bitDepth, request.query.sigma).catch(nativeError);
    },
  );

  app.get(
    '/images/:id/raw',
    {
      schema: {
        summary: 'Raw grayscale samples',
        description:
          'Row-major samples of one slice from the top-left pixel, no header; 16-bit samples are little-endian. Size and format are in the X-Image-Width, X-Image-Height, X-Image-Bit-Depth and X-Image-Byte-Order headers. Compressed with zstd or gzip when accepted. Only for images with transfer "raw" (409 otherwise).',
        tags: ['images'],
        params: ImageIdParams,
        querystring: SliceQuery,
        response: {
          200: Binary('application/octet-stream', 'Grayscale samples'),
          304: Type.Unsafe<undefined>({ type: 'null', description: 'Not modified (no body)' }),
          400: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const info = await requireImage(request.params.id);
      if (info.transfer !== 'raw') {
        throw new ApiError(
          409,
          'RawNotAvailable',
          `The image has ${info.width * info.height} pixels; raw data is only sent for images up to ${config.rawTransferMaxPixels} pixels. Use display.png and /pixel instead.`,
        );
      }

      const slice = requireSlice(info, request.query.slice);
      const encoding = negotiateEncoding(request.headers['accept-encoding']);
      const etag = `"${sliceKey(info, slice)}-${encoding}"`;
      reply
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('Vary', 'Accept-Encoding')
        .header(RAW_HEADERS.width, String(info.width))
        .header(RAW_HEADERS.height, String(info.height))
        .header(RAW_HEADERS.bitDepth, String(info.bitDepth))
        .header(RAW_HEADERS.byteOrder, 'little-endian');
      if (etagMatches(request.headers['if-none-match'], etag)) {
        return reply.code(304).send(undefined);
      }

      const body = await store.encodedPixels(info, encoding, slice);
      if (encoding !== 'identity') {
        reply.header('Content-Encoding', encoding);
      }
      return reply.type('application/octet-stream').send(body);
    },
  );

  app.get(
    '/images/:id/pixel',
    {
      schema: {
        summary: 'One grayscale value',
        description: 'Used for the hover readout of images that are too large for GET /raw.',
        tags: ['images'],
        params: ImageIdParams,
        querystring: PixelQuery,
        response: { 200: PixelResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const info = await requireImage(request.params.id);
      const { x, y } = request.query;
      const slice = requireSlice(info, request.query.slice);
      if (x >= info.width || y >= info.height) {
        throw new ApiError(400, 'BadRequest', `Pixel (${x}, ${y}) is outside the ${info.width}×${info.height} image`);
      }
      reply.header('Cache-Control', 'no-store');
      return { x, y, value: await store.pixelValue(info, x, y, slice) };
    },
  );

  app.get(
    '/images',
    {
      schema: {
        summary: 'List stored images',
        description: 'Used when opening a project to find its image by content (SHA-256 of the uploaded file).',
        tags: ['images'],
        querystring: ImagesQuery,
        response: { 200: ImageListResponse, 400: ErrorResponse },
      },
    },
    async (request) => {
      const images = await store.list();
      const { sha256 } = request.query;
      return {
        images: images
          .filter((info) => sha256 === undefined || info.sha256 === sha256)
          .map((info) => ({ ...info, transfer: info.width * info.height <= config.rawTransferMaxPixels ? ('raw' as const) : ('server' as const) })),
      };
    },
  );

  app.get(
    '/images/:id/original',
    {
      schema: {
        summary: 'The uploaded file',
        description: 'Used to embed the image in a project file.',
        tags: ['images'],
        params: ImageIdParams,
        response: {
          200: { description: 'Uploaded file', content: { 'application/octet-stream': { schema: Type.Unsafe<ReadStream>({ type: 'string', format: 'binary' }) } } },
          400: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const info = await requireImage(request.params.id);
      return reply
        .header('Content-Disposition', attachment(info.name))
        .header('Content-Length', String(info.sizeBytes))
        .type('application/octet-stream')
        .send(createReadStream(store.originalPath(info.imageId)));
    },
  );
};
