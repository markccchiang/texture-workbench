# Server deployment

This guide runs the Texture Workbench server for several users, as in phase 5 of `doc/ui-design-plan.md`. For personal use on your own computer, `npm start` (local mode) is enough; see `INSTALL.md`.

## Local mode and server mode

The server decides its mode from `GLCM_HOST`:

| | Local mode | Server mode |
| --- | --- | --- |
| Address | `127.0.0.1`, `::1` or `localhost` | any other address, e.g. `0.0.0.0` in a container |
| Access token | optional | **required**: the server refuses to start without `GLCM_API_TOKEN` |
| Data directory | `~/.glcm-texture-analysis` | `/data` |
| Largest upload | 200 MiB, 20 000 × 20 000 px | 100 MiB, 10 000 × 10 000 px |
| Rate limit | off | 600 requests per minute per token |
| Analysis queue | 100 000 jobs | 20 000 jobs (ROI × distance) |
| Pixel cache | 2 GiB | 1 GiB |
| Retention | keep everything | images and results older than 7 days are deleted |

Every default can be changed with the `GLCM_*` variables listed in `DEVELOPMENT.md`.

## Run with Docker

Create a token (at least 43 characters, e.g. 32 random bytes in base64) and start the container:

```bash
export GLCM_API_TOKEN="$(openssl rand -base64 32)"
docker compose up -d                 # uses compose.yaml: port 127.0.0.1:8080, volume glcm-data
docker compose logs -f glcm
```

Or without Compose:

```bash
docker build -t texture-workbench .
docker run -d --name glcm -p 127.0.0.1:8080:8080 -v glcm-data:/data -e GLCM_API_TOKEN texture-workbench
node scripts/smoke-test.mjs http://127.0.0.1:8080   # uses GLCM_API_TOKEN from the environment
```

The image is built in two stages from base images pinned by digest (Dependabot proposes updates). The first compiles `glcm_core`, the Node-API addon and the web app. The runtime stage is `node:24-bookworm-slim` with only the OpenCV runtime libraries, and runs as the unprivileged `node` user. It stores everything in the `/data` volume:
- `images/` holds uploads and decoded pixels;
- `results/` holds finished analyses, so they survive restarts (on `SIGTERM` the server finishes writing them before it exits);
- `cache/` holds rendered display images.

The image also carries the `glcm` command, so a container is enough to measure from a script, with no clone of the
repository:

```bash
docker exec -e GLCM_API_TOKEN glcm glcm measure sample:medical/ct-chest.png \
    --server http://127.0.0.1:8080 --token "$GLCM_API_TOKEN" --features Contrast,Entropy
docker exec glcm glcm --help
```

Always give the command `--server`, so that it goes through the running server. Without it the command would build a
second server on `/data`, which empties the `uploads/` and `volumes/` folders as it starts and would disturb an upload
or an import in progress; while the server runs it marks the folder with `server.lock` and the command refuses that
mode, naming the address to use instead. The MCP server (`glcm mcp`) is **not** in the image: its packages are removed
when the image is built, because an agent runs it next to itself from a clone of the repository and speaks to the server
with `--server`.

Back up the volume to keep images and results. A health check calls `GET /api/v1/health` on `GLCM_PORT`, so it keeps working when the port is changed.

Share the token with users over a secure channel. The web app asks for it once and keeps it in the browser tab's session storage, so closing the tab forgets it. To rotate the token, restart the container with a new `GLCM_API_TOKEN`; users are asked for the new token on their next request.

## HTTPS reverse proxy

The server speaks plain HTTP. Put a reverse proxy with HTTPS in front of it, and keep the container port bound to `127.0.0.1` (as `compose.yaml` does) so it is only reachable through the proxy. Set `GLCM_TRUST_PROXY=true` so that client addresses and rate limits use `X-Forwarded-For`.

Caddy (obtains certificates automatically):

```
glcm.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

With nginx, allow large uploads and do not buffer progress events:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 100m;
    proxy_buffering off;          # Server-Sent Events of /api/v1/analyses/{id}/events
    proxy_read_timeout 1h;
}
```

The web app is served from the same origin as the API, so no CORS configuration is needed. Set `GLCM_CORS_ORIGINS` (a comma-separated list such as `https://tools.example.org`) only when pages on other sites call the API.

