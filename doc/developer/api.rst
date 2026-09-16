.. _api:

APIs and file formats
=====================

The application has three programming interfaces: the HTTP API used by the web app, the Node.js addon used by the
server, and the C++ library. This chapter also describes the files the application reads and writes.

HTTP API
--------

Conventions
~~~~~~~~~~~

- **Base path:** ``/api/v1``, on the same origin as the web app (``http://127.0.0.1:8080`` in local mode).
- **Schemas:** every request and response is defined with TypeBox in ``packages/api/src``. Requests are validated and
  responses serialized with these schemas. The complete OpenAPI 3.1 document is generated into
  ``packages/api/openapi.json`` (``npm run openapi``).
- **Authentication:** when the server has an access token (always in server mode), every request except
  ``GET /health`` needs ``Authorization: Bearer <token>``. ``GET /health`` reports whether a token is needed.
- **Errors:** every 4xx and 5xx response has the body ``{"error": "<code>", "message": "<description>"}``.
- **Identifiers:** images are ``img_``, analyses ``ana_``, feature maps ``fmap_`` and volumes ``vol_`` followed by 32
  hexadecimal digits.
- **Coordinates:** ROI coordinates are image pixels as floating-point numbers; pixel ``(column c, row r)`` covers
  ``[c, c + 1) × [r, r + 1)``.

Endpoints
~~~~~~~~~

.. list-table:: System
   :header-rows: 1
   :widths: 35 65

   * - Method and path
     - Description
   * - ``GET /health``
     - ``{status, coreVersion, mode: "local"|"server", authentication: "none"|"bearer"}``; never needs the token
   * - ``GET /catalog``
     - Features (id, name, group, non-standard flag and reason, documentation anchor, cost), presets, analysis limits
       and upload limits

.. list-table:: Images
   :header-rows: 1
   :widths: 35 65

   * - Method and path
     - Description
   * - ``POST /images``
     - Upload one file as ``multipart/form-data``: PNG, JPEG, BMP, TIFF, uncompressed DICOM or a single-slice NIfTI file;
       ``201`` with ``ImageInfo``. The pages of a multi-page TIFF (up to the first page of another size or type) and the
       frames of a DICOM file become the ``slices`` of a stack. ``413`` too large, ``415`` not multipart, ``422``
       ``InvalidImage``, ``UnsupportedImage`` (for example compressed DICOM, or a NIfTI volume: use ``POST /volumes``) or
       ``ImageTooLarge`` (a slice above ``GLCM_MAX_IMAGE_PIXELS``, or all slices above ``GLCM_MAX_STACK_PIXELS``)
   * - ``POST /images/series``
     - The files of a DICOM series as ``multipart/form-data`` (one ``file`` field per file, at most
       ``GLCM_MAX_SERIES_FILES``, together at most ``GLCM_MAX_VOLUME_BYTES``) and an optional ``name`` field; ``201`` with
       the ``ImageInfo`` of one stack. Files that are not DICOM images are left out, only the series (SeriesInstanceUID)
       with the most files is used, and the slices are ordered along the normal of the image plane (ImagePositionPatient
       and ImageOrientationPatient), else by InstanceNumber, else by file name; all files are stored with one value
       conversion. The name is the ``name`` field, else the SeriesDescription. The image's original file is an
       uncompressed multi-page TIFF of the slices, whose SHA-256 identifies it. ``422`` ``UnsupportedImage`` when no
       file is a DICOM image or the images differ in size
   * - ``GET /images?sha256=``
     - Stored images, newest first, optionally only those whose uploaded file has this SHA-256
   * - ``GET /images/{id}``, ``DELETE /images/{id}``
     - ``ImageInfo``; delete the image (``204``)
   * - ``GET /images/{id}/raw?slice``
     - Grayscale samples (of one slice) for images with ``transfer: "raw"`` (``409 RawNotAvailable`` otherwise), compressed with zstd
       or gzip when accepted, ``ETag`` and immutable caching
   * - ``GET /images/{id}/display.png?min&max&maxSize&slice``
     - 8-bit PNG with window/level, long side at most ``maxSize``; ``ETag`` and ``304``
   * - ``GET /images/{id}/edges.png?method&sigma&low&high&maxSize&slice``
     - 8-bit PNG edge map of the gradient magnitude after Gaussian smoothing (``sigma`` pixels): ``sobel`` maps
       ``[low, high]`` to black–white, ``canny`` marks the edges found with the hysteresis thresholds ``low`` and
       ``high``; limits in intensity units per pixel; cached with ``ETag`` like ``display.png``
   * - ``GET /images/{id}/gradient-stats?sigma&slice``
     - ``{sigma, percentiles: {"50", "90", "95", "99"}, max}`` of the gradient magnitude, for choosing edge map limits
   * - ``GET /images/{id}/pixel?x&y&slice``
     - ``{x, y, value}`` for one pixel
   * - ``GET /images/{id}/original``
     - The uploaded file, as a download

.. list-table:: ROIs and analyses
   :header-rows: 1
   :widths: 35 65

   * - Method and path
     - Description
   * - ``POST /images/{id}/roi-stats``
     - ``{rois: [{id, slice?, shape}]}`` → ``{stats: [{roiId, pixelCount, boundingBox, min, max, mean, std, error}]}``, each
       ROI on its slice
   * - ``POST /images/{id}/threshold-rois``
     - ``{min, max, minPixels, maxRegions, maxPixels?, minSphericity?, slice?}`` → ``{regions: [{points, pixelCount,
       boundingBox}], total}``: the 8-connected parts of the pixels in ``[min, max]`` with holes filled, outlined along
       the pixel edges, with ``minPixels`` to ``maxPixels`` pixels and a sphericity (the shape feature, in pixels) of at
       least ``minSphericity``, the largest ``maxRegions`` (at most 1000; 0 returns only ``total``)
   * - ``POST /images/{id}/wand-roi``
     - ``{x, y, tolerance, slice?}`` → ``{region}``: the 8-connected region around pixel ``(x, y)`` whose values differ from its
       value by at most ``tolerance``, outlined the same way; ``null`` outside the image
   * - ``POST /images/{id}/livewire``
     - ``{from: {x, y}, to: {x, y}, sigma, slice?}`` → ``{points}``: the livewire path between two pixels along strong edges,
       as the pixel centres where it turns; ``400`` for points outside the image or more than 1024 pixels apart
   * - ``POST /images/{id}/combine-rois``
     - ``{operation: "union"|"subtract"|"intersect"|"xor", shapes}`` → ``{shape, pixelCount, boundingBox}``: the shapes
       rasterized on the image grid and combined (``xor``: the pixels an odd number of shapes cover); ``shape`` is one
       polygon along the pixel edges whose parts and holes are joined by zero-width cuts (even-odd rule), ``null`` when
       no pixel is left
   * - ``POST /images/{id}/grow-roi``
     - ``{shape, operation: "enlarge"|"shrink"|"band", distance, pixelSpacing?}`` → the same result: the pixels within
       ``distance`` of the shape, the shape's pixels farther than ``distance`` from every pixel outside it (pixels beyond
       the image count as outside), or the pixels enlarging adds. Distances run between pixel centres, in pixels, or in
       millimetres with ``pixelSpacing`` (exact for non-square pixels)
   * - ``POST /images/{id}/brush-roi``
     - ``{shape, path, radius, erase}`` → the same result: the pixels whose centres lie within ``radius`` of ``path``,
       added to ``shape`` (a new shape when ``null``) or removed from it
   * - ``POST /analyses``
     - ``{imageId, rois, settings, pixelSpacing?}`` → ``202`` with ``AnalysisInfo``; each ROI is measured on its ``slice``;
       ``pixelSpacing`` (``{x, y}`` or ``null``) overrides the image's. ``400`` for invalid settings or ROIs, a slice the
       image does not have, or resampling without a pixel spacing; ``422``
       ``TooManyJobs`` when ROIs × distances exceed ``GLCM_MAX_PENDING_JOBS``; ``503`` ``ServerBusy`` (with
       ``Retry-After``) while the job queue is full
   * - ``GET /analyses/{id}``
     - ``AnalysisInfo``: status (``queued``, ``running``, ``completed``, ``cancelled``, ``failed``), completed and total
       jobs, settings
   * - ``DELETE /analyses/{id}``
     - Cancel: queued jobs are dropped, running jobs finish (``204``)
   * - ``GET /analyses/{id}/events``
     - Server-Sent Events, see :ref:`api-events`
   * - ``GET /analyses/{id}/results``
     - ``glcm-results`` document with the finished jobs, ordered by ROI and distance
   * - ``GET /analyses/{id}/results.csv``, ``.json``
     - The same results as a downloadable CSV or JSON file written by the core

