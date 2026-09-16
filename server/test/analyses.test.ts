import type { AnalysisEvent, AnalysisInfo, AnalysisRequest, AnalysisResults, AnalysisSettings, ImageInfo, RoiStatsResponse } from '@glcm/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobLimitError, JobManager, type AnalysisState } from '../src/analysis/JobManager.js';
import { createTestApp, encodeTiff, uploadImage, type TestApp } from './helpers.js';

// Haralick, Shanmugam and Dinstein (1973), figure 2
const HARALICK = [0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 3, 3];

const SETTINGS: AnalysisSettings = {
  features: ['Mean', 'Contrast'],
  grayLevels: 4,
  quantization: { method: 'none', min: 0, max: 255, binWidth: 0 },
  distances: [1],
  directions: [0, 45, 90, 135],
  aggregation: 'perDirectionAndMean',
  logBase: 'natural',
  score: { enabled: false, age: 40, coefficients: [1.138, -1.814, 1.416, 1.714], profile: 'calibration', intensityMin: 0, intensityMax: 255 },
};

const WHOLE = { id: 'whole', name: 'Whole', shape: { type: 'rectangle' as const, x: 0, y: 0, width: 4, height: 4 } };
const TOP_LEFT = { id: 'top-left', name: 'Top left', shape: { type: 'rectangle' as const, x: 0, y: 0, width: 2, height: 2 } };

interface ParsedEvent {
  event: string;
  data: unknown;
}

function parseEvents(body: string): ParsedEvent[] {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
    });
}

async function setup(concurrency: number): Promise<{ t: TestApp; image: ImageInfo }> {
  const t = await createTestApp({ analysisConcurrency: concurrency });
  const upload = await uploadImage(t.app, 'haralick.tif', encodeTiff({ width: 4, height: 4, bitsPerSample: 8, samplesPerPixel: 1, data: HARALICK }));
  expect(upload.statusCode).toBe(201);
  return { t, image: upload.json<ImageInfo>() };
}

