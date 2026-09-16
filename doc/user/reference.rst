.. _reference:

Keyboard, mouse and menus
=========================

On Windows and Linux, use :kbd:`Ctrl` where :kbd:`⌘` is shown. Keys without modifiers work when the pointer is not in
a text field. *Help ▸ Keyboard Shortcuts* shows a short list in the application.

Keyboard
--------

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Key
     - Action
   * - :kbd:`⌘O`
     - Open an image
   * - :kbd:`⌘S`
     - Save the project
   * - :kbd:`⌘,`
     - Preferences
   * - :kbd:`R` :kbd:`E` :kbd:`P` :kbd:`F` :kbd:`W`
     - Rectangle, ellipse, polygon, freehand, magic wand tool
   * - :kbd:`B` / :kbd:`X`
     - Brush / eraser: paint into or erase from the selected ROI
   * - :kbd:`I`
     - Livewire: an outline that follows edges (:kbd:`Enter` closes it, :kbd:`Backspace` removes the last point)
   * - :kbd:`⇧1` … :kbd:`⇧9` / :kbd:`⇧0`
     - Give the selected ROIs the first … ninth class / remove their class
   * - :kbd:`L`
     - Ruler: measure a distance (:kbd:`Shift` for 45° steps)
   * - :kbd:`T`
     - Add the active ROI to the ROI Manager
   * - :kbd:`Enter`
     - Close the polygon being drawn
   * - :kbd:`Backspace`
     - Remove the last vertex of the polygon being drawn; otherwise delete the selected ROIs
   * - :kbd:`Delete`
     - Delete the selected ROIs
   * - :kbd:`Esc`
     - Cancel the polygon being drawn; otherwise clear the active ROI and the selection
   * - :kbd:`⌘A`
     - Select all ROIs
   * - :kbd:`⌘Z` / :kbd:`⌘⇧Z`
     - Undo / redo ROI changes
   * - Arrow keys
     - Move the selected ROIs by 1 pixel (:kbd:`Shift`: 10 pixels); without a selection, pan the view (:kbd:`Shift`: by
       a whole view)
   * - :kbd:`M` / :kbd:`Shift+M`
     - Measure the selected / all ROIs
   * - :kbd:`+` / :kbd:`−`
     - Zoom in / out
   * - :kbd:`1` / :kbd:`0`
     - Zoom to 100 % / fit the image
   * - :kbd:`Z`
     - Zoom to the selected ROIs
   * - :kbd:`N`
     - Show or hide the navigator
   * - :kbd:`.` / :kbd:`,`
     - Next / previous slice of a stack (also :kbd:`>` / :kbd:`<`)
   * - :kbd:`Space` + drag
     - Pan

Mouse and trackpad
------------------

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Input
     - Action
   * - Mouse wheel, pinch
     - Zoom around the pointer (see *Scroll behaviour* in *Edit ▸ Preferences…*)
   * - Two-finger scroll
     - Pan
   * - :kbd:`⌘` + scroll
     - Zoom
   * - Middle-button drag
     - Pan
   * - Click (Pointer tool)
     - Select an ROI; with :kbd:`Shift`/:kbd:`⌘`, add to or remove from the selection
   * - Drag (Pointer tool)
     - Move the selected ROIs; drag handles to resize or rotate, drag polygon vertices to move them
   * - Double-click a polygon edge
     - Add a vertex to the selected polygon
   * - :kbd:`Alt`-click a polygon vertex
     - Remove the vertex
   * - Hover
     - Pixel value in the status bar; ROI name, shape and pixel count after a moment

Menus
-----

.. list-table::
   :header-rows: 1
   :widths: 15 85

   * - Menu
     - Items
   * - File
     - Open Image…, Open DICOM Series…, Open Sample Image…, Open Project…, Save Project…, Export Results as CSV, Export Results as JSON, Save Report…,
       Close Image, Change Access Token… (servers with an access token)
   * - Edit
     - Undo, Redo, Select All ROIs, Delete ROI, Preferences…
   * - Image
     - Zoom In, Zoom Out, Zoom 100 %, Fit to Window, Zoom to Selection, Window/Level (Auto, Full Range, Custom…), Colour Table (Gray,
       Inverted, Viridis, Magma, Hot), Ruler,
       Image Info
   * - ROI
     - Rectangle, Ellipse, Polygon, Freehand, Livewire, Magic Wand, Brush, Eraser, Threshold ROI…, Union, Subtract, Intersect, XOR, Enlarge or Shrink…, Make Band…, Add to Manager, Duplicate, Copy to All Slices (stacks), Rename, ROI Classes…, Import ROI Set…, Export ROI Set…,
       Export ROIs for ImageJ…, Export ROI Images…
   * - Analyze
     - Measure Selected, Measure All, Batch Measure…, Feature Map…, Presets (the feature presets of the Analysis Settings panel), Clear Results
   * - View
     - Show / Hide Navigator, Show ROI Labels, Show Scale Bar, Show Edge Map, Reset Layout
   * - Help
     - Feature Equations, Keyboard Shortcuts, About

Common questions
----------------

**The ROI Manager shows ⚠ instead of a pixel count.**
   The ROI has fewer than 2 pixels (it may be very small or lie outside the image). Hover the ⚠ to see the reason.

**A result has the status "failed" and mentions the gray level range.**
   With quantization *None*, every intensity must be below the number of gray levels. Choose *Fixed range* or
   *ROI min–max*, or increase the gray levels.

**The Status column shows ⚠.**
   Hover the row to read the warnings, for example that there are no pixel pairs in a direction at the chosen distance,
   or that the score coefficients may not apply to the settings.

**The window slider reacts with a delay.**
   The image is larger than 4096 × 4096 pixels and is rendered by the server. Measurements are not affected.

**The application asks for an access token again.**
   The token is kept only for the browser tab, and a server administrator may have changed it. Ask for the current
   token.
