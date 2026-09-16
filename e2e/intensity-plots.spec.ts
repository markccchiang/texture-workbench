// End-to-end test of Analyze ▸ Plot Profile and Analyze ▸ Histogram: the values shown and saved equal the addon's

import fs from 'node:fs/promises';
import path from 'node:path';
import * as native from '@glcm/native';
import { expect, test, type Page } from '@playwright/test';
import { chooseMenuItem, drag, openSample, ROOT, storedRois } from './helpers.js';

interface Hooks {
  __glcm: { viewer: { getState(): { ruler: { start: { x: number; y: number }; end: { x: number; y: number } } | null } } };
}

const storedRuler = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__glcm.viewer.getState().ruler);

async function camera() {
  return native.decodeImageFile(path.join(ROOT, 'samples', 'textures', 'camera.png'));
}

test('plots the values along the ruler line and saves them', async ({ page }) => {
  await openSample(page);
  await page.keyboard.press('l');
  await drag(page, [100, 120], [300, 180]);
  const ruler = (await storedRuler(page))!;

  await chooseMenuItem(page, 'Analyze', 'Plot Profile');
  const dialog = page.getByRole('dialog', { name: 'Plot Profile' });
  await expect(dialog.getByTestId('profile-line')).toHaveCount(1);

  const image = await camera();
  const expected = await native.lineProfile(image.pixels, image.width, image.height, 8, ruler.start.x, ruler.start.y, ruler.end.x, ruler.end.y);
  await expect(dialog.getByTestId('profile-summary')).toContainText(`${expected.values.length} samples`);

  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Save CSV' }).click()]);
  expect(download.suggestedFilename()).toBe('camera-profile.csv');
  const lines = (await fs.readFile((await download.path())!, 'utf8')).trim().split('\n');
  expect(lines[0]).toBe('distance_px,value');
  expect(lines.slice(1).map((line) => Number(line.split(',')[1]))).toEqual(expected.values);
  expect(Number(lines.at(-1)!.split(',')[0])).toBeCloseTo(expected.length, 9);
});

test('shows the histogram of the selected ROI, or of the whole image', async ({ page }) => {
  await openSample(page);
  await chooseMenuItem(page, 'Analyze', 'Histogram');
  const dialog = page.getByRole('dialog', { name: 'Histogram' });
  await expect(dialog.getByTestId('histogram-target')).toHaveText('Histogram of the whole image');
  await expect(dialog.getByTestId('histogram-summary')).toContainText('262,144 pixels');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // The menu button got the focus back when the dialog closed; tool keys need it elsewhere
  await page.getByTestId('status-bar').click();
  await page.keyboard.press('e');
  await drag(page, [150, 100], [260, 200]);
  await page.keyboard.press('t');
  const [roi] = await storedRois(page);
  await chooseMenuItem(page, 'Analyze', 'Histogram');
  await expect(dialog.getByTestId('histogram-target')).toHaveText(`Histogram of ${roi.name}`);

  const image = await camera();
  const expected = await native.roiHistogram(
    image.pixels,
    image.width,
    image.height,
    8,
    JSON.stringify([{ id: roi.id, name: roi.name, shape: roi.shape }]),
    256,
  );
  await expect(dialog.getByTestId('histogram-summary')).toContainText(
    `${expected.pixelCount.toLocaleString('en-US')} pixels · min ${expected.min} · max ${expected.max}`,
  );
  const bars = dialog.getByTestId('histogram-bar');
  await expect(bars).toHaveCount(expected.counts.length);
  expect(await bars.evaluateAll((elements) => elements.map((element) => Number(element.getAttribute('data-value'))))).toEqual(expected.counts);

  // Fewer bins
  await dialog.getByRole('combobox', { name: 'Bins' }).click();
  await page.getByRole('option', { name: '≤ 16 bins' }).click();
  await expect(bars).toHaveCount(Math.ceil((expected.max! - expected.min! + 1) / Math.ceil((expected.max! - expected.min! + 1) / 16)));
});
