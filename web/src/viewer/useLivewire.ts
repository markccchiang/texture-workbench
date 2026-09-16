// The livewire tool: clicked anchors joined by paths along strong edges. Each segment is computed on the server when its
// anchor is added (or taken from the preview that the pointer already requested); closing adds the segment back to the
// first anchor and makes the joined outline the active ROI.

import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { livewirePath } from '../api/client';
import { shownSlice, sliceField } from '../stores/viewerStore';
import { joinSegments, pixelCentre, type LivewireSegment } from '../rois/livewire';
import { regionShape } from '../rois/regions';
import { useRois } from '../rois/roiStore';
import { useEdgeMap } from './edgeMap';
import type { Point } from './viewport';

const PREVIEW_DELAY_MS = 80;

export interface LivewireDraft {
  /** Clicked pixels */
  anchors: Point[];
  /** segments[i] joins anchor i to anchor i + 1 (the last one, when closing, back to anchor 0); null while computing */
  segments: Array<LivewireSegment | null>;
  /** Path from the last anchor to the pixel under the pointer */
  preview: { target: Point; points: LivewireSegment } | null;
  /** Pixel under the pointer */
  cursor: Point | null;
  closing: boolean;
}

/** The points to draw for a draft (straight lines stand in for segments still being computed) and its anchor centres */
export function livewireDraftPoints(draft: LivewireDraft): { points: Array<[number, number]>; anchors: Array<[number, number]> } {
  const anchors = draft.anchors.map(pixelCentre);
  const pieces: LivewireSegment[] = [[anchors[0]]];
  const segmentCount = draft.closing ? draft.anchors.length : draft.anchors.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const end = anchors[(i + 1) % anchors.length];
    pieces.push(draft.segments[i] ?? [end]);
  }
  if (!draft.closing && draft.cursor) {
    const samePixel = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
    pieces.push(draft.preview && samePixel(draft.preview.target, draft.cursor) ? draft.preview.points : [pixelCentre(draft.cursor)]);
  }
  return { points: joinSegments(pieces, false), anchors };
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

