// Results table rows (doc/ui-design-plan.md, section 6.3.3). Each measurement becomes rows according to its
// aggregation; rows keep the settings they were computed with.

import type { AnalysisSettings, FeatureInfo, MeasurementResult, MeasurementStatus, PixelSpacing } from '@glcm/api';
import { areaMm2 } from '../image/spacing';

export type RowDirection = '0' | '45' | '90' | '135' | 'mean' | 'range';

export interface ResultRow {
  key: string;
  analysisId: string;
  imageName: string;
  roiId: string;
  roiName: string;
  /** Empty when the ROI has no class */
  roiClass: string;
  /** The ROI's slice of a stack; null for an image without slices */
  slice: number | null;
  distance: number;
  /** null for skipped and failed measurements */
  direction: RowDirection | null;
  status: MeasurementStatus;
  error: string;
  pixelCount: number;
  values: Record<string, number | null>;
  score: number | null;
  warnings: string[];
  settings: AnalysisSettings;
  pixelSpacing: PixelSpacing | null;
}

export const DIRECTION_LABELS: Record<RowDirection, string> = {
  '0': '0°',
  '45': '45°',
  '90': '90°',
  '135': '135°',
  mean: 'Mean',
  range: 'Range',
};

export function rowDirections(settings: AnalysisSettings): RowDirection[] {
  switch (settings.aggregation) {
    case 'meanOnly':
      return ['mean'];
    case 'meanAndRange':
      return ['mean', 'range'];
    default:
      return [...[0, 45, 90, 135].filter((d) => settings.directions.includes(d as 0)).map((d) => String(d) as RowDirection), 'mean'];
  }
}

export function rowsForResult(
  result: MeasurementResult,
  context: { analysisId: string; index: number; imageName: string; settings: AnalysisSettings; pixelSpacing?: PixelSpacing | null },
): ResultRow[] {
  const base = {
    analysisId: context.analysisId,
    imageName: context.imageName,
    roiId: result.roiId,
    roiName: result.roiName,
    roiClass: result.roiClass ?? '',
    slice: result.slice ?? null,
    distance: result.distance,
    status: result.status,
    error: result.error,
    pixelCount: result.pixelCount,
    warnings: result.warnings,
    settings: context.settings,
    pixelSpacing: context.pixelSpacing ?? null,
  };
  const keyPrefix = `${context.analysisId}:${context.index}`;
  if (result.status !== 'ok') {
    return [{ ...base, key: keyPrefix, direction: null, values: {}, score: null }];
  }
  return rowDirections(context.settings).map((direction) => ({
    ...base,
    key: `${keyPrefix}:${direction}`,
    direction,
    values: Object.fromEntries(Object.entries(result.values).map(([id, values]) => [id, values[direction]])),
    score: result.score ? result.score[direction] : null,
  }));
}

/** Six significant digits; scientific notation for very small or large magnitudes */
export function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '';
  }
  if (value === 0) {
    return '0';
  }
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-4) {
    return value.toExponential(4);
  }
  return String(Number(value.toPrecision(6)));
}

export interface Column {
  id: string;
  label: string;
  /** Non-standard feature (⚠) */
  nonStandard?: boolean;
  numeric: boolean;
  value(row: ResultRow): string | number | null;
}

/** Fixed columns (Image first when rows come from several images), then the features present in the rows in catalog order, then the score if any row has one */
export function columnsForRows(rows: readonly ResultRow[], features: readonly FeatureInfo[]): Column[] {
  const present = new Set(rows.flatMap((row) => Object.keys(row.values)));
  const columns: Column[] = [
    // Only needed once the rows come from more than one image, e.g. after a batch
    ...(new Set(rows.map((row) => row.imageName)).size > 1 ? [{ id: 'image', label: 'Image', numeric: false, value: (row: ResultRow) => row.imageName }] : []),
    { id: 'roi', label: 'ROI', numeric: false, value: (row) => row.roiName },
    ...(rows.some((row) => row.roiClass) ? [{ id: 'class', label: 'Class', numeric: false, value: (row: ResultRow) => row.roiClass }] : []),
    // Only for ROIs on the slices of a stack
    ...(rows.some((row) => row.slice !== null) ? [{ id: 'slice', label: 'Slice', numeric: true, value: (row: ResultRow) => row.slice }] : []),
    { id: 'distance', label: 'd', numeric: true, value: (row) => row.distance },
    { id: 'direction', label: 'Dir', numeric: false, value: (row) => (row.direction ? DIRECTION_LABELS[row.direction] : '') },
    { id: 'pixels', label: 'Pixels', numeric: true, value: (row) => row.pixelCount },
    // Once a measurement has a pixel spacing
    ...(rows.some((row) => row.pixelSpacing)
      ? [{ id: 'area', label: 'Area (mm²)', numeric: true, value: (row: ResultRow) => (row.pixelSpacing ? areaMm2(row.pixelCount, row.pixelSpacing) : null) }]
      : []),
    { id: 'grayLevels', label: 'Ng', numeric: true, value: (row) => row.settings.grayLevels },
  ];
  for (const feature of features) {
    if (present.has(feature.id)) {
      columns.push({ id: `feature:${feature.id}`, label: feature.name, nonStandard: feature.nonStandard, numeric: true, value: (row) => row.values[feature.id] ?? null });
    }
  }
  if (rows.some((row) => row.settings.score.enabled)) {
    columns.push({ id: 'score', label: 'Score', numeric: true, value: (row) => row.score });
  }
  columns.push({ id: 'status', label: 'Status', numeric: false, value: (row) => (row.status === 'ok' ? (row.warnings.length ? '⚠' : '') : `${row.status}: ${row.error}`) });
  return columns;
}

export function cellText(column: Column, row: ResultRow): string {
  const value = column.value(row);
  return typeof value === 'number' ? formatValue(value) : (value ?? '');
}

export type SortDirection = 'asc' | 'desc';

/** Stable sort; empty numeric cells go last in either direction */
export function sortRows(rows: readonly ResultRow[], column: Column, direction: SortDirection): ResultRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: column.value(row) }))
    .sort((a, b) => {
      const aEmpty = a.value === null || a.value === '';
      const bEmpty = b.value === null || b.value === '';
      if (aEmpty || bEmpty) {
        return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
      }
      const order =
        typeof a.value === 'number' && typeof b.value === 'number'
          ? a.value - b.value
          : String(a.value).localeCompare(String(b.value), undefined, { numeric: true });
      return order === 0 ? a.index - b.index : sign * order;
    })
    .map(({ row }) => row);
}

/**
 * Text that spreadsheets would evaluate as a formula when pasted (it starts with =, +, - or @) gets a leading
 * apostrophe, as in the core's CSV export. Used for text cells only; numbers are pasted as numbers.
 */
export function spreadsheetText(text: string): string {
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

/** Tab-separated text with a header row; numbers keep full precision */
export function rowsToTsv(rows: readonly ResultRow[], columns: readonly Column[]): string {
  const clean = (text: string) => text.replace(/[\t\r\n]+/g, ' ');
  const header = columns.map((column) => clean(column.nonStandard ? `${column.label} [non-standard]` : column.label));
  const lines = rows.map((row) =>
    columns.map((column) => {
      const value = column.value(row);
      return typeof value === 'number' ? String(value) : spreadsheetText(clean(value ?? ''));
    }),
  );
  return [header, ...lines].map((line) => line.join('\t')).join('\n');
}
