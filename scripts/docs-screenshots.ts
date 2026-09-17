// Captures the UI screenshots of the user guide into doc/user/images.
//
//   npm run build:web && npm run docs:screenshots
//
// Starts two temporary servers (without and with an access token), opens the sample image in Chromium, draws and
// measures ROIs, and saves the screenshots. Run it again after UI changes so the guide stays accurate.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { chooseMenuItem, clickAt, drag, toPage, waitForImage } from '../e2e/helpers.js';
import { E2E_API_TOKEN } from '../e2e/token.js';
import { encodeNifti } from '../bindings/node/test/medical.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(ROOT, 'doc', 'user', 'images');
const PORT = 8190;
const TOKEN_PORT = 8191;
const VIEWPORT = { width: 1440, height: 960 };

const SETTINGS = {
  features: ['Mean', 'Energy', 'Contrast', 'HomogeneityII', 'CorrelationII', 'Entropy'],
  grayLevels: 32,
  quantization: { method: 'fixedRange', min: 0, max: 255, binWidth: 8 },
  distances: [1],
  directions: [0, 45, 90, 135],
  aggregation: 'perDirectionAndMean',
  logBase: 'natural',
  score: { enabled: true, age: 45, coefficients: [1.138, -1.814, 1.416, 1.714], profile: 'calibration', intensityMin: 0, intensityMax: 255 },
};

interface Server {
  process: ChildProcess;
  dataDir: string;
}

async function isListening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    return true;
  } catch {
    return false;
  }
}

async function startServer(port: number, apiToken: string): Promise<Server> {
  // A server left over from an earlier run would pass the health check and serve an outdated build
  if (await isListening(port)) {
    throw new Error(`Port ${port} is already in use; stop the other server first`);
  }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-docs-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, GLCM_HOST: '127.0.0.1', GLCM_PORT: String(port), GLCM_DATA_DIR: dataDir, GLCM_API_TOKEN: apiToken, GLCM_LOG_LEVEL: 'warn', UV_THREADPOOL_SIZE: '8' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const server = { process: child, dataDir };
  for (let attempt = 0; attempt < 120 && child.exitCode === null && child.signalCode === null; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) {
        return server;
      }
    } catch {
      // Not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const exitCode = child.exitCode;
  await stopServer(server);
  throw new Error(exitCode !== null ? `The server on port ${port} exited with status ${exitCode}` : `The server on port ${port} did not start`);
}

async function stopServer(server: Server): Promise<void> {
  const { process: child } = server;
  // Waiting for "exit" from a process that has already exited would never finish
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(forceKill);
  }
  await fs.rm(server.dataDir, { recursive: true, force: true });
}

type Clip = { x: number; y: number; width: number; height: number };

async function shot(page: Page, name: string, target?: Locator | Clip, margin = 0): Promise<void> {
  let clip: Clip | undefined;
  if (target && 'boundingBox' in target) {
    const box = (await target.boundingBox())!;
    clip = { x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin };
  } else {
    clip = target;
  }
  if (clip) {
    const viewport = page.viewportSize() ?? VIEWPORT;
    const x = Math.max(0, Math.floor(clip.x));
    const y = Math.max(0, Math.floor(clip.y));
    clip = { x, y, width: Math.min(viewport.width - x, Math.ceil(clip.width)), height: Math.min(viewport.height - y, Math.ceil(clip.height)) };
  }
  await page.screenshot({ path: path.join(OUTPUT, `${name}.png`), clip, animations: 'disabled' });
  console.log(`✓ ${name}.png`);
}

/** A dialog after its opening transition, so that its final position is captured */
async function dialogShot(page: Page, name: string, dialog: Locator): Promise<void> {
  await dialog.waitFor();
  await page.waitForTimeout(600);
  await shot(page, name, dialog);
}

/** Numbered markers placed relative to elements, for the main window figure */
async function addCallouts(page: Page, callouts: Array<{ selector: string; label: string; dx: number; dy: number }>): Promise<void> {
  await page.evaluate((items) => {
    for (const { selector, label, dx, dy } of items) {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`No element for ${selector}`);
      }
      const box = element.getBoundingClientRect();
      const marker = document.createElement('div');
      marker.className = 'docs-callout';
      marker.textContent = label;
      Object.assign(marker.style, {
        position: 'fixed',
        left: `${box.left + dx}px`,
        top: `${box.top + dy}px`,
        width: '26px',
        height: '26px',
        borderRadius: '50%',
        background: '#fa5252',
        color: '#ffffff',
        font: '700 14px/26px system-ui, sans-serif',
        textAlign: 'center',
        boxShadow: '0 0 0 2px #ffffff, 0 2px 8px rgba(0, 0, 0, 0.6)',
        zIndex: '10000',
        pointerEvents: 'none',
      });
      document.body.append(marker);
    }
  }, callouts);
}

