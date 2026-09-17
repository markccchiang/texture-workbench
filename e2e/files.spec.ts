// End-to-end tests of R4 (doc/ui-design-plan.md, section 6.4): exports carry the core's values, and ROI set and project
// round trips are lossless.

import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Download, type Page } from '@playwright/test';
import { readImageJRois } from '@glcm/api';
import * as native from '@glcm/native';
import { unzipSync } from 'fflate';
import {
  chooseMenuItem,
  drag,
  drawThreeRois,
  openImage,
  openSample,
  parseCsv,
  resultRows,
  ROOT,
  SETTINGS,
  storedRois,
  storedSettings,
  waitForImage,
} from './helpers.js';

let camera: native.DecodedImage;

test.beforeAll(async () => {
  camera = await native.decodeImageFile(path.join(ROOT, 'samples', 'textures', 'camera.png'));
});

test.beforeEach(async ({ page }) => {
  await openSample(page);
});

async function download(page: Page, action: () => Promise<void>): Promise<{ file: Download; path: string }> {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  return { file, path: (await file.path())! };
}

async function chooseFile(page: Page, action: () => Promise<void>, filePath: string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), action()]);
  await chooser.setFiles(filePath);
}

async function measureRectangle(page: Page) {
  await page.keyboard.press('r');
  await drag(page, [120, 90], [190, 150]);
  await page.keyboard.press('t');
  await page.keyboard.press('m');
  await expect(page.getByTestId('results-table').locator('tbody tr')).toHaveCount(5);
  const [roi] = await storedRois(page);
  const expected = JSON.parse(
    await native.runAnalysis(camera.pixels, camera.width, camera.height, camera.bitDepth, JSON.stringify([{ id: roi.id, name: roi.name, shape: roi.shape }]), JSON.stringify(SETTINGS)),
  ).results[0];
  return { roi, expected };
}

test('exports results as CSV and JSON with the values of the core', async ({ page }) => {
  const { roi, expected } = await measureRectangle(page);

  const csv = await download(page, () => chooseMenuItem(page, 'File', 'Export Results as CSV'));
  expect(csv.file.suggestedFilename()).toBe('camera-results.csv');
  const { comments, header, rows } = parseCsv(await fs.readFile(csv.path, 'utf8'));
  expect(comments).toContain('# format=glcm-results-csv');
  expect(comments).toContain('# grayLevels=32');
  expect(header).toContain('Correlation III [non-standard]');
  expect(rows).toHaveLength(5);
  expect(rows[0][header.indexOf('quantization')]).toBe('fixedRange [0, 255]');
  for (const row of rows) {
    expect(row).toHaveLength(header.length);
    const direction = row[header.indexOf('direction')];
    expect(row[header.indexOf('roiName')]).toBe(roi.name);
    // Shortest round-trip text: the parsed numbers equal the core's doubles exactly
    expect(Number(row[header.indexOf('Contrast')])).toBe(expected.values.Contrast[direction]);
    expect(Number(row[header.indexOf('Correlation III [non-standard]')])).toBe(expected.values.CorrelationIII[direction]);
  }

  const json = await download(page, () => chooseMenuItem(page, 'File', 'Export Results as JSON'));
  expect(json.file.suggestedFilename()).toBe('camera-results.json');
  const document = JSON.parse(await fs.readFile(json.path, 'utf8'));
  expect(document).toMatchObject({ format: 'glcm-results', version: 1, image: { name: 'camera.png' }, settings: SETTINGS });
  expect(document.results[0].values).toEqual(expected.values);
});

test('exports and imports an ROI set without loss', async ({ page }) => {
  await drawThreeRois(page);
  const original = await storedRois(page);

  const exported = await download(page, () => chooseMenuItem(page, 'ROI', 'Export ROI Set…'));
  expect(exported.file.suggestedFilename()).toBe('camera.roi.json');
  const document = JSON.parse(await fs.readFile(exported.path, 'utf8'));
  expect(document).toMatchObject({ format: 'glcm-roi-set', version: 1, image: { name: 'camera.png', width: 512, height: 512, bitDepth: 8 } });

  await chooseMenuItem(page, 'Edit', /^Select All ROIs/);
  await chooseMenuItem(page, 'Edit', /^Delete ROI/);
  await expect(page.getByTestId('roi-row')).toHaveCount(0);

  await chooseFile(page, () => chooseMenuItem(page, 'ROI', 'Import ROI Set…'), exported.path);
  await expect(page.getByTestId('roi-row')).toHaveCount(3);
  const imported = await storedRois(page);
  expect(imported.map(({ id, name, color, shape }) => ({ id, name, color, shape }))).toEqual(original.map(({ id, name, color, shape }) => ({ id, name, color, shape })));

  // Importing is one undoable step
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('roi-row')).toHaveCount(0);
});

