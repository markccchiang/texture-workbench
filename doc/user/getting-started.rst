.. _getting-started:

Getting started
===============

Starting the application
------------------------

**On your own computer**, build and start the server once the requirements in ``INSTALL.md`` are installed:

.. code-block:: bash

   npm install
   npm run build:native
   npm run build:web
   npm start

Then open http://127.0.0.1:8080 in your browser. The server only accepts connections from this computer, and your
images and results are stored in ``~/.glcm-texture-analysis``. Stop the server with :kbd:`Ctrl+C` in the terminal.
The same build also gives you the ``glcm`` command and an MCP server for AI assistants, described in :ref:`scripting`.

**On a shared server**, open the address your administrator gives you. The first time, the application asks for an
**access token**:

.. figure:: images/token-prompt.png
   :alt: The Access token dialog with a password field and a Continue button.
   :align: center

   Servers shared by several people require an access token.

Paste the token and choose **Continue**. The token is kept only for this browser tab; after closing the tab, you are
asked again. To enter a different token, choose *File ▸ Change Access Token…*. On a shared server, uploaded images and
results are usually deleted automatically after some days (7 by default), so export or save what you want to keep
(see :ref:`files`).

Opening an image
----------------

.. figure:: images/start-screen.png
   :alt: The start screen with the buttons Open Image and Open sample image.
   :width: 100%

   The start screen.

There are three ways to open an image:

- **Open Image…** on the start screen or in the *File* menu (:kbd:`⌘O` / :kbd:`Ctrl+O`) shows the file dialog.
- **Drag** an image file from your desktop or file manager onto the window.
- **Open sample image** opens ``textures/camera.png``, the cameraman photograph; **More sample images…** (or *File ▸ Open Sample Image…*) lists synthetic
  test patterns, natural textures and medical images (chest and abdominal CT slices, a brain MRI slice, a chest X-ray and a mammogram, all 16-bit).

Supported files are PNG, JPEG, BMP and TIFF with 8 or 16 bits per pixel, uncompressed DICOM images and NIfTI files
(see :ref:`medical-files`). The image is uploaded to the server, which decodes it:

- **Color images** are converted to grayscale, and a notification says so.
- **Multi-page TIFF files** open with their first page only, and a notification says so.
- **16-bit images** keep their full intensity range for measurements; the display uses a window (see
  :ref:`window-level`).
- **Limits:** by default an image can have up to 200 MB and 20 000 × 20 000 pixels on your own computer (100 MB and
  10 000 × 10 000 pixels on a shared server). Larger files are rejected with a message.

Opening another image replaces the current one, together with its ROIs; the results table keeps its rows. *File ▸
Close Image* closes the image. *Image ▸ Image Info* shows the file name, size, bit depth, channels, the value
conversion of DICOM and NIfTI files, default display window and SHA-256 checksum of the open image.

.. _medical-files:

DICOM and NIfTI files
~~~~~~~~~~~~~~~~~~~~~

**DICOM** files (``.dcm``, or any name) open like other images when they are uncompressed (implicit or explicit VR
little endian). Compressed DICOM files (JPEG, JPEG-LS, JPEG 2000 or RLE) are refused with a message; convert them first,
for example with ``dcmdjpeg`` or ``gdcmconv --raw``. A file with several frames opens with its first frame.

**NIfTI** files (``.nii`` or ``.nii.gz``, NIfTI-1 or NIfTI-2) hold volumes. When a 3D or 4D file opens, a dialog asks
which slice to open:

.. figure:: images/volume-import.png
   :alt: The Open Slice dialog with the orientation buttons, a preview of an axial slice and the slice slider.
   :width: 60%

   Choosing a slice of a NIfTI volume.

- **Orientation**: *Axial*, *Coronal* or *Sagittal*. Slices are shown in RAS orientation, whatever the order of the
  axes in the file: axial slices with the patient's right on the right and anterior at the top; coronal slices with
  superior at the top; sagittal slices with anterior on the right. The letters on the edges of the preview give the
  directions. The dialog starts in the plane of the file's first two axes, at the middle slice.
- **Slice** (0 is the most inferior, posterior or left slice) and, for 4D files, **Volume** (for example a time point).
  The arrow keys move the focused slider one step.
- **Open Slice** opens the slice as a normal 2D image named like ``brain.nii.gz [axial 120]`` (with ``, volume 3``
  for 4D files). Its pixel spacing is the in-plane voxel size. Open the file again to choose another slice.

A NIfTI file with a single slice opens directly.

**Values.** Measurements use 8- or 16-bit samples, so the values of DICOM and NIfTI files are converted, and the
conversion is shown in *Image Info* and written into exported results (``valueConversion``):

- The rescale is applied first: RescaleSlope and RescaleIntercept (DICOM), or ``scl_slope`` and ``scl_inter`` (NIfTI).
- Integer values between 0 and 65 535 are stored unchanged.
- Integer values with a negative minimum are stored + 1024. For CT this is HU + 1024, as in the CT samples: air
  (−1000 HU) is stored as 24 and water as 1024. In CT files, lower values (outside the scan field) are stored as 0,
  and a notification says so. For NIfTI files, whose modality is not known, this applies when the minimum is at
  least −1024.
- Other values (for example floating-point data) are mapped linearly from their minimum–maximum to 0–65 535; for
  NIfTI files the minimum and maximum of the whole file, so all slices are stored alike.
- DICOM **MONOCHROME1** images, where low values are bright, are inverted so that bright means dense.

For example, *Rescale slope 1, intercept -1024; values stored + 1024; HU = stored value - 1024*. Texture features
are computed from the stored samples.

**Metadata.** DICOM PixelSpacing (or ImagerPixelSpacing, the spacing at the detector) gives the pixel spacing, and
the first WindowCenter/WindowWidth the initial display window. NIfTI slices open with the window of the whole file
(its 0.5th and 99.5th percentiles). By default a volume can have up to 4 GB of voxel data (1 GB on a shared server).

.. _main-window:

The main window
---------------

.. figure:: images/main-window.png
   :alt: The main window with numbered areas.
   :width: 100%

   Areas of the main window.

#. **Menu bar** — *File*, *Edit*, *Image*, *ROI*, *Analyze*, *View* and *Help*. The badge at the right shows
   **Local** on your own computer, or the server name.
#. **Toolbar** — pointer and pan tools, the four ROI tools, zoom, the display window, and **Measure**.
#. **Image canvas** — the image with its ROIs. A navigator appears in the corner when the image is larger than the
   view.
#. **ROI Manager** — the ROIs of the image with their pixel counts.
#. **Analysis Settings** — the features and GLCM parameters used by the next measurement.
#. **Results** — one or more rows for every measured ROI.
#. **Status bar** — the position and value of the pixel under the pointer, the zoom, the image, the selected ROI and
   its pixel count, the progress of running measurements, and how the image is rendered.

The panels can be resized by dragging the borders between them; the side panel (ROI Manager and settings) and the
Results panel can be collapsed by dragging their border all the way. The layout is remembered; *View ▸ Reset Layout*
restores it.
