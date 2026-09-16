// File ▸ Save Report…: builds the report from the Results panel and offers it as one HTML file.

import type { FeatureInfo } from '@glcm/api';
import { notifications } from '@mantine/notifications';
import { getCoreVersion } from '../api/client';
import { loadCatalog } from '../api/queryClient';
import { downloadText } from '../files/download';
import { useResults } from '../results/resultsStore';
import { useRois } from '../rois/roiStore';
import { useViewer } from '../stores/viewerStore';
import { renderReportAssets, type OpenImageSource } from './reportAssets';
import { buildReportHtml, reportFileName, type ReportSections } from './reportHtml';
import { buildReportModel, type ReportModel } from './reportModel';

export interface SaveReportOptions {
  title: string;
  notes: string;
  sections: ReportSections;
}

/** The report of what the app currently holds; the catalog gives the feature names */
export function buildCurrentModel(features: readonly FeatureInfo[], title: string, notes: string, coreVersion: string): ReportModel {
  const { runs, rows } = useResults.getState();
  const image = useViewer.getState().image;
  return buildReportModel({
    runs,
    rows,
    features,
    openImage: image ? { info: image.info, rois: useRois.getState().rois } : null,
    title,
    notes,
    createdAt: new Date().toISOString(),
    coreVersion,
  });
}

function openImageSource(): OpenImageSource | null {
  const viewer = useViewer.getState();
  const image = viewer.image;
  if (!image) {
    return null;
  }
  return {
    imageId: image.info.imageId,
    raw: image.raw,
    width: image.info.width,
    height: image.info.height,
    windowMin: viewer.window.min,
    windowMax: viewer.window.max,
    colorTable: viewer.colorTable,
    rois: useRois.getState().rois,
  };
}

/** Saves the report; false when there is nothing to report or it could not be built */
export async function saveReportFile(options: SaveReportOptions): Promise<boolean> {
  try {
    const catalog = await loadCatalog();
    const coreVersion = await getCoreVersion().catch(() => '');
    const model = buildCurrentModel(catalog.features, options.title, options.notes, coreVersion);
    if (model.images.length === 0) {
      notifications.show({ color: 'gray', title: 'Nothing to report', message: 'Measure ROIs first; the results table is empty.' });
      return false;
    }
    const warnings: string[] = [];
    const assets = await renderReportAssets(model, options.sections, {
      openImage: openImageSource(),
      onWarning: (message) => warnings.push(message),
    });
    downloadText(buildReportHtml(model, options.sections, assets), reportFileName(model), 'text/html');
    if (warnings.length > 0) {
      notifications.show({ color: 'yellow', title: 'Report saved without every picture', message: warnings.join(' '), autoClose: 10000 });
    }
    return true;
  } catch (error) {
    notifications.show({
      color: 'red',
      title: 'Could not save the report',
      message: error instanceof Error ? error.message : String(error),
      autoClose: 10000,
    });
    return false;
  }
}
