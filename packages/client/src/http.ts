// The API over HTTP. Nothing here touches the file system or the native addon, and the bytes are plain Uint8Arrays, so
// this runs wherever `fetch` does — a command line, an agent server, or another program.

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface UploadFile {
  name: string;
  data: Uint8Array;
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
  body: Uint8Array;
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

export const API_PATH_PREFIX = '/api/v1';

export function apiResponse(status: number, contentType: string, body: Uint8Array): ApiResponse {
  const text = () => new TextDecoder().decode(body);
  return {
    status,
    contentType,
    body,
    text,
    json<T>() {
      try {
        return JSON.parse(text()) as T;
      } catch {
        throw new ApiError(status, 'InvalidResponse', `The answer was not JSON: ${text().slice(0, 200)}`);
      }
    },
  };
}

export function withQuery(path: string, query: RequestOptions['query']): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      parameters.set(key, String(value));
    }
  }
  const text = parameters.toString();
  return text ? `${path}?${text}` : path;
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
        result = await fetch(`${base}${API_PATH_PREFIX}${withQuery(path, options.query)}`, { method, headers, body });
      } catch (error) {
        throw new ApiError(0, 'NetworkError', `${base} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
      return apiResponse(result.status, result.headers.get('content-type') ?? '', new Uint8Array(await result.arrayBuffer()));
    },
    close: async () => undefined,
  };
}
