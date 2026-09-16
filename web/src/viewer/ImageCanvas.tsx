// Image canvas with zoom, pan, pixel readout and the ROI tools (doc/ui-design-plan.md, sections 6.1 and 6.2).
//
// All pointer input goes through the container's handlers, which hit-test the Konva stage to find ROIs and vertices.
// Only the Transformer handles its own anchors.

import type { RoiShape } from '@glcm/api';
import type Konva from 'konva';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Image as KonvaImage, Layer, Stage } from 'react-konva';
import { getPixel } from '../api/client';
import { runAppAction } from '../app/actions';
import { sampleAt } from '../image/raw';
import {
  ellipseFromDrag,
  freehandFromPath,
  hasCuts,
  insertVertex,
  isDrawableShape,
  moveVertex,
  rectangleFromDrag,
  removeVertex,
  SHAPE_LABELS,
  shapeKind,
  translateShape,
} from '../rois/geometry';
import { useRois } from '../rois/roiStore';
import { applyBrushStroke } from '../rois/editActions';
import { wandAt } from '../rois/regionActions';
import { BrushStrokeLayer, type BrushStroke } from './BrushStrokeLayer';
import { EdgeMapLayer } from './EdgeMapLayer';
import { livewireDraftPoints, useLivewire } from './useLivewire';
import { roiProblem, useRoiStatistics } from '../rois/useRoiStatistics';
import { usePreferences } from '../stores/preferences';
import { useViewer } from '../stores/viewerStore';
import { keyToAction } from './keyboard';
import { Navigator } from './Navigator';
import { ROI_NODE_NAME, RoiLayer, VERTEX_NODE_NAME, type PolygonDraft } from './RoiLayer';
import { FeatureMapLayer } from '../featureMaps/FeatureMapLayer';
import { snapRuler } from './ruler';
import { RulerLayer } from './RulerLayer';
import { useDisplaySource } from './useDisplaySource';
import { imageToScreen, pixelAt, screenToImage, zoomAt, type Point } from './viewport';
import { classifyWheel } from './wheel';
import { areaMm2, formatArea } from '../image/spacing';

const PIXEL_LOOKUP_DELAY_MS = 80;
const TOOLTIP_DELAY_MS = 300;
/** Clicking this close (screen pixels) to the first vertex closes a polygon */
const CLOSE_DISTANCE = 8;
/** A click this soon after closing a polygon, at the same place, is the second click of a double-click */
const DOUBLE_CLICK_MS = 500;

/** Safari's non-standard pinch events */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

type Gesture =
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number }
  | { kind: 'drag'; pointerId: number; tool: 'rectangle' | 'ellipse'; start: Point }
  | { kind: 'freehand'; pointerId: number; path: Array<[number, number]> }
  | { kind: 'move'; pointerId: number; start: Point; shapes: Map<string, RoiShape> }
  | { kind: 'vertex'; pointerId: number; roiId: string; index: number }
  | { kind: 'ruler'; pointerId: number; start: Point }
  | { kind: 'brush'; pointerId: number; erase: boolean; path: Array<[number, number]> };

type Hit = { kind: 'roi'; roiId: string } | { kind: 'vertex'; roiId: string; index: number } | { kind: 'transformer' };

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="slider"]') !== null;
}

function isInOverlay(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('[role="dialog"], [role="menu"]') !== null;
}

/** Drops repeated vertices, e.g. the two clicks of a double-click */
function withoutRepeats(points: Array<[number, number]>): Array<[number, number]> {
  return points.filter((point, i) => i === 0 || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1]);
}

