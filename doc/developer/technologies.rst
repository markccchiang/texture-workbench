.. _technologies:

Technologies and packages
=========================

The versions below are the ones pinned in the repository (``package.json`` files and ``package-lock.json`` for npm
packages, system packages for the C++ dependencies). npm packages are pinned to exact versions so that builds are
reproducible; upgrade them deliberately and run all tests.

Languages and runtimes
----------------------

.. list-table::
   :header-rows: 1
   :widths: 25 20 55

   * - Technology
     - Version
     - Used for
   * - C++
     - C++17
     - ``glcm_core`` and the Node-API addon
   * - CMake
     - 3.22 or newer
     - Building the core library, its tests and (through cmake-js) the addon
   * - Node.js
     - 24 or newer
     - The API server, build tools and tests; developed with Node.js 25
   * - TypeScript
     - 5.9.3
     - Server, web app, shared schemas, tests and scripts (strict mode)
   * - Python
     - 3
     - Building this documentation; the diagrams of this guide (``scripts/docs-diagrams.py``, standard library only);
       the reference values and medical samples (Python 3.12, see Testing)

C++ libraries
-------------

.. list-table::
   :header-rows: 1
   :widths: 25 20 55

   * - Library
     - Version
     - Used for
   * - `OpenCV <https://opencv.org/>`_
     - 4 or 5 (core, imgproc, imgcodecs)
     - Image decoding (PNG, JPEG, BMP, TIFF), grayscale conversion, matrices, PNG/TIFF encoding, resizing
   * - `Eigen <https://eigen.tuxfamily.org/>`_
     - 3.3 or newer (5.x works)
     - Eigenvalues for the Maximal Correlation Coefficient
   * - `nlohmann/json <https://github.com/nlohmann/json>`_
     - 3.11 or newer
     - JSON of ROI sets, settings, results and manifests (used only inside ``.cpp`` files)
   * - `zlib <https://zlib.net/>`_
     - any recent
     - Reading ``.nii.gz`` files; PNG chunk checksums
   * - `GoogleTest <https://github.com/google/googletest>`_
     - any recent
     - Unit tests of the core (optional)

Node.js addon
-------------

.. list-table::
   :header-rows: 1
   :widths: 25 20 55

   * - Package
     - Version
     - Used for
   * - Node-API
     - version 8
     - ABI-stable interface between Node.js and C++; the addon works across Node.js versions without rebuilding
   * - ``node-addon-api``
     - 8.9.2
     - C++ wrapper of Node-API (``Napi::AsyncWorker``, promises, buffers)
   * - ``cmake-js``
     - 8.0.0
     - Builds the addon with CMake against the Node.js headers

API server
----------

.. list-table::
   :header-rows: 1
   :widths: 32 13 55

   * - Package
     - Version
     - Used for
   * - ``fastify``
     - 5.12.4
     - HTTP server: routing, schema validation (Ajv), serialization, hooks, logging (pino)
   * - ``@fastify/type-provider-typebox``
     - 6.1.0
     - Typed request and reply objects from the TypeBox route schemas
   * - ``@fastify/swagger``
     - 9.8.1
     - OpenAPI 3.1 document generated from the route schemas
   * - ``@fastify/multipart``
     - 10.1.1
     - Streaming image uploads with size limits
   * - ``@fastify/static``
     - 10.1.3
     - Serving the built web app with cache headers
   * - ``@fastify/cors``
     - 11.3.0
     - CORS allow-list (only when ``GLCM_CORS_ORIGINS`` is set)
   * - ``@fastify/rate-limit``
     - 11.2.0
     - Per-token request limits
   * - ``typebox``
     - 1.3.30
     - Schemas shared by server and web app (``packages/api``); ``typebox/value`` validates files in the browser
   * - ``fflate``
     - 0.8.3
     - ZIP archives of exports (server), of batch results with several groups of settings (web app), ImageJ's
       ``RoiSet.zip`` (``packages/api``), and reading them in tests
   * - ``tsx``
     - 4.23.13
     - Runs the TypeScript server without a separate compile step (also in the Docker image)

Node.js built-ins do the rest: ``node:crypto`` (SHA-256 of uploads, token comparison with ``timingSafeEqual``),
``node:zlib`` (gzip and zstd of raw pixel data) and ``node:stream`` (streaming uploads).

Web app
-------

.. list-table::
   :header-rows: 1
   :widths: 32 13 55

   * - Package
     - Version
     - Used for
   * - ``react``, ``react-dom``
     - 19.3.0
     - User interface components
   * - ``vite``, ``@vitejs/plugin-react``
     - 8.3.0, 6.1.1
     - Development server with live reload and ``/api`` proxy; production build
   * - ``@mantine/core``, ``@mantine/hooks``, ``@mantine/notifications``
     - 9.6.1
     - Component library (menus, dialogs, inputs, tables, sliders), keyboard shortcut hook, notifications; dark theme
   * - ``@tabler/icons-react``
     - 3.46.0
     - Icons of the toolbar, menus and panels
   * - ``zustand``
     - 5.0.15
     - Application state stores; ``persist`` middleware for settings and preferences
   * - ``@tanstack/react-query``
     - 5.102.8
     - Loading and caching server data (catalog, samples, ROI statistics)
   * - ``@tanstack/react-virtual``
     - 3.14.13
     - Rendering only the visible rows of long Results tables
   * - ``konva``, ``react-konva``
     - 10.5.0, 19.2.7
     - The image canvas: image layer, ROI shapes, transform handles, labels, hit testing
   * - ``react-resizable-panels``
     - 4.12.4
     - Resizable and collapsible panels with layouts remembered in ``localStorage``

