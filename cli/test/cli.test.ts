import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResultsDocument, RoiSetDocument } from '@glcm/api';
import { buildApp, type App } from '@glcm/server/app';
import { DEFAULT_CONFIG } from '@glcm/server/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
