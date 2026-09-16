# Developing Texture Workbench

This file covers developing, testing, configuring and deploying Texture Workbench. To install the requirements and build it, see [INSTALL.md](INSTALL.md); for what the application does, see the [README](README.md). The Developer guide of the documentation (`doc/developer/`) describes the architecture, the APIs and the technologies in more detail.

## Architecture

The application has three parts:
- a C++ library (`core/`);
- a Node.js server that uses the library through a Node-API addon;
- a TypeScript web app (see [Web application](#web-application)).

<p align="center">
  <img src="doc/developer/images/architecture-overview.svg" alt="Architecture: the web app in the browser calls the API server over HTTP (JSON, pixels, PNG, Server-Sent Events); the server calls the Node-API addon, which calls the glcm_core C++ library, and stores images, results and caches in the data directory; shared TypeBox schemas provide request validation, TypeScript types and the OpenAPI document." width="900">
</p>

## Requirements and build

The requirements, the build of the C++ library, the addon and the web app, and the documentation build are described in [INSTALL.md](INSTALL.md).

## Tests

```bash
ctest --test-dir build
./build/glcm-tests --gtest_filter='TextureAnalysisTest.ConstantImage'   # a single test
```

The tests (`core/tests/`) check the features against Haralick's worked example, against a simple, independent GLCM implementation, and against reference values from PyRadiomics and scikit-image. They also cover ROI masks and ROI operations, image loading, quantization, display rendering, the analysis pipeline, feature maps and the exporters.

The JavaScript tests are described under [Web application](#web-application).

## Using the C++ library

`glcm::TextureAnalysis` and the other analysis modules compute these features:

| Group | Features |
| --- | --- |
| First-order statistics | Mean, STD, Minimum, Maximum, Range, Median, 10th/90th Percentile, Interquartile Range, (Robust) Mean Absolute Deviation, Root Mean Squared, Energy, Variance, Skewness, Kurtosis, Entropy, Uniformity |
| Run length (GLRLM) | Short/Long Run Emphasis, Gray Level and Run Length Non-Uniformity (and normalized), Run Percentage, Gray Level Variance, Run Variance, Run Entropy, Low/High Gray Level Run Emphasis, Short/Long Run Low/High Gray Level Emphasis |
| Size zone (GLSZM) | Small/Large Area Emphasis, Gray Level and Size Zone Non-Uniformity (and normalized), Zone Percentage, Gray Level Variance, Zone Variance, Zone Entropy, Low/High Gray Level Zone Emphasis, Small/Large Area Low/High Gray Level Emphasis |
| Gray tone difference (NGTDM) | Coarseness, Contrast, Busyness, Complexity, Strength |
| Local binary patterns (LBP) | Fractions of the uniform patterns 0–8 and of non-uniform patterns, LBP Entropy, LBP Energy (rotation-invariant uniform LBP with 8 samples, radius = distance) |
| Haralick | Energy (Angular Second Moment), Contrast, Correlation (I, II, III), Sum of Squares (in i, j, both), Homogeneity I, Homogeneity II (Inverse Difference Moment), Sum Average, Sum Variance, Sum Entropy, Entropy, Difference Variance, Difference Entropy, Information Measures of Correlation I and II, Maximal Correlation Coefficient |
| Others | Auto Correlation, Cluster Shade, Cluster Prominence, Dissimilarity, Maximum Probability, Inverse Difference Normalized, Inverse Difference Moment Normalized |

"Another way" variants of Contrast and Correlation compute the same value with a different formula and are useful as cross-checks.

Using the library directly (include paths are relative to `core/`):

```cpp
#include "imaging/ImageLoader.hpp"
#include "io/ResultsCsv.hpp"
#include "pipeline/AnalysisRunner.hpp"

glcm::LoadedImage image = glcm::LoadImageFile("samples/textures/camera.png");

glcm::AnalysisSettings settings = glcm::DefaultSettings(image.info.bit_depth); // Haralick F1–F14, Ng = 32
settings.distances = {1, 2};

glcm::Roi roi;
roi.name = "ROI 1";
roi.shape = glcm::EllipseRoi{256.0, 256.0, 40.0, 25.0, 30.0}; // cx, cy, rx, ry, angle in degrees

glcm::AnalysisOutput output = glcm::RunAnalysis(image.gray, {roi}, settings);
double contrast_0_deg = output.results[0].values.at(glcm::Type::Contrast).H;
std::string csv = glcm::ResultsToCsv(output.results, settings, {"camera.png", "", "2026-09-14T12:00:00Z"});
```

Link against `glcm_core` (for example `target_link_libraries(my_app PRIVATE glcm_core)` after `add_subdirectory(core)`).

## Web application

The web application (`doc/ui-design-plan.md`) has three parts:
- `web/` is the browser app (React, Mantine, Konva). It opens images, draws and manages ROIs, edits the analysis settings, measures, and shows the results.
- `server/` is the API server. It uses the C++ core through a Node-API addon (`bindings/node`), runs analyses and feature maps as jobs, and serves the built web app.
- `packages/api` holds the request and response schemas shared by both.

Build and start it as described in [INSTALL.md](INSTALL.md#2-build-and-start-the-application). The commands for development:

```bash
npm run build:native    # rebuild the addon with cmake-js after changing core/
npm run build:web       # rebuild the web app into web/dist
npm start               # server and built web app on http://127.0.0.1:8080/
npm test                # addon, server and web unit tests (Vitest)
npm run test:e2e        # end-to-end tests in Chromium and WebKit (Playwright; run `npx playwright install chromium webkit` once)
npm run typecheck       # TypeScript
npm run openapi         # regenerate packages/api/openapi.json
```

For web development, run `npm start` and `npm run dev:web` side by side, then open http://127.0.0.1:5173/. The Vite dev server reloads on changes and forwards `/api` to port 8080.

Images up to 4096 × 4096 px are sent to the browser as raw samples and rendered there with a WebGL2 shader, which falls back to a lookup table. Its output is identical to the server's `display.png` rendering. Larger images are shown through `display.png`, and their pixel values come from `/pixel`.

The ROI Manager's pixel counts come from the core, with the same pixel-centre rule the analysis uses. The edge map, the livewire, the magic wand, Threshold ROI, the brush, the eraser, Union and Subtract are computed on the pixel grid by the core too, so an ROI always contains exactly the pixels that are measured.

## Local mode, server mode and deployment

On a loopback address the server runs in **local mode**, without authentication. Any other address is **server mode**, which requires an access token (`GLCM_API_TOKEN`); the web app asks for it once per browser tab. Server mode also switches to lower upload limits, rate limiting and retention. To deploy it with Docker behind an HTTPS reverse proxy, see [doc/deployment.md](doc/deployment.md), which also contains the security checklist.

```bash
export GLCM_API_TOKEN="$(openssl rand -base64 32)"
docker compose up -d                                  # server on 127.0.0.1:8080, data in the glcm-data volume
node scripts/smoke-test.mjs http://127.0.0.1:8080     # checks authentication, upload, analysis and export
```

## Configuration

The server is configured with environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GLCM_HOST` | `127.0.0.1` | Listen address; anything other than `127.0.0.1`, `::1` or `localhost` is server mode |
| `GLCM_API_TOKEN` | none | Access token (at least 43 characters, e.g. `openssl rand -base64 32`); required in server mode, enforced whenever set |
| `GLCM_CORS_ORIGINS` | none | Comma-separated origins of other sites allowed to call the API |
| `GLCM_RATE_LIMIT_PER_MINUTE` | `0`; `600` in server mode | API requests per minute per token (0 = no limit) |
| `GLCM_RETENTION_HOURS` | `0`; `168` in server mode | Delete uploaded images and results older than this (0 = keep) |
| `GLCM_TRUST_PROXY` | `false` | Use `X-Forwarded-*` headers from a reverse proxy |
| `GLCM_PORT` | `8080` | Port |
| `GLCM_DATA_DIR` | `~/.glcm-texture-analysis`; `/data` in server mode | Uploaded images, results and caches |
| `GLCM_MAX_UPLOAD_BYTES` | 209,857,600 (200 MiB); 100 MiB in server mode | Largest upload |
| `GLCM_MAX_IMAGE_PIXELS` | 400,000,000; 100,000,000 in server mode | Largest image; checked from the file header before decoding |
| `GLCM_MAX_VOLUME_BYTES` | 4 GiB; 1 GiB in server mode | Largest NIfTI volume (uncompressed voxel data); checked from the file header |
| `GLCM_RAW_TRANSFER_MAX_PIXELS` | 16,777,216 (4096²) | Images up to this size are sent to the browser as raw data |
| `GLCM_DISPLAY_MAX_SIZE` | `4096` | Largest long side of `display.png` |
| `GLCM_DISPLAY_CACHE_BYTES` | 536,870,912 (512 MiB) | Disk space for cached `display.png` renderings |
| `GLCM_ANALYSIS_CONCURRENCY` | number of CPU cores | Analysis jobs (ROI × distance) running at the same time |
| `GLCM_MAX_PENDING_JOBS` | 100,000; 20,000 in server mode | Analysis jobs queued or running over all analyses; larger analyses get `422 TooManyJobs`, others `503 ServerBusy` while the queue is full |
| `GLCM_MAX_FEATURE_MAP_BANDS` | 4,096; 1,024 in server mode | Bands of one feature map, each about a second of computing (they also count as pending jobs); larger maps get `422 TooManyJobs` |
| `GLCM_PIXEL_CACHE_BYTES` | 2,147,483,648 (2 GiB); 1 GiB in server mode | Memory for pixel buffers of recently used images (0 = read the file for every request) |
| `GLCM_WEB_DIR` | `web/dist` | Built web app |
| `GLCM_SAMPLES_DIR` | `samples/` | Sample images offered on the start screen |
| `GLCM_DOCS_DIR` | `doc/_build/html` | Built documentation, served at `/docs/` (Help ▸ Feature Equations links to it) |
| `GLCM_LOG_LEVEL` | `info` | Fastify log level |

`npm start` sets `UV_THREADPOOL_SIZE` to 16 unless it is already set. Analyses run in Node's libuv thread pool, which has only 4 threads by default.

## HTTP API

Endpoints (full details in `packages/api/openapi.json` and the Developer guide):

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/health` | Liveness and core version |
| `GET /api/v1/catalog` | Features (with non-standard flags), presets and limits |
| `POST /api/v1/images` | Upload an image as a multipart `file` field |
| `GET`, `DELETE /api/v1/images/{id}` | Image info (size, bit depth, default window, histogram); delete |
| `GET /api/v1/images/{id}/display.png?min&max&maxSize` | 8-bit rendering with window/level |
| `GET /api/v1/images/{id}/raw` | Raw little-endian samples, zstd or gzip compressed, for images up to 4096 × 4096 |
| `GET /api/v1/images/{id}/pixel?x&y` | One pixel value |
| `GET /api/v1/images/{id}/edges.png?method&sigma&low&high` | Sobel or Canny edge map as an 8-bit PNG |
| `GET /api/v1/images/{id}/gradient-stats?sigma` | Percentiles of the gradient magnitude, for choosing edge map limits |
| `POST /api/v1/images/{id}/roi-stats` | Pixel count, bounding box, min/max/mean/STD of ROIs |
| `POST /api/v1/images/{id}/threshold-rois` | ROIs of the connected regions in an intensity range (Threshold ROI) |
| `POST /api/v1/images/{id}/livewire` | Livewire path between two pixels along strong edges |
| `POST /api/v1/images/{id}/wand-roi` | ROI of the connected region around a pixel within a tolerance (magic wand) |
| `POST /api/v1/images/{id}/combine-rois` | Union or subtraction of ROIs, as one polygon |
| `POST /api/v1/images/{id}/brush-roi` | A brush or eraser stroke applied to an ROI |
| `POST /api/v1/analyses` | Start an analysis (image id, ROIs, settings); returns `202` |
| `GET`, `DELETE /api/v1/analyses/{id}` | Status; cancel (queued jobs are dropped) |
| `GET /api/v1/analyses/{id}/events` | Server-Sent Events: `result`, `progress`, `finished` |
| `GET /api/v1/analyses/{id}/results` | Results of the finished jobs (`glcm-results` JSON) |
| `GET /api/v1/analyses/{id}/results.csv`, `results.json` | The same results as a downloadable file written by the core |
| `POST /api/v1/feature-maps` | Start a feature map (image id, feature, window, step, settings); returns `202` |
| `GET`, `DELETE /api/v1/feature-maps/{id}` | Status and progress; cancel a running map or forget a finished one |
| `GET /api/v1/feature-maps/{id}/values` | The map's values as little-endian 32-bit floats, once completed |
| `POST /api/v1/exports/results` | CSV or JSON for a list of results documents (e.g. the current table); a ZIP when their settings differ |
| `POST /api/v1/exports/roi-images` | ZIP of ROI crops, masks, optional quantized images and `manifest.json` |
| `GET /api/v1/images?sha256` | Stored images, optionally by SHA-256 of the uploaded file (used when opening projects) |
| `GET /api/v1/images/{id}/original` | The uploaded file (used to embed images in projects) |
| `GET /api/v1/samples`, `GET /api/v1/samples/file?path` | Sample images |

## Command line and MCP

`cli/` (`@glcm/cli`) drives the same API without a browser, either in its own process (no server, no port) or against a
running server with `--server` and `--token`.

```bash
npm run cli -- --help                                    # or: node cli/bin/glcm.mjs --help
npm run cli -- features --presets                        # what can be measured
npm run cli -- info sample:textures/brick.png            # size, bit depth, window, spacing, checksum
npm run cli -- measure image.png --preset haralick --out results.csv
npm run cli -- measure *.png --rois rois.roi.json --out batch.csv   # merged when the settings match
npm run cli -- regions ct.png --min 1200 --max 1600 --out lungs.roi.json
npm run cli -- measure ct.png --rois RoiSet.zip --out lungs.csv    # ImageJ's .roi or RoiSet.zip, on ImageJ's pixels
npm run cli -- regions ct.png --min 1200 --max 1600 --out lungs-RoiSet.zip   # .zip: a RoiSet.zip for ImageJ
npm run cli -- feature-map brick.png --feature Contrast --out contrast.tif
npm run cli -- measure image.png --server http://127.0.0.1:8080 --token "$GLCM_API_TOKEN"
```

Images are looked up by their SHA-256 first, so measuring the same file twice uploads it once. In its own process the
tool uses the same data folder as the application (`GLCM_DATA_DIR`, by default `~/.glcm-texture-analysis`), so images
opened in the browser can be measured from a script and the other way round.

`glcm mcp` serves the same operations to an AI agent over [MCP](https://modelcontextprotocol.io) on standard input and
output: `list_features`, `list_samples`, `open_image`, `view_image` (the rendering or the edge map, as a picture the
model can look at), `select_regions` (by intensity or around a pixel), `measure` (ROIs as rectangles, as a region set
from `select_regions`, or from an ROI set or ImageJ ROI file) and `feature_map`. Tables are shortened for reading and written in full
with `saveTo`. To use it from an MCP client:

```json
{
  "mcpServers": {
    "texture-workbench": { "command": "node", "args": ["/path/to/texture-workbench/cli/bin/glcm.mjs", "mcp"] }
  }
}
```

The layers are worth keeping apart: `@glcm/client` is the API as a library — the HTTP transport and the operations
(open an image, build and check settings, measure, select regions, feature maps) — and depends only on `@glcm/api` and
`fetch`. It reads no files and needs no native addon, so it also runs in a browser or another program, and could be
published on its own if the MCP server ever moves to a repository of its own. `@glcm/cli` adds what needs a computer:
the in-process transport (`localClient`), reading images and ROI files, the commands and the MCP server.

While the server runs it marks its data directory with `server.lock`, and a command refuses to build a second server on
the same folder — that would empty `uploads/` and `volumes/` under it. Send the command to the server instead:
`--server http://127.0.0.1:8080 --token "$GLCM_API_TOKEN"`.

The Docker image ships the `glcm` command as well (`docker exec <container> glcm measure … --server http://127.0.0.1:8080
--token …`). Its build removes the MCP SDK and zod by name, about 17 MB of packages a server image is better without, and
`glcm mcp` then says so instead of failing obscurely. It cannot use `npm ci --omit=optional` for that: esbuild ships its
platform binary as an optional dependency, and without it `tsx` cannot run the server.
Everything else needs the built native addon (`npm run build:native`), so it runs from a clone of this repository.

## Documentation

The `doc/` folder contains a [Sphinx](https://www.sphinx-doc.org/) site (theme: [sphinx_rtd_theme](https://sphinx-rtd-theme.readthedocs.io/)) with three parts:
- **User guide:** opening and viewing images, drawing and editing ROIs, measuring, and saving, importing and exporting, with screenshots and a keyboard, mouse and menu reference.
- **Texture features:** the equations of every feature family as implemented in `core/analysis/` (GLCM, first-order, GLRLM, GLSZM, NGTDM, LBP), and a list of references.
- **Developer guide:** the architecture, the HTTP, Node.js addon and C++ APIs, the file formats, and the technologies and packages used.

How to build it is described in [INSTALL.md](INSTALL.md#4-build-the-documentation-optional).

The screenshots of the user guide (`doc/user/images/`) are generated from the running application. After changing the user interface, regenerate them from the repository root with `npm run build:web && npm run docs:screenshots`.

## Project structure

| Path | Contents |
| --- | --- |
| `core/` | `glcm_core` library: `analysis/` (texture features), `roi/` (ROI masks, region selection and ROI operations), `imaging/` (loading, quantization, display), `pipeline/` (settings, analysis runner, feature maps), `io/` (JSON, CSV, ROI image export), `tests/` |
| `bindings/node/` | Node-API addon (`@glcm/native`) exposing `glcm_core` to the server |
| `packages/api/` | Shared API schemas and types (`@glcm/api`) and the generated OpenAPI document |
| `packages/client/` | The API as a library (`@glcm/client`): HTTP transport and operations, with no file system and no native addon |
| `cli/` | The `glcm` command and the MCP server (`@glcm/cli`) |
| `server/` | Fastify API server (`@glcm/server`); also serves the built web app and the sample images |
| `web/` | Browser app (`@glcm/web`): React, Mantine, Konva, WebGL2 image rendering, ROI tools, settings and results |
| `e2e/` | Playwright end-to-end tests (`npm run test:e2e`), in local mode and with an access token |
| `Dockerfile`, `compose.yaml` | Server image and deployment example (`doc/deployment.md`) |
| `.github/workflows/` | CI: core, unit and end-to-end tests on macOS and Ubuntu; Docker image smoke test |
| `doc/` | Sphinx documentation (user guide with screenshots, feature equations and references, developer guide), the design plan and the deployment guide |
| `samples/` | Sample images: synthetic test patterns, CC0 textures (including the default sample `textures/camera.png`) and medical images: chest and abdominal CT, MRI, a chest X-ray and a mammogram (see `samples/README.md`) |
| `scripts/` | Helper scripts, e.g. `generate-samples.ts` (`npm run samples`) and `fetch-medical-samples.py` |
