// End-to-end test of Analyze ▸ Copy as Command… and the command section of Batch Measure: the saved files and the copied
// command, run with the command line, give the values the app measured

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shellWords } from '@glcm/api';
import * as native from '@glcm/native';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { run } from '../cli/src/main.js';
import { chooseMenuItem, drawThreeRois, openSample, parseCsv, resultRows, ROOT, SETTINGS, storedRois } from './helpers.js';

async function saveFiles(page: Page, scope: Locator, folder: string): Promise<string[]> {
  const [download] = await Promise.all([page.waitForEvent('download'), scope.getByRole('button', { name: 'Save Files' }).click()]);
  const entries = unzipSync(new Uint8Array(await fs.readFile((await download.path())!)));
  for (const [name, data] of Object.entries(entries)) {
    await fs.writeFile(path.join(folder, name), data);
  }
  expect(download.suggestedFilename()).toMatch(/-glcm-command\.zip$/);
  return Object.keys(entries).sort();
}

/** Runs the command in the folder, in its own process with its own data folder, and returns the CSV it wrote */
async function runCommand(command: string, folder: string): Promise<string> {
  const words = shellWords(command);
  expect(words.slice(0, 2)).toEqual(['glcm', 'measure']);
  const out = words[words.indexOf('--out') + 1];
  const previous = process.cwd();
  process.chdir(folder);
  const errors: string[] = [];
  try {
    const code = await run([...words.slice(1), '--data-dir', path.join(folder, 'data')], { out: () => undefined, err: (text) => errors.push(text) });
    expect(code, errors.join('\n')).toBe(0);
  } finally {
    process.chdir(previous);
  }
  return fs.readFile(path.join(folder, out), 'utf8');
}

test('copies the measurement as a glcm command that gives the same values', async ({ page }) => {
  await openSample(page);
  await drawThreeRois(page);

  await chooseMenuItem(page, 'Analyze', 'Copy as Command…');
  const dialog = page.getByRole('dialog', { name: 'Copy as Command' });
  const commandBlock = dialog.getByTestId('glcm-command');
  await expect(commandBlock).toHaveText('glcm measure camera.png --settings camera.settings.json --rois camera.roi.json --out camera-results.csv');
  // Sending to this server adds its address
  await dialog.getByRole('switch').check({ force: true });
  await expect(commandBlock).toContainText(`--server http://`);
  await dialog.getByRole('switch').uncheck({ force: true });
  const command = (await commandBlock.textContent())!;

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-e2e-command-'));
  try {
    expect(await saveFiles(page, dialog, folder)).toEqual(['camera-measure.sh', 'camera.roi.json', 'camera.settings.json']);
    expect(strFromU8(await fs.readFile(path.join(folder, 'camera-measure.sh')))).toContain(command);
    await fs.copyFile(path.join(ROOT, 'samples', 'textures', 'camera.png'), path.join(folder, 'camera.png'));
    const csv = parseCsv(await runCommand(command, folder));
    await page.keyboard.press('Escape');

    // The same ROIs measured in the app
    await chooseMenuItem(page, 'Analyze', 'Measure All');
    await expect.poll(async () => (await resultRows(page)).filter((row) => row.status === 'ok').length).toBeGreaterThanOrEqual(15);
    const rows = await resultRows(page);
    const roiName = csv.header.indexOf('roiName');
    const direction = csv.header.indexOf('direction');
    const contrast = csv.header.indexOf('Contrast');
    const means = csv.rows.filter((row) => row[direction] === 'mean');
    expect(means).toHaveLength(3);
    for (const row of means) {
      const app = rows.find((candidate) => candidate.roiName === row[roiName] && candidate.direction === 'mean')!;
      expect(Number(row[contrast])).toBeCloseTo(app.values.Contrast!, 9);
    }
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('Batch Measure copies a command for the chosen images', async ({ page }) => {
  await openSample(page);
  await drawThreeRois(page);
  const [roi] = await storedRois(page);
  await chooseMenuItem(page, 'Analyze', 'Batch Measure…');
  const dialog = page.getByRole('dialog', { name: 'Batch Measure' });
  const images = ['camera.png', 'brick.png'].map((name) => path.join(ROOT, 'samples', 'textures', name));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dialog.getByLabel('Images').click()]);
  await chooser.setFiles(images);
  await dialog.getByRole('button', { name: 'Copy as Command…' }).click();
  const commandBlock = dialog.getByTestId('glcm-command');
  await expect(commandBlock).toHaveText('glcm measure camera.png brick.png --settings batch.settings.json --rois batch.roi.json --out batch-results.csv');

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-e2e-command-'));
  try {
    expect(await saveFiles(page, dialog, folder)).toEqual(['batch-measure.sh', 'batch.roi.json', 'batch.settings.json']);
    for (const image of images) {
      await fs.copyFile(image, path.join(folder, path.basename(image)));
    }
    const csv = parseCsv(await runCommand((await commandBlock.textContent())!, folder));
    const brick = await native.decodeImageFile(images[1]);
    const expected = JSON.parse(
      await native.runAnalysis(
        brick.pixels,
        brick.width,
        brick.height,
        8,
        JSON.stringify([{ id: roi.id, name: roi.name, shape: roi.shape }]),
        JSON.stringify(SETTINGS),
      ),
    ).results[0];
    const row = csv.rows.find(
      (candidate) =>
        candidate[csv.header.indexOf('image')] === 'brick.png' &&
        candidate[csv.header.indexOf('roiName')] === roi.name &&
        candidate[csv.header.indexOf('direction')] === 'mean',
    )!;
    expect(Number(row[csv.header.indexOf('Contrast')])).toBe(expected.values.Contrast.mean);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