.. list-table:: Volumes
   :header-rows: 1
   :widths: 35 65

   * - Method and path
     - Description
   * - ``POST /volumes``
     - Upload one NIfTI-1/2 file (``.nii`` or ``.nii.gz``) as ``multipart/form-data``; ``201`` with ``VolumeInfo``.
       The volume is kept (uncompressed) until it is deleted. ``422`` ``InvalidImage`` (not NIfTI), ``UnsupportedImage``
       (``.hdr``/``.img`` pairs, RGB or complex data, more than 4 dimensions) or ``ImageTooLarge`` (more voxel data than
       ``GLCM_MAX_VOLUME_BYTES``)
   * - ``GET /volumes/{id}``, ``DELETE /volumes/{id}``
     - ``VolumeInfo``; delete the volume (``204``). Images opened from it are kept
   * - ``GET /volumes/{id}/preview.png?orientation&slice&volume&maxSize``
     - 8-bit PNG of one slice with the volume's default window; ``400`` for a slice or volume out of range
   * - ``POST /volumes/{id}/images``
     - ``{orientation: "axial"|"coronal"|"sagittal", slice, volume?}`` → ``201`` with the ``ImageInfo`` of a new image
       named ``<file> [<orientation> <slice>]`` (``, volume <n>`` for 4D files), whose original file is a PNG of the
       slice with its pixel spacing
   * - ``POST /volumes/{id}/stack``
     - ``{orientation, volume?}`` → ``201`` with the ``ImageInfo`` of a stack of every slice in that orientation (slice 1
       is the most inferior, posterior or left one), named ``<file> [<orientation>]`` (``, volume <n>`` for 4D files), with the window of the whole
       volume; its original file is an uncompressed multi-page TIFF of the slices with the pixel spacing

