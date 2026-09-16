// The client against a real server over HTTP: what a program outside this repository would do with it. The server is
// built here only to have something to talk to; the client itself knows nothing about it.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type App } from '@glcm/server/app';
import { DEFAULT_CONFIG } from '@glcm/server/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiError,
  buildSettings,
  computeFeatureMap,
  getCatalog,
  httpClient,
  listSamples,
  measure,
  openImage,
  roisFromDocument,
  roiSetOf,
  selectRegionAt,
  selectThresholdRegions,
  validateSettings,
  valueRange,
  wholeImageRoi,
  type ApiClient,
} from '../src/index.js';

const REPOSITORY = path.resolve(import.meta.dirname, '..', '..', '..');
const TOKEN = 'c'.repeat(43);

let app: App;
let dataDir: string;
let client: ApiClient;
let catalog: Awaited<ReturnType<typeof getCatalog>>;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-client-test-'));
  app = await buildApp(
    { ...DEFAULT_CONFIG, dataDir, samplesDir: path.join(REPOSITORY, 'samples'), webDir: null, docsDir: null, apiToken: TOKEN, logLevel: 'silent' },
    { logger: false },
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  client = httpClient(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, TOKEN);
  catalog = await getCatalog(client);
});

afterAll(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the API client', () => {
  it('reads the catalog and the samples', async () => {
    expect(catalog.features.map((feature) => feature.id)).toContain('Contrast');
    expect(catalog.presets.map((preset) => preset.id)).toContain('haralick');
    expect((await listSamples(client)).map((sample) => sample.path)).toContain('textures/brick.png');
  });

  it('opens an image from bytes, and finds it again by its checksum', async () => {
    const data = await fs.readFile(path.join(REPOSITORY, 'samples', 'textures', 'brick.png'));
    const first = await openImage(client, { kind: 'bytes', name: 'brick.png', data, contentType: 'image/png' });
    expect(first.reused).toBe(false);
    expect(first.info).toMatchObject({ width: 512, height: 512, bitDepth: 8 });

    const again = await openImage(client, { kind: 'bytes', name: 'other-name.png', data, contentType: 'image/png' });
    expect(again.reused).toBe(true);
    expect(again.info.imageId).toBe(first.info.imageId);

    // A sample the server ships, and an image it already has
    const sample = await openImage(client, { kind: 'sample', path: 'textures/camera.png' });
    expect(sample.info.name).toBe('camera.png');
    expect((await openImage(client, { kind: 'id', imageId: sample.info.imageId })).info.imageId).toBe(sample.info.imageId);
  });

  it('builds settings the way the application does, and refuses what it would refuse', () => {
    const settings = buildSettings(catalog, 8, { preset: 'basic', grayLevels: 16, distances: [1, 2] });
    expect(settings.grayLevels).toBe(16);
    expect(settings.distances).toEqual([1, 2]);
    expect(settings.features.length).toBeGreaterThan(0);
    expect(validateSettings(settings, 8, catalog).errors).toEqual([]);

    expect(validateSettings({ ...settings, grayLevels: 1000 }, 8, catalog).errors[0]).toContain('Gray levels must be an integer');
    expect(() => buildSettings(catalog, 8, { preset: 'nope' })).toThrow(/no preset "nope"/);
    expect(() => buildSettings(catalog, 8, { features: ['Nope'] })).toThrow(/Unknown features: Nope/);
  });

  it('measures ROIs and gives back the document and the CSV', async () => {
    const { info } = await openImage(client, { kind: 'sample', path: 'textures/brick.png' });
    const settings = buildSettings(catalog, info.bitDepth, { features: ['Contrast', 'Entropy'], aggregation: 'meanOnly' });
    const measurement = await measure(client, { imageId: info.imageId, rois: [wholeImageRoi(info)], settings });

    expect(measurement.analysis.status).toBe('completed');
    expect(measurement.document.results).toHaveLength(1);
    expect(measurement.document.results[0].values.Contrast.mean).toBeGreaterThan(0);
    expect(measurement.csv).toContain('# format=glcm-results-csv');
    expect(measurement.csv).toContain('Whole image');
  });

  it('selects regions and turns them into an ROI set', async () => {
    const { info } = await openImage(client, { kind: 'sample', path: 'textures/brick.png' });
    const { regions, total } = await selectThresholdRegions(client, info.imageId, { min: 0, max: 110, minPixels: 400, maxRegions: 3 });
    expect(regions.length).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(regions.length);

    const document = roiSetOf(info, regions);
    expect(document.format).toBe('glcm-roi-set');
    expect(document.rois[0].shape.type).toBe('polygon');
    // The ROI set reads back as ROIs a measurement accepts
    expect(roisFromDocument(document)).toHaveLength(document.rois.length);

    const region = await selectRegionAt(client, info.imageId, { x: 10, y: 10, tolerance: 20 });
    expect(region?.pixelCount).toBeGreaterThan(0);
  });

  it('computes a feature map and reports its range in one pass', async () => {
    const { info } = await openImage(client, { kind: 'sample', path: 'textures/brick.png' });
    const settings = buildSettings(catalog, info.bitDepth, {});
    const map = await computeFeatureMap(client, info.imageId, {
      feature: 'Contrast',
      window: 15,
      step: 32,
      grayLevels: settings.grayLevels,
      quantization: settings.quantization,
      distance: 1,
      directions: settings.directions,
      logBase: settings.logBase,
    });
    expect([map.info.columns, map.info.rows]).toEqual([16, 16]);
    expect(map.values).toHaveLength(16 * 16);

    const range = valueRange(map.values);
    expect(range.minimum).toBeGreaterThanOrEqual(0);
    expect(range.maximum!).toBeGreaterThan(range.minimum!);
    expect(valueRange(new Float32Array([Number.NaN, Number.NaN]))).toEqual({ minimum: null, maximum: null, empty: 2 });
  });

  it('reports a refused request with the message the server gave', async () => {
    const address = app.server.address();
    const wrong = httpClient(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, 'wrong-token');
    await expect(getCatalog(wrong)).rejects.toThrow(/the server needs an access token/);

    const unreachable = httpClient('http://127.0.0.1:1', null);
    await expect(getCatalog(unreachable)).rejects.toMatchObject({ code: 'NetworkError' });
    expect(() => roisFromDocument({ rois: [] })).toThrow(ApiError);
  });
});