describe('ROI statistics', () => {
  let t: TestApp;
  let image: ImageInfo;

  beforeAll(async () => {
    ({ t, image } = await setup(2));
  });

  afterAll(async () => {
    await t.close();
  });

  it('counts pixels with the core rasterizer', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/images/${image.imageId}/roi-stats`,
      payload: {
        rois: [
          { id: 'a', shape: TOP_LEFT.shape },
          { id: 'b', shape: { type: 'ellipse', cx: 2, cy: 2, rx: 1, ry: 1 } },
          { id: 'c', shape: { type: 'polygon', points: [[0, 0], [4, 0], [0, 4]] } },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const { stats } = response.json<RoiStatsResponse>();
    expect(stats.map((s) => [s.roiId, s.pixelCount])).toEqual([
      ['a', 4],
      ['b', 4],
      ['c', 6],
    ]);
    expect(stats[0]).toMatchObject({ boundingBox: { x: 0, y: 0, width: 2, height: 2 }, min: 0, max: 0, mean: 0 });
  });

  it('validates the request', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: `/api/v1/images/${image.imageId}/roi-stats`,
      payload: { rois: [{ id: 'a', shape: { type: 'circle', r: 3 } }] },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await t.app.inject({ method: 'POST', url: `/api/v1/images/img_${'0'.repeat(32)}/roi-stats`, payload: { rois: [] } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('analyses', () => {
  let t: TestApp;
  let image: ImageInfo;

  beforeAll(async () => {
    ({ t, image } = await setup(3));
  });

  afterAll(async () => {
    await t.close();
  });

  const start = (request: Partial<AnalysisRequest>) =>
    t.app.inject({ method: 'POST', url: '/api/v1/analyses', payload: { imageId: image.imageId, rois: [WHOLE], settings: SETTINGS, ...request } });

  it('streams results and reproduces the core values', async () => {
    const response = await start({ rois: [WHOLE, TOP_LEFT], settings: { ...SETTINGS, distances: [1, 2] } });
    expect(response.statusCode).toBe(202);
    const info = response.json<AnalysisInfo>();
    expect(info).toMatchObject({ imageId: image.imageId, imageName: 'haralick.tif', total: 4, coreVersion: '0.1.0' });
    expect(info.analysisId).toMatch(/^ana_[0-9a-f]{32}$/);

    // The stream ends after the "finished" event
    const stream = await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/events` });
    expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const events = parseEvents(stream.body);
    expect(events.filter((e) => e.event === 'result')).toHaveLength(4);
    expect(events.at(-1)).toEqual({ event: 'finished', data: { status: 'completed', completed: 4, total: 4, error: null } });

    const status = await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}` });
    expect(status.json<AnalysisInfo>()).toMatchObject({ status: 'completed', completed: 4 });

    const results = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results` })).json<AnalysisResults>();
    expect(results).toMatchObject({ format: 'glcm-results', version: 1, status: 'completed', image: { name: 'haralick.tif', sha256: image.sha256 } });
    expect(results.results.map((r) => [r.roiId, r.distance])).toEqual([
      ['whole', 1],
      ['whole', 2],
      ['top-left', 1],
      ['top-left', 2],
    ]);
    const whole = results.results[0];
    expect(whole.status).toBe('ok');
    expect(whole.values.Contrast['0']).toBeCloseTo(14 / 24, 12);
    expect(whole.values.Contrast['90']).toBeCloseTo(1, 12);
    expect(whole.values.Mean.mean).toBe(1.25);
    // A constant 2 × 2 region has no contrast
    expect(results.results[2].values.Contrast.mean).toBe(0);
  });

  it('keeps the pixel spacing of the request and writes ROI areas into the results files', async () => {
    const spacing = { x: 0.5, y: 0.25 };
    const response = await start({ pixelSpacing: spacing });
    expect(response.statusCode).toBe(202);
    const info = response.json<AnalysisInfo>();
    expect(info.pixelSpacing).toEqual(spacing);
    await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/events` });

    const results = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results` })).json<AnalysisResults>();
    expect(results.image.pixelSpacing).toEqual(spacing);
    const csv = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results.csv` })).body;
    expect(csv).toContain('# pixelSpacingMm=0.5;0.25');
    const [header, first] = csv.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    const columns = header.split(',');
    const area = columns.indexOf('areaMm2');
    const pixels = columns.indexOf('pixelCount');
    expect(area).toBe(pixels + 1);
    // Both columns come before the first quoted field, so splitting on commas is safe here
    expect(Number(first.split(',')[area])).toBe(Number(first.split(',')[pixels]) * 0.5 * 0.25);

    // Without one in the request, the image's own: none for this TIFF
    const plain = (await start({})).json<AnalysisInfo>();
    expect(plain.pixelSpacing).toBeNull();
    await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${plain.analysisId}/events` });
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${plain.analysisId}/results.csv` })).body).not.toContain('areaMm2');

    expect((await start({ pixelSpacing: { x: 0, y: 1 } })).statusCode).toBe(400);
  });

  it('resamples the image to another pixel spacing before measuring, and records it in the results', async () => {
    // The 4 × 4 image at 0.5 × 0.25 mm, resampled to 0.25 mm square pixels: 8 × 4 pixels
    const settings = { ...SETTINGS, features: ['ShapePixelSurface', 'Mean'], aggregation: 'meanOnly' as const, resampling: { x: 0.25, y: 0.25 } };
    const response = await start({ settings, pixelSpacing: { x: 0.5, y: 0.25 } });
    expect(response.statusCode).toBe(202);
    const info = response.json<AnalysisInfo>();
    await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/events` });
    const results = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results` })).json<AnalysisResults>();
    expect(results.settings.resampling).toEqual({ x: 0.25, y: 0.25 });
    const [whole] = results.results;
    expect(whole.pixelCount).toBe(32);
    expect(whole.values.ShapePixelSurface.mean).toBe(32 * 0.0625);
    const csv = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results.csv` })).body;
    expect(csv).toContain('# pixelSpacingMm=0.5;0.25');
    expect(csv).toContain('# resampledPixelSpacingMm=0.25;0.25');
    const [header, first] = csv.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    // The area comes from the resampled pixels: 32 × 0.25 × 0.25 mm², the same 2 mm² as the image's 16 pixels
    expect(Number(first.split(',')[header.split(',').indexOf('areaMm2')])).toBe(2);

    // This TIFF has no pixel spacing, so resampling needs one in the request
    const refused = await start({ settings });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain("Resampling needs the image's pixel spacing");
    expect((await start({ settings: { ...settings, resampling: { x: 0, y: 1 } }, pixelSpacing: { x: 1, y: 1 } })).statusCode).toBe(400);
  });

  it('measures the Laplacian of Gaussian of the image when the settings ask for it', async () => {
    const settings = {
      ...SETTINGS,
      features: ['Mean', 'Median'],
      aggregation: 'meanOnly' as const,
      quantization: { method: 'fixedBinWidth' as const, min: 0, max: 0, binWidth: 1 },
      filter: { type: 'laplacianOfGaussian' as const, sigma: 1 },
    };
    const response = await start({ settings });
    expect(response.statusCode).toBe(202);
    const info = response.json<AnalysisInfo>();
    await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/events` });
    const results = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results` })).json<AnalysisResults>();
    const [whole] = results.results;
    expect(whole.status).toBe('ok');
    expect(results.settings.filter).toEqual({ type: 'laplacianOfGaussian', sigma: 1 });
    // Filtered values are real: the mean is no longer the image's 1.25, the range tops out at the largest real value, and
    // with a bin width of 1 the bins start at the whole number below the smallest value, as PyRadiomics aligns them
    expect(whole.values.Mean.mean).not.toBe(1.25);
    expect(Number.isInteger(whole.quantization.upper)).toBe(false);
    expect(Number.isInteger(whole.quantization.lower)).toBe(true);
    const csv = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results.csv` })).body;
    expect(csv).toContain('# filter=laplacianOfGaussian;sigma=1');

    // A fixed range assumes whole intensities
    const refused = await start({ settings: { ...settings, quantization: SETTINGS.quantization } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain('fixed bin width or ROI min-max');
  });

  it('measures a wavelet sub-band of the image when the settings ask for it', async () => {
    const settings = {
      ...SETTINGS,
      features: ['Mean'],
      aggregation: 'meanOnly' as const,
      quantization: { method: 'roiMinMax' as const, min: 0, max: 0, binWidth: 1 },
      filter: { type: 'wavelet' as const, band: 'LL' as const },
    };
    const response = await start({ settings });
    expect(response.statusCode).toBe(202);
    const info = response.json<AnalysisInfo>();
    await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/events` });
    const results = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results` })).json<AnalysisResults>();
    expect(results.results[0].status).toBe('ok');
    expect(results.settings.filter).toEqual({ type: 'wavelet', band: 'LL' });
    const csv = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results.csv` })).body;
    expect(csv).toContain('# filter=wavelet;wavelet=coif1;band=LL');
    expect((await start({ settings: { ...settings, filter: { type: 'wavelet', band: 'XY' } } as never })).statusCode).toBe(400);
  });

  it('measures shape features in millimetres with the pixel spacing of the request', async () => {
    const settings = { ...SETTINGS, features: ['ShapePixelSurface'], aggregation: 'meanOnly' as const };
    const surface = async (request: Partial<AnalysisRequest>) => {
      const info = (await start({ settings, ...request })).json<AnalysisInfo>();
      await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/events` });
      const results = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${info.analysisId}/results` })).json<AnalysisResults>();
      return results.results[0].values.ShapePixelSurface.mean;
    };
    // The 4 × 4 image: 16 pixels, or 16 × 0.5 × 0.25 mm²
    expect(await surface({})).toBe(16);
    expect(await surface({ pixelSpacing: { x: 0.5, y: 0.25 } })).toBe(2);
  });

  it('computes the calibration score', async () => {
    const response = await start({ settings: { ...SETTINGS, score: { ...SETTINGS.score, enabled: true } } });
    const { analysisId } = response.json<AnalysisInfo>();
    await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${analysisId}/events` });
    const [result] = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${analysisId}/results` })).json<AnalysisResults>().results;
    expect(result.score?.mean).toEqual(expect.any(Number));
  });

  it('rejects invalid requests before starting', async () => {
    const unknownFeature = await start({ settings: { ...SETTINGS, features: ['NoSuchFeature'] } });
    expect(unknownFeature.statusCode).toBe(400);
    expect(unknownFeature.json().message).toContain('NoSuchFeature');

    const schema = await start({ settings: { ...SETTINGS, grayLevels: 1000 } });
    expect(schema.statusCode).toBe(400);

    const noRois = await start({ rois: [] });
    expect(noRois.statusCode).toBe(400);

    const missingImage = await start({ imageId: `img_${'1'.repeat(32)}` });
    expect(missingImage.statusCode).toBe(404);

    const unknown = await t.app.inject({ method: 'GET', url: `/api/v1/analyses/ana_${'2'.repeat(32)}` });
    expect(unknown.statusCode).toBe(404);
  });

  it('reports a failed job without stopping the others', async () => {
    // Quantization "none" with Ng = 2 fails for pixel values 2 and 3
    const response = await start({ rois: [WHOLE, TOP_LEFT], settings: { ...SETTINGS, grayLevels: 2 } });
    const { analysisId } = response.json<AnalysisInfo>();
    await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${analysisId}/events` });
    const { results } = (await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${analysisId}/results` })).json<AnalysisResults>();
    expect(results.map((r) => r.status)).toEqual(['failed', 'ok']);
    expect(results[0].error).not.toBe('');
  });
});

