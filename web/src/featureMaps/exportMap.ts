// Saving the feature map: a PNG with its colours at one pixel per grid point, or a 32-bit float TIFF of its values.

import { downloadBlob, fileStem } from '../files/download';
import { colorTableById } from '../image/colorTables';
import type { FeatureMapView } from './featureMapStore';
import { renderMapRgba } from './mapImage';
import { encodeFloat32Tiff } from '@glcm/api';

function baseName(map: FeatureMapView): string {
  return `${fileStem(map.info.imageName)}-${map.info.settings.feature}-map`;
}

export async function saveFeatureMapPng(map: FeatureMapView): Promise<void> {
  const { info, values, window } = map;
  if (!values || !window) {
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = info.columns;
  canvas.height = info.rows;
  canvas.getContext('2d')!.putImageData(new ImageData(renderMapRgba(values, window, colorTableById(map.colorTable)), info.columns, info.rows), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    throw new Error('The browser could not encode the PNG');
  }
  downloadBlob(blob, `${baseName(map)}.png`);
}

export function saveFeatureMapTiff(map: FeatureMapView): void {
  const { info, values } = map;
  if (!values) {
    return;
  }
  // The description records what the values are, for reading the file elsewhere
  const description = JSON.stringify({
    format: 'glcm-feature-map',
    version: 1,
    image: info.imageName,
    coreVersion: info.coreVersion,
    settings: info.settings,
    step: info.step,
    columns: info.columns,
    rows: info.rows,
  });
  const tiff = encodeFloat32Tiff(values, info.columns, info.rows, description);
  downloadBlob(new Blob([tiff], { type: 'image/tiff' }), `${baseName(map)}.tif`);
}
