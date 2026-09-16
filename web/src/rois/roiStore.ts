// ROIs of the open image, their selection and undo/redo (doc/ui-design-plan.md, section 6.2).
//
// History stores snapshots of the ROI list. Continuous edits (dragging, resizing) update the list live between
// beginEdit() and endEdit(), which records one step.

import type { RoiShape } from '@glcm/api';
import { create } from 'zustand';
import { ROI_COLORS, roiColor, translateShape } from './geometry';

export interface ManagedRoi {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  shape: RoiShape;
  /** Name of the ROI's class; absent when it has none */
  className?: string;
  /** The slice of a stack the ROI lies on, from 1; absent for an image without slices */
  slice?: number;
}

/** Whether an ROI lies on the slice shown (null: an image without slices shows every ROI) */
export function isOnSlice(roi: Pick<ManagedRoi, 'slice'>, slice: number | null): boolean {
  return slice === null || (roi.slice ?? 1) === slice;
}

/** A class ROIs can belong to, e.g. lesion or normal */
export interface RoiClass {
  name: string;
  color: string;
}

export const MAX_CLASS_NAME_LENGTH = 100;

export const HISTORY_LIMIT = 200;

export interface RoiState {
  rois: ManagedRoi[];
  selectedIds: string[];
  hoveredId: string | null;
  /** Number used for the next default name "ROI n" */
  nextNumber: number;
  past: ManagedRoi[][];
  future: ManagedRoi[][];
  /** Snapshot taken by beginEdit() */
  editSnapshot: ManagedRoi[] | null;
  /** The shape just drawn, not yet in the ROI Manager (doc/ui-design-plan.md, section 6.2: active vs managed) */
  activeShape: RoiShape | null;
  /** Classes in the order of their shortcuts (⇧1–⇧9); kept when another image opens */
  classes: RoiClass[];
  /** The slice shown of a stack, which new ROIs lie on; null for an image without slices */
  currentSlice: number | null;

  setActiveShape(shape: RoiShape | null): void;
  /** Follows the slice shown; ROIs on other slices leave the selection */
  setCurrentSlice(slice: number | null): void;
  /** Copies ROIs onto every other slice of a stack of `slices` slices, as one undo step; returns the ids of the copies */
  copyToAllSlices(ids: readonly string[], slices: number): string[];
  /** Moves the active shape into the manager; returns its id, or null without an active shape */
  addActiveRoi(): string | null;
  addRoi(shape: RoiShape, name?: string): string;
  importRois(rois: Array<Omit<ManagedRoi, 'visible' | 'id'> & { id?: string; visible?: boolean }>): string[];
  deleteRois(ids: readonly string[]): void;
  duplicateRois(ids: readonly string[]): string[];
  renameRoi(id: string, name: string): void;
  /** Sets a colour "#RRGGBB"; undoable. Other values are ignored. */
  recolorRoi(id: string, color: string): void;
  replaceShape(id: string, shape: RoiShape): void;
  /** Gives several ROIs new shapes as one undo step (Enlarge, Shrink) */
  replaceShapes(changes: ReadonlyArray<{ id: string; shape: RoiShape }>): void;
  /** Gives one ROI a new shape and deletes others, as one undo step (Union); the kept ROI is selected */
  mergeRois(targetId: string, shape: RoiShape, removeIds: readonly string[]): void;
  nudgeRois(ids: readonly string[], dx: number, dy: number): void;
  setVisible(id: string, visible: boolean): void;
  setAllVisible(visible: boolean): void;

  /** Replaces the class list (opening a project) */
  setClasses(classes: readonly RoiClass[]): void;
  /** Adds a class named "Class n" with the next colour and returns it */
  addClass(): RoiClass;
  /** Renames or recolours a class; its ROIs follow, as one undo step. Throws for an empty, too long or taken name. */
  updateClass(name: string, change: Partial<RoiClass>): void;
  /** Removes a class; its ROIs keep their colour but lose the class (undoable) */
  removeClass(name: string): void;
  /** Adds the classes whose names are not in the list yet (importing ROI sets) */
  mergeClasses(classes: readonly RoiClass[]): void;
  /** Gives ROIs a class and its colour, or removes their class (null), as one undo step */
  assignClass(ids: readonly string[], className: string | null): void;

