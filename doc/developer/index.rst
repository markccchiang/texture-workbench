.. _developer-guide:

Developer guide
===============

This part of the documentation is for people who change or extend the application. It complements these documents in
the repository:

- ``README.md``: what the application does.
- ``INSTALL.md``: requirements, building the application, setting up the command line and MCP clients, the C++
  library and the documentation.
- ``DEVELOPMENT.md``: tests, development commands, configuration, deployment and the list of endpoints.
- ``doc/ui-design-plan.md``: the design plan the application was built from, with the decisions behind it and the
  status of each implementation phase.
- ``doc/deployment.md``: running the server with Docker behind an HTTPS reverse proxy, and the security checklist.

The guide has three chapters:

:ref:`architecture`
   How the C++ library, the Node.js addon, the API server and the web app fit together, the design of each component,
   and how data flows through them when an image is opened, measured and exported.

:ref:`api`
   The HTTP API (``/api/v1``), the Node.js addon, the C++ library and the file formats.

:ref:`technologies`
   The languages, frameworks and packages in each part, with their versions and what they are used for.

Quick start for developers
--------------------------

.. code-block:: bash

   # C++ library and its tests
   cmake -S . -B build && cmake --build build
   ctest --test-dir build

   # Node.js workspaces: addon, server, web app
   npm install
   npm run build:native      # the addon; run again after changing core/
   npm run build:web
   npm start                 # http://127.0.0.1:8080 (local mode)
   npm run dev:web           # Vite dev server on :5173 with live reload; keep npm start running

   # Checks
   npm run typecheck
   npm test                  # Vitest: addon, server and web unit tests
   npm run test:e2e          # Playwright in Chromium and WebKit
   npm run openapi           # regenerate packages/api/openapi.json after changing routes or schemas

Conventions
-----------

- **C++** follows ``.clang-format`` (Google style, 4-space indentation, 140 columns) and the ``readability-*`` checks of
  ``.clang-tidy``: ``CamelCase`` types and functions, ``lower_case`` variables and namespaces, ``UPPER_CASE`` constants,
  and a ``_`` prefix for private members. The build uses ``-Wall -Wextra`` and must stay free of warnings with Clang
  and GCC.
- **TypeScript** is strict; ``npm run typecheck`` checks the Node projects (addon types, server, scripts, tests) and the
  web app.
- **Versions** of npm packages are pinned exactly, and ``package-lock.json`` is committed.
- **Schemas first:** request and response shapes are defined once in ``packages/api`` and used for validation,
  serialization, the OpenAPI document and the web app's types.
- **One implementation of the numbers:** masks, quantization, features, window/level and exports are computed by
  ``glcm_core``; TypeScript code does not recompute them, with two exceptions tested against the core: the window/level
  lookup table and shader follow the same integer formula, and the ImageJ ROI writer rasterizes shapes with a port of
  ``RasterizeMask``.
- **Documentation:** a change to what the core computes must be reflected in :doc:`../equations`.
