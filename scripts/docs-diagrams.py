#!/usr/bin/env python3
"""Draws the data-flow diagrams of doc/developer/architecture.rst as SVG files in doc/developer/images/.

The diagrams share the colours, fonts and shapes of the hand-written architecture-overview.svg: blue for the web app,
green for the API server, purple for the addon, orange for the C++ core and teal for the data directory. After changing
a flow, run this script (standard library only) and rebuild the documentation:

    python3 scripts/docs-diagrams.py
"""

from html import escape
from pathlib import Path

OUTPUT = Path(__file__).resolve().parent.parent / 'doc' / 'developer' / 'images'

SANS = "'Inter', 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif"
MONO = "'SFMono-Regular', Menlo, Consolas, monospace"
INK = '#1e293b'
BODY = '#334155'
MUTED = '#64748b'
LINE = '#475569'
FAINT = '#cbd5e1'

# Accent, fill and border of each part of the system
COLORS = {
    'web': ('#3b73d9', '#eef4fe', '#bcd2f7'),
    'server': ('#2e9d62', '#edf8f1', '#b7e2c8'),
    'addon': ('#7c4ddb', '#f3eefc', '#d6c6f5'),
    'core': ('#e07b00', '#fff5e8', '#f5cf9c'),
    'data': ('#0e9aa7', '#e8f7f8', '#a9dde2'),
}
# Outcome pills of the batch flow: text/border and fill
STATUS = {
    'done': ('#23794b', '#e3f5ea'),
    'skipped': ('#9a6212', '#fdf3dc'),
    'failed': ('#c23b3b', '#fde8e8'),
    'cancelled': ('#526074', '#eef1f5'),
}

DEFS = """  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#475569"/>
    </marker>
    <marker id="arrow-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#64748b"/>
    </marker>
    <filter id="shadow" x="-10%" y="-20%" width="120%" height="150%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" flood-color="#0f172a" flood-opacity="0.10"/>
    </filter>
  </defs>
"""


def text_width(content: str, size: float, mono: bool = False, upper: bool = False) -> float:
    return len(content) * size * (0.61 if mono else 0.72 if upper else 0.55)


def text(x, y, content, size=12.0, weight=None, fill=INK, anchor='start', mono=False, spacing=None, transform=None) -> str:
    attributes = [f'x="{x:.1f}"', f'y="{y:.1f}"', f'font-size="{size}"', f'fill="{fill}"']
    if weight:
        attributes.append(f'font-weight="{weight}"')
    if anchor != 'start':
        attributes.append(f'text-anchor="{anchor}"')
    if mono:
        attributes.append(f'font-family="{MONO}"')
    if spacing:
        attributes.append(f'letter-spacing="{spacing}"')
    if transform:
        attributes.append(f'transform="{transform}"')
    return f'  <text {" ".join(attributes)}>{escape(content, quote=False)}</text>\n'