.. list-table:: Feature maps
   :header-rows: 1
   :widths: 35 65

   * - Method and path
     - Description
   * - ``POST /feature-maps``
     - ``{imageId, slice?, settings}`` → ``202`` with ``FeatureMapInfo`` (which records the ``slice``); ``400`` for invalid settings, ``404`` for an unknown
       image; ``422`` ``TooManyJobs`` when the map needs more bands of rows (about a second of computing each) than
       ``GLCM_MAX_FEATURE_MAP_BANDS`` or ``GLCM_MAX_PENDING_JOBS``; ``503`` ``ServerBusy`` while the job queue is full
   * - ``GET /feature-maps/{id}``
     - ``FeatureMapInfo``: status, ``step``, ``columns``, ``rows``, ``completedRows``, ``error``, settings
   * - ``GET /feature-maps/{id}/values``
     - ``rows × columns`` little-endian 32-bit floats, row-major, NaN where a window has no pixel pairs;
       ``409 NotReady`` until the map has completed
   * - ``DELETE /feature-maps/{id}``
     - Cancel a queued or running map (queued bands are dropped, running bands stop after their current point), or
       forget a finished one (``204``)

.. list-table:: Exports and samples
   :header-rows: 1
   :widths: 35 65

   * - Method and path
     - Description
   * - ``POST /exports/results``
     - ``{format: "csv"|"json", documents: [{timestamp, image, settings, results}]}``. Documents with equal settings and
       image are merged into one file; several groups are returned as a ZIP with one file per group
   * - ``POST /exports/roi-images``
     - ``{imageId, rois, settings?, transparentOutside, includeQuantized}`` → ZIP of crops, masks, optional quantized
       images and ``manifest.json``
   * - ``GET /samples``, ``GET /samples/file?path=``
     - Sample images offered on the start screen, and one sample file

Main schemas
~~~~~~~~~~~~

**ImageInfo** — ``imageId``, ``name``, ``sizeBytes``, ``width``, ``height``, ``bitDepth`` (8 or 16), ``slices`` (1 for a
single image; width and height are those of one slice), ``sourceChannels``, ``sha256``, ``transfer`` (``"raw"`` or ``"server"``), ``windowMin``, ``windowMax`` (0.5 and 99.5
percentiles, or the first DICOM window), ``histogram`` (256 bins), ``pixelSpacing``, ``valueConversion`` (DICOM and
NIfTI only), ``warnings``, ``createdAt``.

**Value conversion** — ``{scale, offset, unit, description}``: the file's value (after its rescale slope and intercept)
is ``stored sample × scale + offset``; ``unit`` is ``HU`` for CT. Values are stored unchanged when they are integers
within 0–65 535, + 1024 when they are integers with a negative minimum, and mapped linearly from their minimum–maximum
otherwise; DICOM MONOCHROME1 is inverted (``scale`` −1). ``AnalysisInfo.valueConversion`` and the results document's
``image.valueConversion`` carry the description, which exports write as ``# valueConversion=…``.

**VolumeInfo** — ``volumeId``, ``name``, ``sizeBytes``, ``niftiVersion``, ``dimensions`` (voxels along i, j, k),
``volumes``, ``dataType``, ``axisCodes`` (e.g. ``LAS``), ``orientationSource`` (``sform``, ``qform`` or ``none``),
``acquisitionOrientation``, ``slices`` (``count``, ``width``, ``height`` and ``pixelSpacing`` per orientation),
``minimum``, ``maximum``, ``bitDepth``, ``valueConversion`` (or ``null``), ``windowMin``, ``windowMax``, ``warnings``,
``createdAt``. Slices are laid out in RAS orientation: axial columns towards the patient's right and rows from anterior,
coronal columns towards the right and rows from superior, sagittal columns towards anterior and rows from superior;
slice 0 is the most inferior, posterior or left one.

**Pixel spacing** — ``{x, y}`` in millimetres per pixel. ``ImageInfo.pixelSpacing`` comes from the file's resolution
(PNG ``pHYs``, JPEG JFIF, BMP, TIFF; ``null`` without one, or for 72/96 dpi on both axes), DICOM PixelSpacing or
ImagerPixelSpacing, or the NIfTI voxel size. An ``AnalysisRequest`` may
set ``pixelSpacing`` (a spacing, or ``null`` for none) to override it; ``AnalysisInfo.pixelSpacing`` records the value
used, and the results document carries it as ``image.pixelSpacing``. Result documents with a spacing export an
``areaMm2`` column and a ``# pixelSpacingMm=x;y`` comment; ``POST /exports/results`` groups documents by spacing too.
Texture features are computed in pixels and do not depend on the spacing; shape features are in millimetres with it,
and resampling and the sigma of the Laplacian of Gaussian use it.

**ROI** — ``{id, name, color?, shape}`` where ``shape`` is one of:

.. code-block:: text

   {"type": "rectangle", "x": 100, "y": 100, "width": 64, "height": 64}
   {"type": "ellipse", "cx": 260.5, "cy": 300, "rx": 40, "ry": 25, "angle": 30}
   {"type": "polygon", "points": [[10, 10], [80, 20], [40, 90]], "freehand": false}

A request may contain up to 1000 ROIs; a polygon up to 10 000 vertices.

**AnalysisSettings**

.. code-block:: json

   {
     "features": ["Contrast", "Entropy", "CorrelationII", "CorrelationIII"],
     "grayLevels": 32,
     "quantization": {"method": "fixedRange", "min": 0, "max": 65535, "binWidth": 0},
     "distances": [1, 2],
     "directions": [0, 45, 90, 135],
     "aggregation": "perDirectionAndMean",
     "logBase": "natural",
     "score": {"enabled": true, "age": 40, "coefficients": [1.138, -1.814, 1.416, 1.714],
               "profile": "calibration", "intensityMin": 0, "intensityMax": 65535}
   }

