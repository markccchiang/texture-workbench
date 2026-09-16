import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse, FeatureMapIdParams, FeatureMapInfo, FeatureMapRequest } from '@glcm/api';
import * as native from '@glcm/native';
import { Type } from 'typebox';
import type { FeatureMapManager, FeatureMapState } from '../analysis/FeatureMapManager.js';
import { JobLimitError } from '../analysis/JobManager.js';
import { ApiError } from '../errors.js';
import { requireSlice } from '../imageInfo.js';
import type { ImageStore } from '../storage/ImageStore.js';

export interface FeatureMapRoutesOptions {
  store: ImageStore;
  maps: FeatureMapManager;
}

const NoBody = (description: string) => Type.Unsafe<undefined>({ type: 'null', description });

/** Retry-After of 503 ServerBusy, when the task queue is full */
const BUSY_RETRY_SECONDS = 30;

export const featureMapRoutes: FastifyPluginAsyncTypebox<FeatureMapRoutesOptions> = async (app, { store, maps }) => {
  function requireMap(featureMapId: string): FeatureMapState {
    const state = maps.get(featureMapId);
    if (!state) {
      throw new ApiError(404, 'NotFound', `Feature map ${featureMapId} was not found`);
    }
    return state;
  }

  app.post(
    '/feature-maps',
    {
      schema: {
        summary: 'Start a feature map',
        description:
          'Computes a co-occurrence feature in a window around every point of a grid over the whole image, in bands of rows of about equal computing work that share the worker limit with analyses. A map with more bands than GLCM_MAX_FEATURE_MAP_BANDS (or the pending task limit) is refused with 422 TooManyJobs. Poll GET /feature-maps/{id} until the status is final, then fetch the values. Maps are kept in memory only, and the oldest finished maps are forgotten.',
        tags: ['featureMaps'],
        body: FeatureMapRequest,
        response: { 202: FeatureMapInfo, 400: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { imageId, settings } = request.body;
      const image = await store.info(imageId);
      if (!image) {
        throw new ApiError(404, 'NotFound', `Image ${imageId} was not found`);
      }
      try {
        native.featureMapGrid(JSON.stringify(settings), image.width, image.height);
      } catch (error) {
        if ((error as { code?: string }).code === 'INVALID_ARGUMENT') {
          throw new ApiError(400, 'BadRequest', (error as Error).message);
        }
        throw error;
      }
      const slice = requireSlice(image, request.body.slice);
      const pixels = await store.pixels(image, slice);
      try {
        return reply.code(202).send(maps.start(settings, image, pixels, slice).info);
      } catch (error) {
        if (!(error instanceof JobLimitError)) {
          throw error;
        }
        if (error.reason === 'tooLarge') {
          throw new ApiError(
            422,
            'TooManyJobs',
            `The feature map needs ${error.jobs} parts of about a second of computing, more than the limit of ${error.limit}; use a larger step, a smaller window or fewer gray levels`,
          );
        }
        reply.header('Retry-After', String(BUSY_RETRY_SECONDS));
        throw new ApiError(503, 'ServerBusy', `The server is busy with ${error.pending} tasks; try again later`);
      }
    },
  );

  app.get(
    '/feature-maps/:id',
    {
      schema: {
        summary: 'Feature map status',
        tags: ['featureMaps'],
        params: FeatureMapIdParams,
        response: { 200: FeatureMapInfo, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => requireMap(request.params.id).info,
  );

  app.get(
    '/feature-maps/:id/values',
    {
      schema: {
        summary: 'Values of a completed feature map',
        description:
          'rows × columns little-endian 32-bit floats, row-major; NaN where a window has no pixel pairs in a selected direction. Grid point (column, row) stands for the image pixels [column × step, (column + 1) × step) × [row × step, (row + 1) × step). 409 NotReady until the map has completed.',
        tags: ['featureMaps'],
        params: FeatureMapIdParams,
        response: {
          200: {
            description: 'Float32 values',
            content: { 'application/octet-stream': { schema: Type.Unsafe<Buffer>({ type: 'string', format: 'binary' }) } },
          },
          400: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const { info, values } = requireMap(request.params.id);
      if (info.status !== 'completed') {
        throw new ApiError(409, 'NotReady', `Feature map ${info.featureMapId} is ${info.status}`);
      }
      return reply
        .type('application/octet-stream')
        .header('Cache-Control', 'no-store')
        .send(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
    },
  );

  app.delete(
    '/feature-maps/:id',
    {
      schema: {
        summary: 'Cancel or forget a feature map',
        description: 'A queued or running map is cancelled: queued bands are dropped and running bands stop after their current point. A finished map is forgotten.',
        tags: ['featureMaps'],
        params: FeatureMapIdParams,
        response: { 204: NoBody('Cancelled or forgotten (no body)'), 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      if (!maps.cancel(request.params.id)) {
        throw new ApiError(404, 'NotFound', `Feature map ${request.params.id} was not found`);
      }
      return reply.code(204).send(undefined);
    },
  );
};
