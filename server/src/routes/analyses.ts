import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  AnalysisIdParams,
  AnalysisInfo,
  AnalysisRequest,
  AnalysisResults,
  BrushRoiRequest,
  CombineRoisRequest,
  GrowRoiRequest,
  LivewireRequest,
  LivewireResponse,
  RoiShapeResult,
  ErrorResponse,
  ImageIdParams,
  MAX_LIVEWIRE_SPAN,
  RoiStatsRequest,
  RoiStatsResponse,
  ThresholdRoisRequest,
  ThresholdRoisResponse,
  WandRoiRequest,
  WandRoiResponse,
  type AnalysisEvent,
  type ImageInfo,
} from '@glcm/api';
import * as native from '@glcm/native';
import { Type } from 'typebox';
import { isFinished, JobLimitError, type AnalysisState, type JobManager } from '../analysis/JobManager.js';
import { ApiError } from '../errors.js';
import { attachment, fileStem } from '../files.js';
import type { ImageStore } from '../storage/ImageStore.js';
import type { ResultStore } from '../storage/ResultStore.js';
import { formatResultsDocument } from './exports.js';

export interface AnalysisRoutesOptions {
  store: ImageStore;
  jobs: JobManager;
  results: ResultStore;
  /** Interval of SSE keep-alive comments */
  heartbeatMs?: number;
}

const NoBody = (description: string) => Type.Unsafe<undefined>({ type: 'null', description });

/** Retry-After of 503 ServerBusy, when the job queue is full */
const BUSY_RETRY_SECONDS = 30;

function nativeError(error: unknown): never {
  if ((error as { code?: string }).code === 'INVALID_ARGUMENT') {
    throw new ApiError(400, 'BadRequest', (error as Error).message);
  }
  throw error;
}