export function useLivewire(imageId: string | null) {
  const [draft, setDraftState] = useState<LivewireDraft | null>(null);
  const draftRef = useRef<LivewireDraft | null>(null);
  const imageRef = useRef(imageId);
  const generation = useRef(0);
  const previewTimer = useRef<number | undefined>(undefined);
  const previewAbort = useRef<AbortController | null>(null);

  const update = useCallback((next: LivewireDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const stopPreview = useCallback(() => {
    window.clearTimeout(previewTimer.current);
    previewAbort.current?.abort();
    previewAbort.current = null;
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    stopPreview();
    update(null);
  }, [stopPreview, update]);

  const request = useCallback((from: Point, to: Point, signal?: AbortSignal) => {
    return livewirePath(imageRef.current!, { from, to, sigma: useEdgeMap.getState().sigma, ...sliceField(shownSlice()) }, signal).then(
      (response) => response.points,
    );
  }, []);

  const completeIfClosed = useCallback(() => {
    const current = draftRef.current;
    if (!current?.closing || current.segments.length !== current.anchors.length || current.segments.some((segment) => segment === null)) {
      return;
    }
    const points = joinSegments(current.segments as LivewireSegment[], true);
    cancel();
    if (points.length >= 3) {
      const { shape, simplified } = regionShape({ points });
      useRois.getState().setActiveShape(shape);
      if (simplified) {
        notifications.show({ color: 'yellow', title: 'Outline simplified', message: 'The livewire outline had too many vertices for an ROI and was simplified.' });
      }
    }
  }, [cancel]);

  const resolveSegment = useCallback(
    (index: number, from: Point, to: Point) => {
      const run = generation.current;
      request(from, to)
        .then((points) => {
          const current = draftRef.current;
          if (run !== generation.current || !current || index >= current.segments.length) {
            return;
          }
          const segments = [...current.segments];
          segments[index] = points;
          update({ ...current, segments });
          completeIfClosed();
        })
        .catch((error: unknown) => {
          const current = draftRef.current;
          if (run !== generation.current || !current) {
            return;
          }
          notifications.show({ color: 'red', title: 'Livewire failed', message: (error as Error).message });
          // Drop the anchor whose segment failed (or stop closing)
          update(
            current.closing && index === current.anchors.length - 1
              ? { ...current, closing: false, segments: current.segments.slice(0, index) }
              : { ...current, anchors: current.anchors.slice(0, index + 1), segments: current.segments.slice(0, index) },
          );
        });
    },
    [completeIfClosed, request, update],
  );

  /** Starts a draft, or adds an anchor to it */
  const addPoint = useCallback(
    (pixel: Point) => {
      const current = draftRef.current;
      if (!imageRef.current || current?.closing) {
        return;
      }
      if (!current) {
        useRois.getState().setActiveShape(null);
        update({ anchors: [pixel], segments: [], preview: null, cursor: pixel, closing: false });
        return;
      }
      const from = current.anchors[current.anchors.length - 1];
      if (same(from, pixel)) {
        return;
      }
      stopPreview();
      const index = current.segments.length;
      const ready = current.preview && same(current.preview.target, pixel) ? current.preview.points : null;
      update({ ...current, anchors: [...current.anchors, pixel], segments: [...current.segments, ready], preview: null });
      if (!ready) {
        resolveSegment(index, from, pixel);
      }
    },
    [resolveSegment, stopPreview, update],
  );

  /** Follows the pointer with a preview path from the last anchor */
  const move = useCallback(
    (pixel: Point | null) => {
      const current = draftRef.current;
      if (!current || current.closing) {
        return;
      }
      if (current.cursor && pixel && same(current.cursor, pixel)) {
        return;
      }
      update({ ...current, cursor: pixel });
      stopPreview();
      if (!pixel) {
        return;
      }
      const from = current.anchors[current.anchors.length - 1];
      const run = generation.current;
      previewTimer.current = window.setTimeout(() => {
        const controller = new AbortController();
        previewAbort.current = controller;
        request(from, pixel, controller.signal)
          .then((points) => {
            const latest = draftRef.current;
            if (run === generation.current && latest && !latest.closing && same(latest.anchors[latest.anchors.length - 1], from)) {
              update({ ...latest, preview: { target: pixel, points } });
            }
          })
          .catch(() => undefined);
      }, PREVIEW_DELAY_MS);
    },
    [request, stopPreview, update],
  );

  /** Closes the outline back to the first anchor; needs at least three anchors */
  const finish = useCallback(() => {
    const current = draftRef.current;
    if (!current || current.closing) {
      return;
    }
    if (current.anchors.length < 3) {
      notifications.show({ color: 'yellow', title: 'Add more points', message: 'A livewire outline needs at least three points.' });
      return;
    }
    stopPreview();
    const index = current.segments.length;
    update({ ...current, closing: true, preview: null, segments: [...current.segments, null] });
    resolveSegment(index, current.anchors[current.anchors.length - 1], current.anchors[0]);
  }, [resolveSegment, stopPreview, update]);

  /** Removes the last anchor, or the whole draft when only one is left */
  const removeLast = useCallback(() => {
    const current = draftRef.current;
    if (!current || current.closing) {
      return;
    }
    if (current.anchors.length <= 1) {
      cancel();
      return;
    }
    stopPreview();
    update({ ...current, anchors: current.anchors.slice(0, -1), segments: current.segments.slice(0, current.anchors.length - 2), preview: null });
  }, [cancel, stopPreview, update]);

  // A draft belongs to one image
  useEffect(() => {
    imageRef.current = imageId;
    cancel();
  }, [imageId, cancel]);

  return { draft, draftRef, addPoint, move, finish, removeLast, cancel };
}
