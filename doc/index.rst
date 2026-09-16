Texture Workbench
=================

Texture Workbench computes texture features of regions of interest (ROIs) in 8- and 16-bit grayscale images: Haralick
features from the Gray Level Co-occurrence Matrix (GLCM), first-order statistics, and run length (GLRLM), size zone
(GLSZM), neighbourhood gray tone difference (NGTDM) and local binary pattern (LBP) features. Users open an image in the
browser, view it with a display window and colour tables, draw rectangle, ellipse, polygon or freehand ROIs, choose the
features and analysis settings, measure, and export the results. A feature map shows how a co-occurrence feature changes
across the whole image, computed in a sliding window and drawn in colour over the image. The application runs on a
single computer (local mode) or on a server shared by several users (server mode).

This documentation has three parts:

- **User guide** explains how to use the application: opening and viewing images, drawing ROIs, measuring, and saving,
  importing and exporting.
- **Texture features** describes exactly how the core (``core/analysis/``) computes each feature: the co-occurrence
  matrices of ``glcm::TextureAnalysis``, the first-order statistics, and the run length, size zone, gray tone difference
  and local binary pattern features. It also lists the literature the features come from and the reference
  implementations (PyRadiomics, scikit-image) they are checked against.
- **Developer guide** describes the architecture of the application, its APIs (HTTP, Node.js addon and C++) and file
  formats, and the technologies and packages it is built with.

For installing and building the application, and setting up its command line and AI assistants, see ``INSTALL.md``
in the repository root, and for testing, configuring and
developing it, ``DEVELOPMENT.md``; for server deployment, see
``doc/deployment.md``.

.. toctree::
   :maxdepth: 2
   :caption: User guide

   user/index
   user/getting-started
   user/viewing
   user/rois
   user/measuring
   user/files
   user/reference

.. toctree::
   :maxdepth: 2
   :caption: Texture features

   equations
   references

.. toctree::
   :maxdepth: 2
   :caption: Developer guide

   developer/index
   developer/architecture
   developer/api
   developer/technologies

Building this documentation
---------------------------

.. code-block:: bash

   cd doc
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   make html

The HTML pages are written to ``doc/_build/html``; open ``doc/_build/html/index.html`` in a browser.
