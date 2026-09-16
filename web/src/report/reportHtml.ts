// The report as one self-contained HTML file: images as data URIs, charts as inline SVG, no external resources, with a
// print stylesheet so the browser's Print ▸ Save as PDF gives a PDF.

import type { AnalysisSettings } from '@glcm/api';
import { fileStem, timestampForFileName } from '../files/download';
import { formatValue } from '../results/rows';
import { cellText, columnsForRows } from '../results/rows';
import type { ReportImage, ReportModel } from './reportModel';

export interface ReportSections {
  /** The open image, drawn with its ROIs */
  image: boolean;
  rois: boolean;
  settings: boolean;
  results: boolean;
  charts: boolean;
}

export const DEFAULT_SECTIONS: ReportSections = { image: true, rois: true, settings: true, results: true, charts: true };

export interface ReportAssets {
  /** PNG data URI per image key; missing when the image could not be drawn */
  images: Record<string, string>;
  /** SVG markup per image key, in the order of the image's chart specs */
  charts: Record<string, string[]>;
}

export const EMPTY_ASSETS: ReportAssets = { images: {}, charts: {} };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[character]};`);
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const QUANTIZATION_LABELS: Record<string, string> = {
  fixedRange: 'Fixed range',
  roiMinMax: 'ROI min–max',
  fixedBinWidth: 'Fixed bin width',
  none: 'None',
};

const AGGREGATION_LABELS: Record<string, string> = {
  perDirectionAndMean: 'Per direction and mean',
  meanOnly: 'Mean only',
  meanAndRange: 'Mean and range',
};

const LOG_BASE_LABELS: Record<string, string> = { natural: 'Natural (ln)', log2: 'Base 2', log10: 'Base 10' };

function quantizationText(settings: AnalysisSettings): string {
  const { method, min, max, binWidth } = settings.quantization;
  const label = QUANTIZATION_LABELS[method] ?? method;
  if (method === 'fixedRange') {
    return `${label} [${min}, ${max}]`;
  }
  return method === 'fixedBinWidth' ? `${label} ${formatValue(binWidth)}` : label;
}

/** A label and its value; long values take a whole row of the grid, checksums are set in a monospace font */
export type Fact = [label: string, value: string] | [label: string, value: string, options: { wide?: boolean; mono?: boolean }];

/** Label and value pairs describing one set of analysis settings */
export function settingsRows(settings: AnalysisSettings, featureNames: Map<string, string>): Fact[] {
  const features = settings.features.map((id) => featureNames.get(id) ?? id);
  return [
    [`Features (${features.length})`, features.join(', '), { wide: true }],
    ['Gray levels', String(settings.grayLevels)],
    ['Quantization', quantizationText(settings)],
    ['Distances', settings.distances.join(', ')],
    ['Directions', settings.directions.map((direction) => `${direction}°`).join(', ')],
    ['Aggregation', AGGREGATION_LABELS[settings.aggregation] ?? settings.aggregation],
    ['Logarithm', LOG_BASE_LABELS[settings.logBase] ?? settings.logBase],
    ['Score', settings.score.enabled ? `Enabled, age ${settings.score.age}, profile ${settings.score.profile}` : 'Disabled'],
  ];
}

function definitionList(rows: Fact[]): string {
  const items = rows
    .filter(([, value]) => value !== '')
    .map(([label, value, options]) => {
      const row = options?.wide ? ' class="wide"' : '';
      const cell = options?.mono ? ' class="mono"' : '';
      return `<div${row}><dt>${escapeHtml(label)}</dt><dd${cell}>${escapeHtml(value)}</dd></div>`;
    })
    .join('');
  return `<dl class="facts">${items}</dl>`;
}

function table(kind: 'rois' | 'results', header: string[], rows: string[][], numeric: boolean[] = []): string {
  const head = header.map((label, index) => `<th${numeric[index] ? ' class="num"' : ''}>${escapeHtml(label)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell, index) => `<td${numeric[index] ? ' class="num"' : ''}>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table data-report="${kind}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function roiTable(image: ReportImage): string {
  const withArea = image.rois.some((roi) => roi.areaMm2 !== null);
  const withShape = image.rois.some((roi) => roi.shape !== '');
  const withClass = image.rois.some((roi) => roi.className !== '');
  const header = ['ROI', ...(withClass ? ['Class'] : []), ...(withShape ? ['Shape'] : []), 'Pixels', ...(withArea ? ['Area (mm²)'] : [])];
  const numeric = header.map((label) => label === 'Pixels' || label === 'Area (mm²)');
  const rows = image.rois.map((roi) => [
    roi.name,
    ...(withClass ? [roi.className] : []),
    ...(withShape ? [roi.shape] : []),
    roi.pixelCount === null ? '' : roi.pixelCount.toLocaleString(),
    ...(withArea ? [roi.areaMm2 === null ? '' : formatValue(roi.areaMm2)] : []),
  ]);
  return table('rois', header, rows, numeric);
}

function resultsTable(image: ReportImage, model: ReportModel): string {
  const columns = columnsForRows(image.rows, model.features).filter((column) => column.id !== 'image');
  const header = columns.map((column) => (column.nonStandard ? `${column.label} ⚠` : column.label));
  const rows = image.rows.map((row) => columns.map((column) => cellText(column, row)));
  return table(
    'results',
    header,
    rows,
    columns.map((column) => column.numeric),
  );
}

function imageFacts(image: ReportImage): Fact[] {
  const info = image.info;
  return [
    ['File', image.name],
    ...(info ? ([['Size', `${info.width} × ${info.height} px, ${info.bitDepth}-bit`]] as Fact[]) : []),
    ['Pixel spacing', image.pixelSpacing ? `${formatValue(image.pixelSpacing.x)} × ${formatValue(image.pixelSpacing.y)} mm` : 'Not set'],
    ...(info?.valueConversion ? ([['Values', info.valueConversion.description, { wide: true }]] as Fact[]) : []),
    ['SHA-256', image.sha256, { wide: true, mono: true }],
    ['Measurements', `${image.rows.length} rows from ${image.runs.length} ${image.runs.length === 1 ? 'analysis' : 'analyses'}`],
  ];
}

function warningList(image: ReportImage): string {
  const warnings = [...new Set(image.rows.flatMap((row) => row.warnings))];
  if (warnings.length === 0) {
    return '';
  }
  return `<div class="warnings"><h4>Warnings</h4><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>`;
}

function imageSection(image: ReportImage, model: ReportModel, sections: ReportSections, assets: ReportAssets, index: number): string {
  const featureNames = new Map(model.features.map((feature) => [feature.id, feature.name]));
  const parts: string[] = [`<h2 id="image-${index}">${escapeHtml(image.name)}</h2>`, definitionList(imageFacts(image))];

  const png = assets.images[image.key];
  if (sections.image && png) {
    const caption = image.open && image.rois.length > 0 ? 'The image with its ROIs.' : 'The image as measured.';
    parts.push(`<figure class="image"><img src="${png}" alt="${escapeHtml(image.name)}"><figcaption>${caption}</figcaption></figure>`);
  }
  if (sections.rois && image.rois.length > 0) {
    parts.push(`<h3>ROIs (${image.rois.length})</h3>`, roiTable(image));
  }
  if (sections.settings) {
    parts.push(`<h3>Analysis settings</h3>`);
    for (const group of image.settingsGroups) {
      const when = group.timestamps.map(formatDateTime).join(', ');
      parts.push(
        `<p class="when">${escapeHtml(`${group.measurements} ${group.measurements === 1 ? 'measurement' : 'measurements'}, ${when}`)}</p>`,
        definitionList(settingsRows(group.settings, featureNames)),
      );
    }
  }
  if (sections.results && image.rows.length > 0) {
    parts.push(`<h3>Results (${image.rows.length} rows)</h3>`, resultsTable(image, model));
  }
  const charts = assets.charts[image.key] ?? [];
  if (sections.charts && charts.length > 0) {
    parts.push('<h3>Charts</h3>', '<div class="charts">');
    image.charts.forEach((spec, chartIndex) => {
      const svg = charts[chartIndex];
      if (svg) {
        parts.push(`<figure class="chart"><h4>${escapeHtml(spec.featureName)}</h4>${svg}<figcaption>${escapeHtml(spec.caption)}</figcaption></figure>`);
      }
    });
    parts.push('</div>');
  }
  parts.push(warningList(image));
  return `<section class="image-section">${parts.join('\n')}</section>`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px 64px; background: #f6f7f9; color: #14171c;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 980px; margin: 0 auto; background: #fff; padding: 32px 36px 40px; border: 1px solid #e2e5ea; border-radius: 6px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 36px 0 8px; padding-top: 12px; border-top: 2px solid #14171c; }
h3 { font-size: 15px; margin: 22px 0 6px; }
h4 { font-size: 13px; margin: 0 0 4px; font-weight: 600; }
p { margin: 6px 0; }
.subtitle { color: #5c636e; margin: 0 0 16px; }
.notes { white-space: pre-wrap; border-left: 3px solid #c9ccd1; padding: 2px 0 2px 12px; margin: 12px 0 0; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 2px 20px; margin: 8px 0 12px; }
.facts div { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid #eef0f3; }
.facts dt { flex: 0 0 34%; color: #5c636e; }
.facts dd { margin: 0; flex: 1; overflow-wrap: anywhere; }
.facts div.wide { grid-column: 1 / -1; }
.facts div.wide dt { flex: 0 0 17%; }
.facts dd.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.when { color: #5c636e; font-size: 12px; margin: 10px 0 2px; }
.table-wrap { overflow-x: auto; margin: 8px 0 4px; }
table { border-collapse: collapse; font-size: 12px; width: 100%; }
th, td { border-bottom: 1px solid #e2e5ea; padding: 4px 8px; text-align: left; white-space: nowrap; }
th { background: #f1f3f6; font-weight: 600; position: sticky; top: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
figure { margin: 10px 0 18px; }
figure.image img { max-width: 100%; height: auto; border: 1px solid #e2e5ea; background: #000; }
figcaption { color: #5c636e; font-size: 12px; margin-top: 4px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px 20px; }
.chart svg { max-width: 100%; height: auto; border: 1px solid #eef0f3; }
.warnings { border-left: 3px solid #e2a03f; padding-left: 12px; margin: 12px 0; }
.warnings h4 { color: #8a5b00; }
.warnings ul { margin: 4px 0; padding-left: 18px; }
footer { color: #5c636e; font-size: 12px; margin-top: 32px; border-top: 1px solid #e2e5ea; padding-top: 10px; }
.toolbar { max-width: 980px; margin: 0 auto 12px; display: flex; justify-content: flex-end; }
button { font: inherit; padding: 6px 14px; border: 1px solid #c9ccd1; border-radius: 4px; background: #fff; cursor: pointer; }
@page { margin: 14mm; }
@media print {
  body { background: #fff; padding: 0; }
  main { max-width: none; border: 0; padding: 0; }
  .no-print { display: none !important; }
  th { position: static; }
  section.image-section { break-before: page; }
  section.image-section:first-of-type { break-before: auto; }
  h2, h3, h4 { break-after: avoid; }
  figure, tr { break-inside: avoid; }
}
`;