Browser APIs: **WebGL2** (unsigned-integer textures and a fragment shader for window/level), Canvas 2D (lookup-table
fallback and the navigator thumbnail), ``fetch`` with streams (raw pixel download with progress, Server-Sent Events),
``XMLHttpRequest`` (upload progress), Web Crypto (SHA-256 of batch images, to reuse images the server already has),
``sessionStorage`` (access token) and ``localStorage`` (settings, preferences, layout). The Results plots are SVG drawn
by React components, without a chart library.

Testing
-------

.. list-table::
   :header-rows: 1
   :widths: 32 13 55

   * - Package
     - Version
     - Used for
   * - ``vitest``
     - 4.1.11
     - Unit tests of the addon, server and web app (two projects: ``node`` and ``web``)
   * - ``jsdom``
     - 27.4.0
     - Browser environment for the web unit tests
   * - ``@playwright/test``
     - 1.63.0
     - End-to-end tests in Chromium and WebKit, starting the servers from ``playwright.config.ts``
   * - ``pngjs``
     - 7.0.0
     - Reading PNG output in addon, server and end-to-end tests, and writing the synthetic samples
   * - GoogleTest
     - system package
     - Core unit tests
   * - PyRadiomics, scikit-image, SimpleITK, PyWavelets (Python 3.12)
     - 3.1.0 (git tag), 0.26.0, 2.5.6, 1.10.0
     - Reference values for the features, the resampling, the Laplacian of Gaussian and wavelet filters and the stain
       densities of colour deconvolution:
       ``scripts/radiomics-reference.py`` (packages pinned in ``scripts/requirements-radiomics.txt``) writes
       ``core/tests/data/*.json``, which the core tests compare against. Only regenerating those files needs Python; the
       tests and the application do not run it.
   * - ImageJ (Java 21, in a digest-pinned container)
     - 1.54p
     - Reference data for ImageJ ROI files (``scripts/imagej-roi``, ``packages/api/test/data/imagej``) and for the colour
       conversions that follow ImageJ (``scripts/imagej-colour``, ``core/tests/data/imagej-colour.json``)
   * - pydicom, nibabel (Python 3.12)
     - 3.0.2, 5.4.2
     - Writing the medical samples and their pixel spacing: ``scripts/fetch-medical-samples.py`` (pinned in
       ``scripts/requirements-medical.txt``)

Command line and MCP
--------------------

.. list-table::
   :header-rows: 1
   :widths: 32 20 48

   * - Package
     - Version
     - Used for
   * - ``@modelcontextprotocol/sdk``
     - 1.30.0
     - The MCP server of ``glcm mcp`` (standard input and output); an optional dependency, left out of the Docker image
   * - ``zod``
     - 4.6.5
     - Input schemas of the MCP tools; optional like the SDK
   * - ``tsx``
     - 4.23.13
     - Runs the TypeScript command line (``cli/bin/glcm.mjs`` registers it)

The command line has no parser dependency: options are read with ``node:util`` ``parseArgs``.

Documentation, build and deployment
-----------------------------------

.. list-table::
   :header-rows: 1
   :widths: 32 20 48

   * - Tool
     - Version
     - Used for
   * - Sphinx, ``sphinx_rtd_theme``
     - from ``doc/requirements.txt``
     - This documentation; equations rendered with MathJax
   * - Docker
     - multi-stage build
     - ``node:24-bookworm`` (pinned by digest, like the runtime image) builds the core, addon and web app; ``node:24-bookworm-slim`` with
       ``libopencv-core406``, ``libopencv-imgproc406`` and ``libopencv-imgcodecs406`` runs the server as user ``node``
   * - Docker Compose
     - ``compose.yaml``
     - Deployment example with a data volume
   * - GitHub Actions
     - ``actions/checkout@v7``, ``actions/setup-node@v7``, ``actions/cache@v6``, ``actions/upload-artifact@v7``,
       ``docker/setup-buildx-action@v4``, ``docker/build-push-action@v7`` (pinned to commit SHAs)
     - Continuous integration on ``ubuntu-latest`` and ``macos-latest``, Docker image build and smoke test
   * - clang-format, clang-tidy
     - ``.clang-format``, ``.clang-tidy``
     - C++ formatting and naming checks

Version notes
-------------

- **Vitest 4**, not 5: Vitest 5 does not support Node.js 25, which the project is developed with.
- **jsdom 27**, not 30: jsdom 30 does not support Node.js 25 either.
- **TypeBox 1.x** is published as ``typebox``; the older ``@sinclair/typebox`` package has a different API.
- **Mantine 9** renamed several props (for example ``Collapse`` uses ``expanded``, and colors are set with ``c``).
- **Zustand 5** selectors must return stable references: selecting ``state.list.filter(…)`` re-renders forever.
  Select the stored value and derive in the component.
- **Playwright** versions need their matching browser builds: run ``npx playwright install chromium webkit`` after
  changing the version.
- **OpenCV** 4.6 (Debian and Ubuntu packages) and 5 (Homebrew) are both supported; the core uses only the core,
  imgproc and imgcodecs modules.
