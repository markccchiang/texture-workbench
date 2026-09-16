// The feature map over the image, one block of step × step image pixels per grid point, clipped to the image. It does not
// take pointer input.

import { useMemo } from 'react';
import { Image as KonvaImage, Layer } from 'react-konva';
import { colorTableById } from '../image/colorTables';
import type { Viewport } from '../viewer/viewport';
import { useViewer } from '../stores/viewerStore';
import { useFeatureMap } from './featureMapStore';
import { renderMapRgba } from './mapImage';

export function FeatureMapLayer({ viewport, imageWidth, imageHeight }: { viewport: Viewport; imageWidth: number; imageHeight: number }) {
  const info = useFeatureMap((state) => state.map?.info ?? null);
  const values = useFeatureMap((state) => state.map?.values ?? null);
  const window = useFeatureMap((state) => state.map?.window ?? null);
  const colorTable = useFeatureMap((state) => state.map?.colorTable ?? 'viridis');
  const opacity = useFeatureMap((state) => state.map?.opacity ?? 1);
  const visible = useFeatureMap((state) => state.map?.visible ?? false);
  // A map of a stack covers one slice
  const slice = useViewer((state) => state.image?.slice ?? 1);
  const columns = info?.columns ?? 0;
  const rows = info?.rows ?? 0;

  const canvas = useMemo(() => {
    if (!values || !window || columns === 0 || rows === 0) {
      return null;
    }
    const target = document.createElement('canvas');
    target.width = columns;
    target.height = rows;
    target.getContext('2d')!.putImageData(new ImageData(renderMapRgba(values, window, colorTableById(colorTable)), columns, rows), 0, 0);
    return target;
  }, [values, window, colorTable, columns, rows]);

  if (!info || !canvas || !visible || (info.slice ?? 1) !== slice) {
    return null;
  }
  return (
    <Layer
      listening={false}
      imageSmoothingEnabled={false}
      clipX={viewport.x}
      clipY={viewport.y}
      clipWidth={imageWidth * viewport.scale}
      clipHeight={imageHeight * viewport.scale}
    >
      <KonvaImage
        image={canvas}
        x={viewport.x}
        y={viewport.y}
        width={columns * info.step}
        height={rows * info.step}
        scaleX={viewport.scale}
        scaleY={viewport.scale}
        opacity={opacity}
        listening={false}
        perfectDrawEnabled={false}
      />
    </Layer>
  );
}
