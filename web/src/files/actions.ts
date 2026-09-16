// Save, import and export actions of the menus and panels (doc/ui-design-plan.md, section 6.4).

import type { ExportFormat, ImageInfo, ProjectDocument, ResultsDocument } from '@glcm/api';
import { notifications } from '@mantine/notifications';
import { downloadOriginal, exportResults, exportRoiImages, findImagesBySha256, getCoreVersion } from '../api/client';
import { adaptToImage } from '@glcm/api';
import { useAnalysisSettings } from '../analysis/settingsStore';
import { useResults } from '../results/resultsStore';
import { useRois } from '../rois/roiStore';
import { openImageFile, openStoredImage } from '../stores/imageLoader';
import { useUi } from '../stores/uiStore';
import { useViewer } from '../stores/viewerStore';
import { downloadBlob, downloadText } from './download';
import { base64ToBytes, buildProject, parseProject, projectFileName, runsFromProject } from './project';
import { buildRoiSet, parseRoiSet, prepareRoiImport, roiSetFileName } from './roiSet';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(title: string, error: unknown): void {
  notifications.show({ color: 'red', title, message: errorMessage(error), autoClose: 10000 });
}

function inform(title: string, message: string): void {
  notifications.show({ color: 'gray', title, message });
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The results table as documents: one per analysis, with its finished results */
export function resultsDocuments(): ResultsDocument[] {
  return useResults
    .getState()
    .runs.map((run) => ({
      timestamp: run.timestamp,
      image: { name: run.imageName, sha256: run.imageSha256, ...(run.pixelSpacing ? { pixelSpacing: run.pixelSpacing } : {}) },
      settings: run.settings,
      results: run.results.filter((result) => result !== undefined),
    }))
    .filter((document) => document.results.length > 0);
}

export async function exportResultsFile(format: ExportFormat): Promise<void> {
  const documents = resultsDocuments();
  if (documents.length === 0) {
    inform('Nothing to export', 'Measure ROIs first; the results table is empty.');
    return;
  }
  try {
    const { blob, fileName } = await exportResults(format, documents);
    downloadBlob(blob, fileName);
  } catch (error) {
    fail('Could not export the results', error);
  }
}

export function exportRoiSetFile(): void {
  const image = useViewer.getState().image;
  const { rois } = useRois.getState();
  if (!image || rois.length === 0) {
    inform('Nothing to export', 'Add ROIs to the ROI Manager first.');
    return;
  }
  downloadText(`${JSON.stringify(buildRoiSet(image.info, rois, useRois.getState().classes), null, 2)}\n`, roiSetFileName(image.info.name));
}

export async function importRoiSetFile(file: File): Promise<void> {
  const image = useViewer.getState().image;
  if (!image) {
    inform('Open an image first', 'ROIs are imported onto the open image.');
    return;
  }
  try {
    const { rois, classes, warnings } = prepareRoiImport(parseRoiSet(await file.text()), image.info);
    if (rois.length === 0) {
      notifications.show({ color: 'yellow', title: 'No ROIs imported', message: warnings.join(' ') || `${file.name} contains no ROIs.` });
      return;
    }
    useRois.getState().mergeClasses(classes);
    useRois.getState().importRois(rois);
    notifications.show({
      color: warnings.length > 0 ? 'yellow' : 'green',
      title: `Imported ${plural(rois.length, 'ROI')}`,
      message: warnings.join(' ') || `From ${file.name}`,
      autoClose: warnings.length > 0 ? 10000 : 4000,
    });
  } catch (error) {
    fail(`Could not import ${file.name}`, error);
  }
}

export interface RoiImagesOptions {
  scope: 'selected' | 'all';
  transparentOutside: boolean;
  includeQuantized: boolean;
}

export async function exportRoiImagesFile(options: RoiImagesOptions): Promise<boolean> {
  const image = useViewer.getState().image;
  const { rois, selectedIds } = useRois.getState();
  const chosen = options.scope === 'selected' ? rois.filter((roi) => selectedIds.includes(roi.id)) : rois;
  if (!image || chosen.length === 0) {
    inform('Nothing to export', options.scope === 'selected' ? 'Select ROIs in the ROI Manager first.' : 'Add ROIs first.');
    return false;
  }
  const stored = useAnalysisSettings.getState().settings;
  if (options.includeQuantized && !stored) {
    inform('Settings not loaded', 'Quantized images need the analysis settings.');
    return false;
  }
  try {
    const { blob, fileName } = await exportRoiImages({
      imageId: image.info.imageId,
      rois: chosen.map(({ id, name, color, shape }) => ({ id, name, color, shape })),
      settings: stored ? adaptToImage(stored, image.info.bitDepth) : undefined,
      transparentOutside: image.info.bitDepth === 8 && options.transparentOutside,
      includeQuantized: options.includeQuantized,
    });
    downloadBlob(blob, fileName);
    return true;
  } catch (error) {
    fail('Could not export the ROI images', error);
    return false;
  }
}

export async function saveProjectFile({ embedImage }: { embedImage: boolean }): Promise<boolean> {
  const image = useViewer.getState().image;
  if (!image) {
    inform('Nothing to save', 'Open an image first.');
    return false;
  }
  try {
    const [coreVersion, imageBytes] = await Promise.all([getCoreVersion(), embedImage ? downloadOriginal(image.info.imageId) : undefined]);
    const project = buildProject({
      classes: useRois.getState().classes,
      info: image.info,
      pixelSpacing: useViewer.getState().pixelSpacing,
      rois: useRois.getState().rois,
      settings: useAnalysisSettings.getState().settings,
      runs: useResults.getState().runs,
      coreVersion,
      imageBytes,
    });
    downloadText(JSON.stringify(project), projectFileName(image.info.name));
    return true;
  } catch (error) {
    fail('Could not save the project', error);
    return false;
  }
}

/** A project waiting for the user to choose its image file */
let pendingProject: ProjectDocument | null = null;

function restoreProject(project: ProjectDocument, info: ImageInfo): void {
  const rois = useRois.getState();
  rois.reset();
  rois.setClasses((project.classes ?? []).map(({ name, color }) => ({ name, color: color ?? '' })));
  rois.importRois(
    project.rois.map(({ id, name, color, visible, shape, class: className }) => ({ id, name, color: color ?? '', visible, shape, ...(className ? { className } : {}) })),
  );
  // Opening a project is not an undoable edit
  useRois.setState({ past: [], future: [], selectedIds: [] });
  if (project.settings) {
    useAnalysisSettings.getState().setSettings(project.settings, { history: 'clear' });
  }
  useResults.getState().loadRuns(runsFromProject(project));
  if (project.image.pixelSpacing !== undefined) {
    useViewer.getState().setPixelSpacing(project.image.pixelSpacing);
  }

  const mismatch = info.sha256 !== project.image.sha256;
  notifications.show({
    color: mismatch ? 'yellow' : 'green',
    title: `Opened the project of ${project.image.name}`,
    message: mismatch
      ? `The chosen image is not the file saved in the project (${project.image.name}); ROIs and results may not match it.`
      : `${plural(project.rois.length, 'ROI')}, ${plural(project.results.length, 'analysis')}`.replace('analysiss', 'analyses'),
    autoClose: mismatch ? 10000 : 4000,
  });
}

export async function openProjectFile(file: File): Promise<void> {
  let project: ProjectDocument;
  try {
    project = parseProject(await file.text());
  } catch (error) {
    fail(`Could not open ${file.name}`, error);
    return;
  }

  let info: ImageInfo | null;
  try {
    const [stored] = await findImagesBySha256(project.image.sha256);
    if (stored) {
      info = await openStoredImage(stored);
    } else if (project.image.data) {
      info = await openImageFile(new File([base64ToBytes(project.image.data) as BlobPart], project.image.name));
    } else {
      pendingProject = project;
      notifications.show({
        color: 'blue',
        title: `Choose the image ${project.image.name}`,
        message: 'The server does not have the image of this project, and the project does not embed it.',
        autoClose: 10000,
      });
      useUi.getState().requestFile('projectImage');
      return;
    }
  } catch (error) {
    fail(`Could not open the image of ${file.name}`, error);
    return;
  }
  if (info) {
    restoreProject(project, info);
  }
}

/** The image file chosen for a pending project */
export async function continueProjectWithImage(file: File): Promise<void> {
  const project = pendingProject;
  pendingProject = null;
  const info = await openImageFile(file);
  if (project && info) {
    restoreProject(project, info);
  }
}