- ``features``: ids from ``GET /catalog``.
- ``grayLevels``: 2–256.
- ``quantization.method``: ``fixedRange``, ``roiMinMax``, ``fixedBinWidth`` or ``none``.
- ``distances``: 1–64.
- ``aggregation``: ``perDirectionAndMean``, ``meanOnly`` or ``meanAndRange``.
- ``logBase``: ``natural`` or ``log2``.
- ``score.profile``: ``calibration`` computes the score inputs with Ng = 256, d = 1 and all directions whatever the
  settings; ``currentSettings`` uses the settings and warns.
- ``resampling`` (optional): ``{x, y}``, the pixel spacing in millimetres to resample the image and the ROIs to before
  measuring; needs the image's pixel spacing (see :ref:`Resampling <resampling>`).
- ``filter`` (optional): ``{"type": "laplacianOfGaussian", "sigma": s}`` or ``{"type": "wavelet", "wavelet": "coif1"
  (optional), "band": "LL"|"LH"|"HL"|"HH"}``, applied after resampling. A filtered image has real values, so it needs
  quantization ``fixedBinWidth`` or ``roiMinMax``, and neither local binary patterns nor the score.

**MeasurementResult** — one ROI at one distance:

.. code-block:: json

   {
     "roiId": "7f3c", "roiName": "ROI 1", "roiClass": "lesion", "slice": 12, "distance": 1,
     "status": "ok", "error": "", "pixelCount": 4096,
     "pairCounts": {"0": 8064, "45": 7938, "90": 8064, "135": 7938},
     "quantization": {"lower": 0, "upper": 255},
     "values": {"Contrast": {"0": 2.08, "45": 3.11, "90": 1.95, "135": 3.02, "mean": 2.54, "range": 1.16}},
     "score": null,
     "warnings": []
   }

``roiClass`` is the ROI's class and is omitted for ROIs without one; ``slice`` is the ROI's slice of a stack (from
1) and is omitted for ROIs without one. Values are ``null`` for directions that were not selected. ``status`` is ``skipped`` (e.g. fewer than 2 pixels) or
``failed`` (e.g. intensities outside the gray levels without quantization) with ``error`` explaining why.

.. _api-events:

Progress events
~~~~~~~~~~~~~~~

``GET /analyses/{id}/events`` returns ``text/event-stream``. Results of jobs that finished before the request are
replayed first, so a client that connects late receives everything. The stream ends after ``finished``:

.. code-block:: text

   event: result
   data: {"index": 0, "result": { MeasurementResult }}

   event: progress
   data: {"completed": 1, "total": 4}

   event: finished
   data: {"status": "completed", "completed": 4, "total": 4, "error": null}

``index`` is the position of the result in the final order (ROI index × number of distances + distance index). Lines
starting with ``:`` are keep-alive comments.

Raw pixel data
~~~~~~~~~~~~~~

The body of ``GET /images/{id}/raw`` is the grayscale samples row by row from the top-left pixel, with no header;
16-bit samples are little-endian. The size is in the headers ``X-Image-Width``, ``X-Image-Height``,
``X-Image-Bit-Depth`` and ``X-Image-Byte-Order: little-endian``. Clients should check that the decoded length equals
``width × height × bitDepth / 8``.

Error codes
~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 12 28 60

   * - Status
     - ``error``
     - Meaning
   * - 400
     - ``BadRequest``
     - The request does not match the schema, or the core rejected the settings or ROIs
   * - 401
     - ``Unauthorized``
     - Missing or wrong access token (with ``WWW-Authenticate: Bearer``)
   * - 404
     - ``NotFound``
     - Unknown image, analysis, feature map, volume, sample or route
   * - 409
     - ``RawNotAvailable``
     - Raw samples requested for a large image; use ``display.png`` and ``/pixel``
   * - 409
     - ``NotReady``
     - Feature map values requested before the map has completed
   * - 413
     - ``PayloadTooLarge``
     - Upload larger than ``GLCM_MAX_UPLOAD_BYTES``
   * - 415
     - ``UnsupportedMediaType``
     - Upload not sent as ``multipart/form-data``
   * - 422
     - ``InvalidImage``, ``UnsupportedImage``, ``ImageTooLarge``, ``TooManyJobs``
     - The file cannot be decoded, has an unsupported format (e.g. 32-bit float), or has too many pixels (checked from
       the file header before decoding); an analysis has more jobs than the server allows
   * - 429
     - ``TooManyRequests``
     - Rate limit exceeded (with ``Retry-After``)
   * - 503
     - ``ServerBusy``
     - The analysis job queue is full (with ``Retry-After``)
   * - 500
     - ``InternalError``
     - Unexpected server error (details only in the server log)

Example session
~~~~~~~~~~~~~~~

.. code-block:: bash

   API=http://127.0.0.1:8080/api/v1
   AUTH="Authorization: Bearer $GLCM_API_TOKEN"     # only needed when the server has a token

   curl -s $API/health
   IMAGE=$(curl -s -H "$AUTH" -F file=@samples/textures/brick.png $API/images | jq -r .imageId)

   ANALYSIS=$(curl -s -H "$AUTH" -H 'Content-Type: application/json' $API/analyses -d '{
     "imageId": "'$IMAGE'",
     "rois": [{"id": "r1", "name": "ROI 1", "shape": {"type": "rectangle", "x": 10, "y": 10, "width": 100, "height": 80}}],
     "settings": {"features": ["Contrast", "Entropy"], "grayLevels": 32,
       "quantization": {"method": "fixedRange", "min": 0, "max": 255, "binWidth": 8},
       "distances": [1], "directions": [0, 45, 90, 135], "aggregation": "perDirectionAndMean", "logBase": "natural",
       "score": {"enabled": false, "age": 40, "coefficients": [1.138, -1.814, 1.416, 1.714],
                 "profile": "calibration", "intensityMin": 0, "intensityMax": 255}}
   }' | jq -r .analysisId)

   curl -sN -H "$AUTH" $API/analyses/$ANALYSIS/events        # waits until the analysis has finished
   curl -s -H "$AUTH" -OJ $API/analyses/$ANALYSIS/results.csv