test('exports ROIs for ImageJ and imports ImageJ ROI sets on the same pixels', async ({ page }) => {
  await drawThreeRois(page);
  const drawn = await storedRois(page);
  const counts = async (shapes: unknown[]) =>
    (await native.roiStats(camera.pixels, camera.width, camera.height, camera.bitDepth, JSON.stringify(shapes.map((shape, i) => ({ id: `r${i}`, shape }))))).map(
      (stats) => stats.pixelCount,
    );

  const exported = await download(page, () => chooseMenuItem(page, 'ROI', 'Export ROIs for ImageJ…'));
  expect(exported.file.suggestedFilename()).toBe('camera-RoiSet.zip');
  await expect(page.getByText('Saved 3 ROIs for ImageJ')).toBeVisible();
  const written = readImageJRois(new Uint8Array(await fs.readFile(exported.path)), 'camera-RoiSet.zip').document.rois;
  expect(written.map((roi) => roi.name)).toEqual(drawn.map((roi) => roi.name));
  expect(await counts(written.map((roi) => roi.shape))).toEqual(await counts(drawn.map((roi) => roi.shape)));

  // ROIs saved by ImageJ, with the pixel counts ImageJ gives them; the lines and points in the archive are left out
  const data = path.join(ROOT, 'packages', 'api', 'test', 'data', 'imagej');
  const reference = JSON.parse(await fs.readFile(path.join(data, 'imagej-rois.json'), 'utf8')) as { rois: Array<{ name: string; pixels?: { count: number } }> };
  const withArea = reference.rois.filter((entry) => entry.pixels);
  await chooseFile(page, () => chooseMenuItem(page, 'ROI', 'Import ROI Set…'), path.join(data, 'imagej-rois.zip'));
  await expect(page.getByTestId('roi-row')).toHaveCount(3 + withArea.length);
  await expect(page.getByText(/Skipped 4 selections without an area/)).toBeVisible();
  const imported = (await storedRois(page)).slice(3);
  expect(imported.map((roi) => roi.name)).toEqual(withArea.map((entry) => entry.name));
  expect(await counts(imported.map((roi) => roi.shape))).toEqual(withArea.map((entry) => entry.pixels!.count));
});

test('saves and opens projects, re-uploading an embedded image', async ({ page }) => {
  const { roi } = await measureRectangle(page);
  const rowsBefore = await resultRows(page);
  const imageBefore = (await openImage(page))!;

  // Embedded image: still opens after the image was deleted from the server
  await chooseMenuItem(page, 'File', /^Save Project…/);
  // A click while the dialog is still opening can be lost (seen in WebKit on a CI runner): check until it holds
  const embed = page.getByRole('dialog', { name: 'Save Project' }).getByLabel('Embed the image');
  await expect(async () => {
    await embed.check({ timeout: 2000 });
    await expect(embed).toBeChecked({ timeout: 500 });
  }).toPass();
  const embedded = await download(page, () => page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click());
  expect(embedded.file.suggestedFilename()).toBe('camera.glcmproj');
  expect(JSON.parse(await fs.readFile(embedded.path, 'utf8')).image.data).toEqual(expect.any(String));
  // Delete every copy: earlier tests uploaded the same sample, and the app opens a stored image with the same SHA-256
  // before it uses the embedded data
  const copies = async () =>
    ((await (await page.request.get(`/api/v1/images?sha256=${imageBefore.sha256}`)).json()) as { images: Array<{ imageId: string }> }).images;
  const stored = await copies();
  expect(stored.map((image) => image.imageId)).toContain(imageBefore.imageId);
  for (const image of stored) {
    expect((await page.request.delete(`/api/v1/images/${image.imageId}`)).status()).toBe(204);
  }
  expect(await copies()).toEqual([]);

  await page.goto('/?testHooks');
  const upload = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/images');
  await chooseFile(page, () => chooseMenuItem(page, 'File', 'Open Project…'), embedded.path);
  await upload;
  await waitForImage(page);
  await expect(page.getByTestId('roi-row')).toHaveCount(1);
  const reopened = (await openImage(page))!;
  expect(reopened.imageId).not.toBe(imageBefore.imageId);
  expect(reopened.sha256).toBe(imageBefore.sha256);
  expect((await storedRois(page)).map(({ id, name, shape }) => ({ id, name, shape }))).toEqual([{ id: roi.id, name: roi.name, shape: roi.shape }]);
  expect(await resultRows(page)).toEqual(rowsBefore);
  expect(await storedSettings(page)).toEqual(SETTINGS);
  await expect(page.getByTestId('results-table').locator('tbody tr')).toHaveCount(5);

  // Without the image: the server finds the uploaded image by its SHA-256
  await chooseMenuItem(page, 'File', /^Save Project…/);
  const reference = await download(page, () => page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click());
  expect(JSON.parse(await fs.readFile(reference.path, 'utf8')).image.data).toBeUndefined();
  await page.goto('/?testHooks');
  await chooseFile(page, () => chooseMenuItem(page, 'File', 'Open Project…'), reference.path);
  await waitForImage(page);
  expect((await openImage(page))!.imageId).toBe(reopened.imageId);
  expect(await resultRows(page)).toEqual(rowsBefore);
});

