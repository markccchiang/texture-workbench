// The pictures of a report, drawn in the browser: the open image with its ROIs, a rendering of every other measured
// image, and the charts of the Plot view as inline SVG.

import type { ColorTableId } from '../image/colorTables';
import { colorizeRgba, colorTableById } from '../image/colorTables';
import { renderToRgba } from '../image/lut';
import type { RawImage } from '../image/raw';
import { fetchDisplayBlob, findImagesBySha256 } from '../api/client';
import { CHARTS, type ChartProps } from '../results/ResultsPlot';
import { latestMeasurements, seriesOf } from '../results/plotData';
import { inlineSvg } from '../results/svgExport';
import { cutEdges, roiColor } from '../rois/geometry';
import type { ManagedRoi } from '../rois/roiStore';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { RoiShape } from '@glcm/api';
import type { ReportAssets, ReportSections } from './reportHtml';
import type { ChartSpec, ReportImage, ReportModel } from './reportModel';

/** Longest side of the image in a report; keeps the file a few hundred kilobytes per image */
const MAX_IMAGE_SIZE = 1400;
const CHART_WIDTH = 460;
const CHART_HEIGHT = 300;

/** Light colours for the charts, whatever theme the app is in: a report is a document, printed on white */
const CHART_VARIABLES: Array<[string, string]> = [
  ['--mantine-color-default-border', '#c9ccd1'],
  ['--mantine-color-dimmed', '#5c636e'],
  ['--mantine-color-text', '#14171c'],
];