class Drawing:
    def __init__(self, title: str, description: str, width: int = 960):
        self.title = title
        self.description = description
        self.width = width
        self.back: list[str] = []
        self.parts: list[str] = []

    def add(self, element: str, back: bool = False) -> None:
        (self.back if back else self.parts).append(element)

    def section_label(self, x, y, label) -> None:
        self.add(text(x, y, label.upper(), 10.5, 700, MUTED, spacing='0.08em'))

    def box(self, cx, cy, w, h, title, subtitle=None, color='web', strong=False, mono_title=False) -> None:
        accent, fill, border = COLORS[color]
        x, y = cx - w / 2, cy - h / 2
        stroke = f'stroke="{accent}" stroke-width="1.8"' if strong else f'stroke="{border}" stroke-width="1.4"'
        self.add(f'  <g filter="url(#shadow)"><rect x="{x:.1f}" y="{y:.1f}" width="{w}" height="{h}" rx="10" fill="{fill}" {stroke}/></g>\n')
        if subtitle:
            self.add(text(cx, cy - 3, title, 12.5, 600, INK, 'middle', mono=mono_title))
            self.add(text(cx, cy + 13, subtitle, 10.5, None, MUTED, 'middle', mono=True))
        else:
            self.add(text(cx, cy + 4.5, title, 12.5, 600, INK, 'middle', mono=mono_title))

    def diamond(self, cx, cy, w, h, title, detail=None) -> None:
        points = f'{cx},{cy - h / 2} {cx + w / 2},{cy} {cx},{cy + h / 2} {cx - w / 2},{cy}'
        self.add(f'  <g filter="url(#shadow)"><polygon points="{points}" fill="#ffffff" stroke="#94a3b8" stroke-width="1.4"/></g>\n')
        if detail:
            self.add(text(cx, cy - 1, title, 12, 600, INK, 'middle'))
            self.add(text(cx, cy + 14, detail, 10, None, MUTED, 'middle', mono=True))
        else:
            self.add(text(cx, cy + 4, title, 12, 600, INK, 'middle'))

    def pill(self, cx, cy, label, status) -> None:
        ink, fill = STATUS[status]
        w = text_width(label, 11.5) + 32
        self.add(f'  <rect x="{cx - w / 2:.1f}" y="{cy - 13}" width="{w:.1f}" height="26" rx="13" fill="{fill}" stroke="{ink}" stroke-width="1.2"/>\n')
        self.add(text(cx, cy + 4, label, 11.5, 700, ink, 'middle'))

    def arrow(self, points, label=None, at=None, anchor='start', dashed=False) -> None:
        path = ' '.join(f'{"M" if i == 0 else "L"}{x:.1f},{y:.1f}' for i, (x, y) in enumerate(points))
        dash = ' stroke-dasharray="6 4"' if dashed else ''
        color, marker = (MUTED, 'arrow-muted') if dashed else (LINE, 'arrow')
        self.add(f'  <path d="{path}" fill="none" stroke="{color}" stroke-width="1.6" stroke-linejoin="round"{dash} marker-end="url(#{marker})"/>\n')
        if label:
            self.add(text(at[0], at[1], label, 11, 600, MUTED, anchor))

    def panel(self, x, y, w, h) -> None:
        self.add(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1.2"/>\n', back=True)

    def svg(self, height: int) -> str:
        head = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} {height}" width="{self.width}" height="{height}" '
            f'role="img" aria-labelledby="title desc" font-family="{SANS}">\n'
            f'  <title id="title">{escape(self.title)}</title>\n  <desc id="desc">{escape(self.description)}</desc>\n{DEFS}\n'
            f'  <rect width="{self.width}" height="{height}" fill="#ffffff"/>\n'
        )
        return head + ''.join(self.back) + ''.join(self.parts) + '</svg>\n'


