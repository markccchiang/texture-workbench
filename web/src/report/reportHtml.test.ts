import { describe, expect, it } from 'vitest';
import { buildReportHtml, DEFAULT_SECTIONS, escapeHtml, EMPTY_ASSETS, reportFileName, settingsRows } from './reportHtml';
import { FEATURES, IMAGE_INFO, measurement, rowsOf, run, SETTINGS } from './reportFixtures';
import { buildReportModel, type ReportModel } from './reportModel';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function model(overrides: Partial<Parameters<typeof buildReportModel>[0]> = {}): ReportModel {
  const runs = [run('ana1', 'camera.png', [measurement('r1', 'Tumour', { roiClass: 'lesion' }), measurement('r2', 'Muscle')])];
  return buildReportModel({
    runs,
    rows: rowsOf(runs),
    features: FEATURES,
    openImage: { info: IMAGE_INFO, rois: [] },
    title: 'Pancreas study',
    notes: 'Two ROIs on one slice.',
    createdAt: '2026-09-16T12:00:00.000Z',
    coreVersion: '0.1.0',
    ...overrides,
  });
}

const assets = (key: string) => ({ images: { [key]: PNG }, charts: { [key]: ['<svg id="chart"></svg>', '<svg id="chart2"></svg>'] } });

describe('report HTML', () => {
  it('is one self-contained document with every section', () => {
    const report = model();
    const html = buildReportHtml(report, DEFAULT_SECTIONS, assets(report.images[0].key));

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Pancreas study</title>');
    expect(html).toContain('Two ROIs on one slice.');
    expect(html).toContain('core 0.1.0');
    // Image, ROIs, settings, results and charts
    expect(html).toContain(`<img src="${PNG}"`);
    expect(html).toContain('Tumour');
    expect(html).toContain('lesion');
    expect(html).toContain('Gray levels');
    expect(html).toContain('<td class="num">2.5</td>');
    expect(html).toContain('<svg id="chart"></svg>');
    expect(html).toContain('@media print');
    expect(html).toContain('camera.png-sha');

    // Nothing is loaded from the network
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/<script\s+src=/);
    expect(html).not.toContain('@import');
    expect(html).not.toMatch(/<link\b/);
  });

  it('leaves out the sections that are switched off', () => {
    const report = model();
    const html = buildReportHtml(report, { image: false, rois: false, settings: false, results: true, charts: false }, assets(report.images[0].key));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('Gray levels');
    expect(html).not.toContain('<h3>ROIs');
    expect(html).toContain('<h3>Results (2 rows)</h3>');
    // The image facts stay: they say what was measured
    expect(html).toContain('camera.png-sha');
  });

  it('escapes everything that comes from the user or the files', () => {
    const runs = [run('ana1', '<img src=x onerror=alert(1)>.png', [measurement('r1', '</td><script>alert(2)</script>')])];
    const report = buildReportModel({
      runs,
      rows: rowsOf(runs),
      features: FEATURES,
      openImage: null,
      title: '<script>alert(3)</script>',
      notes: 'a & b < c',
      createdAt: '2026-09-16T12:00:00.000Z',
      coreVersion: '0.1.0',
    });
    const html = buildReportHtml(report, DEFAULT_SECTIONS, EMPTY_ASSETS);
    expect(html).not.toContain('<script>alert');
    // The name is text in the document, never markup
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.png');
    expect(html).toContain('&lt;script&gt;alert(3)&lt;/script&gt;');
    expect(html).toContain('a &amp; b &lt; c');
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('lists an index when several images were measured, and names the file after the image', () => {
    const runs = [run('a1', 'camera.png', [measurement('r1', 'A')]), run('a2', 'ct.png', [measurement('r1', 'B')], { imageSha256: 'ct-sha' })];
    const many = buildReportModel({ ...{ features: FEATURES, openImage: null, title: '', notes: '', createdAt: '2026-09-16T12:00:00.000Z', coreVersion: '0.1.0' }, runs, rows: rowsOf(runs) });
    const html = buildReportHtml(many, DEFAULT_SECTIONS, EMPTY_ASSETS);
    expect(html).toContain('<title>Texture analysis report</title>');
    expect(html).toContain('<a href="#image-0">camera.png</a>');
    expect(html).toContain('<a href="#image-1">ct.png</a>');
    expect(reportFileName(many, new Date('2026-09-16T12:34:56'))).toBe('session-report-20260916-123456.html');
    expect(reportFileName(model(), new Date('2026-09-16T12:34:56'))).toBe('camera-report-20260916-123456.html');
  });

  it('describes the settings in words', () => {
    const names = new Map(FEATURES.map((feature) => [feature.id, feature.name]));
    expect(settingsRows(SETTINGS, names)).toEqual([
      ['Features (2)', 'Contrast, Entropy', { wide: true }],
      ['Gray levels', '32'],
      ['Quantization', 'Fixed range [0, 255]'],
      ['Distances', '1'],
      ['Directions', '0°, 45°, 90°, 135°'],
      ['Aggregation', 'Mean only'],
      ['Logarithm', 'Natural (ln)'],
      ['Score', 'Disabled'],
    ]);
    expect(settingsRows({ ...SETTINGS, quantization: { method: 'fixedBinWidth', min: 0, max: 255, binWidth: 2.5 } }, names)[2]).toEqual([
      'Quantization',
      'Fixed bin width 2.5',
    ]);
  });
});
