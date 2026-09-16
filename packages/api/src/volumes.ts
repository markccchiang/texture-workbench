// NIfTI volumes: uploaded once, previewed slice by slice, and turned into 2D images (POST /volumes/:id/images)

import { type Static, Type } from 'typebox';
import { PixelSpacing, ValueConversion } from './schemas.js';

export const VOLUME_ID_PATTERN = '^vol_[0-9a-f]{32}$';

export const VolumeIdParams = Type.Object({
  id: Type.String({ pattern: VOLUME_ID_PATTERN, description: 'Volume id returned by POST /volumes' }),
});
export type VolumeIdParams = Static<typeof VolumeIdParams>;

export const SliceOrientation = Type.Union([Type.Literal('axial'), Type.Literal('coronal'), Type.Literal('sagittal')], {
  description:
    'Slice planes in RAS orientation: axial (right of the patient on the right, anterior at the top), coronal (superior at the top) and sagittal (anterior on the right, superior at the top)',
});
export type SliceOrientation = Static<typeof SliceOrientation>;

export const SliceGeometry = Type.Object({
  count: Type.Integer({ description: 'Slices in this orientation; slice 0 is the most inferior, posterior or left one' }),
  width: Type.Integer(),
  height: Type.Integer(),
  pixelSpacing: Type.Union([PixelSpacing, Type.Null()], { description: 'In-plane voxel size; null when the file gives none' }),
});
export type SliceGeometry = Static<typeof SliceGeometry>;

export const VolumeInfo = Type.Object({
  volumeId: Type.String({ pattern: VOLUME_ID_PATTERN }),
  name: Type.String({ description: 'File name of the upload' }),
  sizeBytes: Type.Integer({ description: 'Size of the uploaded file' }),
  niftiVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
  dimensions: Type.Array(Type.Integer(), { minItems: 3, maxItems: 3, description: "Voxels along the file's axes i, j, k" }),
  volumes: Type.Integer({ description: 'The 4th dimension, e.g. time points; 1 for a 3D file' }),
  dataType: Type.String({ description: 'e.g. int16 or float32' }),
  axisCodes: Type.String({ description: 'Directions of the i, j and k axes, e.g. RAS or LPS' }),
  orientationSource: Type.Union([Type.Literal('sform'), Type.Literal('qform'), Type.Literal('none')], {
    description: 'Where the orientation comes from; none: the axes are assumed to be RAS',
  }),
  acquisitionOrientation: Type.Union([SliceOrientation], { description: 'The plane of the i and j axes' }),
  slices: Type.Object({ axial: SliceGeometry, coronal: SliceGeometry, sagittal: SliceGeometry }),
  minimum: Type.Number({ description: 'Smallest value after scl_slope and scl_inter, over all volumes' }),
  maximum: Type.Number({ description: 'Largest value after scl_slope and scl_inter, over all volumes' }),
  bitDepth: Type.Union([Type.Literal(8), Type.Literal(16)], { description: 'Bit depth of the images made from the slices' }),
  valueConversion: Type.Union([ValueConversion, Type.Null()], { description: 'How every slice is stored; null when the values are kept' }),
  windowMin: Type.Integer({ description: 'Default display window: 0.5th percentile of all volumes' }),
  windowMax: Type.Integer({ description: 'Default display window: 99.5th percentile of all volumes' }),
  warnings: Type.Array(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
});
export type VolumeInfo = Static<typeof VolumeInfo>;

export const VolumePreviewQuery = Type.Object({
  orientation: SliceOrientation,
  slice: Type.Integer({ minimum: 0 }),
  volume: Type.Optional(Type.Integer({ minimum: 0, description: 'Default 0' })),
  maxSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384, description: 'Largest long side; capped by the server limit' })),
});
export type VolumePreviewQuery = Static<typeof VolumePreviewQuery>;

export const VolumeSliceRequest = Type.Object(
  {
    orientation: SliceOrientation,
    slice: Type.Integer({ minimum: 0 }),
    volume: Type.Optional(Type.Integer({ minimum: 0, description: 'Default 0' })),
  },
  { additionalProperties: false },
);
export type VolumeSliceRequest = Static<typeof VolumeSliceRequest>;

export const VolumeStackRequest = Type.Object(
  {
    orientation: SliceOrientation,
    volume: Type.Optional(Type.Integer({ minimum: 0, description: 'Default 0' })),
  },
  { additionalProperties: false },
);
export type VolumeStackRequest = Static<typeof VolumeStackRequest>;

/** Name of the stack made from a volume, e.g. "brain.nii.gz [axial]" or "bold.nii.gz [axial, volume 3]" */
export function stackImageName(volumeName: string, orientation: SliceOrientation, volume: number, volumes: number): string {
  return `${volumeName} [${orientation}${volumes > 1 ? `, volume ${volume}` : ''}]`;
}

/** Name of the image made from a slice, e.g. "brain.nii.gz [axial 120]" or "bold.nii.gz [axial 12, volume 3]" */
export function sliceImageName(volumeName: string, orientation: SliceOrientation, slice: number, volume: number, volumes: number): string {
  return `${volumeName} [${orientation} ${slice}${volumes > 1 ? `, volume ${volume}` : ''}]`;
}
