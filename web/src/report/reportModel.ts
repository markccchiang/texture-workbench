// What a report shows: the runs of the Results panel grouped by image, with the ROIs, settings and rows of each
// (doc/ui-design-plan.md, section 6.4). Pure: the browser parts live in reportAssets.tsx.

import type { AnalysisSettings, FeatureInfo, ImageInfo, PixelSpacing } from '@glcm/api';
import { areaMm2 } from '../image/spacing';
import { chartCaption, type ChartKind } from '../results/ResultsPlot';
import { distancesOf, latestMeasurements, plotFeatures } from '../results/plotData';
import type { AnalysisRun } from '../results/resultsStore';
import type { ResultRow } from '../results/rows';
import { SHAPE_LABELS, shapeKind } from '../rois/geometry';
import type { ManagedRoi } from '../rois/roiStore';

/** Features that get a chart of their own; the rest are in the results table */
export const MAX_CHART_FEATURES = 12;

export interface ReportRoi {
  id: string;
  name: string;
  /** Empty when the ROI has no class */
  className: string;
  /** Empty for ROIs known only from their measurements */
  color: string;
  /** "Rectangle", "Ellipse", …; empty for ROIs known only from their measurements */
  shape: string;
  pixelCount: number | null;
  areaMm2: number | null;
}

export interface ReportSettingsGroup {
  settings: AnalysisSettings;
  /** When the analyses using these settings finished */
  timestamps: string[];
  measurements: number;
}

export interface ChartSpec {
  key: string;
  kind: ChartKind;
  featureId: string;
  featureName: string;
  distance: number;
  caption: string;
}

export interface ReportImage {
  /** Identifies the image in the report and in the rendered assets */
  key: string;
  name: string;
  sha256: string;
  /** The image open in the viewer: only this one can be drawn with its ROIs */
  open: boolean;
  info: ImageInfo | null;
  pixelSpacing: PixelSpacing | null;
  rois: ReportRoi[];
  runs: AnalysisRun[];
  rows: ResultRow[];
  settingsGroups: ReportSettingsGroup[];
  charts: ChartSpec[];
}

export interface ReportModel {
  title: string;
  notes: string;
  /** ISO 8601 */
  createdAt: string;
  coreVersion: string;
  images: ReportImage[];
  /** The catalog, for the column labels and the feature names */
  features: FeatureInfo[];
}

export interface ReportInput {
  runs: readonly AnalysisRun[];
  rows: readonly ResultRow[];
  features: readonly FeatureInfo[];
  /** The open image with its ROIs, when one is open */
  openImage: { info: ImageInfo; rois: readonly ManagedRoi[] } | null;
  title: string;
  notes: string;
  createdAt: string;
  coreVersion: string;
}

function imageKey(sha256: string, name: string): string {
  return `${sha256}:${name}`;
}

function settingsGroupsOf(runs: readonly AnalysisRun[]): ReportSettingsGroup[] {
  const groups = new Map<string, ReportSettingsGroup>();
  for (const run of runs) {
    const key = JSON.stringify(run.settings);
    const measurements = run.results.filter((result) => result !== undefined).length;
    const group = groups.get(key);
    if (group) {
      group.timestamps.push(run.timestamp);
      group.measurements += measurements;
    } else {
      groups.set(key, { settings: run.settings, timestamps: [run.timestamp], measurements });
    }
  }
  return [...groups.values()];
}

