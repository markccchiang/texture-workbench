// End-to-end test of DICOM and NIfTI files: a DICOM image opens with its value conversion; a NIfTI volume opens the
// slice dialog, and the chosen slice becomes a 2D image

import { expect, test, type Page } from '@playwright/test';
import { encodeDicom, encodeNifti, rampVolume } from '../bindings/node/test/medical.js';
import { chooseMenuItem, SETTINGS } from './helpers.js';

interface Hooks {
  viewer: {
    getState(): {
      image: { info: { imageId: string; name: string; width: number; height: number; bitDepth: number; pixelSpacing: { x: number; y: number } | null } } | null;
    };
  };
}

const openImage = (page: Page) => page.evaluate(() => (window as unknown as { __glcm: Hooks }).__glcm.viewer.getState().image?.info ?? null);

async function start(page: Page): Promise<void> {
  await page.addInitScript((settings) => {
    window.localStorage.setItem('glcm.analysisSettings', JSON.stringify({ state: { settings }, version: 1 }));
  }, SETTINGS);
  await page.goto('/?testHooks');
}

async function chooseFile(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
}

// 6 × 5 × 4 voxels of 0.5 × 1 × 2 mm, two volumes
const VOLUME = encodeNifti({ dimensions: [6, 5, 4, 2], dataType: 'int16', data: rampVolume(6, 5, 4, 2), voxelSize: [0.5, 1, 2], gzip: true });

test('opens a DICOM image with its pixel spacing and value conversion', async ({ page }) => {
  await start(page);
  const dicom = encodeDicom({
    rows: 4,
    columns: 5,
    bitsAllocated: 16,
    data: Array.from({ length: 20 }, (_, i) => i * 100),
    modality: 'CT',
    rescaleSlope: 1,
    rescaleIntercept: -1024,
    pixelSpacing: [0.7, 0.6],
    windowCenter: 40,
    windowWidth: 400,
  });
  await chooseFile(page, 'slice.dcm', dicom);
  await expect(page.getByTestId('status-bar')).toContainText('slice.dcm 5×4 16-bit');
  expect(await openImage(page)).toMatchObject({ width: 5, height: 4, bitDepth: 16, pixelSpacing: { x: 0.6, y: 0.7 } });

  await chooseMenuItem(page, 'Image', 'Image Info');
  const info = page.getByRole('dialog', { name: 'Image Info' });
  await expect(info).toContainText('Rescale slope 1, intercept -1024; values stored + 1024; HU = stored value - 1024');
  await expect(info).toContainText('864 – 1263');
});

test('chooses a slice of a NIfTI volume and opens it as an image', async ({ page }) => {
  await start(page);
  await chooseFile(page, 'ramp.nii.gz', VOLUME);

  const dialog = page.getByRole('dialog', { name: 'Open ramp.nii.gz' });
  await expect(dialog).toContainText('6 × 5 × 4 voxels · 2 volumes · int16 · RAS');
  // The acquisition plane at its middle slice
  await expect(dialog.getByTestId('volume-slice-readout')).toHaveText('1 / 3');
  await expect(dialog.getByTestId('volume-preview')).toHaveAttribute('data-shows', 'axial:1:0');
  await expect(dialog).toContainText('6 × 5 px · 0.5 × 1 mm');

  await dialog.getByText('Coronal', { exact: true }).click();
  await expect(dialog.getByTestId('volume-slice-readout')).toHaveText('2 / 4');
  await expect(dialog).toContainText('6 × 4 px · 0.5 × 2 mm');
  const slice = dialog.getByRole('slider', { name: 'Slice' });
  await slice.focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByTestId('volume-slice-readout')).toHaveText('3 / 4');
  const volume = dialog.getByRole('slider', { name: 'Volume' });
  await volume.focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByTestId('volume-index-readout')).toHaveText('1 / 1');
  await expect(dialog.getByTestId('volume-preview')).toHaveAttribute('data-shows', 'coronal:3:1');
  const preview = dialog.getByTestId('volume-preview');
  expect(await preview.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([6, 4]);

  await dialog.getByRole('button', { name: 'Open Slice', exact: true }).click();
  await expect(page.getByTestId('status-bar')).toContainText('ramp.nii.gz [coronal 3, volume 1] 6×4 16-bit');
  const image = (await openImage(page))!;
  expect(image).toMatchObject({ width: 6, height: 4, pixelSpacing: { x: 0.5, y: 2 } });

  // Coronal slice 3 of volume 1: rows from superior (k = 3) to inferior, columns along i
  const raw = await page.request.get(`/api/v1/images/${image.imageId}/raw`);
  const body = await raw.body();
  const samples = Array.from({ length: 24 }, (_, index) => body.readUInt16LE(2 * index));
  expect(samples).toEqual(Array.from({ length: 24 }, (_, index) => (index % 6) + 30 + 100 * (3 - Math.floor(index / 6)) + 1000));
});

test('cancelling the slice dialog deletes the volume', async ({ page }) => {
  await start(page);
  const created = page.waitForResponse((response) => response.url().endsWith('/api/v1/volumes') && response.request().method() === 'POST');
  await chooseFile(page, 'ramp.nii.gz', VOLUME);
  const { volumeId } = await (await created).json();
  const dialog = page.getByRole('dialog', { name: 'Open ramp.nii.gz' });
  await expect(dialog.getByTestId('volume-preview')).toBeVisible();

  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/v1/volumes/${volumeId}`) && response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await deleted).status()).toBe(204);
  await expect(dialog).toHaveCount(0);
  expect(await openImage(page)).toBeNull();
  expect((await page.request.get(`/api/v1/volumes/${volumeId}`)).status()).toBe(404);
});
