import { describe, expect, it } from 'vitest';
import { combineResultsCsv, parseResultsCsv } from '../src/mergeCsv.js';

const csv = (image: string, sha: string, options: { quantization?: string; rows?: string[] } = {}) =>
  [
    '# format=glcm-results-csv',
    '# version=1',
    '# coreVersion=0.1.0',
    '# timestamp=2026-09-15T10:00:00Z',
    `# image=${image}`,
    `# imageSha256=${sha}`,
    '# grayLevels=32',
    `# quantization=${options.quantization ?? 'fixedRange [0, 255]'}`,
    '# distances=1',
    'timestamp,image,imageSha256,roiName,roiId,status,pixelCount,grayLevels,quantization,distance,direction,Contrast,warnings',
    ...(options.rows ?? [`2026-09-15T10:00:00Z,${image},${sha},ROI 1,a,ok,100,32,"fixedRange [0, 255]",1,mean,2.5,`]),
    '',
  ].join('\n');

describe('results CSV', () => {
  it('reads comments, header and records, keeping line breaks inside quoted fields', () => {
    const file = parseResultsCsv(
      // Fields with quotes are quoted and their quotes doubled, as glcm_core writes them; comment lines are not quoted
      csv('a"b.png', 'aa', { rows: ['x,"a""b.png",aa,ROI 1,a,failed,0,32,q,1,,,"first line', 'second line"', 'y,"a""b.png",aa,ROI 2,b,ok,5,32,q,1,mean,1,'] }),
    );
    expect(file.comments).toContain('# image=a"b.png');
    expect(file.header.startsWith('timestamp,image')).toBe(true);
    expect(file.records).toHaveLength(2);
    expect(file.records[0]).toContain('first line\nsecond line');
  });

  it('combines files with equal settings into one, replacing the per-image comments', () => {
    const [combined, ...rest] = combineResultsCsv([csv('camera.png', 'c1'), csv('brick.png', 'b2')]);
    expect(rest).toEqual([]);
    expect(combined.images).toBe(2);
    const lines = combined.text.trimEnd().split('\n');
    expect(lines.slice(0, 4)).toEqual(['# format=glcm-results-csv', '# version=1', '# coreVersion=0.1.0', '# images=2']);
    expect(lines.filter((line) => /^# (timestamp|image|imageSha256)=/.test(line))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('timestamp,image'))).toHaveLength(1);
    expect(lines.slice(-2).map((line) => line.split(',')[1])).toEqual(['camera.png', 'brick.png']);
  });

  it('keeps files with different settings apart', () => {
    const groups = combineResultsCsv([csv('a.png', '1'), csv('b16.tif', '2', { quantization: 'fixedRange [0, 65535]' }), csv('c.png', '3')]);
    expect(groups.map((group) => group.images)).toEqual([2, 1]);
    expect(groups[1].text).toContain('# quantization=fixedRange [0, 65535]');
  });

  it('rejects text without a header', () => {
    expect(() => parseResultsCsv('# format=glcm-results-csv\n')).toThrow(/no header/);
  });
});
