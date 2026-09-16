// End-to-end test of stacks: a multi-page TIFF opens as one image with a slice slider, ROIs belong to the slice they
// were drawn on and are measured there, a NIfTI volume opens as a stack, and a folder of DICOM files as one series

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as native from '@glcm/native';
import { expect, test, type Page } from '@playwright/test';
import { encodeDicom, encodeNifti, rampVolume } from '../bindings/node/test/medical.js';
import { encodeTiffPages } from '../bindings/node/test/tiff.js';
import { chooseMenuItem, drag, openSample, SETTINGS } from './helpers.js';

interface Hooks {
  viewer: {
    getState(): {
      image: { info: { imageId: string; name: string; slices: number }; slice?: number; raw: { samples: ArrayLike<number> } | null } | null;
    };
  };
  rois: { getState(): { rois: Array<{ id: string; name: string; slice?: number; shape: unknown }>; currentSlice: number | null } };
  results: { getState(): { rows: Array<{ roiId: string; slice: number | null; direction: string | null; values: Record<string, number | null> }> } };
}

const hooks = <T>(page: Page, read: (glcm: Hooks) => T) => page.evaluate(read as never) as Promise<T>;
const shownSlice = (page: Page) => page.evaluate(() => (window as unknown as { __glcm: Hooks }).__glcm.viewer.getState().image?.slice ?? 1);

const WIDTH = 64;
const HEIGHT = 48;
/** Three 8-bit pages with different textures: value 40 × page + a pattern that repeats every 3 + page pixels */
const PAGES = [0, 1, 2].map((page) => ({
  width: WIDTH,
  height: HEIGHT,
  bitsPerSample: 8 as const,
  samplesPerPixel: 1 as const,
  data: Array.from({ length: WIDTH * HEIGHT }, (_, i) => 40 * page + ((i % WIDTH) + Math.floor(i / WIDTH)) % (3 + page) * 20),
}));

async function start(page: Page): Promise<void> {
  await page.addInitScript((settings) => {
    window.localStorage.setItem('glcm.analysisSettings', JSON.stringify({ state: { settings }, version: 1 }));
  }, SETTINGS);
  await page.goto('/?testHooks');
}

test('browses the slices of a TIFF stack and measures ROIs on their own slices', async ({ page }) => {
  // Another image of another size is open first: its renderer must not receive the stack's samples
  await openSample(page);
  const tiff = encodeTiffPages(PAGES);
  await page.getByTestId('file-input').setInputFiles({ name: 'pages.tif', mimeType: 'image/tiff', buffer: tiff });
  const status = page.getByTestId('status-bar');
  await expect(status).toContainText('pages.tif 64×48×3 slices 8-bit');
  const readout = page.getByTestId('slice-readout');
  await expect(readout).toHaveText('1 / 3');

  // ImageJ's keys; the canvas shows the samples of the slice
  await page.keyboard.press('.');
  await expect(readout).toHaveText('2 / 3');
  await expect.poll(() => shownSlice(page)).toBe(2);
  const samples = await page.evaluate(() => Array.from((window as unknown as { __glcm: Hooks }).__glcm.viewer.getState().image!.raw!.samples).slice(0, 8));
  expect(samples).toEqual(PAGES[1].data.slice(0, 8));

  // An ROI drawn now lies on slice 2
  await page.keyboard.press('r');
  await drag(page, [8, 8], [40, 32]);
  await page.keyboard.press('t');
  await expect(page.getByTestId('roi-slice')).toHaveText('slice 2 · ');
  const [roi] = await hooks(page, () => (window as unknown as { __glcm: Hooks }).__glcm.rois.getState().rois);
  expect(roi.slice).toBe(2);

  // On another slice it is not selected; clicking it in the ROI Manager shows its slice again
  await page.keyboard.press(',');
  await expect(readout).toHaveText('1 / 3');
  await expect.poll(() => hooks(page, () => (window as unknown as { __glcm: Hooks }).__glcm.rois.getState().currentSlice)).toBe(1);
  await page.getByTestId('roi-row').click();
  await expect(readout).toHaveText('2 / 3');

  await chooseMenuItem(page, 'Analyze', 'Measure Selected');
  const table = page.getByTestId('results-table');
  await expect(table.locator('thead')).toContainText('Slice');
  await expect.poll(async () => (await hooks(page, () => (window as unknown as { __glcm: Hooks }).__glcm.results.getState().rows)).length).toBeGreaterThan(0);
  const rows = await hooks(page, () => (window as unknown as { __glcm: Hooks }).__glcm.results.getState().rows);
  expect(rows.every((row) => row.slice === 2)).toBe(true);

  // The same ROI on the second page, measured by the addon
  const decoded = await native.decodeImageFile(await writeTemporary('pages.tif', tiff));
  const secondPage = decoded.pixels.subarray(WIDTH * HEIGHT, 2 * WIDTH * HEIGHT);
  const expected = JSON.parse(
    await native.runAnalysis(secondPage, WIDTH, HEIGHT, 8, JSON.stringify([{ id: roi.id, name: roi.name, shape: roi.shape }]), JSON.stringify(SETTINGS)),
  );
  const mean = rows.find((row) => row.direction === 'mean')!;
  expect(mean.values.Contrast).toBe(expected.results[0].values.Contrast.mean);

  // Copy to All Slices puts the ROI on the others
  await page.getByRole('button', { name: 'ROI actions' }).click();
  await page.getByRole('menuitem', { name: 'Copy to All Slices' }).click();
  await expect(page.getByTestId('roi-row')).toHaveCount(3);
  const slices = (await hooks(page, () => (window as unknown as { __glcm: Hooks }).__glcm.rois.getState().rois)).map((stored) => stored.slice);
  expect(slices).toEqual([2, 1, 3]);
});