class Sequence:
    """A sequence diagram: lanes with headers and dashed lifelines, numbered messages top to bottom"""

    def __init__(self, drawing: Drawing, lanes: dict):
        self.d = drawing
        self.lanes = lanes  # key: (centre x, title, subtitle, colour)
        self.y = 96.0
        self.step = 0
        self.frame = None
        for cx, title, subtitle, color in lanes.values():
            accent, fill, _ = COLORS[color]
            x, w = cx - 120, 240
            self.d.add(f'  <g filter="url(#shadow)"><rect x="{x}" y="20" width="{w}" height="62" rx="12" fill="{fill}" stroke="{accent}" stroke-width="1.5"/></g>\n')
            self.d.add(f'  <path d="M{x},32 A12,12 0 0 1 {x + 12},20 H{x + w - 12} A12,12 0 0 1 {x + w},32 V50 H{x} Z" fill="{accent}"/>\n')
            self.d.add(text(cx, 40, title, 13.5, 700, '#ffffff', 'middle'))
            self.d.add(text(cx, 70, subtitle, 11, None, MUTED, 'middle', mono=True))

    def message(self, source, target, label, response=False) -> None:
        self.step += 1
        x1, x2 = self.lanes[source][0], self.lanes[target][0]
        direction = 1 if x2 > x1 else -1
        line_y = self.y + 32
        label_y = line_y - 10
        dash = ' stroke-dasharray="6 4"' if response else ''
        color, marker = (MUTED, 'arrow-muted') if response else (LINE, 'arrow')
        self.d.add(
            f'  <line x1="{x1 + direction * 5}" y1="{line_y}" x2="{x2 - direction * 7}" y2="{line_y}" stroke="{color}" '
            f'stroke-width="1.6"{dash} marker-end="url(#{marker})"/>\n'
        )
        badge_x = x1 + direction * 22
        accent = COLORS[self.lanes[source][3]][0]
        self.d.add(f'  <circle cx="{badge_x}" cy="{label_y - 4}" r="9" fill="{accent}"/>\n')
        self.d.add(text(badge_x, label_y - 0.5, str(self.step), 10.5, 700, '#ffffff', 'middle'))
        self.d.add(text(x1 + direction * 38, label_y, label, 11.5, None, INK, 'start' if direction > 0 else 'end', mono=True))
        self.y = line_y + 6

    def note(self, lane, lines, color=None, mono=False) -> None:
        cx = self.lanes[lane][0]
        _, fill, border = COLORS[color or self.lanes[lane][3]]
        w = max(text_width(line, 11, mono) for line in lines) + 30
        h = 12 + 15 * len(lines)
        top = self.y + 8
        x = min(max(cx - w / 2, 16), self.d.width - 16 - w)
        self.d.add(f'  <rect x="{x:.1f}" y="{top:.1f}" width="{w:.1f}" height="{h}" rx="8" fill="{fill}" stroke="{border}" stroke-width="1.2"/>\n')
        for i, line in enumerate(lines):
            self.d.add(text(x + w / 2, top + 19 + 15 * i, line, 11, None, BODY, 'middle', mono=mono))
        self.y = top + h

    def phase(self, label) -> None:
        self.y += 30
        self.d.section_label(24, self.y, label)
        start = 24 + text_width(label, 10.5, upper=True) + 12
        self.d.add(f'  <line x1="{start:.1f}" y1="{self.y - 4}" x2="{self.d.width - 24}" y2="{self.y - 4}" stroke="#e2e8f0" stroke-width="1.2"/>\n')
        self.y += 2

    def begin_frame(self, label) -> None:
        self.frame = (self.y + 12, label)
        self.y += 36

    def end_frame(self) -> None:
        top, label = self.frame
        bottom = self.y + 14
        x1, x2 = 24, self.d.width - 24
        self.d.add(
            f'  <rect x="{x1}" y="{top:.1f}" width="{x2 - x1}" height="{bottom - top:.1f}" rx="10" fill="#fafbfc" stroke="#94a3b8" '
            f'stroke-width="1.2" stroke-dasharray="5 4"/>\n',
            back=True,
        )
        w = text_width(label, 10.5) + 24
        self.d.add(f'  <path d="M{x1},{top + 10:.1f} A10,10 0 0 1 {x1 + 10},{top:.1f} H{x1 + w:.1f} V{top + 22:.1f} H{x1} Z" fill="#e2e8f0"/>\n', back=True)
        self.d.add(text(x1 + 12, top + 15, label, 10.5, 700, LINE))
        self.frame = None
        self.y = bottom

    def finish(self) -> str:
        bottom = self.y + 22
        for cx, *_ in self.lanes.values():
            self.d.add(f'  <line x1="{cx}" y1="82" x2="{cx}" y2="{bottom:.1f}" stroke="{FAINT}" stroke-width="1.5" stroke-dasharray="4 5"/>\n', back=True)
        legend_y = bottom + 26
        right = self.d.width - 24
        self.d.add(f'  <line x1="{right - 250}" y1="{legend_y - 4}" x2="{right - 206}" y2="{legend_y - 4}" stroke="{LINE}" stroke-width="1.6" marker-end="url(#arrow)"/>\n')
        self.d.add(text(right - 198, legend_y, 'request', 11, None, MUTED))
        self.d.add(
            f'  <line x1="{right - 118}" y1="{legend_y - 4}" x2="{right - 74}" y2="{legend_y - 4}" stroke="{MUTED}" stroke-width="1.6" '
            f'stroke-dasharray="6 4" marker-end="url(#arrow-muted)"/>\n'
        )
        self.d.add(text(right - 66, legend_y, 'response', 11, None, MUTED))
        return self.d.svg(int(legend_y + 20))