export function buildReportHtml(model: ReportModel, sections: ReportSections, assets: ReportAssets): string {
  const heading = model.title.trim() || 'Texture analysis report';
  const contents =
    model.images.length > 1
      ? `<nav class="no-print"><h3>Images</h3><ol>${model.images
          .map((image, index) => `<li><a href="#image-${index}">${escapeHtml(image.name)}</a></li>`)
          .join('')}</ol></nav>`
      : '';
  const body = model.images.map((image, index) => imageSection(image, model, sections, assets, index)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="toolbar no-print"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<main>
<header>
<h1>${escapeHtml(heading)}</h1>
<p class="subtitle">${escapeHtml(`Texture Workbench · core ${model.coreVersion} · ${formatDateTime(model.createdAt)}`)}</p>
${model.notes.trim() ? `<p class="notes">${escapeHtml(model.notes.trim())}</p>` : ''}
${contents}
</header>
${body}
<footer>
<p>Every measurement above was computed by Texture Workbench (core ${escapeHtml(model.coreVersion)}) from the images identified by their
SHA-256 checksums, with the analysis settings shown. Feature definitions are in the documentation at <code>/docs/equations.html</code>.</p>
</footer>
</main>
</body>
</html>
`;
}

export function reportFileName(model: ReportModel, date = new Date()): string {
  const single = model.images.length === 1 ? fileStem(model.images[0].name) : 'session';
  return `${single}-report-${timestampForFileName(date)}.html`;
}
