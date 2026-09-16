import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResultsDocument, RoiSetDocument } from '@glcm/api';
import { buildApp, type App } from '@glcm/server/app';
import { DEFAULT_CONFIG } from '@glcm/server/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeTiffPages } from '../../bindings/node/test/tiff.js';
import { run } from '../src/main.js';

const REPOSITORY = path.resolve(import.meta.dirname, '..', '..');

let dataDir: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-cli-test-'));
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Runs a command in this process, as a user would from a shell, and collects what it printed */
async function glcm(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...args, '--data-dir', dataDir], { out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const SAMPLE = 'sample:textures/brick.png';

describe('glcm', () => {
  it('lists the features and the presets', async () => {
    const features = await glcm('features');
    expect(features.code).toBe(0);
    expect(features.out).toContain('Contrast');
    expect(features.out).toContain('Maximal Correlation Coefficient');

    const presets = await glcm('features', '--presets', '--json');
    expect(JSON.parse(presets.out).map((preset: { id: string }) => preset.id)).toContain('haralick');
  });

  it('opens an image once and reuses it afterwards', async () => {
    const first = await glcm('info', SAMPLE);
    expect(first.code).toBe(0);
    expect(first.out).toContain('512 × 512 px, 8-bit');
    expect(first.out).toMatch(/img_[0-9a-f]{32}/);

    // The checksum is known now, so the file is not uploaded again
    const again = await glcm('info', SAMPLE);
    expect(again.err).toContain('already had this image');
    expect(again.out).toContain(first.out.match(/img_[0-9a-f]{32}/)![0]);
  });

  it('measures the whole image when no ROIs are given', async () => {
    const file = path.join(dataDir, 'whole.csv');
    const result = await glcm('measure', SAMPLE, '--preset', 'basic', '--out', file);
    expect(result.code).toBe(0);
    expect(result.err).toContain('1 measurement');

    const csv = await fs.readFile(file, 'utf8');
    const [header, ...rows] = csv.split('\n').filter((line) => line && !line.startsWith('#'));
    expect(header).toContain('roiName');
    expect(header).toContain('Contrast');
    // perDirectionAndMean: four directions and their mean
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('Whole image');
  });

  it('selects regions, writes an ROI set and measures it', async () => {
    const roiFile = path.join(dataDir, 'regions.roi.json');
    const regions = await glcm('regions', SAMPLE, '--min', '0', '--max', '110', '--min-pixels', '400', '--max-regions', '3', '--out', roiFile);
    expect(regions.code).toBe(0);
    const document = JSON.parse(await fs.readFile(roiFile, 'utf8')) as RoiSetDocument;
    expect(document.format).toBe('glcm-roi-set');
    expect(document.rois.length).toBeGreaterThan(0);
    expect(document.rois.length).toBeLessThanOrEqual(3);
    expect(document.rois[0].shape.type).toBe('polygon');
    expect(regions.out).toContain('Region 1');

    const measured = await glcm('measure', SAMPLE, '--rois', roiFile, '--features', 'Contrast,Entropy', '--aggregation', 'meanOnly', '--json');
    expect(measured.code).toBe(0);
    const results = JSON.parse(measured.out) as ResultsDocument;
    expect(results.results).toHaveLength(document.rois.length);
    expect(results.results[0].values.Contrast.mean).toBeGreaterThan(0);
    expect(Object.keys(results.results[0].values).sort()).toEqual(['Contrast', 'Entropy']);
  });

  it('filters regions by size and sphericity, and measures shape features in millimetres', async () => {
    const file = path.join(dataDir, 'filtered.roi.json');
    const options = ['--min', '0', '--max', '110', '--min-pixels', '20', '--max-regions', '50'];
    const all = await glcm('regions', SAMPLE, ...options, '--json');
    const filtered = await glcm('regions', SAMPLE, ...options, '--max-pixels', '400', '--min-sphericity', '0.5', '--out', file);
    expect(filtered.code).toBe(0);
    const kept = JSON.parse(await fs.readFile(file, 'utf8')) as RoiSetDocument;
    expect(kept.rois.length).toBeGreaterThan(0);
    expect(kept.rois.length).toBeLessThan((JSON.parse(all.out) as RoiSetDocument).rois.length);
    expect((await glcm('regions', SAMPLE, ...options, '--min-sphericity', '2')).err).toContain('--min-sphericity must be a number from 0 to 1');

    const measured = await glcm('measure', SAMPLE, '--rois', file, '--preset', 'shape', '--spacing', '0.5,0.5', '--aggregation', 'meanOnly', '--json');
    expect(measured.code).toBe(0);
    const results = (JSON.parse(measured.out) as ResultsDocument).results;
    for (const result of results) {
      expect(result.pixelCount).toBeLessThanOrEqual(400);
      expect(result.values.ShapePixelSurface.mean).toBe(result.pixelCount * 0.25);
      expect(result.values.ShapeSphericity.mean).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('measures every slice of a stack, or one, and selects regions on a slice', async () => {
    const pages = [0, 1, 2].map((page) => ({
      width: 16,
      height: 12,
      bitsPerSample: 8 as const,
      samplesPerPixel: 1 as const,
      data: Array.from({ length: 192 }, (_, i) => (page === 2 && i % 16 < 8 ? 200 : 10 * page + (i % 5))),
    }));
    const file = path.join(dataDir, 'stack.tif');
    await fs.writeFile(file, encodeTiffPages(pages));

    const info = await glcm('info', file);
    expect(info.out).toContain('16 × 12 px × 3 slices, 8-bit');

    const every = JSON.parse((await glcm('measure', file, '--features', 'Mean', '--aggregation', 'meanOnly', '--json')).out) as ResultsDocument;
    expect(every.results.map((result) => [result.roiName, result.slice])).toEqual([
      ['Whole slice 1', 1],
      ['Whole slice 2', 2],
      ['Whole slice 3', 3],
    ]);
    const one = JSON.parse((await glcm('measure', file, '--features', 'Mean', '--aggregation', 'meanOnly', '--slice', '2', '--json')).out) as ResultsDocument;
    expect(one.results.map((result) => result.slice)).toEqual([2]);
    expect(one.results[0].values.Mean.mean).toBe(every.results[1].values.Mean.mean);
    expect((await glcm('measure', file, '--slice', '4')).err).toContain('slice 4 does not exist');

    // More slices than one analysis takes ROIs: measured in parts, joined into one table
    const many = path.join(dataDir, 'many.tif');
    const tiny = { width: 2, height: 2, bitsPerSample: 8 as const, samplesPerPixel: 1 as const };
    await fs.writeFile(many, encodeTiffPages(Array.from({ length: 1003 }, (_, page) => ({ ...tiny, data: [page % 200, 1, 2, 3] }))));
    const out = path.join(dataDir, 'many.csv');
    const measuredMany = await glcm('measure', many, '--features', 'Mean', '--aggregation', 'meanOnly', '--out', out);
    expect(measuredMany.code, measuredMany.err).toBe(0);
    const csvLines = (await fs.readFile(out, 'utf8')).split('\n').filter((line) => line && !line.startsWith('#'));
    expect(csvLines).toHaveLength(1 + 1003);
    expect(csvLines.at(-1)).toContain('Whole slice 1003');

    const roiFile = path.join(dataDir, 'stack-regions.roi.json');
    const regions = await glcm('regions', file, '--slice', '3', '--min', '150', '--max', '255', '--min-pixels', '10', '--out', roiFile);
    expect(regions.code).toBe(0);
    const set = JSON.parse(await fs.readFile(roiFile, 'utf8')) as RoiSetDocument;
    expect(set.image?.slices).toBe(3);
    expect(set.rois.map((roi) => roi.slice)).toEqual([3]);
    const measured = JSON.parse((await glcm('measure', file, '--rois', roiFile, '--features', 'Mean', '--aggregation', 'meanOnly', '--json')).out) as ResultsDocument;
    expect(measured.results[0]).toMatchObject({ slice: 3, pixelCount: 96 });
    expect(measured.results[0].values.Mean.mean).toBe(200);
  });

  it('measures the Laplacian of Gaussian with --log-sigma', async () => {
    const measure = async (...options: string[]) => glcm('measure', SAMPLE, '--features', 'Mean,Median', '--aggregation', 'meanOnly', '--json', ...options);
    const filtered = await measure('--log-sigma', '2', '--quantization', 'fixedBinWidth,25');
    expect(filtered.code).toBe(0);
    const document = JSON.parse(filtered.out) as ResultsDocument;
    expect(document.settings.filter).toEqual({ type: 'laplacianOfGaussian', sigma: 2 });
    expect(document.results[0].status).toBe('ok');

    const refused = await measure('--log-sigma', '2');
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('choose the quantization Fixed bin width or ROI min–max');
    expect((await measure('--log-sigma', '0')).err).toContain('--log-sigma takes the sigma');

    const wavelet = await measure('--wavelet', 'hl', '--quantization', 'roiMinMax');
    expect(wavelet.code).toBe(0);
    const waveletDocument = JSON.parse(wavelet.out) as ResultsDocument;
    expect(waveletDocument.settings.filter).toEqual({ type: 'wavelet', band: 'HL' });
    expect(waveletDocument.results[0].status).toBe('ok');
    expect((await measure('--wavelet', 'LX')).err).toContain('--wavelet takes the sub-band');
    expect((await measure('--wavelet', 'LL', '--log-sigma', '1')).err).toContain('Choose one filter');
  });

  it('resamples before measuring when asked, with a pixel spacing', async () => {
    const measure = async (...options: string[]) => glcm('measure', SAMPLE, '--features', 'Mean', '--aggregation', 'meanOnly', '--json', ...options);
    const plain = JSON.parse((await measure('--spacing', '1,1')).out) as ResultsDocument;
    const resampled = JSON.parse((await measure('--spacing', '1,1', '--resample', '0.5,0.5')).out) as ResultsDocument;
    expect(resampled.settings.resampling).toEqual({ x: 0.5, y: 0.5 });
    expect(resampled.results[0].pixelCount).toBe(plain.results[0].pixelCount * 4);

    // The sample has no pixel spacing of its own
    const refused = await measure('--resample', '0.5,0.5');
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('Resampling needs a pixel spacing');
    expect((await measure('--spacing', '1,1', '--resample', '0.5')).err).toContain('--resample takes the new pixel width and height');
  });

  it('writes regions for ImageJ and measures ImageJ ROI files the same way', async () => {
    const json = path.join(dataDir, 'imagej-regions.roi.json');
    const zip = path.join(dataDir, 'RoiSet.zip');
    const options = ['--min', '0', '--max', '110', '--min-pixels', '400', '--max-regions', '3'];
    expect((await glcm('regions', SAMPLE, ...options, '--out', json)).code).toBe(0);
    const written = await glcm('regions', SAMPLE, ...options, '--out', zip);
    expect(written.code).toBe(0);
    expect(written.err).toContain(`Wrote ${zip}`);
    expect((await fs.readFile(zip)).subarray(0, 2).toString()).toBe('PK');

    // The same pixels from either file
    const measure = async (file: string) => JSON.parse((await glcm('measure', SAMPLE, '--rois', file, '--features', 'Contrast', '--aggregation', 'meanOnly', '--json')).out) as ResultsDocument;
    const [fromJson, fromZip] = await Promise.all([measure(json), measure(zip)]);
    expect(fromZip.results.map((result) => [result.roiName, result.pixelCount])).toEqual(fromJson.results.map((result) => [result.roiName, result.pixelCount]));

    // ImageJ's own archive, with lines and points it leaves out
    const imagej = path.join(REPOSITORY, 'packages', 'api', 'test', 'data', 'imagej', 'imagej-rois.zip');
    const fromImageJ = await glcm('measure', SAMPLE, '--rois', imagej, '--features', 'Contrast', '--aggregation', 'meanOnly', '--json');
    expect(fromImageJ.code).toBe(0);
    expect(fromImageJ.err).toContain('warning: Skipped 4 selections without an area');
    expect((JSON.parse(fromImageJ.out) as ResultsDocument).results.find((result) => result.roiName === 'rectangle')?.pixelCount).toBe(41 * 17);

    const refused = await glcm('regions', SAMPLE, ...options, '--out', path.join(dataDir, 'one.roi'));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('written as a RoiSet.zip archive');
  });

  it('writes a feature map as a 32-bit TIFF', async () => {
    const file = path.join(dataDir, 'map.tif');
    const result = await glcm('feature-map', SAMPLE, '--feature', 'Contrast', '--window', '15', '--step', '16', '--out', file);
    expect(result.code).toBe(0);
    expect(result.out).toContain('32 × 32 points, step 16 px');
    expect(result.out).toMatch(/Values\s+0/);

    const tiff = await fs.readFile(file);
    expect(tiff.subarray(0, 4)).toEqual(Buffer.from([0x49, 0x49, 42, 0])); // little-endian TIFF
    expect(tiff.length).toBeGreaterThan(32 * 32 * 4);
  });

  it('refuses what it cannot do, with the reason and a usage exit code', async () => {
    expect((await glcm('nonsense')).code).toBe(2);
    expect((await glcm('measure')).code).toBe(2);
    expect((await glcm('measure', SAMPLE, '--preset', 'nope')).err).toContain('There is no preset "nope"');
    expect((await glcm('measure', SAMPLE, '--features', 'Nope')).err).toContain('Unknown features: Nope');

    const tooMany = await glcm('measure', SAMPLE, '--gray-levels', '1000');
    expect(tooMany.code).toBe(2);
    expect(tooMany.err).toContain('Gray levels must be an integer');

    const unknownOption = await glcm('features', '--nope');
    expect(unknownOption.code).toBe(2);
    expect(unknownOption.out).toContain('Usage: glcm features');
  });

  it('prints help for the tool and for one command', async () => {
    const help = await glcm('help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('glcm <command> [options]');
    expect(help.out).toContain('mcp');

    const command = await glcm('measure', '--help');
    expect(command.out).toContain('Usage: glcm measure');
    expect(command.out).toContain('Without --rois the whole image is measured');

    // Not the server itself, which would wait on standard input
    const mcp = await glcm('mcp', '--help');
    expect(mcp.code).toBe(0);
    expect(mcp.out).toContain('Usage: glcm mcp');
  });
});

describe('glcm and a data directory in use', () => {
  it('refuses to build a second server on it, and says where to send the command', async () => {
    const busy = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-cli-busy-'));
    try {
      // What the server writes while it runs; this process is alive, so the lock counts
      await fs.writeFile(
        path.join(busy, 'server.lock'),
        JSON.stringify({ pid: process.pid, host: '0.0.0.0', port: 8080, startedAt: new Date().toISOString() }),
      );
      const err: string[] = [];
      const code = await run(['features', '--data-dir', busy], { out: () => undefined, err: (text) => err.push(text) });
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('--server http://127.0.0.1:8080');

      // A lock left behind by a process that is gone says nothing
      await fs.writeFile(path.join(busy, 'server.lock'), JSON.stringify({ pid: 0x7ffffffe, host: '127.0.0.1', port: 8080, startedAt: '' }));
      const stale: string[] = [];
      expect(await run(['features', '--data-dir', busy], { out: (text) => stale.push(text), err: () => undefined })).toBe(0);
      expect(stale.join('\n')).toContain('Contrast');
    } finally {
      await fs.rm(busy, { recursive: true, force: true });
    }
  });
});

describe('glcm against a running server', () => {
  // A token of the length the server insists on
  const TOKEN = 'p'.repeat(43);
  let app: App;
  let serverDataDir: string;
  let baseUrl: string;

  beforeAll(async () => {
    serverDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-cli-server-'));
    app = await buildApp(
      {
        ...DEFAULT_CONFIG,
        dataDir: serverDataDir,
        samplesDir: path.join(REPOSITORY, 'samples'),
        webDir: null,
        docsDir: null,
        apiToken: TOKEN,
        logLevel: 'silent',
      },
      { logger: false },
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(serverDataDir, { recursive: true, force: true });
  });

  /** The same commands, but over HTTP instead of in this process */
  async function remote(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run([...args, '--server', baseUrl, '--token', TOKEN], { out: (text) => out.push(text), err: (text) => err.push(text) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('measures over HTTP, and the image lands in the server\'s own store', async () => {
    const features = await remote('features', '--json');
    expect(features.code).toBe(0);
    expect(JSON.parse(features.out).length).toBeGreaterThan(50);

    const measured = await remote('measure', SAMPLE, '--features', 'Contrast', '--aggregation', 'meanOnly', '--json');
    expect(measured.code).toBe(0);
    const results = JSON.parse(measured.out) as ResultsDocument;
    expect(results.results).toHaveLength(1);
    expect(results.results[0].values.Contrast.mean).toBeGreaterThan(0);

    // The upload went to the server that is listening, not to the local folder
    const stored = await app.inject({ method: 'GET', url: '/api/v1/images', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(stored.json<{ images: unknown[] }>().images).toHaveLength(1);
  });

  it('says what is wrong when the token is missing or wrong', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['features', '--server', baseUrl, '--token', 'wrong'], { out: (t) => out.push(t), err: (t) => err.push(t) });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('the server needs an access token. Pass --token');
  });

  it('says so when no server answers', async () => {
    const err: string[] = [];
    // Port 1 is never open to us
    const code = await run(['features', '--server', 'http://127.0.0.1:1'], { out: () => undefined, err: (text) => err.push(text) });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('could not be reached');
  });
});