LANES = {
    'web': (160, 'Browser · web app', 'web/src', 'web'),
    'server': (480, 'API server', 'server/src', 'server'),
    'core': (800, 'Addon · C++ core', '@glcm/native · glcm_core', 'core'),
}


def open_image() -> str:
    d = Drawing(
        'Opening an image',
        'The browser uploads the file with POST /images. The server streams it to uploads/, computes its SHA-256 and calls '
        'decodeImageFile in the addon, which checks the size from the header, loads the image and computes display statistics '
        'and the pixel spacing. The server writes images/<id>/ and answers 201 with ImageInfo. The browser then downloads the '
        'raw pixels with GET /images/{id}/raw and renders them as a WebGL2 texture.',
    )
    s = Sequence(d, LANES)
    s.message('web', 'server', 'POST /images (multipart)')
    s.note('server', ['stream to uploads/ · SHA-256'])
    s.message('server', 'core', 'decodeImageFile(path, maxPixels)')
    s.note('core', ['size from the header, then LoadImageStackFile', 'display statistics · pixel spacing'])
    s.message('core', 'server', 'pixels · window · histogram', response=True)
    s.note('server', ['write images/<id>/'], color='data', mono=True)
    s.message('server', 'web', '201 ImageInfo (transfer raw or server)', response=True)
    s.message('web', 'server', 'GET /images/{id}/raw')
    s.message('server', 'web', 'pixels.bin (gzip or zstd) · ETag', response=True)
    s.note('web', ['WebGL2 texture · fit to window'])
    return s.finish()


def measure() -> str:
    d = Drawing(
        'Measuring',
        'While ROIs change, the browser sends debounced POST /images/{id}/roi-stats requests; the server calls roiStats, which '
        'rasterizes each ROI, and returns pixel counts for the ROI Manager. To measure, the browser sends POST /analyses; the '
        'server validates the request with validateAnalysis, answers 202 with AnalysisInfo and queues one job per ROI and '
        'distance. The browser reads GET /analyses/{id}/events: for each job the server calls runAnalysis and sends result and '
        'progress events, then a finished event after storing results/<id>.json. Finally the browser fetches the ordered '
        'results with GET /analyses/{id}/results and appends rows to the Results table.',
    )
    s = Sequence(d, LANES)
    s.phase('While drawing: pixel counts')
    s.message('web', 'server', 'POST /images/{id}/roi-stats')
    s.note('web', ['debounced while ROIs change'])
    s.message('server', 'core', 'roiStats')
    s.note('core', ['RasterizeCroppedMask per ROI'])
    s.message('core', 'server', 'statistics per ROI', response=True)
    s.message('server', 'web', 'pixel counts for the ROI Manager', response=True)
    s.phase('Measure: analysis jobs')
    s.message('web', 'server', 'POST /analyses {rois, settings}')
    s.message('server', 'core', 'validateAnalysis')
    s.note('core', ['parse and validate ROIs and settings'])
    s.message('server', 'web', '202 AnalysisInfo', response=True)
    s.note('server', ['queue ROI × distance jobs'])
    s.message('web', 'server', 'GET /analyses/{id}/events')
    s.begin_frame('for each job, a few at a time')
    s.message('server', 'core', 'runAnalysis')
    s.note('core', ['RunAnalysis: one ROI, one distance'])
    s.message('core', 'server', 'result', response=True)
    s.message('server', 'web', 'event: result · progress', response=True)
    s.end_frame()
    s.message('server', 'web', 'event: finished', response=True)
    s.note('server', ['store results/<id>.json'], color='data', mono=True)
    s.message('web', 'server', 'GET /analyses/{id}/results')
    s.message('server', 'web', 'ordered results', response=True)
    s.note('web', ['rows appended to the Results table'])
    return s.finish()


