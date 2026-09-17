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

The command is called ``glcm``. It comes with the application, so you need either a copy of the source, built as
described in `INSTALL.md <https://github.com/markccchiang/texture-workbench/blob/main/INSTALL.md>`_, or the Docker
image, in which it is already installed. Nothing else has to be installed:

.. code-block:: bash

   npx glcm --help                             # in the folder of the source
   docker exec <container> glcm --help         # in a running container

``glcm <command> --help`` explains the options of one command. To use ``glcm`` from any folder, add an alias with the
path of your copy to your shell profile (``~/.zshrc`` or ``~/.bashrc``):

.. code-block:: bash

   alias glcm="node /path/to/texture-workbench/cli/bin/glcm.mjs"

The examples below are written as ``glcm``.

Where the measurements are kept
-------------------------------

Given no other instruction, the command works on your own computer and uses the same folder as the application, so an
image you opened in the browser can be measured from a script, and an image measured from a script is already stored:
opening the same file in the browser finds it by its checksum instead of uploading it again. It needs no running server: it starts everything it needs, measures, and stops.

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
     - Lists the sample images, which can be measured as ``sample:<path>``
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

For a stack (see :ref:`stacks`), that is the whole of every slice, one row per slice with a ``slice`` column;
``--slice 12`` measures only slice 12. More than 1000 ROIs (or slices) are measured in parts of 1000 and written as
one table. ROIs from ``--rois`` are measured on their own slices, and ``glcm regions`` finds
regions on the slice given with ``--slice`` (slice 1 by default) and saves them on it.

A colour image is measured on its luminance. ``--colour`` (on ``info``, ``measure``, ``regions`` and ``feature-map``)
converts it another way first, as *Image ▸ Colour Conversion…* does (see :ref:`colour-images`): ``mean``, ``red``,
``green``, ``blue``, ``hue``, ``saturation``, ``brightness``, ``hematoxylinHe``, ``eosinHe``, ``hematoxylinHdab`` or
``dabHdab``:

.. code-block:: bash

   glcm measure slide.png --colour dabHdab --rois glands.roi.json --out dab.csv

The usual way to measure the *same* regions is to draw them once in the application, save them with *ROI ▸ Export ROI
Set…*, and use that file:

.. code-block:: bash

   glcm measure patient-*.png --rois lungs.roi.json --preset haralick --out study.csv

Images measured with the same settings are written into one table, as a batch measurement in the application would be;
when the settings differ, each group gets its own file. The settings themselves come from the defaults, then a settings
file, then a preset, then single options such as ``--features Contrast,Entropy``, ``--gray-levels 32``,
``--distances 1,2``, ``--quantization fixedRange,0,255``, ``--resample 0.5,0.5`` (see :ref:`resampling <resampling>`; the
image needs a pixel spacing, or ``--spacing``), ``--log-sigma 2`` for the Laplacian of Gaussian or ``--wavelet HH`` for a wavelet sub-band (either with
``--quantization fixedBinWidth,25`` or ``roiMinMax``). They are checked exactly as the Analysis Settings panel
checks them: a combination the application would refuse is refused here too, with the same words.

.. _copy-command:

Copying a measurement as a command
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The application writes the command for you. *Analyze ▸ Copy as Command…* shows the command that repeats *Measure All*
on the open image — every ROI of the ROI Manager, with the current analysis settings:

.. figure:: images/copy-command.png
   :alt: The Copy as Command dialog with the glcm measure command, the note on the saved files, the switch for sending the command to this server, and the buttons Save Files and Copy Command.
   :width: 80%

   A measurement copied as a command.

.. code-block:: bash

   glcm measure camera.png --settings camera.settings.json --rois camera.roi.json --out camera-results.csv

**Save Files** downloads a ZIP with the settings file, the ROI set and a script (``camera-measure.sh``) holding the same
command. Unpack it in the folder with the image and run the command there (or the script, ``sh camera-measure.sh``); the
results go to ``camera-results.csv``. **Copy Command** puts the command on the clipboard.

- The settings file holds the settings exactly as the application sends them for this image, so the command measures
  the same values. Replace the image name, or add more images, to measure other images the same way.
- An image converted by *Image ▸ Colour Conversion…* is named by its colour file, with ``--colour``; a pixel spacing
  entered in *Image Info* (and not stored in the file) is given with ``--spacing``.
- **Send to this server** adds ``--server`` with the application's address, so the command measures on the running
  server, as it must while the application runs on the same folder (see above). On a server with an access token, set
  ``GLCM_API_TOKEN`` before running it.
