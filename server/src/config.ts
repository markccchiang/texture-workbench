import os from 'node:os';
import path from 'node:path';

export type ServerMode = 'local' | 'server';

export interface ServerConfig {
  host: string;
  port: number;
  /** Uploaded images, results and caches (doc/ui-design-plan.md, section 8.2) */
  dataDir: string;
  maxUploadBytes: number;
  maxImagePixels: number;
  /** Pixels of all slices of a stack together (TIFF pages, DICOM frames and series, NIfTI volumes opened as stacks) */
  maxStackPixels: number;
  /** Files of one DICOM series upload */
  maxSeriesFiles: number;
  /** Voxel data of one NIfTI volume, uncompressed (checked from the header) */
  maxVolumeBytes: number;
  /** Images up to this many pixels are sent to the browser as raw data (GET /raw) */
  rawTransferMaxPixels: number;
  /** Largest long side of display.png */
  displayMaxSize: number;
  /** Disk space for cached display.png renderings */
  displayCacheBytes: number;
  /** Analysis jobs (ROI × distance) running at the same time */
  analysisConcurrency: number;
  /** Analysis jobs queued or running at once over all analyses; larger analyses are refused, others wait (503) */
  maxPendingJobs: number;
  /** Bands (about a second of computing each) of one feature map; larger maps are refused */
  maxFeatureMapBands: number;
  /** Memory for pixel buffers of recently used images, shared by ROI statistics, analyses and exports */
  pixelCacheBytes: number;
  logLevel: string;
  /** Built web app (web/dist); not served when missing */
  webDir: string | null;
  /** Sample images offered on the start screen; none when null */
  samplesDir: string | null;
  /** Built Sphinx documentation (doc/_build/html), served at /docs/ when present; none when null */
  docsDir: string | null;
  /** Bearer token required by /api/v1 (except /health); required in server mode */
  apiToken: string | null;
  /** Origins allowed to call the API from other sites (CORS); none by default */
  corsOrigins: string[];
  /** Requests per minute per token (or client address); 0 disables the limit */
  rateLimitPerMinute: number;
  /** Uploaded images and results older than this are deleted; 0 keeps them */
  retentionHours: number;
  /** Trust X-Forwarded-* headers from a reverse proxy (client addresses for rate limits and logs) */
  trustProxy: boolean;
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');

const MIB = 1024 * 1024;

/** Base64 of 32 random bytes, e.g. `openssl rand -base64 32` */
export const MIN_TOKEN_LENGTH = 43;

type Defaults = Omit<ServerConfig, 'dataDir' | 'webDir' | 'samplesDir' | 'docsDir'>;

/** Defaults of local mode (loopback address) */
export const DEFAULT_CONFIG: Defaults = {
  host: '127.0.0.1',
  port: 8080,
  maxUploadBytes: 200 * MIB,
  maxImagePixels: 20_000 * 20_000,
  maxStackPixels: 1_000_000_000,
  maxSeriesFiles: 10_000,
  maxVolumeBytes: 4096 * MIB,
  rawTransferMaxPixels: 4096 * 4096,
  displayMaxSize: 4096,
  displayCacheBytes: 512 * MIB,
  analysisConcurrency: Math.max(1, os.availableParallelism()),
  maxPendingJobs: 100_000,
  maxFeatureMapBands: 4096,
  pixelCacheBytes: 2048 * MIB,
  logLevel: 'info',
  apiToken: null,
  corsOrigins: [],
  rateLimitPerMinute: 0,
  retentionHours: 0,
  trustProxy: false,
};

/** Defaults that differ in server mode (any other address) */
export const SERVER_MODE_DEFAULTS: Partial<Defaults> = {
  maxUploadBytes: 100 * MIB,
  maxImagePixels: 10_000 * 10_000,
  maxStackPixels: 400_000_000,
  maxSeriesFiles: 2_000,
  maxVolumeBytes: 1024 * MIB,
  maxPendingJobs: 20_000,
  maxFeatureMapBands: 1024,
  pixelCacheBytes: 1024 * MIB,
  rateLimitPerMinute: 600,
  retentionHours: 7 * 24,
};

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function serverMode(config: Pick<ServerConfig, 'host'>): ServerMode {
  return isLoopbackHost(config.host) ? 'local' : 'server';
}

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const text = env[name];
  if (text === undefined || text === '') {
    return fallback;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}, got "${text}"`);
  }
  return value;
}

function booleanSetting(env: NodeJS.ProcessEnv, name: string): boolean {
  const text = (env[name] ?? '').toLowerCase();
  if (text === '' || text === 'false' || text === '0') {
    return false;
  }
  if (text === 'true' || text === '1') {
    return true;
  }
  throw new Error(`${name} must be true or false, got "${env[name]}"`);
}

/** Configuration from GLCM_* environment variables, falling back to the defaults of the mode */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.GLCM_HOST || DEFAULT_CONFIG.host;
  const mode = serverMode({ host });
  const defaults: Defaults = mode === 'server' ? { ...DEFAULT_CONFIG, ...SERVER_MODE_DEFAULTS } : DEFAULT_CONFIG;
  // The local folder keeps the project's former name, so images and results stored before the rename are still found
  const defaultDataDir = mode === 'server' ? '/data' : path.join(os.homedir(), '.glcm-texture-analysis');

  return {
    host,
    port: integerSetting(env, 'GLCM_PORT', defaults.port, 0),
    dataDir: path.resolve(env.GLCM_DATA_DIR || defaultDataDir),
    maxUploadBytes: integerSetting(env, 'GLCM_MAX_UPLOAD_BYTES', defaults.maxUploadBytes, 1),
    maxImagePixels: integerSetting(env, 'GLCM_MAX_IMAGE_PIXELS', defaults.maxImagePixels, 1),
    maxStackPixels: integerSetting(env, 'GLCM_MAX_STACK_PIXELS', defaults.maxStackPixels, 1),
    maxSeriesFiles: integerSetting(env, 'GLCM_MAX_SERIES_FILES', defaults.maxSeriesFiles, 1),
    maxVolumeBytes: integerSetting(env, 'GLCM_MAX_VOLUME_BYTES', defaults.maxVolumeBytes, 1),
    rawTransferMaxPixels: integerSetting(env, 'GLCM_RAW_TRANSFER_MAX_PIXELS', defaults.rawTransferMaxPixels, 0),
    displayMaxSize: integerSetting(env, 'GLCM_DISPLAY_MAX_SIZE', defaults.displayMaxSize, 1),
    displayCacheBytes: integerSetting(env, 'GLCM_DISPLAY_CACHE_BYTES', defaults.displayCacheBytes, 0),
    analysisConcurrency: integerSetting(env, 'GLCM_ANALYSIS_CONCURRENCY', defaults.analysisConcurrency, 1),
    maxPendingJobs: integerSetting(env, 'GLCM_MAX_PENDING_JOBS', defaults.maxPendingJobs, 1),
    maxFeatureMapBands: integerSetting(env, 'GLCM_MAX_FEATURE_MAP_BANDS', defaults.maxFeatureMapBands, 1),
    pixelCacheBytes: integerSetting(env, 'GLCM_PIXEL_CACHE_BYTES', defaults.pixelCacheBytes, 0),
    logLevel: env.GLCM_LOG_LEVEL || defaults.logLevel,
    webDir: path.resolve(env.GLCM_WEB_DIR || path.join(REPOSITORY_ROOT, 'web', 'dist')),
    samplesDir: path.resolve(env.GLCM_SAMPLES_DIR || path.join(REPOSITORY_ROOT, 'samples')),
    docsDir: path.resolve(env.GLCM_DOCS_DIR || path.join(REPOSITORY_ROOT, 'doc', '_build', 'html')),
    apiToken: env.GLCM_API_TOKEN || null,
    corsOrigins: (env.GLCM_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    rateLimitPerMinute: integerSetting(env, 'GLCM_RATE_LIMIT_PER_MINUTE', defaults.rateLimitPerMinute, 0),
    retentionHours: integerSetting(env, 'GLCM_RETENTION_HOURS', defaults.retentionHours, 0),
    trustProxy: booleanSetting(env, 'GLCM_TRUST_PROXY'),
  };
}

/** Refuses unsafe configurations (doc/ui-design-plan.md, section 8.2); throws an Error explaining the problem */
export function validateConfig(config: ServerConfig): void {
  const { apiToken } = config;
  if (apiToken !== null && (apiToken.length < MIN_TOKEN_LENGTH || /\s/.test(apiToken))) {
    throw new Error(
      `GLCM_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters without spaces, e.g. the output of "openssl rand -base64 32"`,
    );
  }
  if (serverMode(config) === 'server' && apiToken === null) {
    throw new Error(
      `Listening on ${config.host} is server mode, which requires GLCM_API_TOKEN (e.g. "openssl rand -base64 32"). Use GLCM_HOST=127.0.0.1 for local mode.`,
    );
  }
  for (const origin of config.corsOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`GLCM_CORS_ORIGINS contains "${origin}", which is not an origin such as https://glcm.example.org`);
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) {
      throw new Error(`GLCM_CORS_ORIGINS contains "${origin}", which is not an origin such as https://glcm.example.org`);
    }
  }
}