async function removeCallouts(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll('.docs-callout').forEach((marker) => marker.remove()));
}

/** Toasts would cover parts of the screenshots */
async function hideNotifications(page: Page): Promise<void> {
  await page.addStyleTag({ content: '.mantine-Notifications-root { display: none !important; }' });
}

/** 128 × 128 × 96 int16 voxels of 1.5 mm: a skull, brain with ventricles and a textured lesion, in RAS order */
function headPhantom(): Buffer {
  const [nx, ny, nz] = [128, 128, 96];
  const data = new Array<number>(nx * ny * nz);
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const x = (i - nx / 2) / 52;
        const y = (j - ny / 2 - 4) / 62;
        const z = (k - nz / 2) / 44;
        const r = Math.hypot(x, y, z);
        let value = 0;
        if (r < 1) {
          value = r > 0.9 ? 1400 : 700 + 120 * Math.sin(i / 3) * Math.cos(j / 4) * Math.sin(k / 5);
          if (Math.hypot(x / 0.18, (y - 0.05) / 0.35, z / 0.3) < 1 && Math.abs(x) > 0.04) {
            value = 250;
          }
          if (Math.hypot(x - 0.35, y + 0.3, z - 0.1) < 0.18) {
            value = 1000 + 250 * random();
          }
        }
        data[i + nx * (j + ny * k)] = Math.round(value + (value > 0 ? 30 * random() : 0));
      }
    }
  }
  return encodeNifti({ dimensions: [nx, ny, nz], dataType: 'int16', data, voxelSize: [1.5, 1.5, 1.5], gzip: true });
}