``scripts/smoke-test.mjs`` performs the same steps in JavaScript and checks the responses.

.. _api-cli:

Command line and MCP
--------------------

``cli/`` (``@glcm/cli``) reaches the API either in its own process — it builds the same server object and calls its
routes, so no port is opened and no daemon runs — or over HTTP against a running server with ``--server`` and
``--token``. Both use the data folder of the application, so an image opened in the browser can be measured from a
script.

.. list-table::
   :header-rows: 1
   :widths: 42 58

   * - Command
     - Description
   * - ``glcm features [--presets]``
     - The feature catalog, or the presets that group the features
   * - ``glcm samples``
     - The sample images the server offers, as ``sample:<path>`` arguments
   * - ``glcm info <image>``
     - Size, bit depth, display window, pixel spacing, value conversion and checksum
   * - ``glcm measure <image...> [--rois <file>]``
     - Measures the ROIs (the whole image without ``--rois``) and writes CSV or JSON; several images with equal
       settings are merged into one table. ``--rois`` takes an ROI set, a project, an array of ROIs, or ImageJ's
       ``.roi`` and ``RoiSet.zip``. On a stack, the whole of every slice, or of ``--slice n``; more than 1000 ROIs are
       measured in parts and joined
   * - ``glcm regions <image> [--min --max | --at x,y]``
     - Regions by intensity or around a pixel, written as an ROI set the application also reads, or with an
       ``--out`` name ending in ``.zip`` as a ``RoiSet.zip`` for ImageJ; ``--slice n`` for a slice of a stack
   * - ``glcm feature-map <image> --feature <id>``
     - One feature over the whole image (``--slice n`` of a stack), written as a 32-bit floating point TIFF
   * - ``glcm mcp``
     - Serves the operations to an AI agent over MCP

An image argument is a file, ``sample:<path>`` or an image id. Files are looked up by their SHA-256 before they are
uploaded, so measuring the same file again costs nothing. Settings come from the defaults, then ``--settings <file>``,
then ``--preset``, then single options such as ``--features``, ``--gray-levels``, ``--distances`` and
``--quantization``; they are checked with the same rules as the Analysis Settings panel, and a command that would be
refused exits with code 2 and the reason.

While the server runs it writes ``server.lock`` into its data directory (process id, address and start time), and a
command refuses to run the API in its own process on that folder, naming the address to use instead. Starting a second
server there would empty its ``uploads/`` and ``volumes/`` folders, which the stores clear when they start. A lock left
behind by a process that no longer exists is ignored.

**MCP.** ``glcm mcp`` speaks the Model Context Protocol on standard input and output. An agent cannot draw an ROI, so
regions come from numbers (``rectangles``), from ``select_regions`` (which keeps them under an id such as
``regions_1``) or from an ROI set file. ``view_image`` answers with the rendered image or its edge map as a picture, so
a model can look before it chooses. Results tables are shortened to a readable number of rows and written in full only
when a tool is given ``saveTo``. ``glcm mcp --help`` prints the usage instead of starting the server, and ``glcm mcp``
run in a terminal says on standard error (standard output belongs to the protocol) that it is waiting for a client.

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Tool
     - Arguments
   * - ``list_features``
     - ``presets``
   * - ``list_samples``
     - —
   * - ``open_image``
     - ``image``
   * - ``view_image``
     - ``image``, ``kind`` (``display`` or ``edges``), ``min``, ``max``, ``slice``
   * - ``select_regions``
     - ``image``, ``min``, ``max``, ``minPixels``, ``maxPixels``, ``minSphericity``, ``maxRegions``, ``at``, ``tolerance``,
       ``saveTo``, ``slice``
   * - ``measure``
     - ``image``, ``rois``, ``rectangles``, ``preset``, ``features``, ``grayLevels``, ``distances``, ``maxRows``, ``saveTo``,
       ``slice`` (of the rectangles or the whole image; without regions every slice of a stack is measured)
   * - ``feature_map``
     - ``image``, ``feature``, ``window``, ``saveTo``, ``slice``

The packages MCP needs are optional dependencies, so an installation can leave them out: the Docker image carries the
command line but not the MCP server, and ``glcm mcp`` says so there rather than failing obscurely.

.. _api-addon:

Node.js addon
-------------

``@glcm/native`` (``bindings/node/index.d.ts``) is used by the server; it can also be used by other Node.js programs.
Pixel buffers are row-major grayscale samples with 16-bit samples little-endian. Promises reject, and synchronous
functions throw, with an ``Error`` whose ``code`` is ``INVALID_ARGUMENT``, ``UNSUPPORTED_IMAGE``, ``IMAGE_TOO_LARGE``,
``DECODE_FAILED`` or ``INTERNAL_ERROR``; wrong argument types throw a ``TypeError``.

