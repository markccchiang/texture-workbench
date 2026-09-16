// The edge map over the image: a PNG from the server (reduced for large images) drawn at the image's size. Canny edges are
// drawn in cyan and the rest is transparent; the Sobel magnitude is white with its value as the opacity.

import type { EdgeMethod } from '@glcm/api';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Image as KonvaImage, Layer } from 'react-konva';
import { fetchEdgeMap, getGradientStats } from '../api/client';
import { sliceField, useViewer } from '../stores/viewerStore';
import { autoEdgeLimits, roundLimit, useEdgeMap } from './edgeMap';
import type { Viewport } from './viewport';

const EDGE_COLOR: [number, number, number] = [0, 229, 255];

async function colourEdgeMap(blob: Blob, method: EdgeMethod): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const value = data[i];
    if (method === 'canny') {
      [data[i], data[i + 1], data[i + 2]] = EDGE_COLOR;
      data[i + 3] = value > 0 ? 255 : 0;
    } else {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = value;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** The gradient statistics of an image at a smoothing, shared by the layer and the card */
export function useGradientStats(imageId: string | null, sigma: number, enabled: boolean) {
  const slice = useViewer((state) => state.image?.slice ?? 1);
  return useQuery({
    queryKey: ['gradient-stats', imageId, slice, sigma],
    queryFn: ({ signal }) => getGradientStats(imageId!, sigma, signal, slice),
    enabled: enabled && imageId !== null,
    staleTime: Infinity,
  });
}

export function EdgeMapLayer({ viewport, imageId, width, height }: { viewport: Viewport; imageId: string; width: number; height: number }) {
  const shown = useEdgeMap((state) => state.shown);
  const method = useEdgeMap((state) => state.method);
  const sigma = useEdgeMap((state) => state.sigma);
  const chosen = useEdgeMap((state) => state.limits);
  const opacity = useEdgeMap((state) => state.opacity);
  const statistics = useGradientStats(imageId, sigma, shown);
  const slice = useViewer((state) => state.image?.slice ?? 1);
  const automatic = statistics.data ? autoEdgeLimits(method, statistics.data) : null;
  const limits = chosen ?? automatic;
  const [request] = useDebouncedValue(limits ? { method, sigma, low: roundLimit(limits.low), high: roundLimit(limits.high) } : null, 250);

  const map = useQuery({
    queryKey: ['edge-map', imageId, slice, request],
    queryFn: async ({ signal }) => colourEdgeMap(await fetchEdgeMap(imageId, { ...request!, ...sliceField(slice) }, signal), request!.method),
    enabled: shown && request !== null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

  if (!shown || !map.data) {
    return null;
  }
  return (
    <Layer listening={false} imageSmoothingEnabled={viewport.scale < 1}>
      <KonvaImage
        image={map.data}
        x={viewport.x}
        y={viewport.y}
        width={width}
        height={height}
        scaleX={viewport.scale}
        scaleY={viewport.scale}
        opacity={opacity}
        listening={false}
        perfectDrawEnabled={false}
      />
    </Layer>
  );
}
