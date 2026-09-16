import type { ImageInfo } from '@glcm/api';
import { describe, expect, it } from 'vitest';
import type { ManagedRoi } from '../rois/roiStore';
import { buildRoiSet, clipShape, imageMismatches, parseRoiSet, prepareRoiImport, roiSetFileName } from './roiSet';
import { FileFormatError } from './validate';

const info: ImageInfo = {
  imageId: `img_${'0'.repeat(32)}`,
  name: 'mri 16.tif',
  sizeBytes: 100,
  width: 100,
  height: 50,
  bitDepth: 16,
  slices: 1,
  sourceChannels: 1,
  pixelSpacing: null,
  sha256: 'a'.repeat(64),
  transfer: 'raw',
  windowMin: 0,
  windowMax: 100,
  histogram: new Array<number>(256).fill(0),
  warnings: [],
  createdAt: '2026-09-14T00:00:00.000Z',
};

const rois: ManagedRoi[] = [
  { id: 'r1', name: 'ROI 1', color: '#FFD400', visible: true, shape: { type: 'rectangle', x: 10.25, y: 5, width: 20, height: 10.5 } },
  { id: 'r2', name: 'ROI 2', color: '#00C2FF', visible: false, shape: { type: 'ellipse', cx: 50.5, cy: 25, rx: 10, ry: 5, angle: 30 } },
  { id: 'r3', name: 'Freehand ✓', color: '#FF4FD8', visible: true, shape: { type: 'polygon', points: [[1, 1], [40.125, 2], [20, 30.75]], freehand: true } },
];

describe('ROI set files', () => {
  it('round-trips every shape without loss', () => {
    const document = buildRoiSet(info, rois);
    const parsed = parseRoiSet(JSON.stringify(document, null, 2));
    expect(parsed).toEqual(document);
    expect(parsed.rois.map((roi) => roi.shape)).toEqual(rois.map((roi) => roi.shape));
    expect(parsed.image).toEqual({ name: 'mri 16.tif', width: 100, height: 50, bitDepth: 16, sha256: info.sha256 });
    expect(roiSetFileName(info.name)).toBe('mri_16.roi.json');
  });

  it('reads the example of the design plan', () => {
    const example = {
      format: 'glcm-roi-set',
      version: 1,
      image: { name: 'mri16.tif', width: 512, height: 512, bitDepth: 16, sha256: '…' },
      rois: [
        { id: '7f3c…', name: 'ROI 1', color: '#FFD400', shape: { type: 'rectangle', x: 100, y: 100, width: 64, height: 64 } },
        { id: 'a91e…', name: 'ROI 2', color: '#00C2FF', shape: { type: 'ellipse', cx: 260.5, cy: 300, rx: 40, ry: 25, angle: 30 } },
        { id: 'c02d…', name: 'ROI 3', color: '#FF4FD8', shape: { type: 'polygon', points: [[10, 10], [80, 20], [40, 90]], freehand: false } },
      ],
    };
    expect(parseRoiSet(JSON.stringify(example)).rois).toHaveLength(3);
  });

  it('explains why a file cannot be read', () => {
    const message = (text: string) => {
      try {
        parseRoiSet(text);
      } catch (error) {
        expect(error).toBeInstanceOf(FileFormatError);
        return (error as Error).message;
      }
      return 'no error';
    };
    expect(message('not json')).toContain('not valid JSON');
    expect(message('[]')).toContain('JSON object');
    expect(message('{"format": "glcm-project", "version": 1}')).toContain('expected "glcm-roi-set"');
    expect(message('{"format": "glcm-roi-set", "version": 2, "rois": []}')).toContain('only version 1');
    expect(message('{"format": "glcm-roi-set", "version": 1, "rois": [{"id": "a", "name": "A", "shape": {"type": "circle"}}]}')).toContain('rois.0');
  });
});