## Security checklist

These are the requirements of `doc/ui-design-plan.md`, section 8.2, and how each is checked. File references:
- `security.test.ts` is `server/test/security.test.ts`;
- `auth.spec.ts` is `e2e/auth.spec.ts`;
- `smoke-test.mjs` is `scripts/smoke-test.mjs`, which also runs against the Docker image in CI.

| Requirement | Implementation | Checked by |
| --- | --- | --- |
| Local mode binds to loopback only and needs no token | `serverMode()` in `server/src/config.ts` | `security.test.ts` › configuration |
| Server mode refuses to start without a token of at least 32 random bytes | `validateConfig()`: no token, fewer than 43 characters or whitespace is an error; `main.ts` exits with status 1 | `security.test.ts` › configuration |
| Every `/api/v1` request except `/health` needs `Authorization: Bearer <token>`, compared in constant time, `401` without details | `registerAuthentication()` in `server/src/security.ts`: the API check uses the matched route (or the decoded path), so encoded spellings such as `/%61pi/v1/catalog` need the token too; SHA-256 digests compared with `timingSafeEqual`; `{error: "Unauthorized", message: "Authentication required"}` and `WWW-Authenticate: Bearer` | `security.test.ts` › authentication (including encoded paths); `smoke-test.mjs` |
| The web app asks for the token once and keeps it in `sessionStorage` | `web/src/api/auth.ts`, `TokenPrompt.tsx` | `auth.spec.ts`; `web/src/api/auth.test.ts` |
| Images and progress events carry the header (no `<img src>` or `EventSource`) | `apiFetch()` for display images, raw pixels, downloads and the fetch-based SSE reader; the upload request sets the header too | `auth.spec.ts` (open, measure) |
| HTTPS at a reverse proxy | This guide; `GLCM_TRUST_PROXY` | Deployment review |
| CORS allow-list, empty by default | `registerCors()` only when `GLCM_CORS_ORIGINS` is set; origins are validated | `security.test.ts` › CORS |
| Per-token rate limits | `registerRateLimit()`: key is the token's SHA-256 (or the client address), `429 TooManyRequests` with `Retry-After` | `security.test.ts` › limits |
| No client-supplied file paths; random ids; sanitized export names | Image and analysis ids are random UUIDs checked against patterns; samples are served only from their listing; `fileStem()`, `SanitizeFileName()` | `web.test.ts` (sample traversal), `exports.test.ts`, core `RoiImageExportTest.SanitizesFileNames` |
| Input validation: image size, `Ng` ≤ 256, distances ≤ 64, ≤ 10 000 vertices per ROI, ≤ 1 000 ROIs per request, every body schema-validated | TypeBox schemas in `packages/api`; `maxUploadBytes`; `maxImagePixels`, checked from the file header before decoding (`glcm::ReadImageSize`, so a small file declaring a huge image is refused without allocating memory); `glcm::ValidateSettings` | `security.test.ts` › limits; `analyses.test.ts`; `images.test.ts`; core `ImageHeaderTest`, `ImageLoaderTest` |
| Analyses cannot exhaust the server | `JobManager`: at most `GLCM_MAX_PENDING_JOBS` jobs queued or running (`422 TooManyJobs` for larger analyses, `503 ServerBusy` with `Retry-After` while full); analyses take turns, one job each; a feature map is split into bands of about a second of computing that count against the same limit, at most `GLCM_MAX_FEATURE_MAP_BANDS` per map, and cancelling it stops its running bands; pixel buffers are shared through a byte-limited cache (`GLCM_PIXEL_CACHE_BYTES`) | `analyses.test.ts` › job limits and fairness; `images.test.ts` › pixel cache |
| Uploaded images and results expire | `startRetention()` in `server/src/storage/retention.ts`, at startup and periodically | `security.test.ts` › storage |
| Storage under the data directory with random names | `ImageStore` (`images/`), `ResultStore` (`results/`), `DisplayCache` (`cache/`); exports are generated per request and not stored | `security.test.ts` › storage |
| The token is not logged | Fastify logger redacts `req.headers.authorization` | Code review (`server/src/app.ts`) |