def batch() -> str:
    d = Drawing(
        'Batch measurement',
        'For each image file, the browser computes its SHA-256 and reuses an image the server already stores, otherwise it '
        'uploads the file with POST /images. The ROIs are clipped to the image; without an ROI left the image is skipped. The '
        'settings are fitted to the bit depth; invalid settings mark the image failed. Otherwise POST /analyses starts the '
        'analysis, whose run is added to the Results table, and the browser polls GET /analyses/{id}/results until the '
        'results are final, or cancels with DELETE /analyses/{id}; then the next image follows. Download combined CSV fetches '
        'GET /analyses/{id}/results.csv for each finished image, merges files with the same settings and header, and saves '
        'one CSV file, or a ZIP with one CSV per group of settings.',
    )
    d.panel(20, 20, 560, 940)
    d.section_label(40, 50, 'For each image file')
    d.add(text(560, 50, 'batch/runBatch.ts', 11, None, MUTED, 'end', mono=True))
    main, side = 222, 470

    d.box(main, 105, 290, 50, 'SHA-256 of the file', 'Web Crypto, in the browser', 'web')
    d.arrow([(main, 130), (main, 154)])
    d.diamond(main, 190, 260, 70, 'Already stored?', 'GET /images?sha256=')
    reuse = 482
    d.arrow([(main + 130, 190), (reuse - 87, 190)], 'yes', (main + 140, 181))
    d.box(reuse, 190, 170, 46, 'Reuse the image', None, 'server')
    d.arrow([(main, 225), (main, 258)], 'no', (main + 10, 246))
    d.box(main, 285, 290, 50, 'Upload the file', 'POST /images', 'server')
    d.arrow([(main, 310), (main, 348)])
    d.arrow([(reuse, 213), (reuse, 375), (main + 147, 375)])
    d.box(main, 375, 290, 50, 'Clip the ROIs to the image', 'prepareRoiImport', 'web')
    d.arrow([(main, 400), (main, 432)])
    d.diamond(main, 465, 220, 64, 'Any ROI left?')
    d.arrow([(main + 110, 465), (side - 44, 465)], 'no', (main + 122, 456))
    d.pill(side, 465, 'Skipped', 'skipped')
    d.add(text(side, 494, 'recorded; next image', 10.5, None, MUTED, 'middle'))
    d.arrow([(main, 497), (main, 528)], 'yes', (main + 10, 516))
    d.box(main, 555, 290, 50, 'Fit the settings to the image', 'adaptToImage · checkSettings', 'web')
    d.arrow([(main, 580), (main, 612)])
    d.diamond(main, 645, 220, 64, 'Settings valid?')
    d.arrow([(main + 110, 645), (side - 40, 645)], 'no', (main + 122, 636))
    d.pill(side, 645, 'Failed', 'failed')
    d.add(text(side, 674, 'recorded; next image', 10.5, None, MUTED, 'middle'))
    d.arrow([(main, 677), (main, 708)], 'yes', (main + 10, 696))
    d.box(main, 735, 290, 50, 'Start the analysis', 'POST /analyses · run in the table', 'server')
    d.arrow([(main, 760), (main, 798)])
    d.box(main, 825, 290, 50, 'Wait for the final results', 'GET /analyses/{id}/results', 'server')
    d.arrow([(main + 145, 825), (side - 52, 825)], 'cancel', (main + 156, 816), dashed=True)
    d.pill(side, 825, 'Cancelled', 'cancelled')
    d.add(text(side, 854, 'DELETE /analyses/{id}', 10.5, None, MUTED, 'middle', mono=True))
    d.arrow([(main, 850), (main, 888)])
    d.pill(main, 903, 'Done', 'done')
    d.arrow([(main - 32, 903), (52, 903), (52, 105), (main - 153, 105)])
    d.add(text(44, 505, 'next image', 11, 600, MUTED, 'middle', transform='rotate(-90 44 505)'))

    d.panel(600, 20, 340, 530)
    d.section_label(620, 50, 'Download combined CSV')
    col = 770
    d.box(col, 110, 300, 50, 'Fetch each finished result', 'GET /analyses/{id}/results.csv', 'server')
    d.arrow([(col, 135), (col, 170)])
    d.box(col, 197, 300, 50, 'Merge the CSV texts', 'mergeCsv.ts · same settings and header', 'web')
    d.arrow([(col, 222), (col, 262)])
    d.diamond(col, 296, 200, 64, 'One group?')
    d.arrow([(col, 328), (col, 373)], 'yes', (col + 10, 356))
    d.box(col, 400, 240, 50, 'One CSV file', '# images=N', 'web')
    d.arrow([(col + 100, 296), (918, 296), (918, 490), (col + 127, 490)], 'no', (col + 108, 287))
    d.box(col, 490, 240, 50, 'ZIP, one CSV per group', 'zipped with fflate', 'web')

    d.panel(600, 580, 340, 150)
    d.section_label(620, 610, 'Legend')
    for i, (color, label) in enumerate([('web', 'In the browser'), ('server', 'An API server call')]):
        accent, fill, border = COLORS[color]
        y = 632 + i * 26
        d.add(f'  <rect x="620" y="{y}" width="22" height="16" rx="4" fill="{fill}" stroke="{border}" stroke-width="1.4"/>\n')
        d.add(text(652, y + 12, label, 11.5, None, BODY))
    x = 620
    for label, status in [('Done', 'done'), ('Skipped', 'skipped'), ('Failed', 'failed'), ('Cancelled', 'cancelled')]:
        w = text_width(label, 11.5) + 32
        d.pill(x + w / 2, 700, label, status)
        x += w + 8
    return d.svg(980)


