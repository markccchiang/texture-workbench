import { randomUUID } from 'node:crypto';
import type { AnalysisInfo, AnalysisResults, AnalysisSettings, FeatureMapInfo, ImageInfo, RoiStatsResponse, VolumeInfo } from '@glcm/api';
import * as native from '@glcm/native';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeDicom, encodeNifti, rampVolume } from '../../bindings/node/test/medical.js';
import { encodeTiffPages } from '../../bindings/node/test/tiff.js';
import { createTestApp, multipartBody, uploadImage, type TestApp } from './helpers.js';

const SETTINGS: AnalysisSettings = {
  features: ['Mean', 'Contrast'],
  grayLevels: 8,
  quantization: { method: 'none', min: 0, max: 255, binWidth: 0 },
  distances: [1],
  directions: [0, 45, 90, 135],
  aggregation: 'meanOnly',
  logBase: 'natural',
  score: { enabled: false, age: 40, coefficients: [1.138, -1.814, 1.416, 1.714], profile: 'calibration', intensityMin: 0, intensityMax: 255 },
};

/** Three 4 × 3 pages whose values are 10 × page + pixel index */
const PAGES = [0, 1, 2].map((page) => ({
  width: 4,
  height: 3,
  bitsPerSample: 8 as const,
  samplesPerPixel: 1 as const,
  data: Array.from({ length: 12 }, (_, i) => 10 * page + (i % 7)),
}));

function multipartFiles(files: Array<{ name: string; data: Buffer }>, fields: Record<string, string> = {}) {
  const boundary = `----glcm${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/dicom\r\n\r\n`),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function measure(t: TestApp, request: object): Promise<AnalysisResults> {
  const response = await t.app.inject({ method: 'POST', url: '/api/v1/analyses', payload: request });
  expect(response.statusCode, response.body).toBe(202);
  const info = response.json<AnalysisInfo>();
  await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/events` });
  return (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results` })).json<AnalysisResults>();
}

