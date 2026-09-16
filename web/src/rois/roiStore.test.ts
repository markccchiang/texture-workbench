import type { RoiShape } from '@glcm/api';
import { beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, useRois } from './roiStore';

const rectangle = (x: number): RoiShape => ({ type: 'rectangle', x, y: 0, width: 10, height: 10 });
const store = () => useRois.getState();
const names = () => store().rois.map((roi) => roi.name);

beforeEach(() => {
  store().reset();
  store().setCurrentSlice(null);
});

describe('ROI store', () => {
  it('adds ROIs with default names and colors, selecting the new one', () => {
    const first = store().addRoi(rectangle(0));
    const second = store().addRoi(rectangle(20));
    expect(names()).toEqual(['ROI 1', 'ROI 2']);
    expect(store().rois[0].color).not.toBe(store().rois[1].color);
    expect(store().selectedIds).toEqual([second]);
    expect(first).not.toBe(second);
  });

  it('undoes and redoes add, rename, delete and nudge', () => {
    const id = store().addRoi(rectangle(0));
    store().renameRoi(id, '  Liver  ');
    store().nudgeRois([id], 2, -1);
    expect(store().rois[0]).toMatchObject({ name: 'Liver', shape: { x: 2, y: -1 } });
    store().deleteRois([id]);
    expect(store().rois).toEqual([]);
    expect(store().selectedIds).toEqual([]);

    store().undo();
    expect(store().rois[0].shape).toMatchObject({ x: 2 });
    store().undo();
    expect(store().rois[0].shape).toMatchObject({ x: 0 });
    store().undo();
    expect(names()).toEqual(['ROI 1']);
    store().undo();
    expect(store().rois).toEqual([]);
    store().undo(); // nothing left

    store().redo();
    store().redo();
    expect(names()).toEqual(['Liver']);

    // A new edit clears the redo steps
    store().renameRoi(store().rois[0].id, 'Spleen');
    store().redo();
    expect(names()).toEqual(['Spleen']);
    expect(store().future).toEqual([]);
  });

  it('ignores renames to the same or an empty name', () => {
    const id = store().addRoi(rectangle(0));
    const steps = store().past.length;
    store().renameRoi(id, 'ROI 1');
    store().renameRoi(id, '   ');
    expect(store().past).toHaveLength(steps);
  });

  it('records a continuous edit as one step', () => {
    const id = store().addRoi(rectangle(0));
    const steps = store().past.length;
    store().beginEdit();
    for (let x = 1; x <= 5; x += 1) {
      store().updateShapeLive(id, rectangle(x));
    }
    store().endEdit();
    expect(store().past).toHaveLength(steps + 1);
    store().undo();
    expect(store().rois[0].shape).toMatchObject({ x: 0 });

    // An edit without changes records nothing
    store().beginEdit();
    store().endEdit();
    expect(store().past).toHaveLength(steps);
  });

  it('limits the history', () => {
    const id = store().addRoi(rectangle(0));
    for (let i = 0; i < HISTORY_LIMIT + 50; i += 1) {
      store().nudgeRois([id], 1, 0);
    }
    expect(store().past).toHaveLength(HISTORY_LIMIT);
  });

  it('duplicates with an offset and new ids', () => {
    const id = store().addRoi(rectangle(0));
    const [copy] = store().duplicateRois([id]);
    expect(copy).not.toBe(id);
    expect(store().rois[1]).toMatchObject({ name: 'ROI 1 copy', shape: { x: 10, y: 10 } });
    expect(store().selectedIds).toEqual([copy]);
  });

  it('selects ranges, toggles and all', () => {
    const ids = [0, 1, 2, 3].map((i) => store().addRoi(rectangle(i * 20)));
    store().select([ids[0]]);
    store().selectRange(ids[2]);
    expect(store().selectedIds).toEqual([ids[0], ids[1], ids[2]]);
    store().toggleSelected(ids[1]);
    expect(store().selectedIds).toEqual([ids[0], ids[2]]);
    store().selectAll();
    expect(store().selectedIds).toEqual(ids);
  });

  it('imports ROIs as one undoable step, replacing clashing ids', () => {
    const existing = store().addRoi(rectangle(0));
    const imported = store().importRois([
      { id: existing, name: 'Clash', color: '#FF0000', shape: rectangle(5) },
      { name: 'New', color: '', shape: rectangle(6) },
    ]);
    expect(imported[0]).not.toBe(existing);
    expect(names()).toEqual(['ROI 1', 'Clash', 'New']);
    expect(store().rois[2].color).toMatch(/^#/);
    store().undo();
    expect(names()).toEqual(['ROI 1']);
  });

  it('keeps ids unique when an imported file repeats them', () => {
    const existing = store().addRoi(rectangle(0));
    const imported = store().importRois([
      { id: 'twin', name: 'A', color: '#ff0000', shape: rectangle(10) },
      { id: 'twin', name: 'B', color: '#00ff00', shape: rectangle(20) },
      { id: existing, name: 'C', color: '#0000ff', shape: rectangle(30) },
      { id: 'twin', name: 'D', color: '#ffff00', shape: rectangle(40) },
    ]);
    expect(imported[0]).toBe('twin');
    const ids = store().rois.map((roi) => roi.id);
    expect(new Set(ids).size).toBe(5);
    expect(store().selectedIds).toEqual(imported);
    expect(names()).toEqual(['ROI 1', 'A', 'B', 'C', 'D']);
  });

  it('changes the colour as an undoable step and ignores invalid colours', () => {
    const id = store().addRoi(rectangle(0));
    const original = store().rois[0].color;
    store().recolorRoi(id, '#00C2FF');
    expect(store().rois[0].color).toBe('#00C2FF');
    store().recolorRoi(id, '#00c2ff');
    store().recolorRoi(id, 'blue');
    store().recolorRoi(id, '#12345');
    expect(store().rois[0].color).toBe('#00C2FF');
    store().undo();
    expect(store().rois[0].color).toBe(original);
    store().redo();
    expect(store().rois[0].color).toBe('#00C2FF');
  });

  it('changes visibility without history', () => {
    const id = store().addRoi(rectangle(0));
    const steps = store().past.length;
    store().setVisible(id, false);
    store().setAllVisible(false);
    expect(store().rois[0].visible).toBe(false);
    expect(store().past).toHaveLength(steps);
  });

  it('puts new ROIs on the slice shown, and copies ROIs onto every other slice', () => {
    expect(store().rois).toEqual([]);
    store().setCurrentSlice(2);
    const id = store().addRoi(rectangle(0));
    const [imported] = store().importRois([{ name: 'Imported', color: '', shape: rectangle(5) }, { name: 'On 3', color: '', slice: 3, shape: rectangle(9) }]);
    expect(store().rois.map((roi) => roi.slice)).toEqual([2, 2, 3]);
    expect(store().selectedIds).toContain(imported);

    // Showing another slice leaves only its ROIs selected
    store().select([id, store().rois[2].id]);
    store().setCurrentSlice(3);
    expect(store().selectedIds).toEqual([store().rois[2].id]);

    // Select All and range selection stay on the slice shown
    store().selectAll();
    expect(store().selectedIds).toEqual([store().rois[2].id]);
    store().setCurrentSlice(2);
    store().select([id]);
    store().selectRange(store().rois[2].id);
    expect(store().selectedIds).toEqual([id, imported]);

    const copies = store().copyToAllSlices([id], 4);
    expect(copies).toHaveLength(3);
    expect(store().rois.filter((roi) => roi.name === 'ROI 1').map((roi) => roi.slice)).toEqual([2, 1, 3, 4]);
    store().undo();
    expect(store().rois).toHaveLength(3);
  });
});