export interface OpenImageSource {
  imageId: string;
  raw: RawImage | null;
  width: number;
  height: number;
  windowMin: number;
  windowMax: number;
  colorTable: ColorTableId;
  /** The ROIs drawn on it: those of the slice shown of a stack */
  rois: readonly ManagedRoi[];
  /** The slice shown of a stack, from 1; absent for slice 1 */
  slice?: number;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The image could not be read'));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draws the ROI outlines and names on a canvas whose pixels are `scale` times the image pixels */
function drawRois(context: CanvasRenderingContext2D, rois: readonly ManagedRoi[], scale: number): void {
  const lineWidth = Math.max(1, 1.5 / scale);
  context.save();
  context.scale(scale, scale);
  context.lineJoin = 'round';
  context.font = `${Math.max(9, 11 / scale)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  for (const roi of rois) {
    if (!roi.visible) {
      continue;
    }
    context.strokeStyle = roi.color;
    context.lineWidth = lineWidth;
    strokeShape(context, roi.shape);
    const [x, y] = labelPosition(roi.shape);
    context.lineWidth = Math.max(2, 3 / scale);
    context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    context.strokeText(roi.name, x, y);
    context.fillStyle = roi.color;
    context.fillText(roi.name, x, y);
  }
  context.restore();
}

function strokeShape(context: CanvasRenderingContext2D, shape: RoiShape): void {
  if (shape.type === 'rectangle') {
    context.strokeRect(shape.x, shape.y, shape.width, shape.height);
    return;
  }
  if (shape.type === 'ellipse') {
    context.beginPath();
    context.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, ((shape.angle ?? 0) * Math.PI) / 180, 0, 2 * Math.PI);
    context.stroke();
    return;
  }
  // Polygons may join parts and holes with zero-width cuts, which are not drawn (as in the viewer)
  const points = shape.points;
  if (points.length < 2) {
    return;
  }
  const cuts = cutEdges(points);
  context.beginPath();
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    if (cuts[index]) {
      continue;
    }
    context.moveTo(points[index][0], points[index][1]);
    context.lineTo(next[0], next[1]);
  }
  context.stroke();
}

function labelPosition(shape: RoiShape): [number, number] {
  if (shape.type === 'rectangle') {
    return [shape.x + 2, shape.y - 3];
  }
  if (shape.type === 'ellipse') {
    return [shape.cx - shape.rx + 2, shape.cy - shape.ry - 3];
  }
  const xs = shape.points.map(([x]) => x);
  const ys = shape.points.map(([, y]) => y);
  return [Math.min(...xs) + 2, Math.min(...ys) - 3];
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('The browser did not give a canvas to draw on');
  }
  return context;
}

/** PNG data URI of the open image, with its window, colour table and ROIs */
export async function renderOpenImage(source: OpenImageSource, withRois: boolean): Promise<string> {
  let picture: HTMLCanvasElement;
  if (source.raw) {
    picture = canvasOf(source.width, source.height);
    // Allocated here, so the buffer is the one ImageData wants
    const rgba = new Uint8ClampedArray(source.width * source.height * 4);
    renderToRgba(source.raw, source.windowMin, source.windowMax, rgba);
    if (source.colorTable !== 'gray') {
      colorizeRgba(rgba, colorTableById(source.colorTable));
    }
    contextOf(picture).putImageData(new ImageData(rgba, source.width, source.height), 0, 0);
  } else {
    // The server renders it, already no larger than MAX_IMAGE_SIZE
    const blob = await fetchDisplayBlob(source.imageId, { min: source.windowMin, max: source.windowMax, maxSize: MAX_IMAGE_SIZE, slice: source.slice });
    const rendered = await blobToImage(blob);
    picture = canvasOf(rendered.naturalWidth, rendered.naturalHeight);
    contextOf(picture).drawImage(rendered, 0, 0);
  }

  const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(picture.width, picture.height));
  let target = picture;
  if (scale < 1) {
    target = canvasOf(Math.round(picture.width * scale), Math.round(picture.height * scale));
    const context = contextOf(target);
    context.imageSmoothingEnabled = true;
    context.drawImage(picture, 0, 0, target.width, target.height);
  }
  if (withRois) {
    // The ROI coordinates are image pixels, whatever the picture was scaled to
    drawRois(contextOf(target), source.rois, target.width / source.width);
  }
  return target.toDataURL('image/png');
}

/** PNG data URI of an image the server still has, without ROIs (they are not kept with past measurements) */
async function renderStoredImage(sha256: string): Promise<string | null> {
  const [info] = await findImagesBySha256(sha256);
  if (!info) {
    return null;
  }
  const blob = await fetchDisplayBlob(info.imageId, { min: info.windowMin, max: info.windowMax, maxSize: MAX_IMAGE_SIZE });
  const image = await blobToImage(blob);
  const canvas = canvasOf(image.naturalWidth, image.naturalHeight);
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Renders a chart off-screen and serializes it, with the CSS variables of the charts resolved to light colours */
function renderChartSvg(props: ChartProps, kind: ChartSpec['kind']): string {
  const host = document.createElement('div');
  host.setAttribute('data-mantine-color-scheme', 'light');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${props.width}px;height:${props.height}px`;
  for (const [name, value] of CHART_VARIABLES) {
    host.style.setProperty(name, value);
  }
  document.body.append(host);
  const root = createRoot(host);
  try {
    const Chart = CHARTS[kind];
    flushSync(() =>
      root.render(
        <svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`} role="img" aria-label={props.featureName}>
          <Chart {...props} />
        </svg>,
      ),
    );
    const svg = host.querySelector('svg');
    return svg ? inlineSvg(svg, '#ffffff') : '';
  } finally {
    // Unmounting while React is flushing is not allowed
    window.setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  }
}

function chartsOf(image: ReportImage, openImageName: string | null, rois: readonly ManagedRoi[]): string[] {
  return image.charts.map((spec) => {
    const measurements = latestMeasurements(image.runs, spec.featureId);
    const series = seriesOf(measurements);
    if (series.length === 0) {
      return '';
    }
    const colors = series.map(
      (entry, index) => (entry.imageName === openImageName ? rois.find((roi) => roi.id === entry.roiId)?.color : undefined) || roiColor(index),
    );
    return renderChartSvg(
      {
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        series,
        colors,
        distance: spec.distance,
        featureName: spec.featureName,
        seriesProps: () => ({}),
      },
      spec.kind,
    );
  });
}

export interface AssetOptions {
  openImage: OpenImageSource | null;
  /** Reported once per image that could not be drawn */
  onWarning?(message: string): void;
}

/** Draws everything the chosen sections need; a picture that fails is left out, the rest of the report is still built */
export async function renderReportAssets(model: ReportModel, sections: ReportSections, options: AssetOptions): Promise<ReportAssets> {
  const assets: ReportAssets = { images: {}, charts: {} };
  const openImageName = model.images.find((image) => image.open)?.name ?? null;
  for (const image of model.images) {
    if (sections.image) {
      try {
        const png = image.open && options.openImage ? await renderOpenImage(options.openImage, sections.rois) : await renderStoredImage(image.sha256);
        if (png) {
          assets.images[image.key] = png;
        } else {
          options.onWarning?.(`The server no longer has ${image.name}, so the report shows no picture of it.`);
        }
      } catch (error) {
        options.onWarning?.(`${image.name} could not be drawn: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (sections.charts) {
      assets.charts[image.key] = chartsOf(image, openImageName, options.openImage?.rois ?? []);
    }
  }
  return assets;
}