.. list-table::
   :header-rows: 1
   :widths: 40 60

   * - Function
     - Description
   * - ``coreVersion(): string``
     - Version of ``glcm_core``
   * - ``catalog(): NativeCatalog``
     - Features, presets and limits
   * - ``decodeImageFile(path, {maxPixels, maxStackPixels}?): Promise<DecodedImage>``
     - Size, bit depth, ``slices``, channels, warnings, default window, histogram and pixels of an image file; the pages
       of a multi-page TIFF and the frames of a DICOM file are slices, their pixels one slice after another, and
       ``maxStackPixels`` limits all of them together. With ``maxPixels``,
       the size is read from the header first: larger images reject with ``IMAGE_TOO_LARGE`` before decoding, and
       files that are not PNG, JPEG, BMP, TIFF, DICOM or NIfTI with ``DECODE_FAILED``. Also ``valueConversion`` (or
       ``null``); DICOM files give their window as ``windowMin``/``windowMax``
   * - ``inspectNiftiVolume(path, copyPath, {maxBytes}?): Promise<NativeVolumeInfo>``
     - Header, RAS axes, slice geometry, value range, ``storage`` (``{kind, bitDepth, scale, offset}``), conversion and
       window of a NIfTI file, written uncompressed to ``copyPath`` (``glcm::InspectNiftiVolume``)
   * - ``extractNiftiSlice(path, {orientation, slice, volume, storage, maxPixels?, encodePng?}): Promise<DecodedImage & {png}>``
     - One slice as a decoded image (``glcm::ExtractNiftiSlice``), optionally also as a PNG with its pixel spacing
   * - ``extractNiftiStack(path, {orientation, volume, storage, maxPixels?, maxStackPixels?}): Promise<DecodedStack>``
     - Every slice of one volume in one orientation (``glcm::ExtractNiftiStack``), with ``tiff``: an uncompressed
       multi-page TIFF of them
   * - ``decodeDicomSeries(paths, {maxPixels, maxStackPixels}?): Promise<DecodedStack>``
     - The files of a DICOM series as one stack (``glcm::LoadDicomSeries``), with ``tiff`` and ``seriesDescription``
   * - ``renderDisplay(pixels, width, height, bitDepth, min, max, maxSize): Promise<Buffer>``
     - PNG with window/level, downscaled to ``maxSize``
   * - ``roiStats(pixels, width, height, bitDepth, roisJson): Promise<NativeRoiStatistics[]>``
     - Pixel count, bounding box and intensity statistics per ROI
   * - ``selectThresholdRegions(pixels, width, height, bitDepth, min, max, minPixels, maxRegions, maxPixels?, minSphericity?): Promise<{regions, total}>``
     - ``glcm::SelectThresholdRegions``; each region is ``{points, pixelCount, boundingBox}``; ``maxPixels`` and
       ``minSphericity`` may be ``null``
   * - ``selectWandRegion(pixels, width, height, bitDepth, x, y, tolerance): Promise<region | null>``
     - ``glcm::SelectWandRegion``
   * - ``gradientStatistics(pixels, width, height, bitDepth, sigma): Promise<{sigma, percentiles, max}>``
     - ``glcm::ComputeGradientStatistics``
   * - ``renderEdgeMap(pixels, width, height, bitDepth, method, sigma, low, high, maxSize): Promise<Buffer>``
     - ``glcm::RenderEdgeMap``, encoded as an 8-bit PNG
   * - ``livewirePath(pixels, width, height, bitDepth, fromX, fromY, toX, toY, sigma): Promise<Array<[x, y]>>``
     - ``glcm::LivewirePath``
   * - ``combineRois(roisJson, operation, width, height): Promise<{points, pixelCount, boundingBox}>``
     - ``glcm::CombineShapes``
   * - ``brushRoi(roisJson, path, radius, erase, width, height): Promise<{points, pixelCount, boundingBox}>``
     - ``glcm::PaintStroke``; ``path`` is a ``Float64Array`` of x, y pairs and ``roisJson`` holds at most one ROI
   * - ``growRoi(roisJson, operation, distance, spacingX, spacingY, width, height): Promise<{points, pixelCount, boundingBox}>``
     - ``glcm::GrowShape`` with ``operation`` ``"enlarge"``, ``"shrink"`` or ``"band"``; ``roisJson`` holds one ROI
   * - ``validateAnalysis(roisJson, settingsJson): void``
     - Parses and validates an analysis request
   * - ``runAnalysis(pixels, width, height, bitDepth, roisJson, settingsJson, pixelSpacing?): Promise<string>``
     - Every ROI at every distance, as ``glcm-results`` JSON; shape features are in mm with ``pixelSpacing``
       (``{x, y}``), in pixels without it
   * - ``formatResults(resultsJson, format): string``
     - A ``glcm-results`` document written again as ``"csv"`` or canonical ``"json"``
   * - ``exportRoiImages(pixels, width, height, bitDepth, roisJson, settingsJson, transparentOutside, includeQuantized): Promise<ExportedFile[]>``
     - ROI crops, masks, quantized images and manifest as ``{name, data}`` files
   * - ``windowLevel(value, min, max): number``
     - The 8-bit display value of one intensity
   * - ``featureMapGrid(settingsJson, width, height): {step, columns, rows, workPerRow}``
     - Parse and validate feature map settings for an image size; throws ``INVALID_ARGUMENT``. ``workPerRow`` is the
       estimated computing work of one row (``glcm::FeatureMapRowWork``)
   * - ``computeFeatureMap(pixels, width, height, bitDepth, settingsJson, firstRow, rowCount, cancelToken?): Promise<Float32Array>``
     - ``rowCount × columns`` values of rows of a feature map (``glcm::ComputeFeatureMapRows``); rejects with
       ``CANCELLED`` once ``cancelToken`` is cancelled
   * - ``new CancelToken()``, ``token.cancel()``, ``token.cancelled``
     - Stops the ``computeFeatureMap`` calls that received the token after their current point