describe('stacks', () => {
  let t: TestApp;
  let stack: ImageInfo;

  beforeAll(async () => {
    t = await createTestApp({ rawTransferMaxPixels: 1000 });
    const response = await uploadImage(t.app, 'pages.tif', encodeTiffPages(PAGES));
    expect(response.statusCode, response.body).toBe(201);
    stack = response.json<ImageInfo>();
  });

  afterAll(async () => {
    await t.close();
  });

  it('opens every page of a TIFF as a slice', async () => {
    expect(stack).toMatchObject({ width: 4, height: 3, slices: 3, bitDepth: 8, warnings: [] });
    for (const [index, page] of PAGES.entries()) {
      const raw = await t.app.inject({ method: 'GET', url: `/api/v1/images/${stack.imageId}/raw?slice=${index + 1}`, headers: { 'accept-encoding': 'identity' } });
      expect(raw.statusCode).toBe(200);
      expect([...raw.rawPayload]).toEqual(page.data);
      const pixel = await t.app.inject({ method: 'GET', url: `/api/v1/images/${stack.imageId}/pixel?x=3&y=2&slice=${index + 1}` });
      expect(pixel.json().value).toBe(page.data[11]);
    }
    // Slices of one stack have their own ETags; slice 1 is the default
    const first = await t.app.inject({ method: 'GET', url: `/api/v1/images/${stack.imageId}/raw` });
    const second = await t.app.inject({ method: 'GET', url: `/api/v1/images/${stack.imageId}/raw?slice=2` });
    expect(first.headers.etag).not.toBe(second.headers.etag);
    const display = await t.app.inject({ method: 'GET', url: `/api/v1/images/${stack.imageId}/display.png?slice=3` });
    expect(display.statusCode).toBe(200);

    const beyond = await t.app.inject({ method: 'GET', url: `/api/v1/images/${stack.imageId}/raw?slice=4` });
    expect(beyond.statusCode).toBe(400);
    expect(beyond.json().message).toBe('The image has 3 slices; slice 4 does not exist');
  });

  it('measures each ROI on its slice and records the slice', async () => {
    const shape = { type: 'rectangle' as const, x: 0, y: 0, width: 4, height: 3 };
    const stats = await t.app.inject({
      method: 'POST',
      url: `/api/v1/images/${stack.imageId}/roi-stats`,
      payload: { rois: [{ id: 'c', slice: 3, shape }, { id: 'a', shape }, { id: 'b', slice: 2, shape }] },
    });
    const means = stats.json<RoiStatsResponse>().stats.map((statistic) => [statistic.roiId, statistic.mean]);
    const mean = (page: number) => PAGES[page].data.reduce((sum, value) => sum + value, 0) / 12;
    expect(means).toEqual([
      ['c', mean(2)],
      ['a', mean(0)],
      ['b', mean(1)],
    ]);

    const results = await measure(t, {
      imageId: stack.imageId,
      rois: [
        { id: 'r2', name: 'On 2', slice: 2, shape },
        { id: 'r3', name: 'On 3', slice: 3, shape },
      ],
      settings: { ...SETTINGS, quantization: { method: 'fixedBinWidth', min: 0, max: 0, binWidth: 1 }, grayLevels: 32 },
    });
    expect(results.results.map((result) => [result.roiId, result.slice, result.values.Mean.mean])).toEqual([
      ['r2', 2, mean(1)],
      ['r3', 3, mean(2)],
    ]);
    const csv = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${results.analysisId}/results.csv` })).body;
    const header = csv.split('\n').find((line) => line.startsWith('timestamp'))!;
    expect(header).toContain('roiId,slice,status');

    const beyond = await t.app.inject({
      method: 'POST',
      url: '/api/v1/analyses',
      payload: { imageId: stack.imageId, rois: [{ id: 'x', name: 'X', slice: 9, shape }], settings: SETTINGS },
    });
    expect(beyond.statusCode).toBe(400);
  });

  it('selects regions, draws edges and computes feature maps on a slice', async () => {
    const threshold = await t.app.inject({
      method: 'POST',
      url: `/api/v1/images/${stack.imageId}/threshold-rois`,
      payload: { slice: 3, min: 20, max: 30, minPixels: 1, maxRegions: 5 },
    });
    expect(threshold.json().regions[0].pixelCount).toBe(12);
    const none = await t.app.inject({
      method: 'POST',
      url: `/api/v1/images/${stack.imageId}/threshold-rois`,
      payload: { min: 20, max: 30, minPixels: 1, maxRegions: 5 },
    });
    expect(none.json().total).toBe(0);

    const map = await t.app.inject({
      method: 'POST',
      url: '/api/v1/feature-maps',
      payload: {
        imageId: stack.imageId,
        slice: 2,
        settings: { feature: 'Contrast', window: 3, step: 1, grayLevels: 32, quantization: SETTINGS.quantization, distance: 1, directions: [0], logBase: 'natural' },
      },
    });
    expect(map.statusCode, map.body).toBe(202);
    expect(map.json<FeatureMapInfo>().slice).toBe(2);
  });

  it('opens a NIfTI volume as a stack in one orientation', async () => {
    const nifti = encodeNifti({ dimensions: [4, 3, 2, 2], dataType: 'int16', data: rampVolume(4, 3, 2, 2), voxelSize: [0.5, 0.75, 2] });
    const { payload, headers } = multipartBody('ramp.nii', nifti, 'application/octet-stream');
    const volume = (await t.app.inject({ method: 'POST', url: '/api/v1/volumes', payload, headers })).json<VolumeInfo>();
    const response = await t.app.inject({ method: 'POST', url: `/api/v1/volumes/${volume.volumeId}/stack`, payload: { orientation: 'coronal', volume: 1 } });
    expect(response.statusCode, response.body).toBe(201);
    const image = response.json<ImageInfo>();
    expect(image).toMatchObject({
      name: 'ramp.nii [coronal, volume 1]',
      width: 4,
      height: 2,
      slices: 3,
      pixelSpacing: { x: 0.5, y: 2 },
      madeFrom: 'niftiVolume',
    });
    expect(image.windowMin).toBe(volume.windowMin);

    // Every slice equals the single slice the volume gives
    for (let slice = 0; slice < 3; slice += 1) {
      const single = (
        await t.app.inject({ method: 'POST', url: `/api/v1/volumes/${volume.volumeId}/images`, payload: { orientation: 'coronal', slice, volume: 1 } })
      ).json<ImageInfo>();
      const expected = await t.app.inject({ method: 'GET', url: `/api/v1/images/${single.imageId}/raw`, headers: { 'accept-encoding': 'identity' } });
      const actual = await t.app.inject({ method: 'GET', url: `/api/v1/images/${image.imageId}/raw?slice=${slice + 1}`, headers: { 'accept-encoding': 'identity' } });
      expect(actual.rawPayload.equals(expected.rawPayload)).toBe(true);
    }

    // The original is a TIFF that uploads as the same stack
    const original = await t.app.inject({ method: 'GET', url: `/api/v1/images/${image.imageId}/original` });
    const again = (await uploadImage(t.app, 'again.tif', original.rawPayload)).json<ImageInfo>();
    expect(again).toMatchObject({ slices: 3, width: 4, height: 2, sha256: image.sha256 });
  });

  it('opens a DICOM series as a stack ordered along the image normal', async () => {
    const file = (z: number, instance: number, value: number) => ({
      name: `slice-${instance}.dcm`,
      data: encodeDicom({
        rows: 2,
        columns: 2,
        bitsAllocated: 16,
        data: [value, value, value, value],
        modality: 'MR',
        seriesUid: '1.2.3',
        seriesDescription: 'T2 axial',
        instanceNumber: instance,
        position: [0, 0, z],
        orientation: [1, 0, 0, 0, 1, 0],
        pixelSpacing: [0.8, 0.6],
      }),
    });
    const files = [file(10, 1, 300), file(-10, 2, 100), file(0, 3, 200), { name: 'notes.txt', data: Buffer.from('not an image') }];
    const { payload, headers } = multipartFiles(files);
    const response = await t.app.inject({ method: 'POST', url: '/api/v1/images/series', payload, headers });
    expect(response.statusCode, response.body).toBe(201);
    const image = response.json<ImageInfo>();
    expect(image).toMatchObject({ name: 'T2 axial', slices: 3, width: 2, height: 2, pixelSpacing: { x: 0.6, y: 0.8 } });
    expect(image.madeFrom).toBe('dicomSeries');
    // Stored as gray slices: no colour conversion, not even luminance
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/images/${image.imageId}/colour`, payload: { conversion: 'luminance' } })).statusCode).toBe(422);
    expect(image.warnings).toEqual(['1 file is not a DICOM image and was left out']);
    const values = [];
    for (let slice = 1; slice <= 3; slice += 1) {
      values.push((await t.app.inject({ method: 'GET', url: `/api/v1/images/${image.imageId}/pixel?x=0&y=0&slice=${slice}` })).json().value);
    }
    expect(values).toEqual([100, 200, 300]);

    const named = multipartFiles(files.slice(0, 1), { name: 'My series' });
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/images/series', ...named })).json<ImageInfo>().name).toBe('My series');

    const nothing = multipartFiles(files.slice(3));
    const refused = await t.app.inject({ method: 'POST', url: '/api/v1/images/series', ...nothing });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toBe('None of the files is a DICOM image');
  });

  it('refuses stacks above the pixel limit', async () => {
    const limited = await createTestApp({ maxStackPixels: 30 });
    try {
      const response = await uploadImage(limited.app, 'pages.tif', encodeTiffPages(PAGES));
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe('ImageTooLarge');
    } finally {
      await limited.close();
    }
  });

  it('decodes a multi-frame DICOM file as a stack', async () => {
    const frames = encodeDicom({ rows: 1, columns: 2, bitsAllocated: 8, frames: 3, data: [1, 2, 3, 4, 5, 6] });
    const response = await uploadImage(t.app, 'frames.dcm', frames);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<ImageInfo>()).toMatchObject({ slices: 3, width: 2, height: 1, warnings: [] });
    const decoded = await native.decodeImageFile(await writeTemporary(frames));
    expect([...decoded.pixels]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

async function writeTemporary(data: Buffer): Promise<string> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-stack-')), 'file.dcm');
  await fs.writeFile(file, data);
  return file;
}
