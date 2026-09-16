// Two ways to reach the API: in this process (no server, no port) or over HTTP against a running server.

import { randomUUID } from 'node:crypto';
import { buildApp, type App } from '@glcm/server/app';
import { loadConfig, type ServerConfig } from '@glcm/server/config';
import { readServerLock } from '@glcm/server/lockFile';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface UploadFile {
  name: string;
  data: Buffer;
  contentType: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body */
  json?: unknown;
  /** multipart/form-data upload, as the image and volume routes want it */
  file?: UploadFile;
  accept?: string;
}

export interface ApiResponse {
  status: number;
  contentType: string;
  body: Buffer;
  json<T = unknown>(): T;
  text(): string;
}

export interface ApiClient {
  /** Where the requests go, for messages */
  readonly description: string;
  request(method: HttpMethod, path: string, options?: RequestOptions): Promise<ApiResponse>;
  close(): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const PREFIX = '/api/v1';

function response(status: number, contentType: string, body: Buffer): ApiResponse {
  return {
    status,
    contentType,
    body,
    text: () => body.toString('utf8'),
    json<T>() {
      try {
        return JSON.parse(body.toString('utf8')) as T;
      } catch {
        throw new ApiError(status, 'InvalidResponse', `The answer was not JSON: ${body.toString('utf8').slice(0, 200)}`);
      }
    },
  };
}

function withQuery(path: string, query: RequestOptions['query']): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      parameters.set(key, String(value));
    }
  }
  const text = parameters.toString();
  return text ? `${path}?${text}` : path;
}

/** multipart/form-data body with one file field, as @fastify/multipart reads it */
function multipartBody(file: UploadFile): { payload: Buffer; contentType: string } {
  const boundary = `----glcm${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replaceAll('"', '')}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
  );
  return { payload: Buffer.concat([head, file.data, Buffer.from(`\r\n--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Fails with the server's own error message when a request was refused */
export function requireOk(result: ApiResponse, what: string): ApiResponse {
  // The server answers "Authentication required", which does not say what to do about it here
  if (result.status === 401) {
    throw new ApiError(401, 'Unauthorized', `${what}: the server needs an access token. Pass --token, or set GLCM_API_TOKEN.`);
  }
  if (result.status >= 400) {
    let code = 'HttpError';
    let message = result.text().slice(0, 300);
    try {
      const body = result.json<{ error?: string; message?: string }>();
      code = body.error ?? code;
      message = body.message ?? message;
    } catch {
      // Not a JSON error body: the text above is used
    }
    throw new ApiError(result.status, code, `${what}: ${message}`);
  }
  return result;
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
      const result = await app.inject({
        method,
        url: PREFIX + withQuery(path, options.query),
        headers: {
          accept: options.accept ?? 'application/json',
          ...(upload ? { 'content-type': upload.contentType } : {}),
          ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        payload: upload ? upload.payload : options.json !== undefined ? JSON.stringify(options.json) : undefined,
      });
      return response(result.statusCode, String(result.headers['content-type'] ?? ''), result.rawPayload);
    },
    close: () => app.close(),
  };
}

/** A running server, local or remote */
export function httpClient(baseUrl: string, token: string | null): ApiClient {
  const base = baseUrl.replace(/\/$/, '');
  return {
    description: base,
    async request(method, path, options = {}) {
      const headers: Record<string, string> = { accept: options.accept ?? 'application/json' };
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }
      let body: BodyInit | undefined;
      if (options.file) {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(options.file.data)], { type: options.file.contentType }), options.file.name);
        body = form;
      } else if (options.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(options.json);
      }
      let result: Response;
      try {
        result = await fetch(`${base}${PREFIX}${withQuery(path, options.query)}`, { method, headers, body });
      } catch (error) {
        throw new ApiError(0, 'NetworkError', `${base} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
      return response(result.status, result.headers.get('content-type') ?? '', Buffer.from(await result.arrayBuffer()));
    },
    close: async () => undefined,
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
