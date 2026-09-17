import { createHash } from 'node:crypto';
import type { ImageInfo } from '@glcm/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeTiffPages } from '../../bindings/node/test/tiff.js';
import { createTestApp, encodeTiff, uploadImage, type TestApp } from './helpers.js';

describe('colour conversions', () => {
  let t: TestApp;
  let colour: ImageInfo;
  let gray: ImageInfo;

  // Pixels: red, green, blue, white, and a dark brown
  const RGB = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 90, 60, 30, 128, 128, 128];

  beforeAll(async () => {
    t = await createTestApp();
    colour = (await uploadImage(t.app, 'slide.tif', encodeTiff({ width: 3, height: 2, bitsPerSample: 8, samplesPerPixel: 3, data: RGB }))).json<ImageInfo>();
    gray = (await uploadImage(t.app, 'gray.tif', encodeTiff({ width: 2, height: 1, bitsPerSample: 8, samplesPerPixel: 1, data: [1, 2] }))).json<ImageInfo>();
  });

  afterAll(async () => {
    await t.close();
  });

  const convert = (id: string, conversion: string) => t.app.inject({ method: 'POST', url: `/api/v1/images/${id}/colour`, payload: { conversion } });
  const samples = async (info: ImageInfo) => {
    const raw = (await t.app.inject({ method: 'GET', url: `/api/v1/images/${info.imageId}/raw` })).rawPayload;
    return info.bitDepth === 8 ? [...raw] : Array.from({ length: raw.length / 2 }, (_, i) => raw.readUInt16LE(2 * i));
  };

  it('stores a channel as a new image that names its colour image', async () => {
    expect(colour.sourceChannels).toBe(3);
    const response = await convert(colour.imageId, 'red');
    expect(response.statusCode).toBe(201);
    const red = response.json<ImageInfo>();
    expect(red).toMatchObject({
      name: 'slide.tif [red]',
      bitDepth: 8,
      width: 3,
      height: 2,
      colourSource: { imageId: colour.imageId, conversion: 'red' },
      valueConversion: { scale: 1, offset: 0, unit: '', description: 'Red channel; value = stored value' },
      warnings: ['Colour image converted: Red channel'],
    });
    expect(await samples(red)).toEqual([255, 0, 0, 255, 90, 128]);

    // The original file is a TIFF of the gray pixels, which identifies the image
    const original = (await t.app.inject({ method: 'GET', url: `/api/v1/images/${red.imageId}/original` })).rawPayload;
    expect(createHash('sha256').update(original).digest('hex')).toBe(red.sha256);
    expect(original.length).toBe(red.sizeBytes);

    // Again: the same image; from the converted image: its colour image converted
    expect((await convert(colour.imageId, 'red')).json<ImageInfo>().imageId).toBe(red.imageId);
    const blue = (await convert(red.imageId, 'blue')).json<ImageInfo>();
    expect(blue.colourSource).toEqual({ imageId: colour.imageId, conversion: 'blue' });
    expect(await samples(blue)).toEqual([0, 0, 255, 255, 30, 128]);
    const luminance = await convert(red.imageId, 'luminance');
    expect(luminance.statusCode).toBe(200);
    expect(luminance.json<ImageInfo>().imageId).toBe(colour.imageId);
  });

  it('stores stain densities as 16-bit samples with their scale', async () => {
    const dab = (await convert(colour.imageId, 'dabHdab')).json<ImageInfo>();
    expect(dab.bitDepth).toBe(16);
    expect(dab.valueConversion).toMatchObject({ unit: 'OD', offset: 0 });
    expect(dab.valueConversion!.scale).toBeCloseTo(1.5331459424663996 / 65535, 15);
    // White has no stain
    expect((await samples(dab))[3]).toBe(0);
  });

  it('previews a conversion without storing it', async () => {
    const before = (await t.app.inject({ method: 'GET', url: '/api/v1/images' })).json<{ images: ImageInfo[] }>().images.length;
    const response = await t.app.inject({ method: 'GET', url: `/api/v1/images/${colour.imageId}/colour-preview.png?conversion=green&maxSize=64` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/images' })).json<{ images: ImageInfo[] }>().images.length).toBe(before);
  });

  it('converts every page of a colour TIFF stack', async () => {
    const page = (r: number) => ({ width: 2, height: 1, bitsPerSample: 8 as const, samplesPerPixel: 3 as const, data: [r, 1, 2, r, 3, 4] });
    const stack = (await uploadImage(t.app, 'pages.tif', encodeTiffPages([page(10), page(20)]))).json<ImageInfo>();
    const red = (await convert(stack.imageId, 'red')).json<ImageInfo>();
    expect(red.slices).toBe(2);
    const slice2 = (await t.app.inject({ method: 'GET', url: `/api/v1/images/${red.imageId}/pixel?x=1&y=0&slice=2` })).json<{ value: number }>();
    expect(slice2.value).toBe(20);
  });

  it('refuses gray images, unknown conversions and missing images', async () => {
    expect((await convert(gray.imageId, 'red')).json()).toMatchObject({ error: 'NotColour' });
    expect((await convert(gray.imageId, 'red')).statusCode).toBe(422);
    expect((await convert(colour.imageId, 'purple')).statusCode).toBe(400);
    expect((await convert('img_00000000000000000000000000000000', 'red')).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/images/${gray.imageId}/colour-preview.png?conversion=red` })).statusCode).toBe(422);
  });
});
