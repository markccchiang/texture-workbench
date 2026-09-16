import type { ImageInfo, RoiShapeResult, RoiStatsResponse } from '@glcm/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, encodeTiff, uploadImage, type TestApp } from './helpers.js';

const OUTER = { type: 'rectangle', x: 2, y: 3, width: 20, height: 15 };
const INNER = { type: 'rectangle', x: 8, y: 7, width: 6, height: 5 };

describe('editing ROIs on the pixel grid', () => {
  let t: TestApp;
  let image: ImageInfo;

  beforeAll(async () => {
    t = await createTestApp();
    const upload = await uploadImage(t.app, 'blank.tif', encodeTiff({ width: 40, height: 30, bitsPerSample: 8, samplesPerPixel: 1, data: new Array(1200).fill(0) }));
    expect(upload.statusCode).toBe(201);
    image = upload.json<ImageInfo>();
  });

  afterAll(async () => {
    await t.close();
  });

  const post = (endpoint: string, body: Record<string, unknown>, imageId = image.imageId) =>
    t.app.inject({ method: 'POST', url: `/api/v1/images/${imageId}/${endpoint}`, payload: body });

  /** Pixels of a polygon, counted by roi-stats with the core rasterizer */
  const pixelsOf = async (shape: RoiShapeResult['shape']) => {
    const response = await post('roi-stats', { rois: [{ id: 'p', shape }] });
    return response.json<RoiStatsResponse>().stats[0].pixelCount;
  };

  it('unites and subtracts ROIs', async () => {
    const union = (await post('combine-rois', { operation: 'union', shapes: [OUTER, { type: 'ellipse', cx: 25, cy: 15, rx: 8, ry: 5 }] })).json<RoiShapeResult>();
    expect(union.shape?.type).toBe('polygon');
    expect(await pixelsOf(union.shape)).toBe(union.pixelCount);

    const hole = (await post('combine-rois', { operation: 'subtract', shapes: [OUTER, INNER] })).json<RoiShapeResult>();
    expect(hole).toMatchObject({ pixelCount: 270, boundingBox: { x: 2, y: 3, width: 20, height: 15 } });
    expect(await pixelsOf(hole.shape)).toBe(270);

    expect((await post('combine-rois', { operation: 'subtract', shapes: [INNER, OUTER] })).json()).toEqual({ shape: null, pixelCount: 0, boundingBox: null });
  });

  it('intersects and xors ROIs', async () => {
    const crossing = { type: 'rectangle', x: 10, y: 10, width: 20, height: 10 };
    const both = (await post('combine-rois', { operation: 'intersect', shapes: [OUTER, crossing] })).json<RoiShapeResult>();
    expect(both).toMatchObject({ pixelCount: 96, boundingBox: { x: 10, y: 10, width: 12, height: 8 } });
    expect(await pixelsOf(both.shape)).toBe(96);
    const either = (await post('combine-rois', { operation: 'xor', shapes: [OUTER, crossing] })).json<RoiShapeResult>();
    expect(either.pixelCount).toBe(300 + 200 - 2 * 96);
    expect(await pixelsOf(either.shape)).toBe(either.pixelCount);
    expect((await post('combine-rois', { operation: 'intersect', shapes: [INNER, { type: 'rectangle', x: 30, y: 20, width: 5, height: 5 }] })).json()).toEqual({
      shape: null,
      pixelCount: 0,
      boundingBox: null,
    });
  });

  it('enlarges, shrinks and makes bands, in pixels or millimetres', async () => {
    const enlarged = (await post('grow-roi', { shape: INNER, operation: 'enlarge', distance: 2 })).json<RoiShapeResult>();
    // Distance 2 reaches two pixels out along the edges, and the corner pixels one step out diagonally (√2), not (2, 1) (√5)
    expect(enlarged.pixelCount).toBe(10 * 9 - 4 * 3);
    expect(await pixelsOf(enlarged.shape)).toBe(enlarged.pixelCount);
    const band = (await post('grow-roi', { shape: INNER, operation: 'band', distance: 2 })).json<RoiShapeResult>();
    expect(band.pixelCount).toBe(enlarged.pixelCount - 30);
    expect((await post('grow-roi', { shape: OUTER, operation: 'shrink', distance: 1 })).json()).toMatchObject({ pixelCount: 18 * 13 });
    // With 0.5 mm pixels, 1 mm is two pixels
    const millimetres = (await post('grow-roi', { shape: INNER, operation: 'enlarge', distance: 1, pixelSpacing: { x: 0.5, y: 0.5 } })).json<RoiShapeResult>();
    expect(millimetres).toEqual(enlarged);
    expect((await post('grow-roi', { shape: INNER, operation: 'shrink', distance: 3 })).json()).toEqual({ shape: null, pixelCount: 0, boundingBox: null });
  });

  it('paints and erases brush strokes', async () => {
    const painted = (await post('brush-roi', { shape: null, path: [[5.5, 5.5]], radius: 0.6, erase: false })).json<RoiShapeResult>();
    expect(painted.shape).toEqual({ type: 'polygon', points: [[5, 5], [6, 5], [6, 6], [5, 6]] });

    const erased = (await post('brush-roi', { shape: OUTER, path: [[12, 0], [12, 29]], radius: 1.5, erase: true })).json<RoiShapeResult>();
    // Pixel centres 10.5 to 13.5 lie within 1.5 of x = 12: four columns of 15 pixels
    expect(erased.pixelCount).toBe(300 - 60);
    expect(await pixelsOf(erased.shape)).toBe(erased.pixelCount);
  });

  it('validates requests', async () => {
    expect((await post('combine-rois', { operation: 'union', shapes: [OUTER] })).statusCode).toBe(400);
    expect((await post('combine-rois', { operation: 'and', shapes: [OUTER, INNER] })).statusCode).toBe(400);
    expect((await post('grow-roi', { shape: OUTER, operation: 'enlarge', distance: 0 })).statusCode).toBe(400);
    expect((await post('grow-roi', { shape: OUTER, operation: 'grow', distance: 1 })).statusCode).toBe(400);
    expect((await post('grow-roi', { shape: OUTER, operation: 'band', distance: 1, pixelSpacing: { x: 0, y: 1 } })).statusCode).toBe(400);
    expect((await post('brush-roi', { shape: null, path: [], radius: 2, erase: false })).statusCode).toBe(400);
    expect((await post('brush-roi', { shape: null, path: [[1, 1]], radius: 0, erase: false })).statusCode).toBe(400);
    expect((await post('combine-rois', { operation: 'union', shapes: [OUTER, INNER] }, `img_${'0'.repeat(32)}`)).statusCode).toBe(404);
  });
});