def pixel_spacing() -> str:
    d = Drawing(
        'Pixel spacing',
        'From the file: ReadImageSize reads the resolution of PNG, JPEG, BMP and TIFF files; LoadedImage.info.pixel_spacing '
        'keeps it, swapped when the EXIF orientation turns the image; decodeImageFile returns it and the server stores it in '
        'ImageInfo.pixelSpacing, null without one. In the web app, viewerStore.pixelSpacing holds the spacing chosen for the '
        "image earlier or else the file's, edited in the Image Info dialog; it drives the scale bar, ROI areas in mm² and the "
        'note on non-square pixels. Into the results: POST /analyses sends the spacing, AnalysisInfo keeps it with the run, the '
        'results document carries it as image.pixelSpacing, and ResultsToCsv writes # pixelSpacingMm and the areaMm2 column.',
    )
    columns = [129, 363, 597, 831]

    d.section_label(24, 44, 'From the file')
    row1 = [
        ('ReadImageSize', 'pHYs · JFIF · BMP · TIFF', 'core'),
        ('LoadedImage.info', 'pixel_spacing · EXIF swap', 'core'),
        ('decodeImageFile()', 'pixelSpacing', 'addon'),
        ('ImageInfo', 'pixelSpacing · null if none', 'server'),
    ]
    for cx, (title, subtitle, color) in zip(columns, row1):
        d.box(cx, 90, 210, 54, title, subtitle, color, mono_title=True)
    for left, right in zip(columns, columns[1:]):
        d.arrow([(left + 105, 90), (right - 106, 90)])

    d.section_label(24, 178, 'In the web app')
    d.box(134, 218, 220, 50, 'Chosen for this image', 'preferences · by SHA-256', 'web')
    d.box(134, 290, 220, 50, 'Image Info dialog', "enter · file's · clear", 'web')
    d.box(430, 254, 250, 62, 'Spacing of the open image', 'viewerStore.pixelSpacing', 'web', strong=True)
    d.arrow([(244, 218), (272, 218), (272, 244), (303, 244)])
    d.arrow([(244, 290), (272, 290), (272, 264), (303, 264)])
    d.arrow([(columns[3], 117), (columns[3], 150), (430, 150), (430, 221)], "else the file's", (640, 143))
    for i, label in enumerate(['Scale bar on the canvas', 'ROI areas in mm²', 'Note on non-square pixels']):
        y = 214 + i * 40
        d.box(780, y, 300, 30, label, None, 'web')
        d.arrow([(555, 254), (590, 254), (590, y), (628, y)])

    d.section_label(24, 350, 'Into the results')
    row3 = [
        ('Start an analysis', 'POST /analyses {pixelSpacing}', 'server'),
        ('Stored with the run', 'AnalysisInfo.pixelSpacing', 'server'),
        ('Results document', 'image.pixelSpacing', 'server'),
        ('ResultsToCsv', '# pixelSpacingMm · areaMm2', 'core'),
    ]
    for cx, (title, subtitle, color) in zip(columns, row3):
        d.box(cx, 405, 210, 54, title, subtitle, color)
    for left, right in zip(columns, columns[1:]):
        d.arrow([(left + 105, 405), (right - 106, 405)])
    # Enters the box right of the row label
    d.arrow([(430, 285), (430, 330), (columns[0] + 60, 330), (columns[0] + 60, 376)])

    d.add(text(24, 468, 'Features are always computed in pixels: the spacing only annotates the results, and each run keeps the spacing it was measured with.',
               11, None, MUTED))
    return d.svg(488)


