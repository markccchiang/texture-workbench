// Keyboard shortcuts of the image canvas (doc/ui-design-plan.md, sections 5.2 and 6.1).

import type { Size } from './viewport';

export type ToolName = 'pointer' | 'pan' | 'rectangle' | 'ellipse' | 'polygon' | 'freehand' | 'wand' | 'brush' | 'eraser' | 'livewire' | 'ruler';

export type ViewerAction =
  | { kind: 'zoomIn' }
  | { kind: 'zoomOut' }
  | { kind: 'zoom100' }
  | { kind: 'fit' }
  | { kind: 'toggleNavigator' }
  | { kind: 'zoomToSelection' }
  /** Move the view (the image moves on screen by dx, dy screen pixels) */
  | { kind: 'pan'; dx: number; dy: number }
  /** Move the selected ROIs by dx, dy image pixels */
  | { kind: 'nudge'; dx: number; dy: number }
  | { kind: 'tool'; tool: ToolName }
  /** Give the selected ROIs the class with this index (⇧1 = 0), or remove their class (null, ⇧0) */
  | { kind: 'assignClass'; index: number | null }
  /** Add the active ROI to the ROI Manager */
  | { kind: 'addRoi' }
  | { kind: 'measure'; scope: 'selected' | 'all' }
  /** Show the next (1) or previous (-1) slice of a stack */
  | { kind: 'slice'; step: 1 | -1 }
  | { kind: 'deleteSelection' }
  /** Remove the last vertex of the polygon being drawn */
  | { kind: 'removeLastVertex' }
  /** Cancel drawing, or clear the active ROI and the selection */
  | { kind: 'cancel' };

export interface KeyInput {
  key: string;
  /** Physical key, e.g. "Digit1"; the key value of ⇧1 depends on the keyboard layout */
  code?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface KeyContext {
  /** Whether ROIs are selected (arrow keys then move them instead of the view) */
  hasSelection: boolean;
  /** Whether a polygon is being drawn */
  drawing?: boolean;
  view: Size;
}

export const PAN_STEP = 50;
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 10;

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const TOOL_KEYS: Record<string, ToolName> = {
  r: 'rectangle',
  e: 'ellipse',
  p: 'polygon',
  f: 'freehand',
  w: 'wand',
  b: 'brush',
  x: 'eraser',
  i: 'livewire',
  l: 'ruler',
};

/**
 * The action for a key press, or null if the canvas does not handle it. Keys with ⌘, Ctrl or Alt are left to the
 * menus and the browser.
 */
export function keyToAction(input: KeyInput, context: KeyContext): ViewerAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) {
    return null;
  }

  const digit = input.shiftKey && input.code?.startsWith('Digit') ? Number(input.code.slice('Digit'.length)) : Number.NaN;
  if (Number.isInteger(digit)) {
    return context.hasSelection ? { kind: 'assignClass', index: digit === 0 ? null : digit - 1 } : null;
  }

  const arrow = ARROWS[input.key];
  if (arrow) {
    const [horizontal, vertical] = arrow;
    if (context.hasSelection) {
      const step = input.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
      return { kind: 'nudge', dx: horizontal * step, dy: vertical * step };
    }
    // Looking further left moves the image to the right on screen; Shift pans by one viewport
    const stepX = input.shiftKey ? context.view.width : PAN_STEP;
    const stepY = input.shiftKey ? context.view.height : PAN_STEP;
    return { kind: 'pan', dx: -horizontal * stepX, dy: -vertical * stepY };
  }

  const letter = input.key.length === 1 ? input.key.toLowerCase() : '';
  if (TOOL_KEYS[letter]) {
    return { kind: 'tool', tool: TOOL_KEYS[letter] };
  }

  switch (input.key) {
    case '+':
    case '=':
      return { kind: 'zoomIn' };
    case '-':
    case '_':
      return { kind: 'zoomOut' };
    case '1':
      return { kind: 'zoom100' };
    case '0':
      return { kind: 'fit' };
    case 'Escape':
      return { kind: 'cancel' };
    // ImageJ's keys for the next and previous slice
    case '.':
    case '>':
      return { kind: 'slice', step: 1 };
    case ',':
    case '<':
      return { kind: 'slice', step: -1 };
    case 'Backspace':
    case 'Delete':
      if (context.drawing) {
        return { kind: 'removeLastVertex' };
      }
      return context.hasSelection ? { kind: 'deleteSelection' } : null;
  }

  switch (letter) {
    case 'n':
      return { kind: 'toggleNavigator' };
    case 'z':
      return context.hasSelection ? { kind: 'zoomToSelection' } : null;
    case 't':
      return { kind: 'addRoi' };
    case 'm':
      return { kind: 'measure', scope: input.shiftKey ? 'all' : 'selected' };
    default:
      return null;
  }
}
