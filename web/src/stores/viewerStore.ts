// State of the open image and the image viewer (doc/ui-design-plan.md, section 6.1).

import type { ImageInfo, PixelSpacing } from '@glcm/api';
import { create } from 'zustand';
import type { RawImage } from '../image/raw';
import { shapeBounds, unionBounds } from '../rois/geometry';
import { useRois } from '../rois/roiStore';
import type { ToolName, ViewerAction } from '../viewer/keyboard';
import { fitToView, imageFits, nextZoomStep, pan, zoomTo, zoomToRect, type Point, type Rect, type Size, type Viewport } from '../viewer/viewport';
import { sameSpacing } from '../image/spacing';
import { usePreferences } from './preferences';
import type { RulerLine } from '../viewer/ruler';
import type { ColorTableId } from '../image/colorTables';
import { defaultWandTolerance } from '../rois/regions';

export type RendererKind = 'webgl2' | 'lut' | 'server';
export type Tool = ToolName;
export type NavigatorMode = 'auto' | 'shown' | 'hidden';

export interface LoadedImage {
  info: ImageInfo;
  /** Samples of the slice shown, for in-browser rendering; null for images with transfer "server" (or when the download failed) */
  raw: RawImage | null;
  /** The slice shown of a stack, from 1; 1 when absent */
  slice?: number;
}

export interface LoadingState {
  name: string;
  phase: 'downloadingSample' | 'uploading' | 'downloading' | 'openingSlice';
  /** 0..1, or null when unknown */
  progress: number | null;
}

export interface HoverState {
  x: number;
  y: number;
  /** null while a server lookup is pending */
  value: number | null;
}

export interface WindowRange {
  min: number;
  max: number;
}

export function maxSampleValue(bitDepth: 8 | 16): number {
  return bitDepth === 16 ? 65535 : 255;
}

export interface ViewerState {
  image: LoadedImage | null;
  loading: LoadingState | null;
  window: WindowRange;
  viewport: Viewport;
  viewSize: Size;
  /** Fit the image once the view has a size */
  needsFit: boolean;
  tool: Tool;
  navigatorMode: NavigatorMode;
  hover: HoverState | null;
  /** What the canvas currently shows: a renderer canvas or a display.png image */
  displaySource: CanvasImageSource | null;
  rendererKind: RendererKind | null;
  /** Incremented whenever displaySource was redrawn */
  displayVersion: number;
  /** Millimetres per pixel of the open image: chosen by the user for this image earlier, else from its file */
  pixelSpacing: PixelSpacing | null;
  /** The ruler line in image coordinates: one at a time, not saved */
  ruler: RulerLine | null;
  /** Colour table of the display; kept when another image opens */
  colorTable: ColorTableId;
  /** Largest difference from the clicked pixel value that the magic wand includes; reset for each image */
  wandTolerance: number;
  /** Diameter of the brush and eraser in image pixels; kept when another image opens */
  brushSize: number;

  setLoading(loading: LoadingState | null): void;
  openImage(image: LoadedImage): void;
  /** Shows another slice of the open stack (its samples already downloaded, when offered) */
  showSlice(image: LoadedImage): void;
  /** Sets the spacing of the open image and remembers it for the image; null: no spacing */
  setPixelSpacing(spacing: PixelSpacing | null): void;
  closeImage(): void;
  setWindow(min: number, max: number): void;
  resetWindow(mode: 'auto' | 'full'): void;
  setViewport(viewport: Viewport): void;
  setViewSize(size: Size): void;
  zoomStep(direction: 1 | -1, anchor?: Point): void;
  zoomToScale(scale: number, anchor?: Point): void;
  fit(): void;
  /** Frames a rectangle in image coordinates with 10 % padding */
  zoomToRegion(rect: Rect): void;
  /** Frames the selected ROIs; false if none is selected */
  zoomToSelection(): boolean;
  panBy(dx: number, dy: number): void;
  setTool(tool: Tool): void;
  setRuler(ruler: RulerLine | null): void;
  setColorTable(colorTable: ColorTableId): void;
  setWandTolerance(tolerance: number): void;
  setBrushSize(size: number): void;
  toggleNavigator(): void;
  setHover(hover: HoverState | null): void;
  setDisplaySource(source: CanvasImageSource | null, kind: RendererKind | null): void;
  /** View actions; other actions are ignored */
  runAction(action: ViewerAction): void;
}

