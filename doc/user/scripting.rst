.. _scripting:

Without the browser: the command line and AI assistants
=======================================================

Everything the application does through the browser it can also do from a command line, and an AI assistant can drive it
too. The measurements are the same in every case: the same code computes them, and the results carry the same image
checksums and settings.

This is worth using when

- the same ROIs have to be measured on many images, again and again, as part of a script or a pipeline;
- measurements should run on a server or overnight, without anyone watching;
- you would like an assistant such as Claude to look at an image, pick out regions and compare their texture with you.

What you need
-------------

The command is called ``glcm``. It comes with the application, so you need either a copy of the source (see
`INSTALL.md <https://github.com/markccchiang/texture-workbench/blob/main/INSTALL.md>`_) or the Docker image, in which it
is already installed:

.. code-block:: bash

   npm run cli -- --help                       # from a copy of the source
   docker exec <container> glcm --help         # in a running container

Where the measurements are kept
-------------------------------

Given no other instruction, the command works on your own computer and uses the same folder as the application, so an
image you opened in the browser can be measured from a script, and an image measured from a script appears in the
browser's *File ▸ Open Image…* history. It needs no running server: it starts everything it needs, measures, and stops.

To use a server instead — a shared one, or the one already running on your own computer — name it:

.. code-block:: bash

   glcm measure image.png --server http://127.0.0.1:8080 --token "$GLCM_API_TOKEN"

Give ``--server`` whenever a server is running on the same folder, for example inside a container. The command refuses
to start a second one there, because that would interrupt uploads in progress, and tells you which address to use.

The commands
------------

.. list-table::
   :header-rows: 1
   :widths: 42 58

   * - Command
     - What it does
   * - ``glcm features``
     - Lists the texture features, or with ``--presets`` the groups of features you can choose by name
   * - ``glcm samples``
     - Lists the sample images, which can be measured as ``sample:<name>``
   * - ``glcm info <image>``
     - Size, bit depth, display window, pixel spacing, value conversion and checksum of an image
   * - ``glcm measure <image…>``
     - Measures ROIs and writes the results as CSV or JSON
   * - ``glcm regions <image>``
     - Finds regions by intensity and saves them as an ROI set the application also reads
   * - ``glcm feature-map <image>``
     - Computes one feature over the whole image and saves it as a 32-bit TIFF
   * - ``glcm mcp``
     - Serves the same work to an AI assistant (below)

``<image>`` is a file, a sample (``sample:textures/brick.png``), or an image the server already has. A file is
recognised by its checksum, so measuring it again does not upload it again.

Measuring
---------

Without ROIs the whole image is measured:

.. code-block:: bash

   glcm measure ct-chest.png --preset haralick --out chest.csv

The usual way to measure the *same* regions is to draw them once in the application, save them with *ROI ▸ Export ROI
Set…*, and use that file:

.. code-block:: bash

   glcm measure patient-*.png --rois lungs.roi.json --preset haralick --out study.csv

Images measured with the same settings are written into one table, as a batch measurement in the application would be;
when the settings differ, each group gets its own file. The settings themselves come from the defaults, then a settings
file, then a preset, then single options such as ``--features Contrast,Entropy``, ``--gray-levels 32``,
``--distances 1,2`` and ``--quantization fixedRange,0,255``. They are checked exactly as the Analysis Settings panel
checks them: a combination the application would refuse is refused here too, with the same words.

Regions can also be found by intensity, without drawing anything:

.. code-block:: bash

   glcm regions ct-chest.png --min 0 --max 700 --min-pixels 4000 --out lungs.roi.json
   glcm measure ct-chest.png --rois lungs.roi.json --preset haralick --out lungs.csv

The ROI set is an ordinary file of the application: *ROI ▸ Import ROI Set…* opens it in the browser to look at what was
measured.

Every command also has a ``--json`` form, which is what a script should read; ``--help`` after any command explains its
options.

An AI assistant
---------------

``glcm mcp`` offers the same work to an assistant that speaks
`MCP <https://modelcontextprotocol.io>`_, such as Claude. Add it to the assistant's configuration:

.. code-block:: json

   {
     "mcpServers": {
       "texture-workbench": { "command": "node", "args": ["/path/to/texture-workbench/cli/bin/glcm.mjs", "mcp"] }
     }
   }

The assistant can then open an image, **look** at it (it receives the rendering, or the edge map, as a picture), choose
regions — as rectangles it names by number, or by intensity as above — measure them, and compute a feature map. It
cannot draw an outline by hand, which is what the browser is for; a practical way to work is to draw the difficult ROIs
yourself, export them, and let the assistant measure and compare them.

Results come back shortened to a readable table, with the full table written to a file when you ask for one. The
assistant works on the same images and folder as the application, so anything it opens can be looked at in the browser
afterwards.

.. note::

   An assistant runs the MCP server on your own computer, with your own files. The Docker image therefore ships the
   command line but not the MCP server: to let an assistant reach a shared server, run ``glcm mcp`` on your computer and
   give it ``--server`` and ``--token``.