describe('importing', () => {
  it('reports a different image', () => {
    expect(imageMismatches({ width: 100, height: 50, bitDepth: 16, sha256: info.sha256 }, info)).toEqual([]);
    expect(imageMismatches(undefined, info)).toEqual([]);
    const messages = imageMismatches({ name: 'other.png', width: 512, height: 512, bitDepth: 8, sha256: 'b'.repeat(64) }, info);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('512×512');
    expect(messages[1]).toContain('other.png');
  });

  it('clips shapes to the image and keeps inside shapes unchanged', () => {
    const size = { width: 100, height: 50 };
    const inside = rois[0].shape;
    expect(clipShape(inside, size)).toEqual({ shape: inside, clipped: false });
    expect(clipShape({ type: 'rectangle', x: 90, y: -5, width: 20, height: 20 }, size)).toEqual({
      shape: { type: 'rectangle', x: 90, y: 0, width: 10, height: 15 },
      clipped: true,
    });
    expect(clipShape({ type: 'rectangle', x: 200, y: 0, width: 5, height: 5 }, size).shape).toBeNull();
    expect(clipShape({ type: 'ellipse', cx: 105, cy: 25, rx: 10, ry: 10 }, size).shape).not.toBeNull();
    expect(clipShape({ type: 'ellipse', cx: 150, cy: 25, rx: 10, ry: 10 }, size).shape).toBeNull();

    const triangle = clipShape({ type: 'polygon', points: [[50, 25], [150, 25], [50, 100]] }, size);
    expect(triangle.clipped).toBe(true);
    const points = triangle.shape?.type === 'polygon' ? triangle.shape.points : [];
    expect(points.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 50)).toBe(true);
    expect(points).toContainEqual([100, 25]);
    expect(clipShape({ type: 'polygon', points: [[-10, -10], [-5, -10], [-5, -5]] }, size).shape).toBeNull();
  });

  it('prepares ROIs with warnings', () => {
    const document = buildRoiSet({ ...info, width: 200 }, [
      ...rois,
      { id: 'out', name: 'Outside', color: '#FFFFFF', visible: true, shape: { type: 'rectangle', x: 150, y: 0, width: 10, height: 10 } },
      { id: 'cut', name: 'Cut', color: '#FFFFFF', visible: true, shape: { type: 'rectangle', x: 95, y: 0, width: 10, height: 10 } },
    ]);
    const prepared = prepareRoiImport(document, info);
    expect(prepared.rois.map((roi) => roi.id)).toEqual(['r1', 'r2', 'r3', 'cut']);
    expect(prepared.warnings).toEqual([
      'The ROIs were drawn on a 200×50 image; this one is 100×50.',
      '1 ROI was clipped to the image.',
      'Skipped 1 ROI outside the image: Outside.',
    ]);
  });

  it('keeps the slices of ROIs on a stack and skips those beyond it', () => {
    const stack = { ...info, slices: 3 };
    const document = buildRoiSet({ ...info, slices: 4 }, [
      { id: 's2', name: 'On 2', color: '#FFFFFF', visible: true, slice: 2, shape: rois[0].shape },
      { id: 's4', name: 'On 4', color: '#FFFFFF', visible: true, slice: 4, shape: rois[0].shape },
    ]);
    expect(document.image?.slices).toBe(4);
    expect(document.rois.map((roi) => roi.slice)).toEqual([2, 4]);
    const prepared = prepareRoiImport(document, stack);
    expect(prepared.rois.map((roi) => [roi.id, roi.slice])).toEqual([['s2', 2]]);
    expect(prepared.warnings).toEqual(['The ROIs were drawn on a stack of 4 slices; this one has a stack of 3 slices.', 'Skipped 1 ROI on slices the image does not have: On 4.']);

    // On an image without slices, slice 1 is the image
    const single = prepareRoiImport(buildRoiSet(info, [{ id: 's1', name: 'On 1', color: '#FFFFFF', visible: true, slice: 1, shape: rois[0].shape }]), info);
    expect(single.rois[0].slice).toBeUndefined();
    expect(single.warnings).toEqual([]);
  });
});
