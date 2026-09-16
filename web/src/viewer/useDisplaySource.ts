// Keeps viewerStore.displaySource up to date with the current image and window (doc/ui-design-plan.md, 6.1):
// raw images are rendered in the browser, other images are fetched as display.png.

import { notifications } from '@mantine/notifications';
import { useEffect, useRef, useState } from 'react';
import { fetchDisplayBlob } from '../api/client';
import { BlobUrlCache } from '../image/blobUrlCache';
import { colorizeRgba, colorTableById } from '../image/colorTables';
import type { RawImage } from '../image/raw';
import { createRenderer, type ImageRenderer } from '../image/renderer';
import { usePreferences } from '../stores/preferences';
import { useViewer } from '../stores/viewerStore';

const DISPLAY_DEBOUNCE_MS = 150;
const displayUrls = new BlobUrlCache(20);

export function useDisplaySource(): void {
  const image = useViewer((state) => state.image);
  const windowRange = useViewer((state) => state.window);
  const colorTable = useViewer((state) => state.colorTable);
  const useWebGl = usePreferences((state) => state.useWebGl);
  // The renderer with the image it was made for: until the effect below replaces it, the renderer of the previous image
  // must not receive the samples of the next one, which may have another size
  const [current, setRenderer] = useState<{ renderer: ImageRenderer; imageId: string } | null>(null);
  // The samples each renderer holds, so they are uploaded again only when the slice changes, not with every window change
  const shownSamples = useRef(new WeakMap<ImageRenderer, RawImage>());
  const [rendererFailed, setRendererFailed] = useState(false);
  // The image whose WebGL context was lost (GPU reset, driver update, too many contexts). It is rendered with the
  // lookup table from then on; the next image tries WebGL again.
  const [contextLostImage, setContextLostImage] = useState<string | null>(null);
  const imageId = image?.info.imageId ?? null;
  const webGlLost = imageId !== null && contextLostImage === imageId;
  const hasRaw = image?.raw != null;
  const slice = image?.slice ?? 1;

  // One renderer per image with raw samples; the slices of a stack replace its samples
  useEffect(() => {
    setRendererFailed(false);
    const raw = useViewer.getState().image?.raw;
    if (!hasRaw || !raw) {
      setRenderer(null);
      return;
    }
    let created: ImageRenderer;
    try {
      created = createRenderer(raw, {
        allowWebGl: useWebGl && !webGlLost,
        onContextLost: () => {
          console.warn('The WebGL context was lost; using the lookup-table renderer');
          setContextLostImage(imageId);
        },
      });
    } catch (error) {
      console.warn('No browser renderer available; using server rendering', error);
      setRenderer(null);
      setRendererFailed(true);
      return;
    }
    shownSamples.current.set(created, raw);
    setRenderer({ renderer: created, imageId: imageId! });
    return () => {
      if (useViewer.getState().displaySource === created.canvas) {
        useViewer.getState().setDisplaySource(null, null);
      }
      created.dispose();
    };
  }, [imageId, hasRaw, useWebGl, webGlLost]);

  // Redraw at most once per frame when the window, the colour table or the slice changes
  const raw = image?.raw ?? null;
  const renderer = current?.imageId === imageId ? current.renderer : null;
  useEffect(() => {
    if (!renderer || !raw) {
      return;
    }
    if (shownSamples.current.get(renderer) !== raw) {
      renderer.setSamples(raw);
      shownSamples.current.set(renderer, raw);
    }
    const frame = requestAnimationFrame(() => {
      renderer.render(windowRange.min, windowRange.max, colorTableById(colorTable).rgb);
      useViewer.getState().setDisplaySource(renderer.canvas, renderer.kind);
    });
    return () => cancelAnimationFrame(frame);
  }, [renderer, raw, windowRange, colorTable]);

  // display.png for images without raw samples
  const serverRendering = image !== null && (image.raw === null || rendererFailed);
  useEffect(() => {
    if (!image || !serverRendering) {
      return;
    }
    const { min, max } = windowRange;
    const key = `${image.info.imageId}:${slice}:${min}:${max}`;
    const controller = new AbortController();

    // display.png is gray; other colour tables are applied in the browser, so the server rendering stays the same
    const show = (url: string) => {
      const element = new Image();
      element.onload = () => {
        if (controller.signal.aborted || useViewer.getState().image?.info.imageId !== image.info.imageId || useViewer.getState().image?.slice !== image.slice) {
          return;
        }
        const table = colorTableById(colorTable);
        const canvas = document.createElement('canvas');
        const context = table.id === 'gray' ? null : canvas.getContext('2d');
        if (!context) {
          useViewer.getState().setDisplaySource(element, 'server');
          return;
        }
        canvas.width = element.naturalWidth;
        canvas.height = element.naturalHeight;
        context.drawImage(element, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        colorizeRgba(pixels.data, table);
        context.putImageData(pixels, 0, 0);
        useViewer.getState().setDisplaySource(canvas, 'server');
      };
      element.src = url;
    };

    const cached = displayUrls.get(key);
    if (cached) {
      show(cached);
      return () => controller.abort();
    }

    // The first rendering is requested at once; window changes are debounced
    const delay = useViewer.getState().displaySource ? DISPLAY_DEBOUNCE_MS : 0;
    const timer = window.setTimeout(async () => {
      try {
        const blob = await fetchDisplayBlob(image.info.imageId, { min, max, slice }, controller.signal);
        show(displayUrls.set(key, blob));
      } catch (error) {
        if (!controller.signal.aborted) {
          notifications.show({ color: 'red', title: 'Could not render the image', message: (error as Error).message });
        }
      }
    }, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [image, slice, serverRendering, windowRange, colorTable]);
}