def command_line() -> str:
    d = Drawing(
        'The command line and the agent server',
        'The glcm command and the MCP server are two front ends over the same operations. @glcm/client holds them — open an '
        'image, build and check settings, measure, select regions, compute feature maps — and depends only on @glcm/api and '
        'fetch, with no file system and no native addon. Below it sit two transports: localClient builds the server in the '
        'same process and calls its routes with inject, without a port; httpClient talks to a running server with --server '
        'and --token. Both reach the same routes, the same addon and the same C++ core, and the same data directory as the '
        'web application.',
    )

    d.section_label(24, 44, 'Front ends')
    d.box(250, 92, 330, 58, 'glcm command', 'cli/src/main.ts · files.ts', 'web')
    d.box(680, 92, 330, 58, 'glcm mcp', 'cli/src/mcp.ts · MCP over stdio', 'web')
    d.add(text(250, 140, 'measure · regions · feature-map · info', 10.5, None, MUTED, 'middle', mono=True))
    d.add(text(680, 140, 'tools an assistant calls', 10.5, None, MUTED, 'middle'))

    d.section_label(24, 186, 'Shared operations')
    d.box(465, 232, 620, 62, '@glcm/client', 'openImage · buildSettings · measure · selectRegions · computeFeatureMap', 'web', strong=True)
    d.arrow([(250, 121), (250, 176), (300, 176), (300, 201)])
    d.arrow([(680, 121), (680, 176), (630, 176), (630, 201)])
    d.add(text(465, 281, 'Only @glcm/api and fetch: reads no files, needs no native addon', 11, None, MUTED, 'middle'))

    d.section_label(24, 322, 'Transports')
    d.box(250, 372, 330, 58, 'localClient', 'buildApp + inject · no port', 'server')
    d.box(680, 372, 330, 58, 'httpClient', 'fetch · --server · --token', 'server')
    d.arrow([(400, 263), (400, 343)], 'in this process', (390, 318), 'end')
    d.arrow([(530, 263), (530, 343)], 'over HTTP', (540, 318))
    d.add(text(250, 420, 'refused while a server uses the same folder', 10.5, None, MUTED, 'middle'))
    d.add(text(680, 420, 'a local or a shared server', 10.5, None, MUTED, 'middle'))

    d.section_label(24, 448, 'The same API underneath')
    d.box(465, 508, 420, 56, 'Routes · jobs · stores', 'server/src', 'server')
    # Between the captions and the section label, so the lines cross no text
    d.arrow([(390, 401), (390, 474), (330, 474), (330, 479)])
    d.arrow([(560, 401), (560, 474), (600, 474), (600, 479)])
    d.box(200, 610, 270, 54, '@glcm/native', 'addon.cpp', 'addon')
    d.box(520, 610, 270, 54, 'glcm_core', 'features · ROIs · exporters', 'core')
    d.box(820, 610, 220, 54, 'Data directory', 'images · results', 'data')
    d.arrow([(465, 536), (465, 566), (200, 566), (200, 582)])
    d.arrow([(336, 610), (383, 610)])
    d.arrow([(465, 536), (465, 566), (820, 566), (820, 582)])

    d.add(text(24, 690, 'The web application uses the same routes and the same data directory, so an image opened in the browser can be measured from a script.',
               11, None, MUTED))
    return d.svg(712)


