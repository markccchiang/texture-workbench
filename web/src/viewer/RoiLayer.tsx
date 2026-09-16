// ROI overlay of the image canvas (doc/ui-design-plan.md, section 6.2). Shapes are drawn in image coordinates inside a
// group scaled by the viewport, with strokes, handles and labels at a constant screen size. Pointer interaction is
// handled by ImageCanvas through hit tests on the node names used here ("roi", "roi-vertex").

import type { RoiShape } from '@glcm/api';
import type Konva from 'konva';
import { useEffect, useMemo, useRef } from 'react';
import { Circle, Ellipse, Group, Layer, Line, Rect, Shape, Text, Transformer } from 'react-konva';
import { cutEdges, hasCuts } from '../rois/geometry';
import { isOnSlice, useRois } from '../rois/roiStore';
import { useUi } from '../stores/uiStore';
import { imageToScreen, type Point, type Viewport } from './viewport';

export const ROI_NODE_NAME = 'roi';
export const VERTEX_NODE_NAME = 'roi-vertex';
const VERTEX_RADIUS = 4;
const ACTIVE_COLOR = '#FFFFFF';

export interface PolygonDraft {
  points: Array<[number, number]>;
  cursor: Point | null;
  /** Points marked with dots; the points themselves when absent (livewire drafts mark only the clicked anchors) */
  anchors?: Array<[number, number]>;
}

interface ShapeNodeProps {
  shape: RoiShape;
  color: string;
  id?: string;
  name?: string;
  strokeWidth: number;
  dash?: number[];
  fill?: string;
  listening: boolean;
  nodeRef?: (node: Konva.Shape | null) => void;
}

