import path from 'node:path';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { API_PREFIX } from '@glcm/api';
import * as native from '@glcm/native';
import Fastify from 'fastify';
import { FeatureMapManager } from './analysis/FeatureMapManager.js';
import { JobManager } from './analysis/JobManager.js';
import { Scheduler } from './analysis/Scheduler.js';
import type { ServerConfig } from './config.js';
import { ApiError } from './errors.js';
import { analysisRoutes } from './routes/analyses.js';
import { catalogRoutes } from './routes/catalog.js';
import { exportRoutes } from './routes/exports.js';
import { featureMapRoutes } from './routes/featureMaps.js';
import { healthRoutes } from './routes/health.js';
import { colourRoutes } from './routes/colour.js';
import { imageRoutes } from './routes/images.js';
import { sampleRoutes } from './routes/samples.js';
import { volumeRoutes } from './routes/volumes.js';
import { registerAuthentication, registerCors, registerRateLimit } from './security.js';
import { DisplayCache } from './storage/DisplayCache.js';
import { ImageStore } from './storage/ImageStore.js';
import { ResultStore } from './storage/ResultStore.js';
import { startRetention } from './storage/retention.js';
import { VolumeStore } from './storage/VolumeStore.js';
import { hasDocs, hasWebApp, registerDocs, registerWebApp, sendWebApp, wantsWebApp } from './web.js';

export interface BuildAppOptions {
  /** false disables request logging (tests, OpenAPI generation) */
  logger?: boolean;
  /** Start the periodic retention cleanup when config.retentionHours > 0 (the server entry point does) */
  retention?: boolean;
}

/** Finished analyses kept in memory; all of them are also stored on disk */
const RETAINED_ANALYSES = 100;
/** Finished feature maps kept in memory (up to 2048 × 2048 32-bit values each); maps are not stored on disk */
const RETAINED_FEATURE_MAPS = 8;

export async function buildApp(config: ServerConfig, options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel, redact: ['req.headers.authorization'] },
    // Analysis requests carry ROI geometry (up to 1000 ROIs × 10 000 vertices); images arrive as multipart uploads
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: config.trustProxy,
  }).withTypeProvider<TypeBoxTypeProvider>();

  const store = new ImageStore(config.dataDir, config.pixelCacheBytes);
  await store.init();
  const volumes = new VolumeStore(config.dataDir);
  await volumes.init();
  const results = new ResultStore(config.dataDir);
  await results.init();
  const displayCache = new DisplayCache(path.join(config.dataDir, 'cache', 'display'), config.displayCacheBytes);
  await displayCache.init();
  // Analyses and feature maps share the worker limit and the pending task limit
  const scheduler = new Scheduler(config.analysisConcurrency);
  const jobs: JobManager = new JobManager({
    concurrency: config.analysisConcurrency,
    scheduler,
    maxPendingJobs: config.maxPendingJobs,
    retainFinished: RETAINED_ANALYSES,
    onFinished: (state) => results.save({ info: state.info, results: jobs.results(state) }),
  });
  const maps = new FeatureMapManager({
    scheduler,
    maxPendingJobs: config.maxPendingJobs,
    maxBands: config.maxFeatureMapBands,
    retainFinished: RETAINED_FEATURE_MAPS,
  });
  // Results are written just after an analysis finishes; closing waits for the writes, so none are lost on shutdown
  app.addHook('onClose', async () => jobs.flush());

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Texture Workbench API',
        description: 'HTTP API of the Texture Workbench server (doc/ui-design-plan.md, section 8.5).',
        version: native.coreVersion(),
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'GLCM_API_TOKEN; required when the server sets one' } },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'system', description: 'Health and feature catalog' },
        { name: 'images', description: 'Upload, display and pixel data' },
        { name: 'volumes', description: 'NIfTI volumes: previews, and slices or stacks opened as images' },
        { name: 'rois', description: 'ROI pixel counts and statistics' },
        { name: 'analyses', description: 'Texture measurements' },
        { name: 'featureMaps', description: 'Texture features computed in a sliding window over the whole image' },
        { name: 'exports', description: 'Results files and ROI images' },
        { name: 'samples', description: 'Sample images for the start screen' },
      ],
    },
  });

  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10, parts: 11 },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const fastifyError = error as { validation?: unknown; code?: string; statusCode?: number; message: string };
    if (fastifyError.validation) {
      return reply.code(400).send({ error: 'BadRequest', message: fastifyError.message });
    }
    if (fastifyError.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: 'PayloadTooLarge', message: `The file is larger than the limit of ${config.maxUploadBytes} bytes` });
    }
    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({ error: fastifyError.code ?? 'BadRequest', message: fastifyError.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'InternalError', message: 'Internal server error' });
  });

  if (config.corsOrigins.length > 0) {
    await registerCors(app, config.corsOrigins);
  }
  if (config.rateLimitPerMinute > 0) {
    await registerRateLimit(app, config);
  }
  if (config.apiToken) {
    registerAuthentication(app, config.apiToken);
  }

  const serveWebApp = hasWebApp(config.webDir);
  if (serveWebApp) {
    await registerWebApp(app, config.webDir!);
  }
  if (hasDocs(config.docsDir)) {
    await registerDocs(app, config.docsDir);
  }

  app.setNotFoundHandler((request, reply) => {
    if (serveWebApp && wantsWebApp(request)) {
      return sendWebApp(reply);
    }
    return reply.code(404).send({ error: 'NotFound', message: `Route ${request.method} ${request.url} was not found` });
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { config });
      await api.register(catalogRoutes, { config });
      await api.register(imageRoutes, { config, store, displayCache });
      await api.register(colourRoutes, { config, store });
      await api.register(analysisRoutes, { store, jobs, results });
      await api.register(featureMapRoutes, { store, maps });
      await api.register(exportRoutes, { store });
      await api.register(volumeRoutes, { config, store, volumes });
      await api.register(sampleRoutes, { samplesDir: config.samplesDir });
    },
    { prefix: API_PREFIX },
  );

  if (options.retention && config.retentionHours > 0) {
    const stop = startRetention({ images: store, volumes, results, jobs }, config.retentionHours * 60 * 60_000, app.log);
    app.addHook('onClose', async () => stop());
  }

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
