import type { ImageInfo } from '@glcm/api';
import { beforeEach, describe, expect, it } from 'vitest';
import { imageToScreen } from '../viewer/viewport';
import { isNavigatorVisible, useViewer } from './viewerStore';

const info: ImageInfo = {
  imageId: `img_${'0'.repeat(32)}`,
  name: 'test.tif',
  sizeBytes: 100,
  width: 400,
  height: 200,
  bitDepth: 16,
  slices: 1,
  sourceChannels: 1,
  pixelSpacing: null,
  sha256: 'a'.repeat(64),
  transfer: 'raw',
  windowMin: 1000,
  windowMax: 3000,
  histogram: new Array<number>(256).fill(0),
  warnings: [],
  createdAt: '2026-09-14T00:00:00.000Z',
};

const initialState = useViewer.getState();

beforeEach(() => {
  useViewer.setState(initialState, true);
});

describe('viewer store', () => {
  it('fits the image once the view has a size', () => {
    useViewer.getState().openImage({ info, raw: null });
    expect(useViewer.getState().needsFit).toBe(true);
    expect(useViewer.getState().window).toEqual({ min: 1000, max: 3000 });

    useViewer.getState().setViewSize({ width: 832, height: 632 });
    expect(useViewer.getState().needsFit).toBe(false);
    expect(useViewer.getState().viewport).toEqual({ scale: 2, x: 16, y: 116 });
  });

  it('clamps and orders the window', () => {
    useViewer.getState().openImage({ info, raw: null });
    useViewer.getState().setWindow(70000, -5);
    expect(useViewer.getState().window).toEqual({ min: 0, max: 65535 });
    useViewer.getState().setWindow(10.4, 20.6);
    expect(useViewer.getState().window).toEqual({ min: 10, max: 21 });
    useViewer.getState().resetWindow('auto');
    expect(useViewer.getState().window).toEqual({ min: 1000, max: 3000 });
    useViewer.getState().resetWindow('full');
    expect(useViewer.getState().window).toEqual({ min: 0, max: 65535 });
  });

  it('zooms around the view centre and runs keyboard actions', () => {
    const state = useViewer.getState();
    state.setViewSize({ width: 832, height: 632 });
    state.openImage({ info, raw: null });
    const centre = { x: 416, y: 316 };
    const before = useViewer.getState().viewport;
    const imagePoint = { x: (centre.x - before.x) / before.scale, y: (centre.y - before.y) / before.scale };

    useViewer.getState().runAction({ kind: 'zoomIn' });
    expect(useViewer.getState().viewport.scale).toBe(3);
    const after = imageToScreen(useViewer.getState().viewport, imagePoint);
    expect(after.x).toBeCloseTo(centre.x, 10);
    expect(after.y).toBeCloseTo(centre.y, 10);

    useViewer.getState().runAction({ kind: 'zoom100' });
    expect(useViewer.getState().viewport.scale).toBe(1);
    const unpanned = useViewer.getState().viewport;
    useViewer.getState().runAction({ kind: 'pan', dx: 5, dy: -5 });
    expect(useViewer.getState().viewport).toEqual({ scale: 1, x: unpanned.x + 5, y: unpanned.y - 5 });
    useViewer.getState().runAction({ kind: 'fit' });
    expect(useViewer.getState().viewport).toEqual({ scale: 2, x: 16, y: 116 });
  });

  it('shows the navigator automatically when the image does not fit', () => {
    const state = useViewer.getState();
    state.setViewSize({ width: 832, height: 632 });
    state.openImage({ info, raw: null });
    expect(isNavigatorVisible(useViewer.getState())).toBe(false);
    useViewer.getState().zoomToScale(8);
    expect(isNavigatorVisible(useViewer.getState())).toBe(true);
    useViewer.getState().toggleNavigator();
    expect(useViewer.getState().navigatorMode).toBe('hidden');
    expect(isNavigatorVisible(useViewer.getState())).toBe(false);
    useViewer.getState().toggleNavigator();
    expect(useViewer.getState().navigatorMode).toBe('shown');
    useViewer.getState().fit();
    expect(isNavigatorVisible(useViewer.getState())).toBe(true);

    useViewer.getState().openImage({ info: { ...info, imageId: `img_${'1'.repeat(32)}` }, raw: null });
    expect(useViewer.getState().navigatorMode).toBe('auto');
    expect(isNavigatorVisible(useViewer.getState())).toBe(false);
  });
});
