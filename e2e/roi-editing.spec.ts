// End-to-end test of Union, Subtract, Intersect, XOR, Enlarge, Shrink, Make Band, the brush and the eraser: the ROIs equal
// the addon's results for the same shapes

import path from 'node:path';
import type { RoiShape } from '@glcm/api';
import * as native from '@glcm/native';
import { expect, test, type Page } from '@playwright/test';
import { chooseMenuItem, openSample, ROOT, storedRois, toPage } from './helpers.js';

interface EditingHooks {
  __glcm: {
    rois: {
      getState(): {
        importRois(rois: Array<{ name: string; color: string; shape: RoiShape }>): string[];
        select(ids: string[]): void;
      };
    };
  };
}

const IMAGE_SIZE = 512;
const roisJson = (...shapes: RoiShape[]) => JSON.stringify(shapes.map((shape, i) => ({ id: `r${i}`, name: `R${i}`, shape })));

async function addAndSelect(page: Page, shapes: RoiShape[]): Promise<void> {
  await page.evaluate((list) => {
    const rois = (window as unknown as EditingHooks).__glcm.rois.getState();
    rois.select(rois.importRois(list.map((shape, i) => ({ name: `Shape ${i + 1}`, color: '', shape }))));
  }, shapes);
}

async function pixelCount(shape: RoiShape): Promise<number> {
  const camera = await native.decodeImageFile(path.join(ROOT, 'samples', 'textures', 'camera.png'));
  const [statistics] = await native.roiStats(camera.pixels, camera.width, camera.height, camera.bitDepth, JSON.stringify([{ id: 'p', shape }]));
  return statistics.pixelCount;
}

async function stroke(page: Page, points: Array<[number, number]>): Promise<void> {
  const [first, ...rest] = await Promise.all(points.map(([x, y]) => toPage(page, x, y)));
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of rest) {
    await page.mouse.move(point.x, point.y, { steps: 8 });
  }
  await page.mouse.up();
}

const rectangle: RoiShape = { type: 'rectangle', x: 100, y: 100, width: 120, height: 80 };

test('Union merges the selected ROIs and Subtract cuts the others out of the first', async ({ page }) => {
  await openSample(page);
  const ellipse: RoiShape = { type: 'ellipse', cx: 210, cy: 170, rx: 50, ry: 30 };
  await addAndSelect(page, [rectangle, ellipse]);
  await chooseMenuItem(page, 'ROI', 'Union');
  await expect.poll(async () => (await storedRois(page)).length).toBe(1);
  const union = await native.combineRois(roisJson(rectangle, ellipse), 'union', IMAGE_SIZE, IMAGE_SIZE);
  const [merged] = await storedRois(page);
  expect(merged.name).toBe('Shape 1');
  expect(merged.shape).toEqual({ type: 'polygon', points: union.points });

  // A hole in the middle of a new rectangle
  const inner: RoiShape = { type: 'rectangle', x: 300, y: 300, width: 40, height: 30 };
  const outer: RoiShape = { type: 'rectangle', x: 280, y: 280, width: 100, height: 80 };
  await addAndSelect(page, [outer, inner]);
  await chooseMenuItem(page, 'ROI', 'Subtract');
  const subtract = await native.combineRois(roisJson(outer, inner), 'subtract', IMAGE_SIZE, IMAGE_SIZE);
  await expect.poll(async () => (await storedRois(page))[1].shape).toEqual({ type: 'polygon', points: subtract.points });
  expect(subtract.pixelCount).toBe(100 * 80 - 40 * 30);
  expect(await storedRois(page)).toHaveLength(3);
  await expect(page.getByTestId('roi-manager')).toContainText('6,800 px');
});

test('Intersect and XOR combine the selected ROIs into the first one', async ({ page }) => {
  await openSample(page);
  const ellipse: RoiShape = { type: 'ellipse', cx: 210, cy: 170, rx: 50, ry: 30 };
  await addAndSelect(page, [rectangle, ellipse]);
  await chooseMenuItem(page, 'ROI', 'Intersect');
  const intersect = await native.combineRois(roisJson(rectangle, ellipse), 'intersect', IMAGE_SIZE, IMAGE_SIZE);
  await expect.poll(async () => (await storedRois(page)).map((roi) => roi.shape)).toEqual([{ type: 'polygon', points: intersect.points }]);

  const other: RoiShape = { type: 'rectangle', x: 300, y: 300, width: 60, height: 40 };
  const crossing: RoiShape = { type: 'rectangle', x: 330, y: 320, width: 60, height: 40 };
  await addAndSelect(page, [other, crossing]);
  await chooseMenuItem(page, 'ROI', 'XOR');
  const xor = await native.combineRois(roisJson(other, crossing), 'xor', IMAGE_SIZE, IMAGE_SIZE);
  await expect.poll(async () => (await storedRois(page)).map((roi) => roi.shape)).toEqual([
    { type: 'polygon', points: intersect.points },
    { type: 'polygon', points: xor.points },
  ]);
  expect(xor.pixelCount).toBe(2 * (2400 - 30 * 20));

  // Nothing in common: the ROIs stay as they are
  await addAndSelect(page, [{ type: 'rectangle', x: 10, y: 10, width: 5, height: 5 }, { type: 'rectangle', x: 40, y: 40, width: 5, height: 5 }]);
  await chooseMenuItem(page, 'ROI', 'Intersect');
  await expect(page.getByText('Nothing in common')).toBeVisible();
  expect(await storedRois(page)).toHaveLength(4);
});

