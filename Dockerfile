# Texture Workbench server with the web app (doc/ui-design-plan.md, sections 8.2 and 8.6).
#
#   docker build -t texture-workbench .
#   docker run -p 8080:8080 -v glcm-data:/data -e GLCM_API_TOKEN="$(openssl rand -base64 32)" texture-workbench
#
# The image also carries the `glcm` command:
#   docker exec <container> glcm measure /data/image.png --server http://127.0.0.1:8080 --token "$GLCM_API_TOKEN"
#
# The container listens on 0.0.0.0, which is server mode: GLCM_API_TOKEN is required. Put a reverse proxy with HTTPS
# in front of it (see doc/deployment.md).

# Base images are pinned by digest (the tag is kept for readability); .github/dependabot.yml proposes updates.

# ---- Build: core, Node-API addon and web app -------------------------------------------------------------------------
FROM node:24-bookworm@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake g++ make libopencv-dev libeigen3-dev nlohmann-json3-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so they are cached while sources change
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/client/package.json packages/client/
COPY bindings/node/package.json bindings/node/
COPY server/package.json server/
COPY web/package.json web/
COPY cli/package.json cli/
RUN npm ci
# A workspace that is declared but not copied would only show up later, as a command that cannot resolve a package
RUN node -e "const fs = require('fs'); const missing = require('./package.json').workspaces.filter((w) => !fs.existsSync(w + '/package.json')); if (missing.length > 0) { console.error('Workspaces missing from the image: ' + missing.join(', ')); process.exit(1); }"

COPY core core
COPY bindings/node bindings/node
COPY packages/api packages/api
COPY packages/client packages/client
COPY server server
COPY web web
COPY cli cli
# The MCP SDK and zod are removed by name, with the packages only they need (about 17 MB a server image and its
# vulnerability scans are better without); an agent runs `glcm mcp` next to itself, from a clone. Not `--omit=optional`:
# that would also drop esbuild's platform binary, which tsx needs to run the server.
RUN npm run build:native && npm run build:web \
    && npm uninstall @modelcontextprotocol/sdk zod --workspace @glcm/cli --omit=dev \
    && npm prune --omit=dev

# ---- Runtime ---------------------------------------------------------------------------------------------------------
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

RUN apt-get update \
    && apt-get install -y --no-install-recommends libopencv-core406 libopencv-imgproc406 libopencv-imgcodecs406 \
    && rm -rf /var/lib/apt/lists/*

# node_modules/.bin holds the `glcm` command of the cli workspace
ENV PATH="/app/node_modules/.bin:${PATH}" \
    NODE_ENV=production \
    GLCM_HOST=0.0.0.0 \
    GLCM_PORT=8080 \
    GLCM_DATA_DIR=/data \
    GLCM_WEB_DIR=/app/web/dist \
    GLCM_SAMPLES_DIR=/app/samples \
    UV_THREADPOOL_SIZE=16

WORKDIR /app

# node_modules keeps the workspace links (@glcm/api, @glcm/native, ...) to the directories copied next to it
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/api/package.json packages/api/
COPY --from=build /app/packages/api/src packages/api/src
COPY --from=build /app/packages/client/package.json packages/client/
COPY --from=build /app/packages/client/src packages/client/src
COPY --from=build /app/bindings/node/package.json /app/bindings/node/index.js /app/bindings/node/index.d.ts bindings/node/
COPY --from=build /app/bindings/node/build/Release/glcm_native.node bindings/node/build/Release/
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/src server/src
COPY --from=build /app/web/package.json web/
COPY --from=build /app/web/dist web/dist
# The `glcm` command: docker exec <container> glcm measure /data/image.png --server http://127.0.0.1:8080 --token ...
COPY --from=build /app/cli/package.json cli/
COPY --from=build /app/cli/bin cli/bin
COPY --from=build /app/cli/src cli/src
COPY samples samples

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

# Uses GLCM_PORT, so the check keeps working when the port is changed with -e GLCM_PORT=...
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.GLCM_PORT || 8080) + '/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--import", "tsx", "server/src/main.ts"]