  beginEdit(): void;
  updateShapeLive(id: string, shape: RoiShape): void;
  endEdit(): void;

  select(ids: readonly string[]): void;
  toggleSelected(id: string): void;
  selectRange(id: string): void;
  selectAll(): void;
  setHovered(id: string | null): void;

  undo(): void;
  redo(): void;
  /** Removes every ROI and the history (a new image was opened) */
  reset(): void;
}

function newRoiId(): string {
  return crypto.randomUUID();
}

const DUPLICATE_OFFSET = 10;

export const useRois = create<RoiState>()((set, get) => {
  /** Replaces the ROI list, recording the previous one as an undo step */
  const commit = (rois: ManagedRoi[], extra: Partial<RoiState> = {}) => {
    const { rois: previous, past } = get();
    set({ rois, past: [...past, previous].slice(-HISTORY_LIMIT), future: [], ...extra });
  };

  const validSelection = (rois: ManagedRoi[], selectedIds: string[]) => {
    const ids = new Set(rois.map((roi) => roi.id));
    return selectedIds.filter((id) => ids.has(id));
  };

  return {
    rois: [],
    selectedIds: [],
    hoveredId: null,
    nextNumber: 1,
    past: [],
    future: [],
    editSnapshot: null,
    activeShape: null,
    classes: [],
    currentSlice: null,

    setActiveShape: (activeShape) => set({ activeShape }),

    setCurrentSlice: (currentSlice) => {
      const { rois, selectedIds, currentSlice: previous } = get();
      if (previous === currentSlice) {
        return;
      }
      const onSlice = new Set(rois.filter((roi) => isOnSlice(roi, currentSlice)).map((roi) => roi.id));
      set({ currentSlice, selectedIds: selectedIds.filter((id) => onSlice.has(id)), hoveredId: null, activeShape: null });
    },

    copyToAllSlices: (ids, slices) => {
      const { rois } = get();
      const chosen = rois.filter((roi) => ids.includes(roi.id));
      const copies: ManagedRoi[] = [];
      for (const roi of chosen) {
        for (let slice = 1; slice <= slices; slice += 1) {
          if (slice !== (roi.slice ?? 1)) {
            copies.push({ ...roi, id: newRoiId(), slice });
          }
        }
      }
      if (copies.length > 0) {
        commit([...rois, ...copies]);
      }
      return copies.map((roi) => roi.id);
    },

    addActiveRoi: () => {
      const { activeShape } = get();
      if (!activeShape) {
        return null;
      }
      const id = get().addRoi(activeShape);
      set({ activeShape: null });
      return id;
    },

    addRoi: (shape, name) => {
      const { rois, nextNumber, currentSlice } = get();
      const roi: ManagedRoi = {
        id: newRoiId(),
        name: name ?? `ROI ${nextNumber}`,
        color: roiColor(nextNumber - 1),
        visible: true,
        shape,
        ...(currentSlice !== null ? { slice: currentSlice } : {}),
      };
      commit([...rois, roi], { selectedIds: [roi.id], nextNumber: nextNumber + 1 });
      return roi.id;
    },

    importRois: (imported) => {
      const { rois, nextNumber, currentSlice } = get();
      // Ids already taken, including those chosen earlier in this import (a file may repeat an id)
      const existing = new Set(rois.map((roi) => roi.id));
      const added = imported.map((roi, i) => {
        const id = roi.id && !existing.has(roi.id) ? roi.id : newRoiId();
        existing.add(id);
        return {
          id,
          name: roi.name,
          color: roi.color || roiColor(nextNumber - 1 + i),
          visible: roi.visible ?? true,
          shape: roi.shape,
          ...(roi.className ? { className: roi.className } : {}),
          // ROIs without a slice land on the slice shown
          ...(roi.slice !== undefined ? { slice: roi.slice } : currentSlice !== null ? { slice: currentSlice } : {}),
        };
      });
      commit([...rois, ...added], { selectedIds: added.map((roi) => roi.id), nextNumber: nextNumber + added.length });
      return added.map((roi) => roi.id);
    },

    deleteRois: (ids) => {
      const remove = new Set(ids);
      const { rois, selectedIds } = get();
      const remaining = rois.filter((roi) => !remove.has(roi.id));
      if (remaining.length !== rois.length) {
        commit(remaining, { selectedIds: validSelection(remaining, selectedIds) });
      }
    },

    duplicateRois: (ids) => {
      const { rois, nextNumber } = get();
      const copies = rois
        .filter((roi) => ids.includes(roi.id))
        .map((roi, i) => ({
          ...roi,
          id: newRoiId(),
          name: `${roi.name} copy`,
          // Copies keep the colour of their class
          color: roi.className ? roi.color : roiColor(nextNumber - 1 + i),
          shape: translateShape(roi.shape, DUPLICATE_OFFSET, DUPLICATE_OFFSET),
        }));
      if (copies.length > 0) {
        commit([...rois, ...copies], { selectedIds: copies.map((roi) => roi.id), nextNumber: nextNumber + copies.length });
      }
      return copies.map((roi) => roi.id);
    },

    renameRoi: (id, name) => {
      const trimmed = name.trim();
      const { rois } = get();
      if (trimmed && rois.some((roi) => roi.id === id && roi.name !== trimmed)) {
        commit(rois.map((roi) => (roi.id === id ? { ...roi, name: trimmed } : roi)));
      }
    },

    recolorRoi: (id, color) => {
      const { rois } = get();
      if (/^#[0-9A-Fa-f]{6}$/.test(color) && rois.some((roi) => roi.id === id && roi.color.toLowerCase() !== color.toLowerCase())) {
        commit(rois.map((roi) => (roi.id === id ? { ...roi, color } : roi)));
      }
    },

    replaceShape: (id, shape) => {
      commit(get().rois.map((roi) => (roi.id === id ? { ...roi, shape } : roi)));
    },

    replaceShapes: (changes) => {
      if (changes.length === 0) {
        return;
      }
      const shapes = new Map(changes.map(({ id, shape }) => [id, shape]));
      commit(get().rois.map((roi) => (shapes.has(roi.id) ? { ...roi, shape: shapes.get(roi.id)! } : roi)));
    },

    mergeRois: (targetId, shape, removeIds) => {
      const remove = new Set(removeIds.filter((id) => id !== targetId));
      const rois = get()
        .rois.filter((roi) => !remove.has(roi.id))
        .map((roi) => (roi.id === targetId ? { ...roi, shape } : roi));
      commit(rois, { selectedIds: rois.some((roi) => roi.id === targetId) ? [targetId] : [] });
    },

    nudgeRois: (ids, dx, dy) => {
      if (ids.length === 0) {
        return;
      }
      commit(get().rois.map((roi) => (ids.includes(roi.id) ? { ...roi, shape: translateShape(roi.shape, dx, dy) } : roi)));
    },

    setClasses: (classes) => set({ classes: classes.map(({ name, color }) => ({ name, color })) }),

    addClass: () => {
      const { classes } = get();
      let number = classes.length + 1;
      while (classes.some((roiClass) => roiClass.name === `Class ${number}`)) {
        number += 1;
      }
      const added = { name: `Class ${number}`, color: ROI_COLORS[classes.length % ROI_COLORS.length] };
      set({ classes: [...classes, added] });
      return added;
    },

    updateClass: (name, change) => {
      const { classes, rois } = get();
      const current = classes.find((roiClass) => roiClass.name === name);
      if (!current) {
        return;
      }
      const next = { name: change.name?.trim() ?? current.name, color: change.color ?? current.color };
      if (next.name.length === 0 || next.name.length > MAX_CLASS_NAME_LENGTH) {
        throw new Error(`A class name must have 1 to ${MAX_CLASS_NAME_LENGTH} characters`);
      }
      if (next.name !== name && classes.some((roiClass) => roiClass.name === next.name)) {
        throw new Error(`There is already a class named ${next.name}`);
      }
      const updatedClasses = classes.map((roiClass) => (roiClass.name === name ? next : roiClass));
      if (rois.some((roi) => roi.className === name) && (next.name !== name || next.color !== current.color)) {
        commit(
          rois.map((roi) => (roi.className === name ? { ...roi, className: next.name, color: next.color !== current.color ? next.color : roi.color } : roi)),
          { classes: updatedClasses },
        );
      } else {
        set({ classes: updatedClasses });
      }
    },

    removeClass: (name) => {
      const { classes, rois } = get();
      const remaining = classes.filter((roiClass) => roiClass.name !== name);
      if (rois.some((roi) => roi.className === name)) {
        commit(
          rois.map((roi) => {
            if (roi.className !== name) {
              return roi;
            }
            const { className: _removed, ...rest } = roi;
            return rest;
          }),
          { classes: remaining },
        );
      } else {
        set({ classes: remaining });
      }
    },

    mergeClasses: (incoming) => {
      const { classes } = get();
      const added = incoming.filter((roiClass, i) => !classes.some((existing) => existing.name === roiClass.name) && incoming.findIndex((other) => other.name === roiClass.name) === i);
      if (added.length > 0) {
        set({ classes: [...classes, ...added.map(({ name, color }, i) => ({ name, color: color || ROI_COLORS[(classes.length + i) % ROI_COLORS.length] }))] });
      }
    },

    assignClass: (ids, className) => {
      const { rois, classes } = get();
      const target = className === null ? null : classes.find((roiClass) => roiClass.name === className);
      if (className !== null && !target) {
        return;
      }
      const chosen = new Set(ids);
      if (!rois.some((roi) => chosen.has(roi.id))) {
        return;
      }
      commit(
        rois.map((roi) => {
          if (!chosen.has(roi.id)) {
            return roi;
          }
          if (!target) {
            const { className: _removed, ...rest } = roi;
            return rest;
          }
          return { ...roi, className: target.name, color: target.color || roi.color };
        }),
      );
    },

    // Visibility is a view setting, not an edit, so it is not undoable
    setVisible: (id, visible) => set({ rois: get().rois.map((roi) => (roi.id === id ? { ...roi, visible } : roi)) }),
    setAllVisible: (visible) => set({ rois: get().rois.map((roi) => ({ ...roi, visible })) }),

    beginEdit: () => set({ editSnapshot: get().rois }),

    updateShapeLive: (id, shape) => set({ rois: get().rois.map((roi) => (roi.id === id ? { ...roi, shape } : roi)) }),

    endEdit: () => {
      const { editSnapshot, rois, past } = get();
      if (editSnapshot && editSnapshot !== rois) {
        set({ past: [...past, editSnapshot].slice(-HISTORY_LIMIT), future: [], editSnapshot: null });
      } else {
        set({ editSnapshot: null });
      }
    },

    select: (ids) => set({ selectedIds: [...ids] }),

    toggleSelected: (id) => {
      const { selectedIds } = get();
      set({ selectedIds: selectedIds.includes(id) ? selectedIds.filter((other) => other !== id) : [...selectedIds, id] });
    },

    // Shift-click in the manager: from the last selected ROI to this one, in list order
    selectRange: (id) => {
      const { rois, selectedIds } = get();
      const anchor = selectedIds.at(-1);
      const from = rois.findIndex((roi) => roi.id === anchor);
      const to = rois.findIndex((roi) => roi.id === id);
      if (from < 0 || to < 0) {
        set({ selectedIds: [id] });
        return;
      }
      const [low, high] = from <= to ? [from, to] : [to, from];
      const range = rois.slice(low, high + 1).map((roi) => roi.id);
      set({ selectedIds: [...new Set([...selectedIds, ...range])] });
    },

    selectAll: () => set({ selectedIds: get().rois.map((roi) => roi.id) }),

    setHovered: (hoveredId) => {
      if (get().hoveredId !== hoveredId) {
        set({ hoveredId });
      }
    },

    undo: () => {
      const { past, future, rois, selectedIds } = get();
      const previous = past.at(-1);
      if (!previous) {
        return;
      }
      set({ rois: previous, past: past.slice(0, -1), future: [rois, ...future], selectedIds: validSelection(previous, selectedIds) });
    },

    redo: () => {
      const { past, future, rois, selectedIds } = get();
      const next = future[0];
      if (!next) {
        return;
      }
      set({ rois: next, past: [...past, rois], future: future.slice(1), selectedIds: validSelection(next, selectedIds) });
    },

    reset: () => set({ rois: [], selectedIds: [], hoveredId: null, nextNumber: 1, past: [], future: [], editSnapshot: null, activeShape: null }),
  };
});