- The command names the image by its file name, so an image opened from a NIfTI volume or a DICOM series, which has no
  file of its own, needs a file or its image id in its place.

*Analyze ▸ Batch Measure…* has the same button, **Copy as Command…**, for the chosen images and ROIs; the command then
names every image, and an ROI set file chosen in the dialog is used as it is instead of being saved again.

Regions can also be found by intensity, without drawing anything:

.. code-block:: bash

   glcm regions ct-chest.png --min 0 --max 700 --min-pixels 4000 --max-pixels 100000 --out lungs.roi.json
   glcm measure ct-chest.png --rois lungs.roi.json --preset haralick --out lungs.csv

``--max-pixels`` and ``--min-sphericity`` leave out regions that are too large or not round enough, as the Threshold ROI
dialog does; here ``--max-pixels`` leaves out the air around the patient, which also lies in the intensity range.

The ROI set is an ordinary file of the application: *ROI ▸ Import ROI Set…* opens it in the browser to look at what was
measured.

ImageJ's ROI files work the same way: ``--rois`` also takes a ``.roi`` file or a ``RoiSet.zip`` saved by ImageJ's ROI
Manager, measured on the pixels ImageJ measures (see :ref:`imagej-rois`), and an ``--out`` name ending in ``.zip``
writes the regions as a ``RoiSet.zip`` for ImageJ:

.. code-block:: bash

   glcm measure ct-chest.png --rois RoiSet.zip --preset haralick --out lungs.csv
   glcm regions ct-chest.png --min 0 --max 700 --min-pixels 4000 --max-pixels 100000 --out lungs-RoiSet.zip

Every command also has a ``--json`` form, which is what a script should read; ``--help`` after any command explains its
options.

An AI assistant
---------------

``glcm mcp`` offers the same work to an assistant that speaks
`MCP <https://modelcontextprotocol.io>`_, such as Claude. The assistant starts the command itself, so you only add it to
the assistant's configuration; run by hand in a terminal, it just waits for an assistant to connect (:kbd:`Ctrl+C` stops
it).

**Claude Code:**

.. code-block:: bash

   claude mcp add texture-workbench -- node /path/to/texture-workbench/cli/bin/glcm.mjs mcp

**Claude Desktop**, and other assistants that read an ``mcpServers`` file — for Claude Desktop that is
``~/Library/Application Support/Claude/claude_desktop_config.json`` on macOS and
``%APPDATA%\Claude\claude_desktop_config.json`` on Windows:

.. code-block:: json

   {
     "mcpServers": {
       "texture-workbench": { "command": "node", "args": ["/path/to/texture-workbench/cli/bin/glcm.mjs", "mcp"] }
     }
   }

Restart the assistant afterwards; its list of tools then includes ``list_features``, ``list_samples``, ``open_image``,
``view_image``, ``select_regions``, ``measure`` and ``feature_map``. Try, for example: *open
sample:medical/ct-chest.png, show it to me, and compare the texture of the two lungs.*

To let it work with a running or shared server, add the same options as on the command line, for example
``"args": [".../glcm.mjs", "mcp", "--server", "http://127.0.0.1:8080"]``, and ``"--token", "<token>"`` for a server
with a token.

.. tip::

   If the tools do not appear, the assistant most likely cannot find ``node``: applications started from the Dock or
   the Start menu do not see the ``PATH`` of your shell. Put the full path of Node.js in ``command`` (``which node``
   prints it, for example ``/opt/homebrew/bin/node``), make sure the path to ``glcm.mjs`` is absolute, and restart the
   assistant.

The assistant can then open an image, **look** at it (it receives the rendering, or the edge map, as a picture), choose
regions — as rectangles it names by number, or by intensity as above — measure them, and compute a feature map. On a
stack the tools that work on an image (``view_image``, ``select_regions``, ``measure`` and ``feature_map``) take a
``slice`` (from 1), and ``measure`` without regions measures every slice. The same tools, and ``open_image``, take a
``colour`` conversion for colour images. It
cannot draw an outline by hand, which is what the browser is for; a practical way to work is to draw the difficult ROIs
yourself, export them, and let the assistant measure and compare them.

Results come back shortened to a readable table, with the full table written to a file when you ask for one. The
assistant works on the same images and folder as the application, so anything it opens can be looked at in the browser
afterwards.

.. note::

   An assistant runs the MCP server on your own computer, with your own files. The Docker image therefore ships the
   command line but not the MCP server: to let an assistant reach a shared server, run ``glcm mcp`` on your computer and
   give it ``--server`` and ``--token``.