function ShapeNode({ shape, color, id, name, strokeWidth, dash, fill, listening, nodeRef }: ShapeNodeProps) {
  const common = {
    id,
    name,
    stroke: color,
    strokeWidth,
    strokeScaleEnabled: false,
    dash,
    // An invisible fill makes the inside clickable
    fill: fill ?? 'rgba(0, 0, 0, 0)',
    hitStrokeWidth: 10,
    listening,
    perfectDrawEnabled: false,
    shadowForStrokeEnabled: false,
  };
  switch (shape.type) {
    case 'rectangle':
      return (
        <Rect
          ref={nodeRef}
          x={Math.min(shape.x, shape.x + shape.width)}
          y={Math.min(shape.y, shape.y + shape.height)}
          width={Math.abs(shape.width)}
          height={Math.abs(shape.height)}
          {...common}
        />
      );
    case 'ellipse':
      return <Ellipse ref={nodeRef} x={shape.cx} y={shape.cy} radiusX={shape.rx} radiusY={shape.ry} rotation={shape.angle ?? 0} {...common} />;
    case 'polygon': {
      const cuts = cutEdges(shape.points);
      if (!cuts.some(Boolean)) {
        return <Line ref={nodeRef} points={shape.points.flat()} closed {...common} />;
      }
      // Parts and holes joined by cuts (brush, eraser, union, subtract): the whole outline is filled with the even-odd rule,
      // which leaves the holes clear, and only the edges that are not cuts are stroked
      const { points } = shape;
      return (
        <Shape
          ref={nodeRef}
          fillRule="evenodd"
          {...common}
          sceneFunc={(context, node) => {
            context.beginPath();
            points.forEach(([x, y], i) => (i === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
            context.closePath();
            context.fillShape(node);
            context.beginPath();
            points.forEach(([x, y], i) => {
              if (!cuts[i]) {
                const [nextX, nextY] = points[(i + 1) % points.length];
                context.moveTo(x, y);
                context.lineTo(nextX, nextY);
              }
            });
            context.strokeShape(node);
          }}
        />
      );
    }
  }
}

export function RoiLayer({ viewport, draft, interactive }: { viewport: Viewport; draft: PolygonDraft | null; interactive: boolean }) {
  const allRois = useRois((state) => state.rois);
  const currentSlice = useRois((state) => state.currentSlice);
  // Only the ROIs of the slice shown
  const rois = useMemo(() => allRois.filter((roi) => isOnSlice(roi, currentSlice)), [allRois, currentSlice]);
  const selectedIds = useRois((state) => state.selectedIds);
  const hoveredId = useRois((state) => state.hoveredId);
  const activeShape = useRois((state) => state.activeShape);
  const showLabels = useUi((state) => state.showRoiLabels);

  const transformerRef = useRef<Konva.Transformer>(null);
  const nodes = useRef(new Map<string, Konva.Shape>());

  const single = selectedIds.length === 1 ? rois.find((roi) => roi.id === selectedIds[0] && roi.visible) : undefined;
  const transformable = interactive && single && single.shape.type !== 'polygon' ? single : undefined;
  // Polygons joined by cuts change as a whole (brush, eraser), so they get no vertex handles
  const editablePolygon = interactive && single?.shape.type === 'polygon' && !hasCuts(single.shape.points) ? single : undefined;

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) {
      return;
    }
    const node = transformable ? nodes.current.get(transformable.id) : undefined;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [transformable, viewport]);

  const onTransformEnd = () => {
    const node = transformerRef.current?.nodes()[0];
    if (!node || !transformable) {
      return;
    }
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scale({ x: 1, y: 1 });
    let shape: RoiShape;
    if (transformable.shape.type === 'ellipse') {
      const ellipse = node as Konva.Ellipse;
      shape = {
        type: 'ellipse',
        cx: ellipse.x(),
        cy: ellipse.y(),
        rx: ellipse.radiusX() * Math.abs(scaleX),
        ry: ellipse.radiusY() * Math.abs(scaleY),
        angle: Number(ellipse.rotation().toFixed(4)),
      };
    } else {
      shape = { type: 'rectangle', x: node.x(), y: node.y(), width: node.width() * Math.abs(scaleX), height: node.height() * Math.abs(scaleY) };
    }
    const store = useRois.getState();
    store.updateShapeLive(transformable.id, shape);
    store.endEdit();
  };

  const draftPoints = draft ? [...draft.points.flat(), ...(draft.cursor ? [draft.cursor.x, draft.cursor.y] : [])] : [];

  return (
    <Layer>
      <Group x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={viewport.scale}>
        {rois
          .filter((roi) => roi.visible)
          .map((roi) => {
            const selected = selectedIds.includes(roi.id);
            const hovered = hoveredId === roi.id;
            return (
              <ShapeNode
                key={roi.id}
                id={roi.id}
                name={ROI_NODE_NAME}
                shape={roi.shape}
                color={roi.color}
                strokeWidth={selected || hovered ? 2.5 : 1.5}
                fill={selected ? `${roi.color}26` : hovered ? `${roi.color}14` : undefined}
                listening={interactive}
                nodeRef={(node) => {
                  if (node) {
                    nodes.current.set(roi.id, node);
                  } else {
                    nodes.current.delete(roi.id);
                  }
                }}
              />
            );
          })}
        {activeShape && <ShapeNode shape={activeShape} color={ACTIVE_COLOR} strokeWidth={1.5} dash={[6, 4]} listening={false} />}
        {draft && <Line points={draftPoints} stroke={ACTIVE_COLOR} strokeWidth={1.5} strokeScaleEnabled={false} dash={[6, 4]} listening={false} />}
        {draft &&
          (draft.anchors ?? draft.points).map(([x, y], index) => (
            <Circle key={index} x={x} y={y} radius={(index === 0 ? VERTEX_RADIUS + 1 : 2.5) / viewport.scale} fill={ACTIVE_COLOR} listening={false} />
          ))}
        {editablePolygon?.shape.type === 'polygon' &&
          editablePolygon.shape.points.map(([x, y], index) => (
            <Circle
              key={index}
              name={VERTEX_NODE_NAME}
              roiId={editablePolygon.id}
              vertexIndex={index}
              x={x}
              y={y}
              radius={VERTEX_RADIUS / viewport.scale}
              fill="#FFFFFF"
              stroke={editablePolygon.color}
              strokeWidth={1.5}
              strokeScaleEnabled={false}
              hitStrokeWidth={6}
            />
          ))}
      </Group>

      {showLabels &&
        rois
          .filter((roi) => roi.visible)
          .map((roi) => {
            const anchor = labelAnchor(roi.shape);
            const screen = imageToScreen(viewport, anchor);
            return (
              <Text
                key={roi.id}
                x={screen.x}
                y={screen.y - 16}
                text={roi.name}
                fontSize={12}
                fill={roi.color}
                shadowColor="#000000"
                shadowBlur={3}
                shadowOpacity={0.9}
                listening={false}
              />
            );
          })}

      <Transformer
        ref={transformerRef}
        rotateEnabled={transformable?.shape.type === 'ellipse'}
        keepRatio={false}
        flipEnabled={false}
        ignoreStroke
        anchorSize={8}
        anchorStroke="#228be6"
        borderStroke="#FFFFFF"
        borderDash={[4, 3]}
        boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 2 || Math.abs(newBox.height) < 2 ? oldBox : newBox)}
        onTransformStart={() => useRois.getState().beginEdit()}
        onTransformEnd={onTransformEnd}
      />
    </Layer>
  );
}

/** Top-left point of the shape's bounds, where its label goes */
function labelAnchor(shape: RoiShape): Point {
  switch (shape.type) {
    case 'rectangle':
      return { x: Math.min(shape.x, shape.x + shape.width), y: Math.min(shape.y, shape.y + shape.height) };
    case 'ellipse':
      return { x: shape.cx - Math.max(shape.rx, shape.ry), y: shape.cy - Math.max(shape.rx, shape.ry) };
    case 'polygon':
      return shape.points.length === 0
        ? { x: 0, y: 0 }
        : { x: Math.min(...shape.points.map(([x]) => x)), y: Math.min(...shape.points.map(([, y]) => y)) };
  }
}
