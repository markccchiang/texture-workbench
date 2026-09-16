import path from 'node:path';
import type { CatalogResponse } from '@glcm/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLoopbackHost, loadConfig } from '../src/config.js';
import { negotiateEncoding, ZSTD_AVAILABLE } from '../src/encoding.js';
import { createTestApp, type TestApp } from './helpers.js';

describe('system routes', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ maxUploadBytes: 12345 });
  });

  afterAll(async () => {
    await t.close();
  });

  it('reports health', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', coreVersion: '0.1.0', mode: 'local', authentication: 'none' });
  });

  it('serves the feature catalog with upload limits', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/catalog' });
    expect(response.statusCode).toBe(200);
    const catalog = response.json<CatalogResponse>();
    expect(catalog.features).toHaveLength(105);
    expect(catalog.features.find((feature) => feature.id === 'CorrelationIII')).toMatchObject({ nonStandard: true, group: 'other' });
    expect(catalog.presets.map((preset) => preset.id)).toContain('haralick');
    expect(catalog.limits.defaultGrayLevels).toBe(32);
    expect(catalog.uploads).toEqual({
      maxUploadBytes: 12345,
      maxImagePixels: t.config.maxImagePixels,
      rawTransferMaxPixels: t.config.rawTransferMaxPixels,
      displayMaxSize: t.config.displayMaxSize,
    });
  });

  it('answers unknown routes with a JSON 404', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/nothing-here' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'NotFound' });
  });

  it('generates an OpenAPI document for every route', async () => {
    await t.app.ready();
    const spec = t.app.swagger() as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/api/v1/analyses',
      '/api/v1/analyses/{id}',
      '/api/v1/analyses/{id}/events',
      '/api/v1/analyses/{id}/results',
      '/api/v1/analyses/{id}/results.csv',
      '/api/v1/analyses/{id}/results.json',
      '/api/v1/catalog',
      '/api/v1/exports/results',
      '/api/v1/exports/roi-images',
      '/api/v1/feature-maps',
      '/api/v1/feature-maps/{id}',
      '/api/v1/feature-maps/{id}/values',
      '/api/v1/health',
      '/api/v1/images',
      '/api/v1/images/series',
      '/api/v1/images/{id}',
      '/api/v1/images/{id}/brush-roi',
      '/api/v1/images/{id}/combine-rois',
      '/api/v1/images/{id}/display.png',
      '/api/v1/images/{id}/edges.png',
      '/api/v1/images/{id}/gradient-stats',
      '/api/v1/images/{id}/grow-roi',
      '/api/v1/images/{id}/livewire',
      '/api/v1/images/{id}/original',
      '/api/v1/images/{id}/pixel',
      '/api/v1/images/{id}/raw',
      '/api/v1/images/{id}/roi-stats',
      '/api/v1/images/{id}/threshold-rois',
      '/api/v1/images/{id}/wand-roi',
      '/api/v1/samples',
      '/api/v1/samples/file',
      '/api/v1/volumes',
      '/api/v1/volumes/{id}',
      '/api/v1/volumes/{id}/images',
      '/api/v1/volumes/{id}/preview.png',
      '/api/v1/volumes/{id}/stack',
    ]);
    expect(Object.keys(spec.paths['/api/v1/images/{id}']).sort()).toEqual(['delete', 'get']);
  });
});

describe('configuration', () => {
  it('reads GLCM_* variables with defaults', () => {
    const config = loadConfig({ GLCM_PORT: '9000', GLCM_DATA_DIR: '/tmp/glcm-data', GLCM_MAX_UPLOAD_BYTES: '1048576' });
    expect(config).toMatchObject({ host: '127.0.0.1', port: 9000, dataDir: '/tmp/glcm-data', maxUploadBytes: 1048576, displayMaxSize: 4096 });
    const repository = path.resolve(import.meta.dirname, '..', '..');
    expect(config.webDir).toBe(path.join(repository, 'web', 'dist'));
    expect(config.samplesDir).toBe(path.join(repository, 'samples'));
    expect(loadConfig({ GLCM_WEB_DIR: '/srv/web', GLCM_SAMPLES_DIR: '/srv/samples' })).toMatchObject({
      webDir: '/srv/web',
      samplesDir: '/srv/samples',
    });
    expect(() => loadConfig({ GLCM_PORT: 'eighty' })).toThrow(/GLCM_PORT/);
    expect(() => loadConfig({ GLCM_MAX_UPLOAD_BYTES: '0' })).toThrow(/GLCM_MAX_UPLOAD_BYTES/);
  });

  it('recognizes loopback addresses', () => {
    expect(['127.0.0.1', '::1', 'localhost'].every(isLoopbackHost)).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});

describe('content negotiation', () => {
  it('chooses zstd, then gzip, then identity', () => {
    expect(negotiateEncoding(undefined)).toBe('identity');
    expect(negotiateEncoding('br')).toBe('identity');
    expect(negotiateEncoding('gzip, deflate, br')).toBe('gzip');
    expect(negotiateEncoding('gzip, zstd')).toBe(ZSTD_AVAILABLE ? 'zstd' : 'gzip');
    expect(negotiateEncoding('zstd;q=0, gzip;q=0.5')).toBe('gzip');
    expect(negotiateEncoding('gzip;q=0')).toBe('identity');
    expect(negotiateEncoding('*')).toBe(ZSTD_AVAILABLE ? 'zstd' : 'gzip');
  });
});
