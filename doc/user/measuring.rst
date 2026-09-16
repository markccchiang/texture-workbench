.. _measuring:

Measuring
=========

Analysis settings
-----------------

The **Analysis Settings** panel decides what the next measurement computes. The settings are remembered between
sessions, and results already in the table keep the settings they were measured with.

.. figure:: images/analysis-settings.png
   :alt: The Analysis Settings panel with preset, features, gray levels, quantization, distances, directions and
         aggregation.
   :align: center

   The Analysis Settings panel.

.. list-table::
   :header-rows: 1
   :widths: 22 78

   * - Setting
     - Meaning
   * - **Preset**
     - A named set of features: *Haralick F1–F14*, *Clausi (2002): Contrast, Correlation, Entropy*, *Basic*,
       *Score (Mean, Entropy, Contrast)* (the inputs of the age-based score, with the score switched on), one preset
       per feature family (*First-order statistics*, *Run length (GLRLM)*, *Size zone (GLSZM)*, *Gray tone difference
       (NGTDM)*, *Local binary patterns (LBP)* and *Shape (2D)*), or *All features*. Changing the features by hand shows *Custom*.
       The presets are also in *Analyze ▸ Presets*.
   * - **Features**
     - The features to compute. **N selected…** opens the feature picker.
   * - **Gray levels (Ng)**
     - How many gray levels the intensities are reduced to for the co-occurrence, run length, size zone and gray tone
       difference features and for first-order entropy and uniformity: 2–256; the menu in the field offers 8, 16, 32,
       64, 128 and 256. More levels keep more detail but need larger regions for stable values. The other first-order
       statistics and the local binary patterns use the original intensities, and shape features no intensities at all.
   * - **Quantization**
     - How intensities are mapped to gray levels: **Fixed range** (from *Min* to *Max*, the same for every ROI —
       usually the full range of the image), **ROI min–max** (from the lowest to the highest intensity inside each
       ROI), **Fixed bin width** (a fixed number of intensities per gray level) or **None** (intensities are used
       directly and must be below Ng).
   * - **Distances**
     - Distances in pixels, e.g. ``1, 2, 4``; each distance is measured separately. The distance is the gap between the
       two pixels of a co-occurrence pair, the ring of neighbours of the gray tone difference features and the radius
       of the local binary patterns. First-order statistics, run length, size zone and shape features give the same
       values at every distance.
   * - **Directions**
     - The directions of co-occurrence pairs and runs: 0° (horizontal), 45°, 90° (vertical) and 135°. The other
       features have no direction and report the same value for each selected direction.
   * - **Aggregation**
     - Which rows the results show per ROI and distance: **Per direction + mean**, **Mean only**, or **Mean + range**
       (mean and range over the directions, as proposed by Haralick in 1973).
   * - **Log base** (Advanced)
     - Natural logarithm, or log₂ to compare entropies with tools such as PyRadiomics or mahotas.
   * - **Age-based score** (Advanced)
     - Adds a *Score* column computed from the age, mean, entropy and contrast with the given coefficients.
   * - **Filter** (Advanced)
     - *Laplacian of Gaussian* measures the image after a filter that brings out spots and edges about **Sigma** wide
       (in mm with a pixel spacing, in pixels without). *Wavelet (Coiflet 1)* measures one **Sub-band** of a wavelet
       transform: LL a smoothed image, LH horizontal edges, HL vertical edges, HH fine diagonal detail. Filtered values
       are real numbers, so the quantization must be a fixed
       bin width or ROI min–max (choosing the filter switches to a bin width of 25, PyRadiomics' default), and local
       binary patterns and the score are not available. See :ref:`Resampling <resampling>` below.
   * - **Resample before measuring** (Advanced)
     - Resamples the image to other pixels, in millimetres, before measuring — usually square pixels (**Square pixels
       of …** chooses the finer of the image's two spacings), so that neighbours in all four directions lie equally far
       apart. Needs a pixel spacing (see :ref:`pixel-spacing`). See :ref:`Resampling <resampling>` below.

Problems with the settings are listed at the bottom of the panel: errors in red prevent measuring, warnings in yellow
point out, for example, that the Maximal Correlation Coefficient is slow for more than 64 gray levels. **Reset to
defaults** restores the default settings (Haralick features, 32 gray levels, full fixed range, distance 1, all
directions).

The **undo** and **redo** buttons at the top of the panel step back and forth through your changes to the settings,
including choosing a preset or resetting to the defaults. Opening a project starts a new history. :kbd:`⌘Z` /
:kbd:`Ctrl+Z` keeps undoing ROI changes only.

.. figure:: images/feature-picker.png
   :alt: The feature picker with a search field and checkboxes grouped into first-order statistics, Haralick features,
         other co-occurrence features, run length (GLRLM), size zone (GLSZM), gray tone difference (NGTDM) and local
         binary pattern (LBP) features; Correlation III and Sum of Squares are marked non-standard.
   :align: center

   The feature picker.

.. _resampling:

**Resampling.** With *Resample before measuring*, each measurement first computes a new image with pixels of the given
size: the intensities are interpolated with a cubic B-spline, as PyRadiomics resamples images, and rounded to whole
values, and each ROI is laid on the new pixels with its exact shape. The image in the viewer does not change. Pixel
counts, areas and shape features then refer to the new pixels, and the exported results record the new spacing
(``# resampledPixelSpacingMm``) next to the image's own. Resampling to finer pixels does not add detail: it makes
distances and directions comparable between images of different or non-square pixels. With a **Filter** as well, the
image is resampled first and then filtered. Details of both are in :doc:`../equations`.

**Shape features** (perimeter, sphericity, maximum diameter, axis lengths and others) describe the outline of each ROI
rather than its texture. They are in millimetres, and surfaces in mm², when the image has a pixel spacing (see
:ref:`pixel-spacing`), and in pixels otherwise; the exported results record which spacing was used. Compare lengths and
surfaces only between measurements with the same spacing; sphericity and elongation have no unit.

In the **feature picker**, features are grouped as in :doc:`../equations`. Type in the search field to filter them;
**Select all** and **Clear all** apply to the listed features. Two features are marked **⚠ non-standard**
(*Correlation III* and *Sum of Squares (in x and y)*): they follow a formula as printed in a later paper rather than
the original definition; hover the badge for details. Features marked **slow** take noticeably longer for many gray
levels. *Help ▸ Feature Equations* lists every feature by group and opens the equations when the server provides the
built documentation.

.. rubric:: The age-based score

The score combines the age with the mean intensity, entropy and contrast using four coefficients. Its coefficients were
fitted for 8-bit images with 256 gray levels, distance 1 and all four directions. With the **Calibration** profile
(default) its inputs are always computed that way, whatever the other settings are; 16-bit images are first mapped to
0–255 using the display window. With the **Current settings** profile the inputs use the panel's settings, and the
results carry a warning that the coefficients may not apply. **Reset age and coefficients** restores the defaults.

.. _measure-rois:

Measuring ROIs
--------------

- **Measure** in the toolbar, :kbd:`M` or *Analyze ▸ Measure Selected* measures the selected ROIs (or the active ROI, if
  none is selected).
- The arrow next to **Measure**, :kbd:`Shift+M` or *Analyze ▸ Measure All* measures every ROI in the ROI Manager.

Each ROI is measured at each distance as a separate job. While jobs run, the status bar shows their progress, for
example *3/8 jobs*; the **×** next to it cancels the measurement (jobs already started still finish, and their results
are kept). You can keep working — drawing ROIs or changing the settings does not affect a running measurement.

In a stack, each ROI is measured on the slice it lies on, whichever slice is shown; *Measure All* measures the ROIs of
every slice (see :ref:`stacks`). One measurement takes at most 1000 ROIs; more, for example an ROI copied onto every
slice of a large stack, are measured as several measurements one after another, each with its own rows.

Measuring many images
---------------------

*Analyze ▸ Batch Measure…* measures the same ROIs on several images with the current analysis settings:

1. Choose where the ROIs come from: the **ROI Manager** (the ROIs of the open image) or an **ROI set file**
   (``.roi.json``, or ImageJ's ``.roi`` and ``RoiSet.zip``; see :doc:`files`).
2. Choose the **Images** (PNG, JPEG, BMP, TIFF, DICOM or 2D NIfTI; several at once).
3. Click **Measure N images**.

The images are measured one after another. For each image the dialog lists its status (*Uploading*, *Measuring*,
*Done*, *Skipped*, *Failed* or *Cancelled*) and the finished jobs:

- An image the server already has (same SHA-256) is not uploaded again.
- ROIs are clipped to images of another size, as when importing an ROI set; ROIs that lie entirely outside an image are
  left out, and an image without any ROI on it is *Skipped*.
- The settings are fitted to each image's bit depth, like when opening an image. An image whose settings are invalid,
  or that cannot be read, is marked *Failed* and the batch goes on with the next one.

Each measured image is added to the Results table; once the rows come from more than one image the table shows an
**Image** column. **Cancel batch** stops the running measurement and the images after it. Closing the dialog does not
stop the batch; reopen it to see the progress.

**Download combined CSV** saves the results of every finished image as one CSV file, with the settings as comment lines
once (``# images=`` gives the number of images) and the ``image`` and ``imageSha256`` columns telling the rows apart.
If the images needed different settings, for example 8-bit and 16-bit images with a fixed quantization range, the
download is a ZIP with one CSV per group of settings.

.. _feature-maps:

Feature maps
------------

A **feature map** shows how a co-occurrence feature, for example Contrast or Entropy, changes across the whole image.
*Analyze ▸ Feature Map…* computes the feature in a small square window around many points of the image and draws the
values in colour over the image:

- **Feature** — any Haralick or other co-occurrence feature except the Maximal Correlation Coefficient, which is too
  slow to compute for every window.
- **Window** — the side of the square window in pixels, an odd number from 3 to 127 (15 by default). Windows at the
  edges of the image are cut off by the edges.
- **Distance** — one of the distances of the analysis settings; it must be smaller than the window.
- **Step** — the spacing of the points. *Automatic* chooses the smallest step that gives at most 512 points along each
  side (1 for images up to 512 pixels, 8 for 4096 pixels). With *Manual* you choose it, up to 2048 points along a side.
  Each point stands for the block of *step × step* pixels around it, and its window is centred in that block.

The gray levels, quantization, directions and logarithm come from the analysis settings. The quantization applies to
the whole image: *ROI min–max* uses the image minimum and maximum, and *Fixed bin width* starts at the image minimum.
Each point is the mean over the selected directions; a point whose window has no pixel pairs at the distance in some
direction has no value and stays transparent.

.. figure:: images/feature-map.png
   :alt: The camera image with a Contrast map in the Magma colour table over it, and the feature map card with the colour bar, window, colour table, opacity and save buttons.
   :width: 100%

   A Contrast map over the image, with the feature map card.

The map is computed on the server, which shares its workers with measurements. While it runs, a card in the top-right
corner of the image shows the progress; its **×** cancels the map at once. When the map is done, the card controls how it looks:

- **Min** and **Max** set the map's own window: values at or below Min get the first colour, values at or above Max the
  last. **Auto** uses the 0.5 and 99.5 percentiles of the values (the default); **Full range** the smallest and largest
  value.
- **Colour table** — the same tables as for the image (Viridis by default), independent of the image's colour table.
- **Opacity** and **Show over the image** blend the map with the image or hide it.
- Moving the pointer over the image shows the map value of the point under it.
- **Save PNG** saves the map in its colours, one pixel per point. **Save TIFF** saves the values as a 32-bit
  floating-point TIFF (one pixel per point, points without a value as NaN) for other image tools; its description
  records the image and settings.

In a stack the map covers the slice shown when it was started, and it is hidden on other slices. There is one map at a
time. The **×** closes it, and opening another image closes it too. Maps are not saved in projects;
save them as PNG or TIFF to keep them.

Results
-------

.. figure:: images/results-table.png
   :alt: The Results table with columns ROI, d, Dir, Pixels, Ng, the features, Score and Status.
   :width: 100%

   The Results table.

Every measurement adds rows to the **Results** table:

- One row per **ROI**, **distance** (``d``) and **direction** (``Dir``: 0°, 45°, 90°, 135°, Mean or Range, depending
  on the aggregation), with the **pixel count**, the **area** in mm² (once a measurement had a pixel spacing, see
  :doc:`viewing`), the **gray levels** and one column per feature. The **Score** column
  appears when a measurement included the score.
- Values are shown with six significant digits; copied and exported values have full precision.
- Once a measured ROI has a class (see :ref:`roi-classes`), a **Class** column follows the ROI name, and once a
  measured ROI lies on a slice of a stack, a **Slice** column.
- **Status** is empty for normal results, **⚠** when the result has warnings, or *skipped* / *failed* with the reason —
  for example an ROI with fewer than 2 pixels, or intensities above the gray levels when quantization is *None*.
- Hover a row to see the image and settings it was measured with, and its warnings. Hovering also highlights the ROI
  on the canvas; clicking selects it.

Use the buttons above the table to work with it:

- Click a **column header** to sort by it; click again to reverse the order, and a third time to restore the order of
  measurement.
- **Columns** shows or hides columns.
- When the rows come from ROIs of more than one class, a class list shows **All classes** or the rows of one class
  (or those without a class). Copy then copies the rows shown.
- **Copy** copies the table (visible columns, current order) as tab-separated text, ready to paste into a spreadsheet.
  Text cells starting with ``=``, ``+``, ``-`` or ``@`` get a leading apostrophe, so the spreadsheet does not run them
  as formulas.
- **Export** saves the results as CSV or JSON (see :ref:`export-results`).
- The trash button clears the table (*Analyze ▸ Clear Results*).

Plots
~~~~~

**Plot** (next to **Table** above the results) draws one feature of the measurements as a chart; choose the feature
from the list next to the chart types:

- **Bars**: one bar per ROI with the mean over the directions at one distance (choose it when you measured several);
  the whiskers span the values of the single directions.
- **Box**: per ROI, the values of every measured direction at every distance, as the median, the quartiles (linear
  interpolation) and the range.
- **Directions**: a polar plot of the value in each direction at one distance. A co-occurrence matrix counts both
  neighbours of each pixel, so θ and θ + 180° have the same value and the shape is symmetric; an elongated shape shows
  directional texture. The rings are labelled with their values, and the centre is not zero.
- **Distance**: the mean over the directions against the distance ``d``, one line per ROI.

.. figure:: images/results-plot-directions.png
   :alt: The Plot view with a polar plot of Contrast per direction for four ROIs.
   :width: 100%

   Contrast per direction for four ROIs.

Each ROI keeps its colour from the ROI Manager, and hovering its bar, box or line highlights the ROI on the canvas.
When an ROI was measured more than once at the same distance, the latest measurement is plotted; after a batch, the
series are named after the image and the ROI. **Save SVG** saves the chart as an SVG file.

When measured ROIs have classes, **Group by class** appears for the Bars and Box charts. Bars then shows one bar per
class: the mean of its ROIs' means at the chosen distance, with whiskers spanning the ROI means. Box shows the direction
values of all ROIs of each class at every distance. Classes are drawn in their colours, and ROIs without a class form a
*No class* group.

.. note::

   The first-order statistics (Mean, Std, Minimum to Kurtosis) are computed from the original intensities of the ROI.
   First-order Entropy and Uniformity and all texture features (co-occurrence, run length, size zone and gray tone
   difference) use the quantized gray levels, so they depend on the gray levels and quantization settings. Run length
   and size zone features do not depend on the distance: every distance gives the same values. Size zone and gray tone
   difference features have no direction; for gray tone difference features, the distance sets the neighbourhood.
   Local binary pattern features use the original intensities, including the pixels just around the ROI, with the
   distance as the radius of the circle of samples. The formulas are listed in
   :doc:`../equations`.
