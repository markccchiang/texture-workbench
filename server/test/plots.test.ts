import type { ImageInfo, LineProfileResponse, RoiHistogramResponse } from '@glcm/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeTiffPages } from '../../bindings/node/test/tiff.js';
import { createTestApp, encodeTiff, uploadImage, type TestApp } from './helpers.js';

describe('line profiles and ROI histograms', () => {
  let t: TestApp;
  let image: ImageInfo;
  let stack: ImageInfo;

  beforeAll(async () => {
    t = await createTestApp();
    // value = 10 × column + row
    const data = Array.from({ length: 8 * 6 }, (_, i) => 10 * (i % 8) + Math.floor(i / 8));
    image = (await uploadImage(t.app, 'ramp.tif', encodeTiff({ width: 8, height: 6, bitsPerSample: 16, samplesPerPixel: 1, data }))).json<ImageInfo>();
    const page = (value: number) => ({
      width: 4,
      height: 4,
      bitsPerSample: 8 as const,
      samplesPerPixel: 1 as const,
      data: Array.from({ length: 16 }, () => value),
    });
    stack = (await uploadImage(t.app, 'pages.tif', encodeTiffPages([page(5), page(9)]))).json<ImageInfo>();
  });

  afterAll(async () => {
    await t.close();
  });

  const post = (id: string, what: string, payload: object) => t.app.inject({ method: 'POST', url: `/api/v1/images/${id}/${what}`, payload });

  it('samples a line about once per pixel', async () => {
    const response = await post(image.imageId, 'line-profile', { from: { x: 0.5, y: 2.5 }, to: { x: 4.5, y: 2.5 } });
    expect(response.statusCode).toBe(200);
    expect(response.json<LineProfileResponse>()).toEqual({ values: [2, 12, 22, 32, 42], length: 4, step: 1 });

    // Outside the image there is no value
    expect((await post(image.imageId, 'line-profile', { from: { x: 7.5, y: 0.5 }, to: { x: 9.5, y: 0.5 } })).json<LineProfileResponse>().values).toEqual([
      70,
      null,
      null,
    ]);
    // On a slice of a stack
    expect((await post(stack.imageId, 'line-profile', { slice: 2, from: { x: 0, y: 0 }, to: { x: 2, y: 0 } })).json<LineProfileResponse>().values).toEqual([
      9, 9, 9,
    ]);
    expect((await post(stack.imageId, 'line-profile', { slice: 3, from: { x: 0, y: 0 }, to: { x: 2, y: 0 } })).statusCode).toBe(400);
  });

  it('counts the pixels of an ROI in bins over its range', async () => {
    const response = await post(image.imageId, 'roi-histogram', { shape: { type: 'rectangle', x: 0, y: 0, width: 3, height: 2 }, bins: 4 });
    expect(response.statusCode).toBe(200);
    // Values 0, 1, 10, 11, 20, 21: range 22 in bins of width 6
    expect(response.json<RoiHistogramResponse>()).toMatchObject({ pixelCount: 6, min: 0, max: 21, mode: 0, binStart: 0, binWidth: 6, counts: [2, 2, 0, 2] });
    expect(response.json<RoiHistogramResponse>().mean).toBeCloseTo(63 / 6, 12);

    const outside = await post(image.imageId, 'roi-histogram', { shape: { type: 'rectangle', x: 20, y: 20, width: 3, height: 2 } });
    expect(outside.json<RoiHistogramResponse>()).toMatchObject({ pixelCount: 0, min: null, counts: [] });
    expect((await post(stack.imageId, 'roi-histogram', { slice: 2, shape: { type: 'rectangle', x: 0, y: 0, width: 4, height: 4 } })).json()).toMatchObject({
      pixelCount: 16,
      min: 9,
      counts: [16],
    });
    expect((await post(image.imageId, 'roi-histogram', { shape: { type: 'rectangle', x: 0, y: 0, width: 3, height: 2 }, bins: 0 })).statusCode).toBe(400);
  });
});
