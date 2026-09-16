// How the command line reaches the API: in this process (no server, no port) or, through @glcm/client, over HTTP.

import { randomUUID } from 'node:crypto';
import { API_PATH_PREFIX, apiResponse, ApiError, httpClient, type ApiClient, type UploadFile } from '@glcm/client';
import { buildApp, type App } from '@glcm/server/app';
import { loadConfig, type ServerConfig } from '@glcm/server/config';
import { readServerLock } from '@glcm/server/lockFile';

// The transport, the operations and the error type come from the client package
export * from '@glcm/client';

/** multipart/form-data body with one file field, as @fastify/multipart reads it */
function multipartBody(file: UploadFile): { payload: Buffer; contentType: string } {
  const boundary = `----glcm${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replaceAll('"', '')}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
  );
  return { payload: Buffer.concat([head, Buffer.from(file.data), Buffer.from(`\r\n--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * The API in this process: the same routes the server runs, without a port. Refused while a server is using the same
 * data directory, because starting a second one there empties its `uploads/` and `volumes/` folders.
 */
export async function localClient(overrides: Partial<ServerConfig> = {}): Promise<ApiClient> {
  const config: ServerConfig = { ...loadConfig(), logLevel: 'silent', webDir: null, docsDir: null, apiToken: null, rateLimitPerMinute: 0, ...overrides };
  const running = await readServerLock(config.dataDir);
  if (running) {
    const host = running.host === '0.0.0.0' || running.host === '::' ? '127.0.0.1' : running.host;
    throw new ApiError(
      0,
      'DataDirectoryInUse',
      `A server (pid ${running.pid}) is using ${config.dataDir}. Send the command to it instead: --server http://${host}:${running.port} --token <token>`,
    );
  }
  const app: App = await buildApp(config, { logger: false });
  return {
    description: `this computer (${config.dataDir})`,
    async request(method, path, options = {}) {
      const upload = options.file ? multipartBody(options.file) : null;
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) {
          query.set(key, String(value));
        }
      }
      const result = await app.inject({
        method,
        url: `${API_PATH_PREFIX}${path}${query.toString() ? `?${query}` : ''}`,
        headers: {
          accept: options.accept ?? 'application/json',
          ...(upload ? { 'content-type': upload.contentType } : {}),
          ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        payload: upload ? upload.payload : options.json !== undefined ? JSON.stringify(options.json) : undefined,
      });
      return apiResponse(result.statusCode, String(result.headers['content-type'] ?? ''), new Uint8Array(result.rawPayload));
    },
    close: () => app.close(),
  };
}

export interface ConnectionOptions {
  /** Base URL of a running server; without it the API runs in this process */
  server?: string;
  token?: string;
  dataDir?: string;
}

export function createClient(options: ConnectionOptions): Promise<ApiClient> {
  if (options.server) {
    return Promise.resolve(httpClient(options.server, options.token ?? process.env.GLCM_API_TOKEN ?? null));
  }
  return localClient(options.dataDir ? { dataDir: options.dataDir } : {});
}
