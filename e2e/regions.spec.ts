// End-to-end test of Threshold ROI and the magic wand: the ROIs created equal the addon's regions for the same image,
// window, minimum size, pixel and tolerance

import path from 'node:path';
import { MAX_POLYGON_VERTICES } from '@glcm/api';
import * as native from '@glcm/native';
import { expect, test, type Page } from '@playwright/test';
import { chooseMenuItem, openSample, ROOT, storedRois, toPage } from './helpers.js';

interface RegionHooks {
  __glcm: {
    viewer: { getState(): { setWindow(min: number, max: number): void; wandTolerance: number } };
    rois: { getState(): { activeShape: { type: string; points?: Array<[number, number]> } | null } };
  };
}

const camera = () => native.decodeImageFile(path.join(ROOT, 'samples', 'textures', 'camera.png'));

const activeShape = (page: Page) => page.evaluate(() => (window as unknown as RegionHooks).__glcm.rois.getState().activeShape);

test('Threshold ROI adds the regions inside the display window', async ({ page }) => {
  await openSample(page);
  await page.evaluate(() => (window as unknown as RegionHooks).__glcm.viewer.getState().setWindow(0, 40));

  await chooseMenuItem(page, 'ROI', 'Threshold ROI…');
  const dialog = page.getByRole('dialog', { name: 'Threshold ROI' });
  await expect(dialog).toContainText('from 0 to 40');
  await dialog.getByRole('textbox', { name: 'Minimum size' }).fill('200');

  const image = await camera();
  const expected = await native.selectThresholdRegions(image.pixels, image.width, image.height, image.bitDepth, 0, 40, 200, 1000);
  expect(expected.total).toBeGreaterThan(0);
  await expect(dialog.getByTestId('threshold-summary')).toContainText(`${expected.total} region`);
  await dialog.getByRole('button', { name: /^Add \d+ ROIs?$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const rois = await storedRois(page);
  expect(rois).toHaveLength(Math.min(expected.total, 1000));
  expected.regions.forEach((region, i) => {
    if (region.points.length <= MAX_POLYGON_VERTICES) {
      expect(rois[i].shape).toEqual({ type: 'polygon', points: region.points });
    }
  });
  // The ROI Manager's pixel counts come from the core and match the regions
  await expect(page.getByTestId('roi-manager')).toContainText(`${expected.regions[0].pixelCount.toLocaleString('en-US')} px`);
});

test('Threshold ROI leaves out regions by largest size and sphericity', async ({ page }) => {
  await openSample(page);
  await page.evaluate(() => (window as unknown as RegionHooks).__glcm.viewer.getState().setWindow(0, 40));
  await chooseMenuItem(page, 'ROI', 'Threshold ROI…');
  const dialog = page.getByRole('dialog', { name: 'Threshold ROI' });
  await dialog.getByRole('textbox', { name: 'Minimum size' }).fill('20');
  await dialog.getByRole('textbox', { name: 'Maximum size' }).fill('5000');
  await dialog.getByRole('textbox', { name: 'Minimum sphericity' }).fill('0.6');

  const image = await camera();
  const expected = await native.selectThresholdRegions(image.pixels, image.width, image.height, image.bitDepth, 0, 40, 20, 1000, 5000, 0.6);
  const unfiltered = await native.selectThresholdRegions(image.pixels, image.width, image.height, image.bitDepth, 0, 40, 20, 0);
  expect(expected.total).toBeGreaterThan(0);
  expect(expected.total).toBeLessThan(unfiltered.total);
  await expect(dialog.getByTestId('threshold-summary')).toContainText(`${expected.total} region`);
  await expect(dialog.getByTestId('threshold-summary')).toContainText('20 to 5,000 pixels and a sphericity of at least 0.6');
  await dialog.getByRole('button', { name: /^Add \d+ ROIs?$/ }).click();
  await expect.poll(async () => (await storedRois(page)).map((roi) => roi.shape)).toEqual(
    expected.regions.map((region) => ({ type: 'polygon', points: region.points })),
  );
});

test('the magic wand makes the clicked region the active ROI', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('image-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('w');
  await expect(page.getByRole('button', { name: /^Magic wand/ })).toHaveAttribute('aria-pressed', 'true');
  const tolerance = page.getByRole('textbox', { name: 'Wand tolerance' });
  await tolerance.fill('12');
  await expect.poll(() => page.evaluate(() => (window as unknown as RegionHooks).__glcm.viewer.getState().wandTolerance)).toBe(12);

  // A pixel of the sky
  const [x, y] = [60, 40];
  const target = await toPage(page, x + 0.5, y + 0.5);
  await page.mouse.click(target.x, target.y);

  const image = await camera();
  const expected = await native.selectWandRegion(image.pixels, image.width, image.height, image.bitDepth, x, y, 12);
  expect(expected).not.toBeNull();
  if (expected!.points.length <= MAX_POLYGON_VERTICES) {
    await expect.poll(() => activeShape(page)).toEqual({ type: 'polygon', points: expected!.points });
  } else {
    await expect.poll(async () => (await activeShape(page))?.points?.length ?? 0).toBeGreaterThan(0);
  }

  // T adds it to the ROI Manager
  await page.keyboard.press('t');
  await expect.poll(async () => (await storedRois(page)).length).toBe(1);
});