describe('cancellation', () => {
  it('drops queued jobs', async () => {
    const { t, image } = await setup(1);
    try {
      const rois = Array.from({ length: 30 }, (_, i) => ({ ...WHOLE, id: `r${i}`, name: `ROI ${i}` }));
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/analyses',
        payload: { imageId: image.imageId, rois, settings: { ...SETTINGS, distances: [1, 2, 3] } },
      });
      const { analysisId, total } = response.json<AnalysisInfo>();
      expect(total).toBe(90);

      const cancel = await t.app.inject({ method: 'DELETE', url: `/api/v1/analyses/${analysisId}` });
      expect(cancel.statusCode).toBe(204);
      expect(cancel.body).toBe('');

      const events = parseEvents((await t.app.inject({ method: 'GET', url: `/api/v1/analyses/${analysisId}/events` })).body);
      const finished = events.at(-1)!;
      expect(finished.event).toBe('finished');
      expect(finished.data).toMatchObject({ status: 'cancelled', total: 90 });
      expect((finished.data as { completed: number }).completed).toBeLessThan(90);

      const again = await t.app.inject({ method: 'DELETE', url: `/api/v1/analyses/${analysisId}` });
      expect(again.statusCode).toBe(204);
    } finally {
      await t.close();
    }
  });
});