export function ImageCanvas() {
  useDisplaySource();

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const imageNodeRef = useRef<Konva.Image>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const draftRef = useRef<PolygonDraft | null>(null);
  const pixelLookup = useRef<{ timer?: number; controller?: AbortController }>({});
  const tooltipTimer = useRef<number | undefined>(undefined);
  /** Last pointer position over the canvas (container coordinates); null when the pointer is outside */
  const lastPointerRef = useRef<Point | null>(null);
  const [draft, setDraftState] = useState<PolygonDraft | null>(null);
  /** Screen position and time of the click that last closed a polygon on its first vertex */
  const polygonClosedRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [gestureKind, setGestureKind] = useState<Gesture['kind'] | null>(null);
  const [tooltip, setTooltip] = useState<{ roiId: string; x: number; y: number } | null>(null);
  const [brushStroke, setBrushStroke] = useState<BrushStroke | null>(null);

  const image = useViewer((state) => state.image);
  const viewport = useViewer((state) => state.viewport);
  const viewSize = useViewer((state) => state.viewSize);
  const tool = useViewer((state) => state.tool);
  const brushSize = useViewer((state) => state.brushSize);
  const livewire = useLivewire(image?.info.imageId ?? null);
  const displaySource = useViewer((state) => state.displaySource);
  const displayVersion = useViewer((state) => state.displayVersion);
  const hoveredId = useRois((state) => state.hoveredId);
  const rois = useRois((state) => state.rois);
  const statistics = useRoiStatistics();

  const setDraft = useCallback((next: PolygonDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const setGesture = (gesture: Gesture | null) => {
    gestureRef.current = gesture;
    setGestureKind(gesture?.kind ?? null);
  };

  // Track the canvas size
  useEffect(() => {
    const element = containerRef.current!;
    const observer = new ResizeObserver(([entry]) => {
      useViewer.getState().setViewSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The renderer canvas is redrawn in place, which Konva cannot detect
  useEffect(() => {
    imageNodeRef.current?.getLayer()?.batchDraw();
  }, [displayVersion]);

  // Switching tools or images abandons a polygon or livewire outline being drawn
  const cancelLivewire = livewire.cancel;
  useEffect(() => {
    setDraft(null);
    cancelLivewire();
  }, [tool, image, setDraft, cancelLivewire]);

  const localPoint = (clientX: number, clientY: number): Point => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const hitTest = (local: Point): Hit | null => {
    const shape = stageRef.current?.getIntersection(local);
    if (!shape) {
      return null;
    }
    if (shape.getParent()?.getClassName() === 'Transformer') {
      return { kind: 'transformer' };
    }
    if (shape.name() === VERTEX_NODE_NAME) {
      return { kind: 'vertex', roiId: shape.getAttr('roiId') as string, index: shape.getAttr('vertexIndex') as number };
    }
    if (shape.name() === ROI_NODE_NAME) {
      return { kind: 'roi', roiId: shape.id() };
    }
    return null;
  };

  const updatePixelReadout = useCallback((clientX: number, clientY: number) => {
    const state = useViewer.getState();
    const element = containerRef.current;
    if (!state.image || !element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const pixel = pixelAt(state.viewport, { x: clientX - rect.left, y: clientY - rect.top }, state.image.info);
    const lookup = pixelLookup.current;
    if (!pixel) {
      window.clearTimeout(lookup.timer);
      lookup.controller?.abort();
      if (state.hover) {
        state.setHover(null);
      }
      return;
    }
    if (state.hover && state.hover.x === pixel.x && state.hover.y === pixel.y) {
      return;
    }
    if (state.image.raw) {
      state.setHover({ ...pixel, value: sampleAt(state.image.raw, pixel.x, pixel.y) });
      return;
    }

    // Large images: debounced server lookup
    state.setHover({ ...pixel, value: null });
    window.clearTimeout(lookup.timer);
    lookup.controller?.abort();
    const { imageId } = state.image.info;
    const slice = state.image.slice ?? 1;
    lookup.timer = window.setTimeout(async () => {
      const controller = new AbortController();
      lookup.controller = controller;
      try {
        const result = await getPixel(imageId, pixel.x, pixel.y, controller.signal, slice);
        const hover = useViewer.getState().hover;
        const current = useViewer.getState().image;
        if (hover && hover.x === result.x && hover.y === result.y && current?.info.imageId === imageId && (current.slice ?? 1) === slice) {
          useViewer.getState().setHover({ x: result.x, y: result.y, value: result.value });
        }
      } catch {
        // Aborted or failed: the readout keeps showing "…"
      }
    }, PIXEL_LOOKUP_DELAY_MS);
  }, []);

  const updateRoiHover = (roiId: string | null, local: Point) => {
    const rois = useRois.getState();
    if (rois.hoveredId !== roiId) {
      rois.setHovered(roiId);
      window.clearTimeout(tooltipTimer.current);
      setTooltip(null);
      if (roiId) {
        tooltipTimer.current = window.setTimeout(() => setTooltip({ roiId, x: local.x, y: local.y }), TOOLTIP_DELAY_MS);
      }
    } else if (roiId) {
      setTooltip((current) => (current ? { roiId, x: local.x, y: local.y } : current));
    }
  };

  // Hover follows the canvas as well as the pointer. Zooming with keys, switching tools or editing ROIs changes what lies
  // under a resting pointer, and Konva draws the hit graph only after the last pointer event (a frame or more later on a
  // slow GPU), so a hit test on that event finds nothing. After every layer draw the hover is tested again at the last
  // pointer position.
  const refreshHover = () => {
    const local = lastPointerRef.current;
    if (!local || gestureRef.current || useViewer.getState().tool !== 'pointer') {
      return;
    }
    const hit = hitTest(local);
    updateRoiHover(hit && hit.kind !== 'transformer' ? hit.roiId : null, local);
  };
  const refreshHoverRef = useRef(refreshHover);
  useEffect(() => {
    refreshHoverRef.current = refreshHover;
  });
  const hasStage = viewSize.width > 0 && viewSize.height > 0;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    // "draw" fires after the scene; the hit graph is drawn right after it in the same call, hence the microtask
    const onDraw = () => queueMicrotask(() => refreshHoverRef.current());
    const layers = stage.getLayers();
    for (const layer of layers) {
      layer.on('draw.hover', onDraw);
    }
    return () => {
      for (const layer of layers) {
        layer.off('draw.hover');
      }
    };
  }, [hasStage, image]);

  // Wheel, trackpad and Safari pinch; listeners are non-passive so the page does not scroll or zoom
  useEffect(() => {
    const element = containerRef.current!;
    const anchorOf = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const state = useViewer.getState();
      if (!state.image) {
        return;
      }
      const action = classifyWheel(event, usePreferences.getState().scrollBehaviour);
      if (action.kind === 'zoom') {
        state.setViewport(zoomAt(state.viewport, action.factor, anchorOf(event.clientX, event.clientY)));
      } else {
        state.panBy(action.dx, action.dy);
      }
      updatePixelReadout(event.clientX, event.clientY);
    };

    let gestureScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEvent;
      const state = useViewer.getState();
      if (!state.image || gesture.scale <= 0) {
        return;
      }
      state.setViewport(zoomAt(state.viewport, gesture.scale / gestureScale, anchorOf(gesture.clientX, gesture.clientY)));
      gestureScale = gesture.scale;
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart);
    element.addEventListener('gesturechange', onGestureChange);
    element.addEventListener('gestureend', onGestureStart);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
      element.removeEventListener('gestureend', onGestureStart);
    };
  }, [updatePixelReadout]);

  const finishPolygon = useCallback(() => {
    const current = draftRef.current;
    if (!current) {
      return;
    }
    const points = withoutRepeats(current.points);
    setDraft(null);
    if (points.length >= 3) {
      useRois.getState().setActiveShape({ type: 'polygon', points });
    }
  }, [setDraft]);

  const { draftRef: livewireRef, finish: finishLivewire, removeLast: removeLastLivewire } = livewire;

  // Keyboard shortcuts of the canvas; menus, dialogs and text fields keep their own keys
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextInput(event.target) || isInOverlay(event.target)) {
        return;
      }
      if (event.key === ' ') {
        if (event.target instanceof HTMLElement && event.target.closest('button, a, [role="menuitem"]')) {
          return;
        }
        event.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (event.key === 'Enter' && draftRef.current) {
        event.preventDefault();
        finishPolygon();
        return;
      }
      if (event.key === 'Enter' && livewireRef.current) {
        event.preventDefault();
        finishLivewire();
        return;
      }
      const state = useViewer.getState();
      if (!state.image) {
        return;
      }
      const action = keyToAction(event, {
        hasSelection: useRois.getState().selectedIds.length > 0,
        drawing: draftRef.current !== null || livewireRef.current !== null,
        view: state.viewSize,
      });
      if (!action) {
        return;
      }
      event.preventDefault();
      const current = draftRef.current;
      if (action.kind === 'cancel' && livewireRef.current) {
        cancelLivewire();
      } else if (action.kind === 'removeLastVertex' && livewireRef.current) {
        removeLastLivewire();
      } else if (action.kind === 'cancel' && current) {
        setDraft(null);
      } else if (action.kind === 'removeLastVertex' && current) {
        const points = current.points.slice(0, -1);
        setDraft(points.length > 0 ? { ...current, points } : null);
      } else {
        runAppAction(action);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        setSpaceHeld(false);
      }
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [finishPolygon, setDraft, finishLivewire, cancelLivewire, removeLastLivewire, livewireRef]);

  // Cancel a pending pixel lookup when the image changes
  useEffect(() => {
    const lookup = pixelLookup.current;
    return () => {
      window.clearTimeout(lookup.timer);
      lookup.controller?.abort();
    };
  }, [image]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = useViewer.getState();
    if (!state.image) {
      return;
    }
    const local = localPoint(event.clientX, event.clientY);
    const point = screenToImage(state.viewport, local);
    const capture = () => event.currentTarget.setPointerCapture(event.pointerId);

    const panGesture = event.button === 1 || (event.button === 0 && (tool === 'pan' || spaceHeld));
    if (panGesture) {
      event.preventDefault();
      capture();
      setGesture({ kind: 'pan', pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY });
      return;
    }
    if (event.button !== 0) {
      return;
    }

    const roiStore = useRois.getState();
    switch (tool) {
      case 'rectangle':
      case 'ellipse':
        capture();
        roiStore.setActiveShape(null);
        setGesture({ kind: 'drag', pointerId: event.pointerId, tool, start: point });
        return;
      case 'freehand':
        capture();
        roiStore.setActiveShape(null);
        setGesture({ kind: 'freehand', pointerId: event.pointerId, path: [[point.x, point.y]] });
        return;
      case 'polygon': {
        const current = draftRef.current;
        if (!current) {
          // Double-clicking the first vertex: the first click closed the polygon, and this second click must neither
          // discard it nor start a new one
          const closed = polygonClosedRef.current;
          if (closed && event.timeStamp - closed.time < DOUBLE_CLICK_MS && Math.hypot(closed.x - local.x, closed.y - local.y) <= CLOSE_DISTANCE) {
            return;
          }
          roiStore.setActiveShape(null);
          setDraft({ points: [[point.x, point.y]], cursor: point });
          return;
        }
        const first = imageToScreen(state.viewport, { x: current.points[0][0], y: current.points[0][1] });
        if (current.points.length >= 3 && Math.hypot(first.x - local.x, first.y - local.y) <= CLOSE_DISTANCE) {
          polygonClosedRef.current = { x: local.x, y: local.y, time: event.timeStamp };
          finishPolygon();
          return;
        }
        setDraft({ points: [...current.points, [point.x, point.y]], cursor: point });
        return;
      }
      case 'brush':
      case 'eraser': {
        capture();
        const path: Array<[number, number]> = [[point.x, point.y]];
        setGesture({ kind: 'brush', pointerId: event.pointerId, erase: tool === 'eraser', path });
        setBrushStroke({ path, erase: tool === 'eraser' });
        return;
      }
      case 'livewire': {
        const pixel = pixelAt(state.viewport, local, state.image.info);
        if (!pixel) {
          return;
        }
        const current = livewire.draftRef.current;
        if (!current) {
          const closed = polygonClosedRef.current;
          if (closed && event.timeStamp - closed.time < DOUBLE_CLICK_MS && Math.hypot(closed.x - local.x, closed.y - local.y) <= CLOSE_DISTANCE) {
            return;
          }
          livewire.addPoint(pixel);
          return;
        }
        const first = imageToScreen(state.viewport, { x: current.anchors[0].x + 0.5, y: current.anchors[0].y + 0.5 });
        if (current.anchors.length >= 3 && Math.hypot(first.x - local.x, first.y - local.y) <= CLOSE_DISTANCE) {
          polygonClosedRef.current = { x: local.x, y: local.y, time: event.timeStamp };
          livewire.finish();
          return;
        }
        livewire.addPoint(pixel);
        return;
      }
      case 'wand': {
        const pixel = pixelAt(state.viewport, local, state.image.info);
        if (pixel) {
          roiStore.setActiveShape(null);
          void wandAt(state.image.info.imageId, pixel.x, pixel.y);
        }
        return;
      }
      case 'ruler':
        capture();
        state.setRuler({ start: point, end: point });
        setGesture({ kind: 'ruler', pointerId: event.pointerId, start: point });
        return;
      case 'pointer': {
        const hit = hitTest(local);
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        if (!hit) {
          if (!additive) {
            roiStore.select([]);
          }
          return;
        }
        if (hit.kind === 'transformer') {
          return;
        }
        if (hit.kind === 'vertex') {
          const roi = roiStore.rois.find((candidate) => candidate.id === hit.roiId);
          if (event.altKey) {
            if (roi?.shape.type === 'polygon') {
              roiStore.replaceShape(roi.id, removeVertex(roi.shape, hit.index));
            }
            return;
          }
          capture();
          roiStore.beginEdit();
          setGesture({ kind: 'vertex', pointerId: event.pointerId, roiId: hit.roiId, index: hit.index });
          return;
        }
        if (additive) {
          roiStore.toggleSelected(hit.roiId);
          return;
        }
        if (!roiStore.selectedIds.includes(hit.roiId)) {
          roiStore.select([hit.roiId]);
        }
        const selected = new Set(useRois.getState().selectedIds);
        capture();
        roiStore.beginEdit();
        setGesture({
          kind: 'move',
          pointerId: event.pointerId,
          start: point,
          shapes: new Map(roiStore.rois.filter((roi) => selected.has(roi.id)).map((roi) => [roi.id, roi.shape])),
        });
        return;
      }
      default:
        return;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = useViewer.getState();
    updatePixelReadout(event.clientX, event.clientY);
    if (!state.image) {
      return;
    }
    const local = localPoint(event.clientX, event.clientY);
    lastPointerRef.current = local;
    const point = screenToImage(state.viewport, local);
    const gesture = gestureRef.current;
    const roiStore = useRois.getState();

    if (gesture && gesture.pointerId === event.pointerId) {
      switch (gesture.kind) {
        case 'pan':
          state.panBy(event.clientX - gesture.lastX, event.clientY - gesture.lastY);
          gesture.lastX = event.clientX;
          gesture.lastY = event.clientY;
          break;
        case 'drag':
          roiStore.setActiveShape(
            gesture.tool === 'rectangle' ? rectangleFromDrag(gesture.start, point, event.shiftKey) : ellipseFromDrag(gesture.start, point, event.shiftKey),
          );
          break;
        case 'freehand':
          gesture.path.push([point.x, point.y]);
          roiStore.setActiveShape({ type: 'polygon', points: [...gesture.path], freehand: true });
          break;
        case 'move': {
          const dx = point.x - gesture.start.x;
          const dy = point.y - gesture.start.y;
          for (const [id, shape] of gesture.shapes) {
            roiStore.updateShapeLive(id, translateShape(shape, dx, dy));
          }
          break;
        }
        case 'vertex': {
          const roi = roiStore.rois.find((candidate) => candidate.id === gesture.roiId);
          if (roi?.shape.type === 'polygon') {
            roiStore.updateShapeLive(roi.id, moveVertex(roi.shape, gesture.index, point));
          }
          break;
        }
        case 'ruler':
          state.setRuler({ start: gesture.start, end: event.shiftKey ? snapRuler(gesture.start, point) : point });
          break;
        case 'brush': {
          const [lastX, lastY] = gesture.path[gesture.path.length - 1];
          // Points closer than a quarter pixel add nothing to the stroke
          if (Math.hypot(point.x - lastX, point.y - lastY) >= 0.25) {
            gesture.path.push([point.x, point.y]);
            setBrushStroke({ path: [...gesture.path], erase: gesture.erase });
          }
          break;
        }
      }
      return;
    }

    if (draftRef.current) {
      setDraft({ ...draftRef.current, cursor: point });
    }
    if (tool === 'livewire' && livewire.draftRef.current) {
      livewire.move(pixelAt(state.viewport, local, state.image.info));
    }
    if (tool === 'pointer') {
      const hit = hitTest(local);
      updateRoiHover(hit && hit.kind !== 'transformer' ? hit.roiId : null, local);
    }
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    setGesture(null);
    const roiStore = useRois.getState();
    switch (gesture.kind) {
      case 'drag': {
        const active = roiStore.activeShape;
        if (active && !isDrawableShape(active)) {
          roiStore.setActiveShape(null);
        }
        break;
      }
      case 'freehand': {
        const shape = freehandFromPath(gesture.path);
        roiStore.setActiveShape(isDrawableShape(shape) ? shape : null);
        break;
      }
      case 'move':
      case 'vertex':
        roiStore.endEdit();
        break;
      case 'brush': {
        const { path } = gesture;
        // The stroke stays visible until the changed ROI arrives
        void applyBrushStroke(path, gesture.erase).finally(() => setBrushStroke((current) => (current?.path[0] === path[0] ? null : current)));
        break;
      }
      case 'ruler': {
        // A click without a drag removes the ruler
        const { ruler, setRuler } = useViewer.getState();
        if (ruler && ruler.start.x === ruler.end.x && ruler.start.y === ruler.end.y) {
          setRuler(null);
        }
        break;
      }
      default:
        break;
    }
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const state = useViewer.getState();
    if (!state.image) {
      return;
    }
    if (tool === 'polygon') {
      finishPolygon();
      return;
    }
    if (tool === 'livewire') {
      livewire.finish();
      return;
    }
    if (tool === 'pointer') {
      const local = localPoint(event.clientX, event.clientY);
      const hit = hitTest(local);
      const roiStore = useRois.getState();
      const roi = hit?.kind === 'roi' ? roiStore.rois.find((candidate) => candidate.id === hit.roiId) : undefined;
      if (roi?.shape.type === 'polygon' && !hasCuts(roi.shape.points) && roiStore.selectedIds.length === 1 && roiStore.selectedIds[0] === roi.id) {
        roiStore.replaceShape(roi.id, insertVertex(roi.shape, screenToImage(state.viewport, local)));
      }
    }
  };

  let cursor = 'default';
  if (image) {
    if (gestureKind === 'pan') {
      cursor = 'grabbing';
    } else if (tool === 'pan' || spaceHeld) {
      cursor = 'grab';
    } else if (gestureKind === 'move' || (tool === 'pointer' && hoveredId)) {
      cursor = 'move';
    } else {
      cursor = 'crosshair';
    }
  }
  const info = image?.info;
  const tooltipRoi = tooltip ? rois.find((roi) => roi.id === tooltip.roiId) : undefined;
  const tooltipStatistics = tooltipRoi ? statistics.get(tooltipRoi.id) : undefined;
  const pixelSpacing = useViewer((state) => state.pixelSpacing);

  return (
    <div
      ref={containerRef}
      className="canvas-area"
      data-cursor={cursor}
      data-testid="image-canvas"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onDoubleClick={onDoubleClick}
      onPointerLeave={() => {
        lastPointerRef.current = null;
        if (!gestureRef.current) {
          if (useViewer.getState().hover) {
            useViewer.getState().setHover(null);
          }
          updateRoiHover(null, { x: 0, y: 0 });
        }
      }}
      onAuxClick={(event) => event.preventDefault()}
    >
      {viewSize.width > 0 && viewSize.height > 0 && (
        <Stage ref={stageRef} className="canvas-stage" width={viewSize.width} height={viewSize.height}>
          {/* Sharp pixels when magnified; smoothing only when the image is shown smaller than its size */}
          <Layer imageSmoothingEnabled={viewport.scale < 1} listening={false}>
            {info && displaySource && (
              <KonvaImage
                ref={imageNodeRef}
                image={displaySource}
                x={viewport.x}
                y={viewport.y}
                width={info.width}
                height={info.height}
                scaleX={viewport.scale}
                scaleY={viewport.scale}
                listening={false}
                perfectDrawEnabled={false}
              />
            )}
          </Layer>
          {info && <EdgeMapLayer viewport={viewport} imageId={info.imageId} width={info.width} height={info.height} />}
          {info && <FeatureMapLayer viewport={viewport} imageWidth={info.width} imageHeight={info.height} />}
          {info && <RoiLayer viewport={viewport} draft={draft ?? (livewire.draft ? { ...livewireDraftPoints(livewire.draft), cursor: null } : null)} interactive={tool === 'pointer' && !spaceHeld} />}
          {info && brushStroke && <BrushStrokeLayer viewport={viewport} stroke={brushStroke} size={brushSize} />}
          {info && <RulerLayer viewport={viewport} />}
        </Stage>
      )}
      {tooltip && tooltipRoi && (
        <div className="roi-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y + 14 }} data-testid="roi-tooltip">
          <strong>{tooltipRoi.name}</strong>
          <span>{SHAPE_LABELS[shapeKind(tooltipRoi.shape)]}</span>
          <span className="mono">
            {tooltipStatistics ? `${tooltipStatistics.pixelCount.toLocaleString()} px` : '… px'}
            {tooltipStatistics && pixelSpacing ? ` · ${formatArea(areaMm2(tooltipStatistics.pixelCount, pixelSpacing))}` : ''}
          </span>
          {roiProblem(tooltipStatistics) && <span className="roi-tooltip-warning">⚠ {roiProblem(tooltipStatistics)}</span>}
        </div>
      )}
      <Navigator />
    </div>
  );
}