.. code-block:: javascript

   import * as native from '@glcm/native';

   const image = await native.decodeImageFile('samples/textures/brick.png');
   const rois = [{ id: 'r1', name: 'ROI 1', shape: { type: 'ellipse', cx: 256, cy: 256, rx: 40, ry: 25, angle: 30 } }];
   const settings = { features: ['Contrast', 'Entropy'], grayLevels: 32 };
   const document = JSON.parse(
     await native.runAnalysis(image.pixels, image.width, image.height, image.bitDepth, JSON.stringify(rois), JSON.stringify(settings)),
   );
   console.log(document.results[0].values.Contrast.mean);

Settings objects passed to the addon may omit every field except ``features``; missing fields take the defaults of
``glcm::AnalysisSettings``. The HTTP API requires all fields.

C++ library
-----------

Link against ``glcm_core`` (``add_subdirectory(core)`` and ``target_link_libraries(app PRIVATE glcm_core)``); include
paths are relative to ``core/``. The main entry points:

.. list-table::
   :header-rows: 1
   :widths: 35 65

   * - Header
     - Functions and types
   * - ``imaging/ImageLoader.hpp``
     - ``LoadImageFile``, ``LoadImageBytes`` → ``LoadedImage{gray, info, warnings, window}``; ``LoadImageStackFile`` →
       ``LoadedStack{pixels, slices, info, warnings, window, series_description}``; ``EncodeTiffStack``
   * - ``imaging/DicomReader.hpp``, ``imaging/NiftiReader.hpp``
     - ``LoadDicomFile``, ``LoadDicomBytes``, ``LoadDicomStackFile``, ``LoadDicomSeries``; ``InspectNiftiVolume`` →
       ``NiftiVolumeInfo``, ``ExtractNiftiSlice``, ``ExtractNiftiStack``, ``LoadNiftiFile``, ``SliceOrientation``
   * - ``imaging/ValueConversion.hpp``, ``imaging/PngEncoder.hpp``
     - ``ChooseStorage``, ``StoredSample``, ``ValueConversion``; ``EncodePng`` (with ``pHYs``)
   * - ``roi/Roi.hpp``
     - ``RectangleRoi``, ``EllipseRoi``, ``PolygonRoi``, ``Roi``; ``RasterizeMask``, ``RasterizeCroppedMask``, ``MaskBoundingBox``,
       ``CountMaskPixels``
   * - ``roi/RegionSelection.hpp``
     - ``SelectThresholdRegions`` and ``SelectWandRegion``: connected regions of pixel values, with holes filled, as
       polygon outlines along the pixel edges
   * - ``imaging/EdgeDetection.hpp``
     - ``GradientMagnitude``, ``ComputeGradientStatistics`` and ``RenderEdgeMap`` (Sobel and Canny edge maps)
   * - ``roi/Livewire.hpp``
     - ``LivewirePath``: the cheapest path between two pixels along strong edges
   * - ``roi/RoiOperations.hpp``
     - ``MaskOutline`` (an exact polygon for any mask), ``CombineShapes`` (union, subtract, intersect, xor), ``GrowShape``
       (enlarge, shrink, band) and ``PaintStroke`` (brush, eraser)
   * - ``imaging/ImageHeader.hpp``
     - ``ReadImageSize``, ``ReadImageSizeFromBytes`` → ``ImageSize{width, height, more_images, pixel_spacing}``;
       ``PixelSpacing``, ``SpacingFromDensity``
   * - ``imaging/Quantizer.hpp``
     - ``QuantizationSettings``, ``Quantize``, ``QuantizeReal`` (filtered images)
   * - ``imaging/Resampling.hpp``
     - ``ResampledGrid``, ``ResampledValidSize``, ``ResampleImage``, ``ResampleValues``, ``ResampleShape``
   * - ``imaging/ImageFilters.hpp``
     - ``LaplacianOfGaussian``, ``WaveletImage``, ``WaveletBand``
   * - ``analysis/TextureAnalysis.hpp``
     - ``TextureAnalysis``, ``Type``, ``Direction``, ``Features``, ``TextureOptions``
   * - ``analysis/FirstOrder.hpp``
     - ``ComputeFirstOrderStatistics``, ``IsFirstOrderStatistic``
   * - ``analysis/RunLength.hpp``
     - ``ComputeRunLengthMatrix`` → ``RunLengthMatrix``, ``ComputeRunLengthFeatures``, ``IsRunLengthFeature``
   * - ``analysis/SizeZone.hpp``
     - ``ComputeSizeZoneMatrix`` → ``SizeZoneMatrix``, ``ComputeSizeZoneFeatures``, ``IsSizeZoneFeature``
   * - ``analysis/GrayToneDifference.hpp``
     - ``ComputeGrayToneDifferenceMatrix`` → ``GrayToneDifferenceMatrix``, ``ComputeGrayToneDifferenceFeatures``,
       ``IsGrayToneDifferenceFeature``
   * - ``analysis/LocalBinaryPattern.hpp``
     - ``LocalBinaryPatternCode``, ``ComputeLocalBinaryPatternHistogram``, ``ComputeLocalBinaryPatternFeatures``,
       ``IsLocalBinaryPatternFeature``
   * - ``analysis/Shape.hpp``
     - ``ComputeShapeFeatures(mask, spacing, types)``, ``IsShapeFeature``
   * - ``pipeline/AnalysisSettings.hpp``
     - ``AnalysisSettings``, ``DefaultSettings``, ``ValidateSettings``
   * - ``pipeline/AnalysisRunner.hpp``
     - ``RunAnalysis`` → ``AnalysisOutput{results, cancelled}``, computing every feature family of the settings;
       ``ComputeRegionStatistics``
   * - ``pipeline/FeatureCatalog.hpp``
     - ``FeatureCatalog``, ``FeaturePresets``, ``FeatureTypeFromId``
   * - ``pipeline/FeatureMap.hpp``
     - ``FeatureMapSettings``, ``ResolveFeatureMapGrid``, ``ValidateFeatureMapSettings`` and ``ComputeFeatureMapRows``:
       a co-occurrence feature in a sliding window over the whole image
   * - ``imaging/DisplayRenderer.hpp``
     - ``ComputeDisplayStatistics``, ``WindowLevel``, ``RenderWindowLevel``
   * - ``io/Json.hpp``
     - ``RoiSetToJson``/``RoiSetFromJson``, ``SettingsToJson``/``SettingsFromJson``, ``ResultsToJson``/``ResultsFromJson``
   * - ``io/ResultsCsv.hpp``, ``io/RoiImageExport.hpp``
     - ``ResultsToCsv``; ``ExportRoiImages``, ``SanitizeFileName``