test('exports ROI images as a ZIP', async ({ page }) => {
  await drawThreeRois(page);
  const rois = await storedRois(page);

  await chooseMenuItem(page, 'ROI', 'Export ROI Images…');
  await page.getByLabel('Include quantized gray levels').check();
  const zip = await download(page, () => page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click());
  expect(zip.file.suggestedFilename()).toBe('camera-rois.zip');

  const files = unzipSync(await fs.readFile(zip.path));
  expect(Object.keys(files).sort()).toEqual(
    ['ROI_1.png', 'ROI_1_mask.png', 'ROI_1_q32.png', 'ROI_2.png', 'ROI_2_mask.png', 'ROI_2_q32.png', 'ROI_3.png', 'ROI_3_mask.png', 'ROI_3_q32.png', 'manifest.json'].sort(),
  );
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  const counts = await native.roiStats(camera.pixels, camera.width, camera.height, camera.bitDepth, JSON.stringify(rois));
  expect(manifest.entries.map((entry: { pixelCount: number }) => entry.pixelCount)).toEqual(counts.map((c) => c.pixelCount));
});

test('measures the ROIs of the ROI Manager on several images and downloads one CSV', async ({ page }) => {
  await page.keyboard.press('r');
  await drag(page, [120, 90], [190, 150]);
  await page.keyboard.press('t');
  const [roi] = await storedRois(page);

  await chooseMenuItem(page, 'Analyze', 'Batch Measure…');
  const dialog = page.getByRole('dialog');
  const images = ['camera.png', 'brick.png'].map((name) => path.join(ROOT, 'samples', 'textures', name));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dialog.getByLabel('Images').click()]);
  await chooser.setFiles(images);
  await dialog.getByRole('button', { name: 'Measure 2 images' }).click();

  const items = dialog.getByTestId('batch-items').locator('tbody tr');
  await expect(items).toHaveCount(2);
  await expect(items.and(page.locator('[data-status="done"]'))).toHaveCount(2);
  // The open sample is already on the server, so it is not uploaded again (brick.png may be too: the browser projects
  // share one server)
  await expect(items.first()).toContainText('Already on the server.');

  await expect(page.getByTestId('results-table').locator('tbody tr')).toHaveCount(10);
  await expect(page.getByTestId('results-table').getByRole('columnheader', { name: 'Image' })).toBeVisible();

  const csv = await download(page, () => dialog.getByRole('button', { name: 'Download combined CSV' }).click());
  expect(csv.file.suggestedFilename()).toBe('batch-results.csv');
  const { comments, header, rows } = parseCsv(await fs.readFile(csv.path, 'utf8'));
  expect(comments).toContain('# images=2');
  expect(comments.some((comment) => comment.startsWith('# image='))).toBe(false);
  expect(rows).toHaveLength(10);
  expect(rows.map((row) => row[header.indexOf('image')])).toEqual([...Array(5).fill('camera.png'), ...Array(5).fill('brick.png')]);

  const brick = await native.decodeImageFile(images[1]);
  const expected = JSON.parse(
    await native.runAnalysis(brick.pixels, brick.width, brick.height, brick.bitDepth, JSON.stringify([{ id: roi.id, name: roi.name, shape: roi.shape }]), JSON.stringify(SETTINGS)),
  ).results[0];
  for (const row of rows.slice(5)) {
    expect(Number(row[header.indexOf('Contrast')])).toBe(expected.values.Contrast[row[header.indexOf('direction')]]);
  }
});
