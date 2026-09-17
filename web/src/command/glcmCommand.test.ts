import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { commandArchive, commandFileNames, commandScript, imageSource } from './glcmCommand';

describe('glcm command files', () => {
  it('names the colour image of a converted image', () => {
    expect(imageSource({ name: 'brick.png' })).toEqual({ file: 'brick.png' });
    expect(imageSource({ name: 'ihc.png [DAB H-DAB]', colourSource: { imageId: 'img_x', conversion: 'dabHdab' } })).toEqual({
      file: 'ihc.png',
      colour: 'dabHdab',
    });
  });

  it('saves the settings, the ROI set and a script', () => {
    const names = commandFileNames('scan 1.png');
    expect(names).toEqual({
      settings: 'scan_1.settings.json',
      rois: 'scan_1.roi.json',
      script: 'scan_1-measure.sh',
      results: 'scan_1-results.csv',
      archive: 'scan_1-glcm-command.zip',
    });
    const script = commandScript('glcm measure a.png');
    expect(script).toMatch(/^#!\/bin\/sh\n/);
    expect(script.trimEnd().endsWith('glcm measure a.png')).toBe(true);
    const zip = unzipSync(
      commandArchive({
        settings: [names.settings, { grayLevels: 32 } as never],
        rois: [names.rois, { format: 'glcm-roi-set' } as never],
        script: [names.script, script],
      }),
    );
    expect(Object.keys(zip).sort()).toEqual([names.rois, names.script, names.settings].sort());
    expect(JSON.parse(strFromU8(zip[names.settings]))).toEqual({ grayLevels: 32 });
  });
});