async function main(): Promise<void> {
  await fs.mkdir(OUTPUT, { recursive: true });
  // Everything started is stopped in "finally", also when a later step fails
  const servers: Server[] = [];
  let browser: Browser | undefined;
  try {
    servers.push(await startServer(PORT, ''));
    servers.push(await startServer(TOKEN_PORT, E2E_API_TOKEN));
    browser = await chromium.launch();

    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${PORT}`, viewport: VIEWPORT, locale: 'en-US', colorScheme: 'dark' });
    await context.addInitScript((settings) => {
      window.localStorage.setItem('glcm.analysisSettings', JSON.stringify({ state: { settings }, version: 1 }));
    }, SETTINGS);
    const page = await context.newPage();

    // Start screen
    await page.goto('/?testHooks');
    await hideNotifications(page);
    await page.getByRole('button', { name: 'Open sample image' }).waitFor();
    await shot(page, 'start-screen');

    // Image with four ROIs, measured
    await page.getByRole('button', { name: 'Open sample image' }).click();
    await waitForImage(page);
    await page.keyboard.press('r');
    await drag(page, [40, 30], [140, 95]);
    await page.keyboard.press('t');
    await page.keyboard.press('e');
    await drag(page, [45, 280], [125, 400]);
    await page.keyboard.press('t');
    await page.keyboard.press('p');
    for (const [x, y] of [
      [385, 270],
      [480, 262],
      [498, 370],
      [455, 430],
      [398, 375],
    ]) {
      await clickAt(page, x, y);
    }
    await page.keyboard.press('Enter');
    await page.keyboard.press('t');
    await page.keyboard.press('f');
    const outline = [
      [168, 112],
      [178, 82],
      [210, 64],
      [250, 70],
      [268, 96],
      [238, 104],
      [200, 116],
      [172, 116],
    ];
    const start = await toPage(page, outline[0][0], outline[0][1]);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const [x, y] of outline.slice(1)) {
      const point = await toPage(page, x, y);
      await page.mouse.move(point.x, point.y, { steps: 8 });
    }
    await page.mouse.up();
    await page.keyboard.press('t');
    await page.evaluate(() => {
      const rois = (window as unknown as { __glcm: { rois: { getState(): { rois: Array<{ id: string }>; renameRoi(id: string, name: string): void; select(ids: string[]): void } } } }).__glcm.rois.getState();
      ['Sky', 'Coat', 'Grass', 'Hair'].forEach((name, i) => rois.renameRoi(rois.rois[i].id, name));
      rois.select([]);
    });
    await page.keyboard.press('Shift+M');
    await expect(page.getByTestId('results-table').locator('tbody tr')).toHaveCount(20, { timeout: 30_000 });
    await chooseMenuItem(page, 'View', 'Show ROI Labels');
    await page.getByRole('button', { name: /^Pointer/ }).click();
    await page.getByTestId('roi-row').filter({ hasText: 'Coat' }).click();
    const coatPoint = await toPage(page, 300, 180);
    await page.mouse.move(coatPoint.x, coatPoint.y);
    await page.waitForTimeout(400);

    // Without markers, for the README
    await shot(page, 'app-window');

    await addCallouts(page, [
      { selector: 'nav[aria-label="Main menu"]', label: '1', dx: 620, dy: 4 },
      { selector: '[role="toolbar"]', label: '2', dx: 900, dy: 8 },
      { selector: '[data-testid="image-canvas"]', label: '3', dx: 12, dy: 12 },
      { selector: 'section[aria-label^="ROI Manager"]', label: '4', dx: 200, dy: 1 },
      { selector: 'section[aria-label="Analysis Settings"]', label: '5', dx: 200, dy: 1 },
      { selector: 'section[aria-label^="Results"]', label: '6', dx: 230, dy: 1 },
      { selector: '[data-testid="status-bar"]', label: '7', dx: 1000, dy: 0 },
    ]);
    await shot(page, 'main-window');
    await removeCallouts(page);

    await shot(page, 'canvas-rois', page.getByTestId('image-canvas'));
    await shot(page, 'roi-manager', page.locator('section[aria-label^="ROI Manager"]'));
    // A taller window shows the whole settings panel, and a taller Results panel shows more rows
    await page.setViewportSize({ width: VIEWPORT.width, height: 1400 });
    await page.waitForTimeout(400);
    await shot(page, 'analysis-settings', page.locator('section[aria-label="Analysis Settings"]'));
    const resultsBorder = (await page.locator('.separator-horizontal').last().boundingBox())!;
    await page.mouse.move(resultsBorder.x + resultsBorder.width / 2, resultsBorder.y + resultsBorder.height / 2);
    await page.mouse.down();
    await page.mouse.move(resultsBorder.x + resultsBorder.width / 2, resultsBorder.y - 260, { steps: 10 });
    await page.mouse.up();
    await page.mouse.move(5, 1395);
    await page.waitForTimeout(400);
    await shot(page, 'results-table', page.locator('section[aria-label^="Results"]'));
    const results = page.locator('section[aria-label^="Results"]');
    await results.getByText('Plot', { exact: true }).click();
    await results.getByLabel('Feature').click();
    await page.getByRole('option', { name: 'Contrast', exact: true }).click();
    await results.getByText('Directions', { exact: true }).click();
    await page.mouse.move(5, 1395);
    await page.waitForTimeout(400);
    await shot(page, 'results-plot-directions', results);
    await results.getByText('Table', { exact: true }).click();

    // Feature picker, which needs the taller window too
    await page.getByTestId('feature-picker-button').click();
    await page.waitForTimeout(300);
    await shot(page, 'feature-picker', page.getByRole('dialog', { name: 'Features' }));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Features' }).waitFor({ state: 'hidden' });

    await chooseMenuItem(page, 'View', 'Reset Layout');
    await page.setViewportSize(VIEWPORT);
    await page.waitForTimeout(400);

    // Window/level
    await page.getByRole('button', { name: 'Window/level settings' }).click();
    // The Select menus of the settings panel keep hidden dropdowns of the same class
    const popover = page.locator('.mantine-Popover-dropdown').filter({ hasText: 'Histogram' });
    await popover.waitFor();
    const toolbarBox = (await page.getByRole('toolbar').boundingBox())!;
    const popoverBox = (await popover.boundingBox())!;
    await shot(page, 'window-level', {
      x: popoverBox.x - 330,
      y: toolbarBox.y,
      width: popoverBox.width + 350,
      height: popoverBox.y + popoverBox.height - toolbarBox.y + 12,
    });
    // The popover stays open on Escape; its button toggles it
    await page.getByRole('button', { name: 'Window/level settings' }).click();
    await popover.waitFor({ state: 'hidden' });

    // Zoomed in on the selected ROI, with the navigator and an ROI tooltip
    await page.mouse.move(5, VIEWPORT.height - 5);
    await page.keyboard.press('z');
    const hover = await toPage(page, 100, 330);
    await page.mouse.move(hover.x, hover.y);
    await page.waitForTimeout(700);
    await shot(page, 'zoom-navigator', page.getByTestId('image-canvas'));
    await page.mouse.move(5, VIEWPORT.height - 5);
    await page.keyboard.press('0');

    // Feature map over the image, with its card
    await chooseMenuItem(page, 'Analyze', 'Feature Map…');
    await page.getByRole('dialog', { name: 'Feature Map' }).getByRole('button', { name: 'Compute' }).click();
    const mapCard = page.getByRole('region', { name: 'Feature map' });
    await mapCard.getByRole('button', { name: 'Save PNG' }).waitFor({ timeout: 120_000 });
    await mapCard.getByRole('combobox', { name: 'Colour table' }).click();
    await page.getByRole('option', { name: 'Magma', exact: true }).click();
    const mapHover = await toPage(page, 260, 200);
    await page.mouse.move(mapHover.x, mapHover.y);
    await page.waitForTimeout(500);
    await shot(page, 'feature-map', page.getByTestId('image-canvas'));
    await mapCard.getByRole('button', { name: 'Close feature map' }).click();
    await mapCard.waitFor({ state: 'hidden' });
    await page.mouse.move(5, VIEWPORT.height - 5);

    // File menu and dialogs
    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'File', exact: true }).click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    const menuBox = (await menu.boundingBox())!;
    await shot(page, 'file-menu', { x: 0, y: 0, width: menuBox.x + menuBox.width + 24, height: menuBox.y + menuBox.height + 12 });
    await page.keyboard.press('Escape');

    // Threshold ROI with a dark window (the coat and the camera), so the dialog counts several regions
    const setViewerWindow = (min: number, max: number) =>
      page.evaluate(([low, high]) => (window as unknown as { __glcm: { viewer: { getState(): { setWindow(min: number, max: number): void } } } }).__glcm.viewer.getState().setWindow(low, high), [min, max]);
    await setViewerWindow(0, 40);
    await chooseMenuItem(page, 'ROI', 'Threshold ROI…');
    const thresholdDialog = page.getByRole('dialog', { name: 'Threshold ROI' });
    await thresholdDialog.getByTestId('threshold-summary').filter({ hasText: /region/ }).waitFor();
    await dialogShot(page, 'threshold-roi', thresholdDialog);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => (window as unknown as { __glcm: { viewer: { getState(): { resetWindow(mode: 'auto' | 'full'): void } } } }).__glcm.viewer.getState().resetWindow('auto'));

    await chooseMenuItem(page, 'ROI', 'Export ROI Images…');
    await dialogShot(page, 'export-roi-images', page.getByRole('dialog', { name: 'Export ROI Images' }));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    await chooseMenuItem(page, 'File', /^Save Project…/);
    await dialogShot(page, 'save-project', page.getByRole('dialog', { name: 'Save Project' }));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    await chooseMenuItem(page, 'Edit', /^Preferences…/);
    await dialogShot(page, 'preferences', page.getByRole('dialog', { name: 'Preferences' }));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    // Save Report dialog, and the report it writes
    await chooseMenuItem(page, 'File', 'Save Report…');
    const reportDialog = page.getByRole('dialog', { name: 'Save Report' });
    await reportDialog.getByLabel('Title').fill('Cameraman texture report');
    await reportDialog.getByLabel('Notes').fill('Three ROIs on the cameraman photograph, measured at d = 1 and d = 2.');
    await dialogShot(page, 'save-report', reportDialog);
    const [reportDownload] = await Promise.all([
      page.waitForEvent('download'),
      reportDialog.getByRole('button', { name: 'Save Report' }).click(),
    ]);
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const reportFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-report-')), reportDownload.suggestedFilename());
    await reportDownload.saveAs(reportFile);
    const reportPage = await context.newPage();
    await reportPage.setViewportSize({ width: 1060, height: 1180 });
    await reportPage.goto(`file://${reportFile}`);
    await reportPage.locator('figure.chart svg').first().waitFor();
    await shot(reportPage, 'report');
    await reportPage.close();

    // Slice dialog of a NIfTI volume: a synthetic head phantom
    await page.getByTestId('file-input').setInputFiles({ name: 'phantom.nii.gz', mimeType: 'application/gzip', buffer: headPhantom() });
    const sliceDialog = page.getByRole('dialog', { name: 'Open phantom.nii.gz' });
    await sliceDialog.getByTestId('volume-preview').and(page.locator('[data-shows="axial:47:0"]')).waitFor();
    await dialogShot(page, 'volume-import', sliceDialog);
    await sliceDialog.getByRole('button', { name: 'Cancel' }).click();
    await sliceDialog.waitFor({ state: 'hidden' });

    // Edge map over the image, with its card
    await page.mouse.move(5, VIEWPORT.height - 5);
    const edgeMapLoaded = page.waitForResponse((response) => response.url().includes('/edges.png') && response.ok());
    await chooseMenuItem(page, 'View', 'Show Edge Map');
    const edgeCard = page.getByRole('region', { name: 'Edge map' });
    await edgeCard.getByText(/95th percentile/).waitFor();
    await edgeMapLoaded;
    await page.waitForTimeout(600);
    await shot(page, 'edge-map', page.getByTestId('image-canvas'));
    await edgeCard.getByRole('button', { name: 'Hide edge map' }).click();
    await edgeCard.waitFor({ state: 'hidden' });

    // Plot Profile along a ruler line across the coat, and the histogram of the first ROI
    await page.mouse.move(5, VIEWPORT.height - 5);
    await page.getByTestId('status-bar').click();
    await page.keyboard.press('l');
    await drag(page, [120, 250], [420, 250]);
    await chooseMenuItem(page, 'Analyze', 'Plot Profile');
    const profileDialog = page.getByRole('dialog', { name: 'Plot Profile' });
    await profileDialog.getByTestId('profile-line').first().waitFor();
    await dialogShot(page, 'plot-profile', profileDialog);
    await page.keyboard.press('Escape');
    await profileDialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      const glcm = (
        window as unknown as {
          __glcm: {
            viewer: { getState(): { setRuler(ruler: null): void; setTool(tool: string): void } };
            rois: { getState(): { rois: Array<{ id: string }>; select(ids: string[]): void } };
          };
        }
      ).__glcm;
      glcm.viewer.getState().setRuler(null);
      glcm.viewer.getState().setTool('pointer');
      const rois = glcm.rois.getState();
      rois.select([rois.rois[0].id]);
    });
    await chooseMenuItem(page, 'Analyze', 'Histogram');
    const histogramDialog = page.getByRole('dialog', { name: 'Histogram' });
    await histogramDialog.getByTestId('histogram-bar').first().waitFor();
    await dialogShot(page, 'histogram', histogramDialog);
    await page.keyboard.press('Escape');
    await histogramDialog.waitFor({ state: 'hidden' });

    // An ROI with a hole, made with Subtract
    const cutId = await page.evaluate(() => {
      const rois = (
        window as unknown as {
          __glcm: { rois: { getState(): { importRois(list: Array<{ name: string; color: string; shape: unknown }>): string[]; select(ids: string[]): void } } };
        }
      ).__glcm.rois.getState();
      const ids = rois.importRois([
        { name: 'Ring', color: '', shape: { type: 'rectangle', x: 300, y: 330, width: 150, height: 120 } },
        { name: 'Cut', color: '', shape: { type: 'ellipse', cx: 375, cy: 390, rx: 42, ry: 30 } },
      ]);
      rois.select(ids);
      return ids[1];
    });
    await chooseMenuItem(page, 'ROI', 'Subtract');
    await page.waitForFunction(() =>
      (window as unknown as { __glcm: { rois: { getState(): { rois: Array<{ name: string; shape: { type: string } }> } } } }).__glcm.rois
        .getState()
        .rois.some((roi) => roi.name === 'Ring' && roi.shape.type === 'polygon'),
    );
    await page.evaluate(
      (id) => (window as unknown as { __glcm: { rois: { getState(): { deleteRois(ids: string[]): void } } } }).__glcm.rois.getState().deleteRois([id]),
      cutId,
    );
    await page.mouse.move(5, VIEWPORT.height - 5);
    await page.waitForTimeout(400);
    const topLeft = await toPage(page, 270, 300);
    const bottomRight = await toPage(page, 480, 480);
    await shot(page, 'roi-editing', { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y });

    // A band of 12 mm around the ring, with a pixel spacing so the dialog offers millimetres
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __glcm: {
            viewer: { getState(): { setPixelSpacing(spacing: { x: number; y: number }): void } };
            rois: { getState(): { rois: Array<{ id: string; name: string }>; select(ids: string[]): void } };
          };
        }
      ).__glcm;
      hooks.viewer.getState().setPixelSpacing({ x: 0.5, y: 0.5 });
      const rois = hooks.rois.getState();
      rois.select(rois.rois.filter((roi) => roi.name === 'Ring').map((roi) => roi.id));
    });
    await chooseMenuItem(page, 'ROI', 'Make Band…');
    const bandDialog = page.getByRole('dialog', { name: 'Enlarge, Shrink or Band' });
    await bandDialog.getByText('mm', { exact: true }).click();
    await bandDialog.getByLabel('Distance').fill('12');
    await dialogShot(page, 'make-band', bandDialog);
    await bandDialog.getByRole('button', { name: 'Add bands to 1 ROI by 12 mm' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() =>
      (window as unknown as { __glcm: { rois: { getState(): { rois: Array<{ name: string }> } } } }).__glcm.rois.getState().rois.some((roi) => roi.name.startsWith('Ring band')),
    );
    await page.mouse.move(5, VIEWPORT.height - 5);
    await page.waitForTimeout(400);
    const bandTopLeft = await toPage(page, 250, 280);
    const bandBottomRight = await toPage(page, 500, 500);
    await shot(page, 'roi-band', { x: bandTopLeft.x, y: bandTopLeft.y, width: bandBottomRight.x - bandTopLeft.x, height: bandBottomRight.y - bandTopLeft.y });

    // Copy as Command for the ROIs of the band screenshot
    await chooseMenuItem(page, 'Analyze', 'Copy as Command…');
    const commandDialog = page.getByRole('dialog', { name: 'Copy as Command' });
    await commandDialog.getByTestId('glcm-command').waitFor();
    await dialogShot(page, 'copy-command', commandDialog);
    await page.keyboard.press('Escape');
    await commandDialog.waitFor({ state: 'hidden' });

    // Colour Conversion of the immunohistochemistry sample, with DAB chosen
    await page.getByTestId('file-input').setInputFiles(path.join(ROOT, 'samples', 'textures', 'ihc.png'));
    await expect(page.getByTestId('status-bar')).toContainText('ihc.png 512×512 8-bit');
    await chooseMenuItem(page, 'Image', 'Colour Conversion…');
    const colourDialog = page.getByRole('dialog', { name: 'Colour Conversion' });
    await colourDialog.getByRole('radio', { name: 'DAB (H-DAB)' }).check();
    await colourDialog.getByTestId('colour-preview').and(page.locator('[data-shows="dabHdab"]')).waitFor();
    await dialogShot(page, 'colour-conversion', colourDialog);
    await colourDialog.getByRole('button', { name: 'Cancel' }).click();
    await colourDialog.waitFor({ state: 'hidden' });

    // A stack: every axial slice of the head phantom, with an ROI on the slice shown and the slice slider
    await page.getByTestId('file-input').setInputFiles({ name: 'phantom.nii.gz', mimeType: 'application/gzip', buffer: headPhantom() });
    const stackDialog = page.getByRole('dialog', { name: 'Open phantom.nii.gz' });
    await stackDialog.getByTestId('volume-preview').and(page.locator('[data-shows="axial:47:0"]')).waitFor();
    await stackDialog.getByRole('button', { name: 'Open All Slices' }).click();
    await expect(page.getByTestId('slice-readout')).toHaveText('48 / 96', { timeout: 30_000 });
    await page.keyboard.press('e');
    await drag(page, [30, 70], [62, 98]);
    await page.keyboard.press('t');
    await page.mouse.move(5, VIEWPORT.height - 5);
    await page.waitForTimeout(600);
    const canvasBox = (await page.getByTestId('image-canvas').boundingBox())!;
    const sliceBarBox = (await page.getByTestId('slice-bar').boundingBox())!;
    await shot(page, 'stack', { x: canvasBox.x, y: canvasBox.y, width: canvasBox.width, height: sliceBarBox.y + sliceBarBox.height - canvasBox.y });
    await context.close();

    // Access token prompt of a server that requires a token
    const tokenContext = await browser.newContext({ baseURL: `http://127.0.0.1:${TOKEN_PORT}`, viewport: VIEWPORT, locale: 'en-US', colorScheme: 'dark' });
    const tokenPage = await tokenContext.newPage();
    await tokenPage.goto('/');
    await dialogShot(tokenPage, 'token-prompt', tokenPage.getByRole('dialog', { name: 'Access token' }));
    await tokenContext.close();
  } finally {
    await browser?.close();
    for (const server of servers) {
      await stopServer(server);
    }
  }
}

await main();