.. code-block:: cpp

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
   // Image name, SHA-256, timestamp, pixel spacing (std::nullopt: no areas in mm²) and value conversion (none)
   std::string csv = glcm::ResultsToCsv(output.results, settings, {"camera.png", "", "2026-09-14T12:00:00Z", std::nullopt, ""});

Functions throw ``std::invalid_argument`` for invalid input (for example invalid settings); ``RunAnalysis`` reports
problems with a single ROI as a ``Skipped`` or ``Failed`` result instead.

File formats
------------

Every JSON file has ``format`` and an integer ``version``; readers reject other formats and unknown versions.

.. list-table::
   :header-rows: 1
   :widths: 25 20 55

   * - Format
     - File
     - Contents
   * - ``glcm-roi-set``
     - ``*.roi.json``
     - ``image`` (name, width, height, bitDepth, ``slices`` for a stack, sha256), optional ``classes`` (``[{name, color}]``)
       and ``rois`` (each with an optional ``class`` and, on a stack, ``slice`` from 1); written by the web app and by
       ``glcm::RoiSetToJson`` (which writes the ROIs' slices but not ``image.slices``)
   * - ``glcm-results``
     - ``*-results.json``
     - ``coreVersion``, ``timestamp``, ``image`` (name, sha256, and ``pixelSpacing`` and ``valueConversion`` when set),
       ``settings`` and ``results`` (``MeasurementResult`` objects); documents from the server also carry ``analysisId``,
       ``status`` and ``image.id``
   * - ``glcm-results-csv``
     - ``*-results.csv``
     - ``# key=value`` lines with the format, versions, image and settings, then a header row and one row per ROI ×
       distance × direction (or per aggregation); a ``roiClass`` column follows ``roiId`` when an ROI has a class, then a
       ``slice`` column when an ROI lies on a slice of a stack.
       After the pixel spacing and value conversion lines come ``# filter=laplacianOfGaussian;sigma=s`` or
       ``# filter=wavelet;wavelet=coif1;band=HH`` with a filter, then ``# resampledPixelSpacingMm=x;y`` with resampling,
       when ``areaMm2`` counts the resampled pixels. The ``quantization``
       bounds of a result are real numbers for a filtered image.
       Non-standard feature columns end with ``[non-standard]``; numbers
       use the shortest text that reads back to the same double; fields are quoted per RFC 4180; text fields starting
       with ``=``, ``+``, ``-``, ``@``, tab or carriage return get a leading ``'`` (CSV injection)
   * - ``glcm-roi-images``
     - ``manifest.json`` in the ROI images ZIP
     - One entry per ROI with its geometry, bounding box, pixel count and file names, or why it was skipped; for a
       stack, the files of each slice are in a folder ``slice-<n>/`` with its own manifest
   * - ``glcm-project``
     - ``*.glcmproj``
     - ``image`` (name, size, bit depth, sha256, optional base64 ``data``), optional ``classes``, ``rois`` (with
       visibility, class and slice), ``settings``
       and ``results`` (finished analyses with their settings)
   * - ImageJ ROI
     - ``*.roi``, ``RoiSet.zip``
     - ImageJ's binary format (``ij/io/RoiDecoder.java``, version 228), not JSON: read into ``glcm-roi-set`` documents
       and written from ROIs by ``readImageJRois`` and ``writeImageJRois`` in ``@glcm/api``, covering the same pixels as
       in ImageJ 1.54p. Names, stroke colours and positions in stacks are kept (the ROI's ``slice`` is written as its
       position; reading takes the position, else the z, else the t position of a hyperstack); classes and groups are not

Example ROI set:

.. code-block:: json

   {
     "format": "glcm-roi-set",
     "version": 1,
     "image": {"name": "mri16.tif", "width": 512, "height": 512, "bitDepth": 16, "sha256": "…"},
     "classes": [{"name": "lesion", "color": "#FF3B3B"}, {"name": "normal", "color": "#39FF6A"}],
     "rois": [
       {"id": "7f3c", "name": "ROI 1", "color": "#FF3B3B", "class": "lesion",
        "shape": {"type": "rectangle", "x": 100, "y": 100, "width": 64, "height": 64}}
     ]
   }
