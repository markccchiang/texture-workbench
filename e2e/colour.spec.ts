// End-to-end test of Image ▸ Colour Conversion…: a colour image converted another way keeps its ROIs and view, and
// the pixels and measurements are the addon's for that conversion

import path from 'node:path';
import type { ImageInfo } from '@glcm/api';
import * as native from '@glcm/native';
import { expect, test, type Page } from '@playwright/test';
import { encodeTiffPages } from '../bindings/node/test/tiff.js';
import { chooseMenuItem, drag, openImage, resultRows, ROOT, SETTINGS, storedRois, viewport } from './helpers.js';

const IHC = path.join(ROOT, 'samples', 'textures', 'ihc.png');

interface Hooks {
  __glcm: { viewer: { getState(): { image: { raw: { samples: ArrayLike<number> } | null } | null } } };
}

const rawSamples = (page: Page) => page.evaluate(() => Array.from((window as unknown as Hooks).__glcm.viewer.getState().image!.raw!.samples).slice(0, 4096));

test('converts a colour image to a stain density and measures it with the same ROIs', async ({ page }) => {
  await page.addInitScript((settings) => {
    window.localStorage.setItem('glcm.analysisSettings', JSON.stringify({ state: { settings }, version: 1 }));
  }, SETTINGS);
  await page.goto('/?testHooks');
  await page.getByTestId('file-input').setInputFiles(IHC);
  const status = page.getByTestId('status-bar');
  await expect(status).toContainText('ihc.png 512×512 8-bit');

  await page.keyboard.press('r');
  await drag(page, [100, 100], [260, 220]);
  await page.keyboard.press('t');
  const [roi] = await storedRois(page);
  const view = await viewport(page);
  // A spacing entered by hand (the PNG has none) stays with the converted image
  await page.evaluate(() =>
    (window as unknown as { __glcm: { viewer: { getState(): { setPixelSpacing(spacing: { x: number; y: number }): void } } } }).__glcm.viewer
      .getState()
      .setPixelSpacing({ x: 0.25, y: 0.25 }),
  );

  await chooseMenuItem(page, 'Image', 'Colour Conversion…');
  const dialog = page.getByRole('dialog', { name: 'Colour Conversion' });
  await expect(dialog.getByTestId('colour-preview')).toHaveAttribute('data-shows', 'luminance');
  await expect(dialog.getByRole('button', { name: 'Convert' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'DAB (H-DAB)' }).check();
  await expect(dialog.getByTestId('colour-preview')).toHaveAttribute('data-shows', 'dabHdab');
  await expect(dialog.getByTestId('colour-description')).toContainText('DAB optical density');
  await dialog.getByRole('button', { name: 'Convert' }).click();

  await expect(status).toContainText('ihc.png [DAB H-DAB] 512×512 16-bit');
  const info = (await openImage(page)) as unknown as ImageInfo;
  expect(info.colourSource).toEqual(expect.objectContaining({ conversion: 'dabHdab' }));
  expect(info.valueConversion?.unit).toBe('OD');
  // The ROI and the view stay
  expect(await storedRois(page)).toEqual([roi]);
  expect(await viewport(page)).toEqual(view);
  expect(
    await page.evaluate(() => (window as unknown as { __glcm: { viewer: { getState(): { pixelSpacing: unknown } } } }).__glcm.viewer.getState().pixelSpacing),
  ).toEqual({
    x: 0.25,
    y: 0.25,
  });

  // The samples are the addon's conversion
  const expected = await native.decodeImageFile(IHC, { colour: 'dabHdab' });
  await expect.poll(async () => (await rawSamples(page)).length).toBe(4096);
  const decoded = Array.from({ length: 4096 }, (_, i) => expected.pixels.readUInt16LE(2 * i));
  expect(await rawSamples(page)).toEqual(decoded);

  await chooseMenuItem(page, 'Analyze', 'Measure Selected');
  await expect.poll(async () => (await resultRows(page)).length).toBeGreaterThan(0);
  const mean = (await resultRows(page)).find((row) => row.direction === 'mean')!;
  const reference = JSON.parse(
    await native.runAnalysis(
      expected.pixels,
      512,
      512,
      16,
      JSON.stringify([{ id: roi.id, name: roi.name, shape: roi.shape }]),
      JSON.stringify(
        await page.evaluate(() => (window as unknown as { __glcm: { settings: { getState(): { settings: unknown } } } }).__glcm.settings.getState().settings),
      ),
    ),
  );
  expect(mean.values.Contrast).toBe(reference.results[0].values.Contrast.mean);

  // Back to the colour image's luminance: the uploaded image itself
  await chooseMenuItem(page, 'Image', 'Colour Conversion…');
  await dialog.getByRole('radio', { name: 'Luminance' }).check();
  await dialog.getByRole('button', { name: 'Convert' }).click();
  await expect(status).toContainText('ihc.png 512×512 8-bit');
  expect(await storedRois(page)).toEqual([roi]);
});

test('converts a colour stack on the slice shown, keeping the selection there', async ({ page }) => {
  await page.goto('/?testHooks');
  const page_ = (red: number) => ({
    width: 32,
    height: 24,
    bitsPerSample: 8 as const,
    samplesPerPixel: 3 as const,
    data: Array.from({ length: 32 * 24 * 3 }, (_, i) => (i % 3 === 0 ? red + ((i / 3) % 7) : i % 3 === 1 ? 50 : 90)),
  });
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'colour-pages.tif', mimeType: 'image/tiff', buffer: encodeTiffPages([page_(10), page_(100), page_(200)]) });
  const readout = page.getByTestId('slice-readout');
  await expect(readout).toHaveText('1 / 3');
  await page.keyboard.press('.');
  await expect(readout).toHaveText('2 / 3');
  await page.keyboard.press('r');
  await drag(page, [4, 4], [20, 16]);
  await page.keyboard.press('t');
  const selected = await page.evaluate(
    () => (window as unknown as { __glcm: { rois: { getState(): { selectedIds: string[] } } } }).__glcm.rois.getState().selectedIds,
  );
  expect(selected).toHaveLength(1);

  await chooseMenuItem(page, 'Image', 'Colour Conversion…');
  const dialog = page.getByRole('dialog', { name: 'Colour Conversion' });
  await dialog.getByRole('radio', { name: 'Red' }).check();
  await dialog.getByRole('button', { name: 'Convert' }).click();
  await expect(page.getByTestId('status-bar')).toContainText('colour-pages.tif [red]');
  await expect(readout).toHaveText('2 / 3');
  expect(
    await page.evaluate(() => (window as unknown as { __glcm: { rois: { getState(): { selectedIds: string[] } } } }).__glcm.rois.getState().selectedIds),
  ).toEqual(selected);
  const samples = await rawSamples(page);
  expect(samples.slice(0, 3)).toEqual([100, 101, 102]);
});

test('offers the conversion only for colour images', async ({ page }) => {
  await page.goto('/?testHooks');
  await page.getByTestId('file-input').setInputFiles(path.join(ROOT, 'samples', 'textures', 'camera.png'));
  await expect(page.getByTestId('status-bar')).toContainText('camera.png');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Colour Conversion…' })).toBeDisabled();
});