test('Enlarge, Shrink and Make Band change the selected ROIs by a distance in pixels or millimetres', async ({ page }) => {
  await openSample(page);
  const ellipse: RoiShape = { type: 'ellipse', cx: 200, cy: 200, rx: 40, ry: 25, angle: 20 };
  await addAndSelect(page, [ellipse]);
  const grow = async (operation: 'enlarge' | 'shrink' | 'band', distance: number, spacingX = 1, spacingY = 1) =>
    native.growRoi(roisJson(ellipse), operation, distance, spacingX, spacingY, IMAGE_SIZE, IMAGE_SIZE);

  await chooseMenuItem(page, 'ROI', 'Make Band…');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: 'Band' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'mm' })).toBeDisabled();
  await dialog.getByLabel('Distance').fill('6');
  await dialog.getByRole('button', { name: 'Add bands to 1 ROI by 6 px' }).click();
  const band = await grow('band', 6);
  await expect.poll(async () => (await storedRois(page)).map((roi) => [roi.name, roi.shape])).toEqual([
    ['Shape 1', ellipse],
    ['Shape 1 band 6 px', { type: 'polygon', points: band.points }],
  ]);

  // Enlarge the ellipse itself, then shrink it back by more: one undo step each
  const [first] = await storedRois(page);
  await page.evaluate((id) => (window as unknown as EditingHooks).__glcm.rois.getState().select([id]), first.id);
  await chooseMenuItem(page, 'ROI', 'Enlarge or Shrink…');
  await dialog.getByLabel('Distance').fill('3.5');
  await dialog.getByRole('button', { name: 'Enlarge 1 ROI by 3.5 px' }).click();
  const enlarged = await grow('enlarge', 3.5);
  await expect.poll(async () => (await storedRois(page))[0].shape).toEqual({ type: 'polygon', points: enlarged.points });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await storedRois(page))[0].shape).toEqual(ellipse);

  // Millimetres with non-square pixels
  await page.evaluate(() => (window as unknown as { __glcm: { viewer: { getState(): { setPixelSpacing(spacing: { x: number; y: number }): void } } } }).__glcm.viewer.getState().setPixelSpacing({ x: 0.5, y: 0.8 }));
  await chooseMenuItem(page, 'ROI', 'Enlarge or Shrink…');
  // Segmented controls are chosen by their labels; the radio inputs are hidden
  await dialog.getByText('Shrink', { exact: true }).click();
  await dialog.getByText('mm', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: 'mm' })).toBeChecked();
  await dialog.getByLabel('Distance').fill('4');
  await dialog.getByRole('button', { name: 'Shrink 1 ROI by 4 mm' }).click();
  const shrunk = await grow('shrink', 4, 0.5, 0.8);
  await expect.poll(async () => (await storedRois(page))[0].shape).toEqual({ type: 'polygon', points: shrunk.points });
  expect(shrunk.pixelCount).toBeLessThan(await pixelCount(ellipse));
});

test('the brush paints a new ROI and the eraser removes a stroke from it', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('image-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('b');
  await expect(page.getByRole('button', { name: /^Brush \(B\)/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: 'Brush size' }).fill('24');

  await stroke(page, [
    [150, 150],
    [300, 200],
  ]);
  await expect.poll(async () => (await storedRois(page)).length).toBe(1);
  const painted = (await storedRois(page))[0].shape;
  expect(painted.type).toBe('polygon');
  const paintedPixels = await pixelCount(painted);
  // A 24 px wide band about 158 px long, with round ends
  expect(paintedPixels).toBeGreaterThan(3500);
  expect(paintedPixels).toBeLessThan(4600);

  await page.keyboard.press('x');
  await stroke(page, [
    [225, 100],
    [225, 260],
  ]);
  await expect.poll(async () => pixelCount((await storedRois(page))[0].shape)).toBeLessThan(paintedPixels - 200);
  expect(await storedRois(page)).toHaveLength(1);
});
