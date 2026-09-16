// The MCP tools, driven through the protocol with an in-memory transport: what an agent would do.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localClient, type ApiClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';
import { encodeTiffPages } from '../../bindings/node/test/tiff.js';

const SAMPLE = 'sample:textures/brick.png';

let dataDir: string;
let api: ApiClient;
let client: Client;

interface ToolContent {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<ToolContent>;
const textOf = (result: ToolContent) => result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-mcp-test-'));
  api = await localClient({ dataDir });
  const server = createMcpServer({ client: async () => api });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterAll(async () => {
  await client.close();
  await api.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the MCP server', () => {
  it('offers the tools an agent needs, with descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['feature_map', 'list_features', 'list_samples', 'measure', 'open_image', 'select_regions', 'view_image']);
    const measure = tools.find((tool) => tool.name === 'measure')!;
    expect(measure.description).toContain('Without regions the whole image is measured');
    expect(Object.keys(measure.inputSchema.properties ?? {})).toContain('rectangles');
  });

  it('opens an image and describes it', async () => {
    const result = await call('open_image', { image: SAMPLE });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('512 × 512 px, 8-bit');
    expect(textOf(result)).toMatch(/image id: img_[0-9a-f]{32}/);
  });

  it('returns a picture to look at', async () => {
    const result = await call('view_image', { image: SAMPLE });
    const picture = result.content.find((part) => part.type === 'image');
    expect(picture?.mimeType).toBe('image/png');
    const png = Buffer.from(picture!.data!, 'base64');
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');

    const edges = await call('view_image', { image: SAMPLE, kind: 'edges' });
    expect(edges.content.some((part) => part.type === 'image')).toBe(true);
    expect(textOf(edges)).toContain('edge map');
  });

  it('measures rectangles given as numbers', async () => {
    const result = await call('measure', {
      image: SAMPLE,
      rectangles: [
        { name: 'Top left', x: 0, y: 0, width: 128, height: 128 },
        { name: 'Middle', x: 192, y: 192, width: 128, height: 128 },
      ],
      features: ['Contrast', 'Entropy'],
    });
    const text = textOf(result);
    expect(text).toContain('2 measurements');
    expect(text).toContain('Top left');
    expect(text).toContain('Middle');
    expect(text).toContain('Contrast');
    // One row per ROI: the mean over the directions, not four rows each
    expect(text.split('\n').filter((line) => line.startsWith('Top left'))).toHaveLength(1);
  });

  it('selects regions and measures them by their id', async () => {
    const regions = await call('select_regions', { image: SAMPLE, min: 0, max: 110, minPixels: 400, maxRegions: 3 });
    const regionsText = textOf(regions);
    expect(regionsText).toMatch(/kept as "regions_\d+"/);
    expect(regionsText).toContain('Region 1');
    const id = regionsText.match(/"(regions_\d+)"/)![1];

    const file = path.join(dataDir, 'regions.csv');
    const measured = await call('measure', { image: SAMPLE, rois: id, preset: 'basic', saveTo: file });
    expect(textOf(measured)).toContain('Region 1');
    expect(textOf(measured)).toContain(`Written to ${file}`);
    const csv = await fs.readFile(file, 'utf8');
    expect(csv).toContain('# format=glcm-results-csv');
    expect(csv).toContain('Region 1');
  });

  it('saves regions for ImageJ and measures an ImageJ archive', async () => {
    const zip = path.join(dataDir, 'regions-RoiSet.zip');
    await call('select_regions', { image: SAMPLE, min: 0, max: 110, minPixels: 400, maxRegions: 2, saveTo: zip });
    const measured = await call('measure', { image: SAMPLE, rois: zip, preset: 'basic' });
    expect(measured.isError).toBeFalsy();
    expect(textOf(measured)).toContain('Region 2');

    const imagej = path.resolve(import.meta.dirname, '..', '..', 'packages', 'api', 'test', 'data', 'imagej', 'imagej-rois.zip');
    const fromImageJ = textOf(await call('measure', { image: SAMPLE, rois: imagej, preset: 'basic', maxRows: 3 }));
    expect(fromImageJ).toContain('rectangle');
    expect(fromImageJ).toContain('Note: Skipped 4 selections without an area');
  });

  it('shortens a long table and says so', async () => {
    const rectangles = Array.from({ length: 8 }, (_, index) => ({ name: `R${index}`, x: index * 40, y: 0, width: 40, height: 40 }));
    const result = await call('measure', { image: SAMPLE, rectangles, features: ['Contrast'], maxRows: 3 });
    const text = textOf(result);
    expect(text).toContain('8 measurements');
    expect(text).toContain('5 more rows are not shown');
  });

  it('computes a feature map', async () => {
    const result = await call('feature_map', { image: SAMPLE, feature: 'Contrast', window: 15 });
    expect(textOf(result)).toContain('Contrast over brick.png');
    expect(textOf(result)).toMatch(/values \d/);
  });

  it('works on the slices of a stack', async () => {
    const pages = [0, 1].map((page) => ({
      width: 8,
      height: 8,
      bitsPerSample: 8 as const,
      samplesPerPixel: 1 as const,
      data: Array.from({ length: 64 }, (_, i) => 50 * page + (i % 3)),
    }));
    const file = path.join(dataDir, 'two-slices.tif');
    await fs.writeFile(file, encodeTiffPages(pages));
    expect(textOf(await call('open_image', { image: file }))).toContain('8 × 8 px × 2 slices');
    expect(textOf(await call('view_image', { image: file, slice: 2 }))).toContain('slice 2 of 2');

    const whole = textOf(await call('measure', { image: file, features: ['Mean'] }));
    expect(whole).toContain('Whole slice 1 (slice 1)');
    expect(whole).toContain('Whole slice 2 (slice 2)');
    const rectangle = textOf(await call('measure', { image: file, features: ['Mean'], rectangles: [{ name: 'Box', x: 0, y: 0, width: 4, height: 4 }], slice: 2 }));
    expect(rectangle).toContain('Box (slice 2)');
  });

  it('reports a failure as a tool error instead of throwing', async () => {
    const missing = await call('open_image', { image: '/no/such/file.png' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('could not be read');

    const badFeature = await call('measure', { image: SAMPLE, features: ['Nope'] });
    expect(badFeature.isError).toBe(true);
    expect(textOf(badFeature)).toContain('Unknown features: Nope');
  });
});
