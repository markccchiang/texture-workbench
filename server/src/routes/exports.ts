// Exports (doc/ui-design-plan.md, section 6.4). Files are produced by glcm_core, so the web API, the addon and the C++
// library write the same CSV, JSON and ROI images.

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse, ResultsExportRequest, RoiImagesExportRequest, type ExportFormat, type ResultsDocument } from '@glcm/api';
import * as native from '@glcm/native';
import { Type } from 'typebox';
import { ApiError } from '../errors.js';
import { requireSlice } from '../imageInfo.js';
import { attachment, createZip, fileStem } from '../files.js';
import type { ImageStore } from '../storage/ImageStore.js';

export interface ExportRoutesOptions {
  store: ImageStore;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

const Download = (description: string, types: string[]) => ({
  description,
  content: Object.fromEntries(types.map((type) => [type, { schema: Type.Unsafe<Buffer>({ type: 'string', format: 'binary' }) }])),
});

function nativeError(error: unknown): never {
  if ((error as { code?: string }).code === 'INVALID_ARGUMENT') {
    throw new ApiError(400, 'BadRequest', (error as Error).message);
  }
  throw error;
}

/** A results document as CSV or canonical JSON, written by glcm_core */
export function formatResultsDocument(document: ResultsDocument, format: ExportFormat): string {
  const text = JSON.stringify({ format: 'glcm-results', version: 1, ...document });
  try {
    return native.formatResults(text, format);
  } catch (error) {
    return nativeError(error);
  }
}

/** Merges documents computed with the same settings on the same image and pixel spacing, keeping their order */
export function groupDocuments(documents: readonly ResultsDocument[]): ResultsDocument[] {
  const groups = new Map<string, ResultsDocument>();
  for (const document of documents) {
    const key = JSON.stringify([document.image.sha256, document.image.name, document.image.pixelSpacing ?? null, document.image.valueConversion ?? '', document.settings]);
    const group = groups.get(key);
    if (group) {
      group.results.push(...document.results);
    } else {
      groups.set(key, { ...document, results: [...document.results] });
    }
  }
  return [...groups.values()];
}

export const exportRoutes: FastifyPluginAsyncTypebox<ExportRoutesOptions> = async (app, { store }) => {
  app.post(
    '/exports/results',
    {
      schema: {
        summary: 'Export results as CSV or JSON',
        description:
          'One file when all documents share settings and image; otherwise a ZIP with one file per group. CSV files repeat the settings as "# key=value" lines; non-standard feature columns end with " [non-standard]".',
        tags: ['exports'],
        body: ResultsExportRequest,
        response: {
          200: Download('CSV, JSON or ZIP file', [CONTENT_TYPES.csv, CONTENT_TYPES.json, 'application/zip']),
          400: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const { format, documents } = request.body;
      const groups = groupDocuments(documents);
      const files = groups.map((group, i) => ({
        name: groups.length === 1 ? `${fileStem(group.image.name)}-results.${format}` : `${i + 1}-${fileStem(group.image.name)}-results.${format}`,
        data: Buffer.from(formatResultsDocument(group, format)),
      }));

      if (files.length === 1) {
        return reply.header('Content-Disposition', attachment(files[0].name)).type(CONTENT_TYPES[format]).send(files[0].data);
      }
      return reply.header('Content-Disposition', attachment('results.zip')).type('application/zip').send(createZip(files));
    },
  );

  app.post(
    '/exports/roi-images',
    {
      schema: {
        summary: 'Export ROI images as a ZIP',
        description:
          'Per ROI: the bounding-box crop with outside pixels 0 or transparent (PNG, or TIFF for 16-bit images), <name>_mask.png, optionally <name>_q<Ng>.png; plus manifest.json. For a stack, the files of each slice are in a folder slice-<n>/ with its own manifest.',
        tags: ['exports'],
        body: RoiImagesExportRequest,
        response: { 200: Download('ZIP file', ['application/zip']), 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { imageId, rois, settings, transparentOutside, includeQuantized } = request.body;
      const info = await store.info(imageId);
      if (!info) {
        throw new ApiError(404, 'NotFound', `Image ${imageId} was not found`);
      }
      if (includeQuantized && !settings) {
        throw new ApiError(400, 'BadRequest', 'includeQuantized needs settings');
      }
      // A stack: the ROIs of each slice in a folder slice-<n>/ with its own manifest
      const slices = [...new Set(rois.map((roi) => roi.slice ?? 1))].sort((a, b) => a - b);
      const files: Array<{ name: string; data: Buffer }> = [];
      for (const slice of slices) {
        const exported = await native
          .exportRoiImages(
            await store.pixels(info, requireSlice(info, slice)),
            info.width,
            info.height,
            info.bitDepth,
            JSON.stringify(rois.filter((roi) => (roi.slice ?? 1) === slice)),
            settings ? JSON.stringify(settings) : '',
            transparentOutside,
            includeQuantized,
          )
          .catch(nativeError);
        files.push(...exported.map(({ name, data }) => ({ name: info.slices > 1 ? `slice-${slice}/${name}` : name, data })));
      }
      return reply
        .header('Content-Disposition', attachment(`${fileStem(info.name)}-rois.zip`))
        .type('application/zip')
        .send(createZip(files.map(({ name, data }) => ({ name, data }))));
    },
  );
};