def mcp_session() -> str:
    d = Drawing(
        'An assistant measuring over MCP',
        'The assistant lists the tools over standard input and output, then opens an image: the MCP server reads the file, '
        'hashes it and uploads it only when the server does not have it, and answers with the size, bit depth, window and '
        'spacing. view_image returns the rendering as a picture the model can look at. select_regions asks the server for the '
        'regions in an intensity range and keeps their polygons under an id, so the outlines never travel through the model. '
        'measure then names that id: the server runs the analysis and the tool answers with a shortened table, writing the '
        'whole table to a file when saveTo is given.',
    )
    s = Sequence(
        d,
        {
            'agent': (160, 'AI assistant', 'an MCP client', 'web'),
            'mcp': (480, 'glcm mcp', 'cli/src/mcp.ts', 'web'),
            'server': (800, 'API server · core', 'in process or over HTTP', 'server'),
        },
    )
    s.phase('What can be done')
    s.message('agent', 'mcp', 'tools/list')
    s.message('mcp', 'agent', 'open_image · view_image · select_regions · measure', response=True)

    s.phase('Open and look')
    s.message('agent', 'mcp', 'open_image {image}')
    s.note('mcp', ['read the file, hash it,', 'upload only what is new'])
    s.message('mcp', 'server', 'GET /images?sha256= · POST /images')
    s.message('server', 'mcp', 'ImageInfo', response=True)
    s.message('mcp', 'agent', 'size · bit depth · window · spacing', response=True)
    s.message('agent', 'mcp', 'view_image {kind: display}')
    s.message('mcp', 'server', 'GET /images/{id}/display.png')
    s.message('server', 'mcp', 'PNG', response=True)
    s.message('mcp', 'agent', 'an image block the model can look at', response=True)

    s.phase('Choose regions and measure')
    s.message('agent', 'mcp', 'select_regions {min, max}')
    s.message('mcp', 'server', 'POST /images/{id}/threshold-rois')
    s.message('server', 'mcp', 'polygons · pixel counts', response=True)
    s.note('mcp', ['kept as "regions_1":', 'the outlines stay here'])
    s.message('mcp', 'agent', 'a table of the regions', response=True)
    s.message('agent', 'mcp', 'measure {rois: "regions_1", preset}')
    s.message('mcp', 'server', 'POST /analyses · events · results')
    s.message('server', 'mcp', 'results', response=True)
    s.note('mcp', ['20 rows by default;', 'saveTo writes the whole table'])
    s.message('mcp', 'agent', 'a shortened table of values', response=True)
    return s.finish()


def main() -> None:
    diagrams = {
        'flow-open-image.svg': open_image(),
        'flow-measure.svg': measure(),
        'flow-batch.svg': batch(),
        'flow-pixel-spacing.svg': pixel_spacing(),
        'flow-cli.svg': command_line(),
        'flow-mcp.svg': mcp_session(),
    }
    for name, content in diagrams.items():
        (OUTPUT / name).write_text(content)
        print(f'doc/developer/images/{name}')


if __name__ == '__main__':
    main()