describe('job limits and fairness', () => {
  let t: TestApp;
  let image: ImageInfo;
  const pixels = Buffer.from(HARALICK);

  const request = (count: number, prefix = 'roi', imageId = image.imageId): AnalysisRequest => ({
    imageId,
    rois: Array.from({ length: count }, (_, i) => ({ ...WHOLE, id: `${prefix}-${i}`, name: `${prefix} ${i}` })),
    settings: SETTINGS,
  });

  function startError(manager: JobManager, body: AnalysisRequest): unknown {
    try {
      manager.start(body, image, pixels);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  function finished(state: AnalysisState): Promise<void> {
    return new Promise((resolve) => {
      state.events.on('event', (event: AnalysisEvent) => {
        if (event.event === 'finished') {
          resolve();
        }
      });
    });
  }

  beforeAll(async () => {
    ({ t, image } = await setup(1));
  });

  afterAll(async () => {
    await t.close();
  });

  it('refuses analyses that do not fit into the job limit', async () => {
    const manager = new JobManager({ concurrency: 1, maxPendingJobs: 3, retainFinished: 10 });
    const first = manager.start(request(3), image, pixels);
    expect(manager.pendingJobs).toBe(3);

    const busy = startError(manager, request(1));
    expect(busy).toBeInstanceOf(JobLimitError);
    expect(busy).toMatchObject({ reason: 'busy', jobs: 1, pending: 3, limit: 3 });
    expect(startError(manager, request(4))).toMatchObject({ reason: 'tooLarge', jobs: 4, limit: 3 });

    await finished(first);
    expect(manager.pendingJobs).toBe(0);
    const again = manager.start(request(3), image, pixels);
    await finished(again);
  });

  it('lets analyses take turns', async () => {
    const manager = new JobManager({ concurrency: 1, maxPendingJobs: 100, retainFinished: 10 });
    const large = manager.start(request(6, 'large'), image, pixels);
    const small = manager.start(request(2, 'small'), image, pixels);
    const order: string[] = [];
    for (const [label, state] of [['L', large], ['S', small]] as const) {
      state.events.on('event', (event: AnalysisEvent) => {
        if (event.event === 'result') {
          order.push(label);
        }
      });
    }
    await Promise.all([finished(large), finished(small)]);
    // The first two jobs of the large analysis were started before the small one arrived; then they alternate
    expect(order.join('')).toBe('LLSLSLLL');
    expect(manager.results(small).results.map((result) => result.status)).toEqual(['ok', 'ok']);
  });

  it('lets flush() wait for the results of finished analyses to be stored', async () => {
    let stored = false;
    const manager = new JobManager({
      concurrency: 1,
      maxPendingJobs: 10,
      retainFinished: 10,
      onFinished: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        stored = true;
      },
    });
    const state = manager.start(request(1), image, pixels);
    await finished(state);
    expect(stored).toBe(false);
    await manager.flush();
    expect(stored).toBe(true);
    await manager.flush();
  });

  it('refuses an analysis with more jobs than the server allows', async () => {
    const limited = await createTestApp({ maxPendingJobs: 2 });
    try {
      const upload = await uploadImage(limited.app, 'haralick.tif', encodeTiff({ width: 4, height: 4, bitsPerSample: 8, samplesPerPixel: 1, data: HARALICK }));
      const response = await limited.app.inject({ method: 'POST', url: '/api/v1/analyses', payload: request(3, 'roi', upload.json<ImageInfo>().imageId) });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: 'TooManyJobs' });
    } finally {
      await limited.close();
    }
  });
});
