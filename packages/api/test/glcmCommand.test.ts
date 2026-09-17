import { describe, expect, it } from 'vitest';
import { measureArguments, measureCommand, shellQuote, shellWords } from '../src/glcmCommand.js';

describe('glcm measure command', () => {
  it('quotes only the words that need it', () => {
    expect(shellQuote('brick.png')).toBe('brick.png');
    expect(shellQuote('scan 1.png')).toBe("'scan 1.png'");
    expect(shellQuote("it's.png")).toBe(`'it'\\''s.png'`);
    expect(shellQuote('')).toBe("''");
    expect(shellWords(`glcm measure 'scan 1.png' 'it'\\''s.png' --out x.csv`)).toEqual(['glcm', 'measure', 'scan 1.png', "it's.png", '--out', 'x.csv']);
  });

  it('builds the measure command with the options that apply', () => {
    const request = {
      images: ['ihc.png'],
      settingsFile: 'ihc.settings.json',
      roisFile: 'ihc.roi.json',
      colour: 'dabHdab' as const,
      spacing: { x: 0.25, y: 1 / 3 },
      out: 'ihc-results.csv',
      server: 'http://127.0.0.1:8080',
    };
    expect(measureCommand(request)).toBe(
      'glcm measure ihc.png --settings ihc.settings.json --rois ihc.roi.json --colour dabHdab --spacing 0.25,0.333333333333 --out ihc-results.csv --server http://127.0.0.1:8080',
    );
    expect(measureArguments({ images: ['a b.png', 'c.tif'], settingsFile: 's.json', roisFile: 'r.zip', out: 'o.csv' })).toEqual([
      'glcm',
      'measure',
      'a b.png',
      'c.tif',
      '--settings',
      's.json',
      '--rois',
      'r.zip',
      '--out',
      'o.csv',
    ]);
    // Every command splits back into its words
    const words = measureArguments({ ...request, images: ["O'Brien scan.png"] });
    expect(shellWords(words.map(shellQuote).join(' '))).toEqual(words);
  });
});
