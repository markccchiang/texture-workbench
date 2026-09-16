// End-to-end test of File ▸ Save Report…: one self-contained HTML file with the image, ROIs, settings, results and
// charts of the session, and the sections the dialog switched off left out

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Download, type Page } from '@playwright/test';
import { chooseMenuItem, drawThreeRois, openSample, storedRois } from './helpers.js';

async function saveReport(page: Page, prepare?: (dialog: ReturnType<Page['getByRole']>) => Promise<void>): Promise<Download> {
  await chooseMenuItem(page, 'File', 'Save Report…');
  const dialog = page.getByRole('dialog', { name: 'Save Report' });
  await expect(dialog.getByTestId('report-summary')).toContainText('1 image · 3 ROIs');
  await prepare?.(dialog);
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Save Report' }).click()]);
  await expect(dialog).toHaveCount(0);
  return download;
}

const readDownload = async (download: Download) => fs.readFile((await download.path())!, 'utf8');

test('saves a report of the session as one self-contained HTML file', async ({ page }) => {
  await openSample(page);
  await drawThreeRois(page);
  // Shift+M measures every ROI: 3 ROIs × (4 directions + mean)
  await page.keyboard.press('Shift+M');
  await expect(page.getByTestId('results-table').locator('tbody tr')).toHaveCount(15);

  const download = await saveReport(page, async (dialog) => {
    await dialog.getByLabel('Title').fill('Camera test report');
    await dialog.getByLabel('Notes').fill('Three ROIs, mean over the directions.');
  });
  expect(download.suggestedFilename()).toMatch(/^camera-report-\d{8}-\d{6}\.html$/);

  const html = await readDownload(download);
  const rois = await storedRois(page);
  expect(html).toContain('<title>Camera test report</title>');
  expect(html).toContain('Three ROIs, mean over the directions.');
  for (const roi of rois) {
    expect(html).toContain(roi.name);
  }
  // The image and the charts are embedded, nothing is fetched when the file is opened
  expect(html).toContain('<img src="data:image/png;base64,');
  expect(html).toContain('<svg');
  expect(html).not.toMatch(/src="https?:/);
  expect(html).toContain('camera.png');
  expect(html).toContain('Gray levels');
  expect(html).toContain('@media print');

  // It opens as a page, with the charts drawn (the browser needs the .html name to parse it)
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-report-')), download.suggestedFilename());
  await fs.copyFile((await download.path())!, file);
  const report = await page.context().newPage();
  await report.goto(`file://${file}`);
  await expect(report).toHaveTitle('Camera test report');
  await expect(report.getByRole('heading', { name: 'Camera test report' })).toBeVisible();
  await expect(report.locator('figure.image img')).toBeVisible();
  await expect(report.locator('figure.chart svg').first()).toBeVisible();
  await expect(report.locator('table[data-report="results"] tbody tr')).toHaveCount(15);
  await expect(report.locator('table[data-report="rois"] tbody tr')).toHaveCount(3);
  await report.close();
});

test('leaves out the sections switched off in the dialog', async ({ page }) => {
  await openSample(page);
  await drawThreeRois(page);
  // Shift+M measures every ROI: 3 ROIs × (4 directions + mean)
  await page.keyboard.press('Shift+M');
  await expect(page.getByTestId('results-table').locator('tbody tr')).toHaveCount(15);

  const download = await saveReport(page, async (dialog) => {
    await dialog.getByLabel('Images').uncheck();
    await dialog.getByLabel('Charts').uncheck();
    await expect(dialog.getByTestId('report-summary')).not.toContainText('chart');
  });
  const html = await readDownload(download);
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<svg');
  expect(html).toContain('<h3>ROIs (3)</h3>');
  expect(html).toContain('Gray levels');

  // The choice is remembered for the next report
  await chooseMenuItem(page, 'File', 'Save Report…');
  const dialog = page.getByRole('dialog', { name: 'Save Report' });
  await expect(dialog.getByLabel('Images')).not.toBeChecked();
  await expect(dialog.getByLabel('Charts')).not.toBeChecked();
});
