.. _user-guide:

User guide
==========

Texture Workbench measures the texture of regions in images. A typical session has five steps:

#. **Open an image** — PNG, JPEG, BMP or TIFF with 8 or 16 bits per pixel, a DICOM image or series, or a NIfTI volume;
   multi-page files and volumes open as stacks, and colour images can be measured by channel, HSB component or stain
   (:ref:`getting-started`).
#. **Look at it** — zoom, pan, adjust the display window and choose a colour table to see the structures you want to
   measure; measure distances with the ruler and plot a line profile or a histogram (:ref:`viewing`).
#. **Draw regions of interest (ROIs)** — rectangles, ellipses, polygons or freehand outlines, or regions selected by
   intensity with the magic wand or Threshold ROI, collected in the ROI
   Manager (:ref:`rois`).
#. **Measure** — choose the texture features and the analysis settings, and measure the selected or all ROIs, or the
   same ROIs on a batch of images; the results appear in a table and as plots. A feature map shows one feature across
   the whole image (:ref:`measuring`).
#. **Save and export** — export the results as CSV or JSON or as a report, save the ROIs for another session (also as
   ImageJ ROI files), export the ROI images, or save everything as a project (:ref:`files`).

The same measurements can be made without the browser: from a command line for scripts and repeated work, or by an AI
assistant that looks at the images and picks out regions with you (:ref:`scripting`).

.. figure:: images/main-window.png
   :alt: The main window with the sample image, four ROIs, the ROI Manager, the analysis settings and the results table, with numbered markers 1–7 that the Getting started page explains.
   :width: 100%

   The main window after measuring four ROIs on the sample image.

The application runs in a web browser (a current version of Chrome, Edge, Firefox or Safari). It can run on your own
computer, or on a server that several people use; the guide points out where the two differ.

The texture features and the settings that control them are defined precisely in :doc:`../equations`.

.. toctree::
   :maxdepth: 2

   getting-started
   viewing
   rois
   measuring
   files
   scripting
   reference
