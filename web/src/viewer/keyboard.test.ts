import { describe, expect, it } from 'vitest';
import { keyToAction, type KeyInput } from './keyboard';

const view = { width: 800, height: 600 };
const key = (name: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  key: name,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

describe('keyToAction', () => {
  it('maps zoom keys', () => {
    const context = { hasSelection: false, view };
    expect(keyToAction(key('+'), context)).toEqual({ kind: 'zoomIn' });
    expect(keyToAction(key('='), context)).toEqual({ kind: 'zoomIn' });
    expect(keyToAction(key('-'), context)).toEqual({ kind: 'zoomOut' });
    expect(keyToAction(key('1'), context)).toEqual({ kind: 'zoom100' });
    expect(keyToAction(key('0'), context)).toEqual({ kind: 'fit' });
    expect(keyToAction(key('n'), context)).toEqual({ kind: 'toggleNavigator' });
  });

  it('pans with arrows when nothing is selected', () => {
    const context = { hasSelection: false, view };
    expect(keyToAction(key('ArrowLeft'), context)).toEqual({ kind: 'pan', dx: 50, dy: -0 });
    expect(keyToAction(key('ArrowDown'), context)).toEqual({ kind: 'pan', dx: -0, dy: -50 });
    expect(keyToAction(key('ArrowRight', { shiftKey: true }), context)).toEqual({ kind: 'pan', dx: -800, dy: -0 });
    expect(keyToAction(key('ArrowUp', { shiftKey: true }), context)).toEqual({ kind: 'pan', dx: -0, dy: 600 });
  });

  it('nudges the selection with arrows and zooms to it with Z', () => {
    const context = { hasSelection: true, view };
    expect(keyToAction(key('ArrowLeft'), context)).toEqual({ kind: 'nudge', dx: -1, dy: 0 });
    expect(keyToAction(key('ArrowDown', { shiftKey: true }), context)).toEqual({ kind: 'nudge', dx: 0, dy: 10 });
    expect(keyToAction(key('z'), context)).toEqual({ kind: 'zoomToSelection' });
    expect(keyToAction(key('z'), { hasSelection: false, view })).toBeNull();
  });

  it('selects ROI tools and runs ROI and measurement shortcuts', () => {
    const context = { hasSelection: false, view };
    expect(keyToAction(key('r'), context)).toEqual({ kind: 'tool', tool: 'rectangle' });
    expect(keyToAction(key('E', { shiftKey: true }), context)).toEqual({ kind: 'tool', tool: 'ellipse' });
    expect(keyToAction(key('p'), context)).toEqual({ kind: 'tool', tool: 'polygon' });
    expect(keyToAction(key('f'), context)).toEqual({ kind: 'tool', tool: 'freehand' });
    expect(keyToAction(key('l'), context)).toEqual({ kind: 'tool', tool: 'ruler' });
    expect(keyToAction(key('t'), context)).toEqual({ kind: 'addRoi' });
    expect(keyToAction(key('m'), context)).toEqual({ kind: 'measure', scope: 'selected' });
    expect(keyToAction(key('M', { shiftKey: true }), context)).toEqual({ kind: 'measure', scope: 'all' });
    expect(keyToAction(key('Escape'), context)).toEqual({ kind: 'cancel' });
  });

  it('deletes the selection or the last polygon vertex', () => {
    expect(keyToAction(key('Backspace'), { hasSelection: false, view })).toBeNull();
    expect(keyToAction(key('Delete'), { hasSelection: true, view })).toEqual({ kind: 'deleteSelection' });
    expect(keyToAction(key('Backspace'), { hasSelection: true, drawing: true, view })).toEqual({ kind: 'removeLastVertex' });
  });

  it('leaves modified keys and other keys alone', () => {
    const context = { hasSelection: false, view };
    expect(keyToAction(key('0', { metaKey: true }), context)).toBeNull();
    expect(keyToAction(key('ArrowLeft', { altKey: true }), context)).toBeNull();
    expect(keyToAction(key('+', { ctrlKey: true }), context)).toBeNull();
    expect(keyToAction(key('q'), context)).toBeNull();
  });

  it('steps through the slices of a stack with ImageJ\'s keys', () => {
    const context = { hasSelection: false, view };
    const key = (value: string): KeyInput => ({ key: value, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    expect(keyToAction(key('.'), context)).toEqual({ kind: 'slice', step: 1 });
    expect(keyToAction(key('>'), context)).toEqual({ kind: 'slice', step: 1 });
    expect(keyToAction(key(','), context)).toEqual({ kind: 'slice', step: -1 });
    expect(keyToAction(key('<'), context)).toEqual({ kind: 'slice', step: -1 });
  });
});