test('opens every slice of a NIfTI volume as a stack', async ({ page }) => {
  // Over an image of another size and bit depth, showing a slice right after the stack opens
  await openSample(page);
  const volume = encodeNifti({ dimensions: [6, 5, 4, 2], dataType: 'int16', data: rampVolume(6, 5, 4, 2), voxelSize: [0.5, 1, 2], gzip: true });
  await page.getByTestId('file-input').setInputFiles({ name: 'ramp.nii.gz', mimeType: 'application/octet-stream', buffer: volume });
  const dialog = page.getByRole('dialog', { name: 'Open ramp.nii.gz' });
  await dialog.getByText('Coronal', { exact: true }).click();
  await expect(dialog.getByTestId('volume-slice-readout')).toHaveText('2 / 4');
  await dialog.getByRole('button', { name: 'Open All Slices' }).click();

  await expect(page.getByTestId('status-bar')).toContainText('ramp.nii.gz [coronal, volume 0] 6×4×5 slices 16-bit');
  // The slice chosen in the dialog (2, counted from 0 there) is shown
  await expect(page.getByTestId('slice-readout')).toHaveText('3 / 5');
});

test('opens a folder of DICOM files as one series', async ({ page }) => {
  await start(page);
  const folder = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-e2e-series-')), 'Head CT');
  await fs.mkdir(folder);
  for (const [index, z] of [30, 10, 20].entries()) {
    const dicom = encodeDicom({
      rows: 4,
      columns: 4,
      bitsAllocated: 16,
      data: Array.from({ length: 16 }, () => z),
      modality: 'CT',
      seriesUid: '1.2.840.99',
      instanceNumber: index + 1,
      position: [0, 0, z],
      orientation: [1, 0, 0, 0, 1, 0],
    });
    await fs.writeFile(path.join(folder, `IM${index}`), dicom);
  }
  try {
    await chooseMenuItem(page, 'File', 'Open DICOM Series…');
    // The menu asks for a folder; the test hands the input its files directly
    await page.getByTestId('series-input').setInputFiles(folder);
    await expect(page.getByTestId('status-bar')).toContainText('Head CT 4×4×3 slices');
    const image = await hooks(page, () => (window as unknown as { __glcm: Hooks }).__glcm.viewer.getState().image!.info);
    const values = [];
    for (let slice = 1; slice <= 3; slice += 1) {
      values.push((await (await page.request.get(`/api/v1/images/${image.imageId}/pixel?x=0&y=0&slice=${slice}`)).json()).value);
    }
    // Ordered along the image normal
    expect(values).toEqual([10, 20, 30]);
  } finally {
    await fs.rm(path.dirname(folder), { recursive: true, force: true });
  }
});

async function writeTemporary(name: string, data: Buffer): Promise<string> {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-e2e-stack-')), name);
  await fs.writeFile(file, data);
  return file;
}