const INITIAL_VIEWPORT: Viewport = { scale: 1, x: 0, y: 0 };

/** The slice shown of the open image, from 1 (1 for an image without slices) */
export function shownSlice(): number {
  return useViewer.getState().image?.slice ?? 1;
}

/** The slice field of a request about the slice shown: omitted for slice 1 */
export function sliceField(slice: number): { slice?: number } {
  return slice > 1 ? { slice } : {};
}

/** The spacing chosen for an image earlier, else the one from its file */
export function spacingForImage(info: ImageInfo): PixelSpacing | null {
  const chosen = usePreferences.getState().pixelSpacings[info.sha256];
  return chosen !== undefined ? chosen : (info.pixelSpacing ?? null);
}

function viewCentre(size: Size): Point {
  return { x: size.width / 2, y: size.height / 2 };
}

function hasArea(size: Size): boolean {
  return size.width > 0 && size.height > 0;
}

export const useViewer = create<ViewerState>()((set, get) => ({
  image: null,
  loading: null,
  window: { min: 0, max: 255 },
  viewport: INITIAL_VIEWPORT,
  viewSize: { width: 0, height: 0 },
  needsFit: false,
  tool: 'pointer',
  navigatorMode: 'auto',
  hover: null,
  displaySource: null,
  rendererKind: null,
  displayVersion: 0,
  pixelSpacing: null,
  ruler: null,
  colorTable: 'gray',
  wandTolerance: defaultWandTolerance(0, 255),
  brushSize: 10,

  setLoading: (loading) => set({ loading }),

  setPixelSpacing: (spacing) => {
    const info = get().image?.info;
    if (!info) {
      return;
    }
    // Choosing the file's own spacing again forgets the choice
    usePreferences.getState().rememberPixelSpacing(info.sha256, sameSpacing(spacing, info.pixelSpacing) ? undefined : spacing);
    set({ pixelSpacing: spacing });
  },

  openImage: (image) => {
    const { viewSize, image: previous } = get();
    const canFit = hasArea(viewSize);
    // ROIs belong to one image
    if (previous?.info.imageId !== image.info.imageId) {
      useRois.getState().reset();
    }
    useRois.getState().setCurrentSlice(image.info.slices > 1 ? (image.slice ?? 1) : null);
    set({
      image,
      window: { min: image.info.windowMin, max: image.info.windowMax },
      viewport: canFit ? fitToView(image.info, viewSize) : INITIAL_VIEWPORT,
      needsFit: !canFit,
      // A navigator toggled for the previous image should not stick to the next one
      navigatorMode: 'auto',
      hover: null,
      displaySource: null,
      rendererKind: null,
      pixelSpacing: spacingForImage(image.info),
      ruler: null,
      wandTolerance: defaultWandTolerance(image.info.windowMin, image.info.windowMax),
    });
  },

  showSlice: (image) => {
    const { image: current } = get();
    if (current?.info.imageId !== image.info.imageId) {
      return;
    }
    useRois.getState().setCurrentSlice(image.info.slices > 1 ? (image.slice ?? 1) : null);
    set({ image, hover: null });
  },

  closeImage: () => {
    useRois.getState().reset();
    useRois.getState().setCurrentSlice(null);
    set({ image: null, hover: null, displaySource: null, rendererKind: null, viewport: INITIAL_VIEWPORT, needsFit: false, ruler: null });
  },

  setWindow: (min, max) => {
    const { image } = get();
    const limit = image ? maxSampleValue(image.info.bitDepth) : 255;
    const clamp = (value: number) => Math.min(limit, Math.max(0, Math.round(value)));
    const [low, high] = min <= max ? [clamp(min), clamp(max)] : [clamp(max), clamp(min)];
    const current = get().window;
    if (current.min !== low || current.max !== high) {
      set({ window: { min: low, max: high } });
    }
  },

  resetWindow: (mode) => {
    const { image } = get();
    if (!image) {
      return;
    }
    if (mode === 'auto') {
      get().setWindow(image.info.windowMin, image.info.windowMax);
    } else {
      get().setWindow(0, maxSampleValue(image.info.bitDepth));
    }
  },

  setViewport: (viewport) => set({ viewport }),

  setViewSize: (size) => {
    const { image, needsFit, viewSize } = get();
    if (size.width === viewSize.width && size.height === viewSize.height) {
      return;
    }
    if (image && needsFit && hasArea(size)) {
      set({ viewSize: size, viewport: fitToView(image.info, size), needsFit: false });
    } else {
      set({ viewSize: size });
    }
  },

  zoomStep: (direction, anchor) => {
    const { viewport, viewSize } = get();
    set({ viewport: zoomTo(viewport, nextZoomStep(viewport.scale, direction), anchor ?? viewCentre(viewSize)) });
  },

  zoomToScale: (scale, anchor) => {
    const { viewport, viewSize } = get();
    set({ viewport: zoomTo(viewport, scale, anchor ?? viewCentre(viewSize)) });
  },

  fit: () => {
    const { image, viewSize } = get();
    if (image && hasArea(viewSize)) {
      set({ viewport: fitToView(image.info, viewSize) });
    }
  },

  zoomToRegion: (rect) => {
    const { viewSize } = get();
    if (hasArea(viewSize)) {
      set({ viewport: zoomToRect(rect, viewSize) });
    }
  },

  zoomToSelection: () => {
    const { rois, selectedIds } = useRois.getState();
    const bounds = unionBounds(rois.filter((roi) => selectedIds.includes(roi.id)).map((roi) => shapeBounds(roi.shape)));
    if (!bounds) {
      return false;
    }
    get().zoomToRegion(bounds);
    return true;
  },

  panBy: (dx, dy) => set({ viewport: pan(get().viewport, dx, dy) }),

  // Choosing another tool removes the ruler
  setTool: (tool) => set(tool === get().tool ? { tool } : { tool, ruler: null }),

  setRuler: (ruler) => set({ ruler }),

  setColorTable: (colorTable) => set({ colorTable }),

  setBrushSize: (size) => set({ brushSize: Math.min(2000, Math.max(1, Math.round(size))) }),

  setWandTolerance: (tolerance) => set({ wandTolerance: Math.min(65535, Math.max(0, Math.round(tolerance))) }),

  toggleNavigator: () => set({ navigatorMode: isNavigatorVisible(get()) ? 'hidden' : 'shown' }),

  setHover: (hover) => set({ hover }),

  setDisplaySource: (displaySource, rendererKind) => set({ displaySource, rendererKind, displayVersion: get().displayVersion + 1 }),

  runAction: (action) => {
    const state = get();
    switch (action.kind) {
      case 'zoomIn':
        state.zoomStep(1);
        break;
      case 'zoomOut':
        state.zoomStep(-1);
        break;
      case 'zoom100':
        state.zoomToScale(1);
        break;
      case 'fit':
        state.fit();
        break;
      case 'toggleNavigator':
        state.toggleNavigator();
        break;
      case 'pan':
        state.panBy(action.dx, action.dy);
        break;
      case 'nudge': {
        const rois = useRois.getState();
        rois.nudgeRois(rois.selectedIds, action.dx, action.dy);
        break;
      }
      case 'zoomToSelection':
        state.zoomToSelection();
        break;
      case 'tool':
        state.setTool(action.tool);
        break;
      default:
        break;
    }
  },
}));

/** Navigator rule: shown automatically while the image does not fit the view, unless toggled */
export function isNavigatorVisible(state: Pick<ViewerState, 'image' | 'navigatorMode' | 'viewport' | 'viewSize'>): boolean {
  if (!state.image || state.navigatorMode === 'hidden') {
    return false;
  }
  return state.navigatorMode === 'shown' || !imageFits(state.viewport, state.image.info, state.viewSize);
}
