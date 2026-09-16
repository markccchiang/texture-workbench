import type { ImageInfo, ThresholdRoisResponse, WandRoiResponse } from '@glcm/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, encodeTiff, uploadImage, type TestApp } from './helpers.js';

// A ring with a pixel in its hole, and a diagonal chain of three pixels
const ROWS = ['..........', '.####.....', '.##.#.....', '.#..#.#...', '.####..#..', '........#.', '..........'];

describe('ROIs from pixel values', () => {
  let t: TestApp;
  let image: ImageInfo;

  beforeAll(async () => {
    t = await createTestApp();
    const data = ROWS.flatMap((row) => [...row].map((character) => (character === '#' ? 200 : 10)));
    const upload = await uploadImage(t.app, 'rings.tif', encodeTiff({ width: ROWS[0].length, height: ROWS.length, bitsPerSample: 8, samplesPerPixel: 1, data }));
    expect(upload.statusCode).toBe(201);
    image = upload.json<ImageInfo>();
  });

  afterAll(async () => {
    await t.close();
  });

  const threshold = (body: Record<string, unknown>, imageId = image.imageId) =>
    t.app.inject({ method: 'POST', url: `/api/v1/images/${imageId}/threshold-rois`, payload: body });
  const wand = (body: Record<string, unknown>) => t.app.inject({ method: 'POST', url: `/api/v1/images/${image.imageId}/wand-roi`, payload: body });

  it('outlines the parts in an intensity range, largest first', async () => {
    const response = await threshold({ min: 100, max: 255, minPixels: 1, maxRegions: 10 });
    expect(response.statusCode).toBe(200);
    const { regions, total } = response.json<ThresholdRoisResponse>();
    expect(total).toBe(2);
    expect(regions[0]).toEqual({ points: [[1, 1], [5, 1], [5, 5], [1, 5]], pixelCount: 16, boundingBox: { x: 1, y: 1, width: 4, height: 4 } });
    expect(regions[1].pixelCount).toBe(3);

    expect((await threshold({ min: 100, max: 255, minPixels: 4, maxRegions: 0 })).json()).toEqual({ regions: [], total: 1 });
  });

  it('filters the parts by their largest size and their sphericity', async () => {
    const count = async (filters: Record<string, unknown>) =>
      (await threshold({ min: 100, max: 255, minPixels: 1, maxRegions: 10, ...filters })).json<ThresholdRoisResponse>().regions.map((region) => region.pixelCount);
    expect(await count({ maxPixels: 15 })).toEqual([3]);
    // The filled 4 × 4 ring has a sphericity of about 0.94; the three pixels touching at corners are three small diamonds, about 0.51
    expect(await count({ minSphericity: 0.9 })).toEqual([16]);
    expect(await count({ minSphericity: 0.5 })).toEqual([16, 3]);
    expect((await threshold({ min: 100, max: 255, minPixels: 1, maxRegions: 10, minSphericity: 1.5 })).statusCode).toBe(400);
    expect((await threshold({ min: 100, max: 255, minPixels: 5, maxRegions: 10, maxPixels: 4 })).statusCode).toBe(400);
  });

  it('selects the region around a clicked pixel', async () => {
    const response = await wand({ x: 8, y: 5, tolerance: 0 });
    expect(response.statusCode).toBe(200);
    expect(response.json<WandRoiResponse>().region).toMatchObject({ pixelCount: 3, boundingBox: { x: 6, y: 3, width: 3, height: 3 } });
    expect((await wand({ x: 0, y: 0, tolerance: 190 })).json<WandRoiResponse>().region?.pixelCount).toBe(70);
    expect((await wand({ x: 99, y: 0, tolerance: 0 })).json<WandRoiResponse>().region).toBeNull();
  });

  it('validates requests', async () => {
    expect((await threshold({ min: 200, max: 100, minPixels: 1, maxRegions: 10 })).statusCode).toBe(400);
    expect((await threshold({ min: 0, max: 255, minPixels: 0, maxRegions: 10 })).statusCode).toBe(400);
    expect((await threshold({ min: 0, max: 255, minPixels: 1, maxRegions: 1001 })).statusCode).toBe(400);
    expect((await wand({ x: 0, y: 0, tolerance: -1 })).statusCode).toBe(400);
    expect((await threshold({ min: 0, max: 255, minPixels: 1, maxRegions: 1 }, `img_${'0'.repeat(32)}`)).statusCode).toBe(404);
  });
});
