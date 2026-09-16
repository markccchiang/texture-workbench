// Save, import and export (doc/ui-design-plan.md, sections 6.4 and 8.4): export requests handled by the server, and the
// ROI set and project files the web app reads and writes.

import { Type, type Static } from 'typebox';
import { AnalysisSettings, AnalysisStatus, MAX_ROIS_PER_REQUEST, MeasurementResult, Roi } from './analysis.js';
import { IMAGE_ID_PATTERN, ImageInfo, PixelSpacing } from './schemas.js';

export const SHA256_PATTERN = '^[0-9a-f]{64}$';

// ---------------------------------------------------------------------------------------------------------------------
// Images by content
// ---------------------------------------------------------------------------------------------------------------------

export const ImagesQuery = Type.Object({
  sha256: Type.Optional(Type.String({ pattern: SHA256_PATTERN, description: 'Only images whose uploaded file has this SHA-256' })),
});
export type ImagesQuery = Static<typeof ImagesQuery>;

export const ImageListResponse = Type.Object({ images: Type.Array(ImageInfo, { description: 'Newest first' }) });
export type ImageListResponse = Static<typeof ImageListResponse>;

// ---------------------------------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------------------------------

export const ResultsDocument = Type.Object(
  {
    timestamp: Type.String(),
    image: Type.Object({
      name: Type.String(),
      sha256: Type.String(),
      pixelSpacing: Type.Optional(Type.Unsafe<PixelSpacing>({ ...PixelSpacing, description: 'Adds ROI areas in mm² to the export' })),
      valueConversion: Type.Optional(Type.String({ description: 'How the stored samples relate to the values of a DICOM or NIfTI file' })),
    }),
    settings: AnalysisSettings,
    results: Type.Array(MeasurementResult),
  },
  { description: 'Results computed with one set of settings on one image, e.g. one analysis' },
);
export type ResultsDocument = Static<typeof ResultsDocument>;

export const ExportFormat = Type.Union([Type.Literal('csv'), Type.Literal('json')]);
export type ExportFormat = Static<typeof ExportFormat>;

export const ResultsExportRequest = Type.Object({
  format: ExportFormat,
  documents: Type.Array(ResultsDocument, {
    minItems: 1,
    maxItems: 1000,
    description:
      'Documents with the same settings and image are merged into one file; several groups are returned as a ZIP with one file per group',
  }),
});
export type ResultsExportRequest = Static<typeof ResultsExportRequest>;

export const RoiImagesExportRequest = Type.Object({
  imageId: Type.String({ pattern: IMAGE_ID_PATTERN }),
  rois: Type.Array(Roi, { minItems: 1, maxItems: MAX_ROIS_PER_REQUEST }),
  settings: Type.Optional(AnalysisSettings),
  transparentOutside: Type.Boolean({ description: '8-bit images: pixels outside the ROI are transparent instead of 0' }),
  includeQuantized: Type.Boolean({ description: 'Also export the quantized gray levels (uses settings)' }),
});
export type RoiImagesExportRequest = Static<typeof RoiImagesExportRequest>;

// ---------------------------------------------------------------------------------------------------------------------
// Files of the web app
// ---------------------------------------------------------------------------------------------------------------------

export const RoiSetImage = Type.Object({
  name: Type.Optional(Type.String()),
  width: Type.Optional(Type.Integer()),
  height: Type.Optional(Type.Integer()),
  bitDepth: Type.Optional(Type.Integer()),
  slices: Type.Optional(Type.Integer({ minimum: 1, description: 'Slices of the stack the ROIs were drawn on; omitted for a single image' })),
  sha256: Type.Optional(Type.String()),
});
export type RoiSetImage = Static<typeof RoiSetImage>;

export const RoiClass = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  color: Type.Optional(Type.String({ description: '"#RRGGBB", or empty' })),
});
export type RoiClass = Static<typeof RoiClass>;

/** *.roi.json; the same format as glcm::RoiSetToJson */
export const RoiSetDocument = Type.Object({
  format: Type.Literal('glcm-roi-set'),
  version: Type.Literal(1),
  image: Type.Optional(RoiSetImage),
  classes: Type.Optional(Type.Array(RoiClass, { maxItems: 100, description: 'The classes ROIs can belong to' })),
  rois: Type.Array(Roi, { maxItems: MAX_ROIS_PER_REQUEST }),
});
export type RoiSetDocument = Static<typeof RoiSetDocument>;

export const ProjectRoi = Type.Object({ ...Roi.properties, visible: Type.Optional(Type.Boolean()) });
export type ProjectRoi = Static<typeof ProjectRoi>;

export const ProjectRun = Type.Object({
  analysisId: Type.String(),
  imageName: Type.String(),
  imageSha256: Type.String(),
  status: AnalysisStatus,
  timestamp: Type.String(),
  settings: AnalysisSettings,
  pixelSpacing: Type.Optional(PixelSpacing),
  results: Type.Array(MeasurementResult),
});
export type ProjectRun = Static<typeof ProjectRun>;

/** *.glcmproj */
export const ProjectDocument = Type.Object({
  format: Type.Literal('glcm-project'),
  version: Type.Literal(1),
  createdAt: Type.String(),
  coreVersion: Type.String(),
  image: Type.Object({
    name: Type.String(),
    width: Type.Integer(),
    height: Type.Integer(),
    bitDepth: Type.Union([Type.Literal(8), Type.Literal(16)]),
    sha256: Type.String({ pattern: SHA256_PATTERN }),
    pixelSpacing: Type.Optional(
      Type.Union([PixelSpacing, Type.Null()], { description: "The spacing in use when saved; null: none. Omitted: the image's own" }),
    ),
    data: Type.Optional(Type.String({ description: 'The uploaded file, base64-encoded, when embedded for portability' })),
  }),
  classes: Type.Optional(Type.Array(RoiClass, { maxItems: 100 })),
  rois: Type.Array(ProjectRoi, { maxItems: MAX_ROIS_PER_REQUEST }),
  settings: Type.Union([AnalysisSettings, Type.Null()]),
  results: Type.Array(ProjectRun),
});
export type ProjectDocument = Static<typeof ProjectDocument>;
