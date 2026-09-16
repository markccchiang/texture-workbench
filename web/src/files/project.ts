// Project files (*.glcmproj, doc/ui-design-plan.md, section 6.4): image reference (optionally with the image embedded),
// ROIs, settings and results.

import type { PixelSpacing } from '@glcm/api';
import { ProjectDocument, type AnalysisSettings, type ImageInfo, type MeasurementResult } from '@glcm/api';
import type { AnalysisRun } from '../results/resultsStore';
import type { ManagedRoi, RoiClass } from '../rois/roiStore';
import { fileStem } from './download';
import { parseAppFile } from './validate';

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface ProjectContents {
  info: ImageInfo;
  rois: readonly ManagedRoi[];
  classes?: readonly RoiClass[];
  settings: AnalysisSettings | null;
  runs: readonly AnalysisRun[];
  /** The spacing in use (null: none); omitted: not saved, so the image's own applies */
  pixelSpacing?: PixelSpacing | null;
  coreVersion: string;
  /** The uploaded image file, to embed */
  imageBytes?: Uint8Array;
  createdAt?: string;
}

/** Only finished analyses are saved, with the results that finished */
export function buildProject({ info, rois, classes = [], settings, runs, pixelSpacing, coreVersion, imageBytes, createdAt }: ProjectContents): ProjectDocument {
  return {
    format: 'glcm-project',
    version: 1,
    createdAt: createdAt ?? new Date().toISOString(),
    coreVersion,
    image: {
      name: info.name,
      width: info.width,
      height: info.height,
      bitDepth: info.bitDepth,
      sha256: info.sha256,
      ...(pixelSpacing !== undefined ? { pixelSpacing } : {}),
      ...(imageBytes ? { data: bytesToBase64(imageBytes) } : {}),
    },
    ...(classes.length > 0 ? { classes: classes.map(({ name, color }) => ({ name, color })) } : {}),
    rois: rois.map(({ id, name, color, visible, shape, className, slice }) => ({
      id,
      name,
      color,
      visible,
      ...(className ? { class: className } : {}),
      ...(slice !== undefined ? { slice } : {}),
      shape,
    })),
    settings,
    results: runs
      .filter((run) => run.status !== 'queued' && run.status !== 'running')
      .map((run) => ({
        analysisId: run.analysisId,
        imageName: run.imageName,
        imageSha256: run.imageSha256,
        status: run.status,
        timestamp: run.timestamp,
        settings: run.settings,
        ...(run.pixelSpacing ? { pixelSpacing: run.pixelSpacing } : {}),
        results: run.results.filter((result): result is MeasurementResult => result !== undefined),
      })),
  };
}

export function projectFileName(imageName: string): string {
  return `${fileStem(imageName)}.glcmproj`;
}

export function parseProject(text: string): ProjectDocument {
  return parseAppFile<ProjectDocument>(text, ProjectDocument, 'glcm-project', 'project file');
}

export function runsFromProject(project: ProjectDocument): AnalysisRun[] {
  return project.results.map((run) => ({
    analysisId: run.analysisId,
    imageName: run.imageName,
    imageSha256: run.imageSha256,
    settings: run.settings,
    pixelSpacing: run.pixelSpacing ?? null,
    status: run.status,
    timestamp: run.timestamp,
    completed: run.results.length,
    total: run.results.length,
    results: [...run.results],
  }));
}