function writeEvent(response: ServerResponse, { event, data }: AnalysisEvent): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const analysisRoutes: FastifyPluginAsyncTypebox<AnalysisRoutesOptions> = async (app, { store, jobs, results, heartbeatMs = 15000 }) => {
  async function requireImage(imageId: string): Promise<ImageInfo> {
    const info = await store.info(imageId);
    if (!info) {
      throw new ApiError(404, 'NotFound', `Image ${imageId} was not found`);
    }
    return info;
  }

  /** A running or recently finished analysis from memory, or a finished one stored on disk */
  async function requireAnalysis(analysisId: string): Promise<AnalysisState> {
    const state = jobs.get(analysisId);
    if (state) {
      return state;
    }
    const stored = await results.load(analysisId);
    if (!stored) {
      throw new ApiError(404, 'NotFound', `Analysis ${analysisId} was not found`);
    }
    return { info: stored.info, results: stored.results.results, events: new EventEmitter() };
  }

  app.post(
    '/images/:id/roi-stats',
    {
      schema: {
        summary: 'Pixel count and intensity statistics of ROIs',
        description: 'Masks follow the pixel-centre rule of glcm::RasterizeMask, so the counts equal those used by analyses.',
        tags: ['rois'],
        params: ImageIdParams,
        body: RoiStatsRequest,
        response: { 200: RoiStatsResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const info = await requireImage(request.params.id);
      const { rois } = request.body;
      if (rois.length === 0) {
        return { stats: [] };
      }
      const pixels = await store.pixels(info.imageId);
      const stats = await native
        .roiStats(pixels, info.width, info.height, info.bitDepth, JSON.stringify(rois.map(({ id, shape }) => ({ id, shape }))))
        .catch(nativeError);
      return { stats: stats.map((statistics, i) => ({ roiId: rois[i].id, ...statistics })) };
    },
  );

  app.post(
    '/images/:id/threshold-rois',
    {
      schema: {
        summary: 'ROIs from the pixels in an intensity range',
        description:
          'Each 8-connected part of the pixels with min ≤ value ≤ max becomes a polygon along the pixel edges with its holes filled (a part inside another part\'s hole belongs to it). Regions with fewer than minPixels pixels are left out; the largest maxRegions are returned, largest first, and total counts all of them.',
        tags: ['rois'],
        params: ImageIdParams,
        body: ThresholdRoisRequest,
        response: { 200: ThresholdRoisResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const info = await requireImage(request.params.id);
      const { min, max, minPixels, maxRegions } = request.body;
      const pixels = await store.pixels(info.imageId);
      return native.selectThresholdRegions(pixels, info.width, info.height, info.bitDepth, min, max, minPixels, maxRegions).catch(nativeError);
    },
  );

  app.post(
    '/images/:id/wand-roi',
    {
      schema: {
        summary: 'ROI of the connected region around a pixel',
        description:
          'The 8-connected pixels around (x, y) whose values differ by at most tolerance from its value, outlined like threshold-rois with holes filled; region is null when (x, y) lies outside the image.',
        tags: ['rois'],
        params: ImageIdParams,
        body: WandRoiRequest,
        response: { 200: WandRoiResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const info = await requireImage(request.params.id);
      const { x, y, tolerance } = request.body;
      const pixels = await store.pixels(info.imageId);
      return { region: await native.selectWandRegion(pixels, info.width, info.height, info.bitDepth, x, y, tolerance).catch(nativeError) };
    },
  );

  /** ROI objects as the addon reads them */
  const roisJson = (shapes: unknown[]) => JSON.stringify(shapes.map((shape, i) => ({ id: `shape-${i}`, name: `shape-${i}`, shape })));
  const shapeResult = (result: native.NativeRoiShapeResult) => ({
    shape: result.pixelCount > 0 ? { type: 'polygon' as const, points: result.points } : null,
    pixelCount: result.pixelCount,
    boundingBox: result.boundingBox,
  });

  app.post(
    '/images/:id/combine-rois',
    {
      schema: {
        summary: 'Unite, subtract, intersect or xor ROIs',
        description:
          'Rasterizes the shapes on the image grid (pixel-centre rule) and returns the union, the first shape without the others, the pixels all shapes cover, or the pixels an odd number of shapes cover, as one polygon along the pixel edges; separate parts and holes are joined by zero-width cuts, so the polygon covers exactly the resulting pixels.',
        tags: ['rois'],
        params: ImageIdParams,
        body: CombineRoisRequest,
        response: { 200: RoiShapeResult, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const info = await requireImage(request.params.id);
      const { operation, shapes } = request.body;
      return shapeResult(await native.combineRois(roisJson(shapes), operation, info.width, info.height).catch(nativeError));
    },
  );

  app.post(
    '/images/:id/brush-roi',
    {
      schema: {
        summary: 'Paint or erase a brush stroke',
        description:
          'The pixels whose centres lie within radius of the path, added to the shape (or a new shape when it is null), or removed from it with erase. The result is outlined like combine-rois; shape is null when no pixel is left.',
        tags: ['rois'],
        params: ImageIdParams,
        body: BrushRoiRequest,
        response: { 200: RoiShapeResult, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const info = await requireImage(request.params.id);
      const { shape, path, radius, erase } = request.body;
      const flat = Float64Array.from(path.flat());
      return shapeResult(await native.brushRoi(roisJson(shape ? [shape] : []), flat, radius, erase, info.width, info.height).catch(nativeError));
    },
  );

  app.post(
    '/images/:id/grow-roi',
    {
      schema: {
        summary: 'Enlarge or shrink an ROI, or make a band around it',
        description:
          'Distances are measured between pixel centres, in pixels, or in millimetres with pixelSpacing (non-square pixels are exact). enlarge: the image pixels within the distance of a pixel of the shape; shrink: the pixels of the shape farther than the distance from every pixel outside it, pixels beyond the image counting as outside; band: the pixels enlarge adds. The result is outlined like combine-rois; shape is null when no pixel is left.',
        tags: ['rois'],
        params: ImageIdParams,
        body: GrowRoiRequest,
        response: { 200: RoiShapeResult, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const info = await requireImage(request.params.id);
      const { shape, operation, distance, pixelSpacing } = request.body;
      const spacing = pixelSpacing ?? { x: 1, y: 1 };
      return shapeResult(await native.growRoi(roisJson([shape]), operation, distance, spacing.x, spacing.y, info.width, info.height).catch(nativeError));
    },
  );

  app.post(
    '/images/:id/livewire',
    {
      schema: {
        summary: 'Livewire path between two pixels',
        description: `The cheapest 8-connected path from \`from\` to \`to\` where strong edges (gradient magnitude after Gaussian smoothing) are cheap, searched in a box that extends 32 pixels beyond the two points. The points must lie inside the image and at most ${MAX_LIVEWIRE_SPAN} pixels apart along each axis.`,
        tags: ['rois'],
        params: ImageIdParams,
        body: LivewireRequest,
        response: { 200: LivewireResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const info = await requireImage(request.params.id);
      const { from, to, sigma } = request.body;
      const pixels = await store.pixels(info.imageId);
      return { points: await native.livewirePath(pixels, info.width, info.height, info.bitDepth, from.x, from.y, to.x, to.y, sigma).catch(nativeError) };
    },
  );

  app.post(
    '/analyses',
    {
      schema: {
        summary: 'Start an analysis',
        description:
          'Measures every ROI at every distance. Progress and results are streamed by GET /analyses/{id}/events. An analysis with more ROI × distance jobs than the server allows is refused (422 TooManyJobs); while the queue is full, new analyses get 503 ServerBusy with Retry-After.',
        tags: ['analyses'],
        body: AnalysisRequest,
        response: { 202: AnalysisInfo, 400: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { imageId, rois, settings } = request.body;
      const image = await requireImage(imageId);
      try {
        native.validateAnalysis(JSON.stringify(rois), JSON.stringify(settings));
      } catch (error) {
        nativeError(error);
      }
      const pixels = await store.pixels(imageId);
      try {
        return reply.code(202).send(jobs.start(request.body, image, pixels).info);
      } catch (error) {
        if (!(error instanceof JobLimitError)) {
          throw error;
        }
        if (error.reason === 'tooLarge') {
          throw new ApiError(422, 'TooManyJobs', `The analysis has ${error.jobs} jobs (ROIs × distances), more than the limit of ${error.limit}`);
        }
        reply.header('Retry-After', String(BUSY_RETRY_SECONDS));
        throw new ApiError(503, 'ServerBusy', `The server is busy with ${error.pending} analysis jobs; try again later`);
      }
    },
  );

  app.get(
    '/analyses/:id',
    {
      schema: {
        summary: 'Analysis status',
        tags: ['analyses'],
        params: AnalysisIdParams,
        response: { 200: AnalysisInfo, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => (await requireAnalysis(request.params.id)).info,
  );

  app.delete(
    '/analyses/:id',
    {
      schema: {
        summary: 'Cancel an analysis',
        description: 'Queued jobs are dropped; running jobs finish and their results are kept. Finished analyses are not changed.',
        tags: ['analyses'],
        params: AnalysisIdParams,
        response: { 204: NoBody('Cancelled (no body)'), 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      if (!jobs.cancel(request.params.id)) {
        // A finished analysis stored on disk cannot be cancelled any more
        await requireAnalysis(request.params.id);
      }
      return reply.code(204).send(undefined);
    },
  );

  app.get(
    '/analyses/:id/results',
    {
      schema: {
        summary: 'Results of finished jobs',
        tags: ['analyses'],
        params: AnalysisIdParams,
        response: { 200: AnalysisResults, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => jobs.results(await requireAnalysis(request.params.id)),
  );

  for (const format of ['csv', 'json'] as const) {
    app.get(
      `/analyses/:id/results.${format}`,
      {
        schema: {
          summary: `Results of finished jobs as a ${format.toUpperCase()} file`,
          description: 'Written by glcm_core; the same content as POST /exports/results for this analysis.',
          tags: ['analyses'],
          params: AnalysisIdParams,
          response: {
            200: {
              description: `${format.toUpperCase()} file`,
              content: { [format === 'csv' ? 'text/csv' : 'application/json']: { schema: Type.Unsafe<Buffer>({ type: 'string', format: 'binary' }) } },
            },
            400: ErrorResponse,
            404: ErrorResponse,
          },
        },
      },
      async (request, reply) => {
        const { timestamp, image, settings, results: measurements } = jobs.results(await requireAnalysis(request.params.id));
        const document = {
          timestamp,
          image: {
            name: image.name,
            sha256: image.sha256,
            ...(image.pixelSpacing ? { pixelSpacing: image.pixelSpacing } : {}),
            ...(image.valueConversion ? { valueConversion: image.valueConversion } : {}),
          },
          settings,
          results: measurements,
        };
        const text = formatResultsDocument(document, format);
        return reply
          .header('Content-Disposition', attachment(`${fileStem(image.name)}-results.${format}`))
          .type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
          .send(Buffer.from(text));
      },
    );
  }

  app.get(
    '/analyses/:id/events',
    {
      schema: {
        summary: 'Progress as Server-Sent Events',
        description:
          'Events: "result" {index, result} for every finished job (earlier ones are replayed on connect), "progress" {completed, total}, and a final "finished" {status, completed, total, error}, after which the stream ends.',
        tags: ['analyses'],
        params: AnalysisIdParams,
        response: {
          200: { description: 'Event stream', content: { 'text/event-stream': { schema: Type.Unsafe<string>({ type: 'string' }) } } },
          400: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const state = await requireAnalysis(request.params.id);
      const response = reply.raw;
      reply.hijack();
      response.writeHead(200, {
        // Hijacked responses skip Fastify's hooks, so headers set by plugins (e.g. CORS) are copied here
        ...(reply.getHeaders() as Record<string, string>),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      state.results.forEach((result, index) => {
        if (result) {
          writeEvent(response, { event: 'result', data: { index, result } });
        }
      });
      const { info } = state;
      writeEvent(response, { event: 'progress', data: { completed: info.completed, total: info.total } });
      if (isFinished(info.status)) {
        writeEvent(response, { event: 'finished', data: { status: info.status, completed: info.completed, total: info.total, error: info.error } });
        response.end();
        return;
      }

      const onEvent = (event: AnalysisEvent) => {
        writeEvent(response, event);
        if (event.event === 'finished') {
          cleanup();
          response.end();
        }
      };
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), heartbeatMs);
      const cleanup = () => {
        clearInterval(heartbeat);
        state.events.off('event', onEvent);
      };
      state.events.on('event', onEvent);
      request.raw.on('close', cleanup);
    },
  );
};