/** The ROIs of the open image, or what the measurements say about the ROIs of an image measured earlier */
function roisOf(rows: readonly ResultRow[], managed: readonly ManagedRoi[] | null, pixelSpacing: PixelSpacing | null): ReportRoi[] {
  const pixelCounts = new Map<string, number>();
  const classes = new Map<string, string>();
  const names = new Map<string, string>();
  for (const row of rows) {
    if (!pixelCounts.has(row.roiId)) {
      pixelCounts.set(row.roiId, row.pixelCount);
      names.set(row.roiId, row.roiName);
    }
    if (row.roiClass) {
      classes.set(row.roiId, row.roiClass);
    }
  }
  const measured = (id: string) => {
    const pixelCount = pixelCounts.get(id) ?? null;
    return { pixelCount, areaMm2: pixelCount !== null && pixelSpacing ? areaMm2(pixelCount, pixelSpacing) : null };
  };
  if (managed) {
    return managed.map((roi) => ({
      id: roi.id,
      name: roi.name,
      className: roi.className ?? '',
      color: roi.color,
      shape: SHAPE_LABELS[shapeKind(roi.shape)],
      ...measured(roi.id),
    }));
  }
  return [...names.entries()].map(([id, name]) => ({
    id,
    name,
    className: classes.get(id) ?? '',
    color: '',
    shape: '',
    ...measured(id),
  }));
}

/**
 * The charts of one image: a bar chart per measured feature (the first MAX_CHART_FEATURES of the catalog order), plus a
 * polar chart of the first feature when the directions were kept, and a distance chart when several distances were
 * measured.
 */
export function chartSpecsOf(runs: readonly AnalysisRun[], features: readonly FeatureInfo[]): ChartSpec[] {
  const measured = plotFeatures(runs, features).slice(0, MAX_CHART_FEATURES);
  const specs: ChartSpec[] = [];
  for (const feature of measured) {
    const distances = distancesOf(latestMeasurements(runs, feature.id));
    const distance = distances[0] ?? 1;
    const add = (kind: ChartKind) =>
      specs.push({
        key: `${kind}:${feature.id}`,
        kind,
        featureId: feature.id,
        featureName: feature.name,
        distance,
        caption: chartCaption(kind, distance, distances.length, false),
      });
    add('bars');
    if (feature === measured[0]) {
      if (runs.some((run) => run.settings.aggregation === 'perDirectionAndMean')) {
        add('polar');
      }
      if (distances.length > 1) {
        add('distance');
      }
    }
  }
  return specs;
}

/** Groups the runs by image, keeping the order in which the images were first measured */
export function buildReportModel(input: ReportInput): ReportModel {
  const images = new Map<string, ReportImage>();
  for (const run of input.runs) {
    if (run.results.every((result) => result === undefined)) {
      continue; // nothing measured (yet)
    }
    const key = imageKey(run.imageSha256, run.imageName);
    const image = images.get(key);
    if (image) {
      image.runs.push(run);
      image.pixelSpacing = image.pixelSpacing ?? run.pixelSpacing;
    } else {
      images.set(key, {
        key,
        name: run.imageName,
        sha256: run.imageSha256,
        open: input.openImage?.info.sha256 === run.imageSha256,
        info: input.openImage?.info.sha256 === run.imageSha256 ? input.openImage.info : null,
        pixelSpacing: run.pixelSpacing,
        rois: [],
        runs: [run],
        rows: [],
        settingsGroups: [],
        charts: [],
      });
    }
  }

  for (const image of images.values()) {
    const analysisIds = new Set(image.runs.map((run) => run.analysisId));
    image.rows = input.rows.filter((row) => analysisIds.has(row.analysisId));
    image.settingsGroups = settingsGroupsOf(image.runs);
    image.rois = roisOf(image.rows, image.open ? (input.openImage?.rois ?? null) : null, image.pixelSpacing);
    image.charts = chartSpecsOf(image.runs, input.features);
  }

  return {
    title: input.title,
    notes: input.notes,
    createdAt: input.createdAt,
    coreVersion: input.coreVersion,
    images: [...images.values()],
    features: [...input.features],
  };
}

export interface ReportSummary {
  images: number;
  rois: number;
  rows: number;
  charts: number;
}

export function reportSummary(model: ReportModel): ReportSummary {
  return {
    images: model.images.length,
    rois: model.images.reduce((total, image) => total + image.rois.length, 0),
    rows: model.images.reduce((total, image) => total + image.rows.length, 0),
    charts: model.images.reduce((total, image) => total + image.charts.length, 0),
  };
}
