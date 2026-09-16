// Plot view of the Results panel: one feature per ROI as bars or box plots, per direction as a polar plot, or against
// the distance d. Drawn as plain SVG from the per-direction values of the latest measurement of each ROI.

import { Button, Group, SegmentedControl, Select, Switch, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconDownload } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState, type SVGProps } from 'react';
import { CATALOG_QUERY } from '../api/queryClient';
import { downloadText, fileStem } from '../files/download';
import { roiColor } from '../rois/geometry';
import { useRois } from '../rois/roiStore';
import { useViewer } from '../stores/viewerStore';
import {
  boxStats,
  classSeriesOf,
  directionValues,
  distancesOf,
  isFiniteNumber,
  latestMeasurements,
  niceScale,
  plotFeatures,
  seriesOf,
  type Scale,
  type Series,
} from './plotData';
import { useResults } from './resultsStore';
import { formatValue } from './rows';
import { standaloneSvg } from './svgExport';

export type ChartKind = 'bars' | 'box' | 'polar' | 'distance';

const PAD = { left: 62, right: 14, top: 12, bottom: 34 };
const AXIS = 'var(--mantine-color-default-border)';
const LABEL = 'var(--mantine-color-dimmed)';
const FONT_SIZE = 10;

export type SeriesProps = (series: Series, index: number) => SVGProps<SVGGElement>;

export interface ChartProps {
  width: number;
  height: number;
  series: Series[];
  colors: string[];
  distance: number;
  featureName: string;
  seriesProps: SeriesProps;
}

const linear = (domain: [number, number], range: [number, number]) => (value: number) =>
  range[0] + ((value - domain[0]) / (domain[1] - domain[0] || 1)) * (range[1] - range[0]);

const shorten = (text: string, maxChars: number) => (text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text);

function YAxis({ scale, y, left, right, top, bottom, title }: { scale: Scale; y: (value: number) => number; left: number; right: number; top: number; bottom: number; title: string }) {
  return (
    <g>
      {scale.ticks.map((tick) => (
        <g key={tick}>
          <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke={AXIS} strokeDasharray={tick === 0 ? undefined : '2 3'} />
          <text x={left - 4} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={FONT_SIZE} fill={LABEL}>
            {formatValue(tick)}
          </text>
        </g>
      ))}
      <text transform={`translate(11 ${(top + bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize={FONT_SIZE} fill={LABEL}>
        {title}
      </text>
    </g>
  );
}

function CategoryLabels({ series, x, band, y }: { series: Series[]; x: (index: number) => number; band: number; y: number }) {
  const maxChars = Math.max(3, Math.floor(band / 6));
  return (
    <g>
      {series.map((entry, index) => (
        <text key={entry.key} x={x(index)} y={y} textAnchor="middle" fontSize={FONT_SIZE} fill={LABEL}>
          <title>{entry.label}</title>
          {shorten(entry.label, maxChars)}
        </text>
      ))}
    </g>
  );
}

/** Swatches and labels in rows across the top; returns the height used */
function legendLayout(series: Series[], width: number) {
  let x = PAD.left;
  let row = 0;
  const items = series.map((entry) => {
    const itemWidth = Math.min(entry.label.length, 28) * 6 + 22;
    if (x + itemWidth > width - PAD.right && x > PAD.left) {
      x = PAD.left;
      row += 1;
    }
    const item = { x, y: 4 + row * 14 };
    x += itemWidth;
    return item;
  });
  return { items, height: series.length > 0 ? (row + 1) * 14 + 6 : 0 };
}

function Legend({ series, colors, width, seriesProps }: Pick<ChartProps, 'series' | 'colors' | 'width' | 'seriesProps'>) {
  const { items } = legendLayout(series, width);
  return (
    <g>
      {series.map((entry, index) => (
        <g key={entry.key} {...seriesProps(entry, index)}>
          <rect x={items[index].x} y={items[index].y + 2} width={10} height={8} fill={colors[index]} />
          <text x={items[index].x + 14} y={items[index].y + 6} dy="0.32em" fontSize={FONT_SIZE} fill={LABEL}>
            <title>{entry.label}</title>
            {shorten(entry.label, 28)}
          </text>
        </g>
      ))}
    </g>
  );
}

function BarsChart({ width, height, series, colors, distance, featureName, seriesProps }: ChartProps) {
  const bars = series.map((entry) => {
    const atDistance = entry.measurements.filter((candidate) => candidate.distance === distance);
    if (entry.className !== undefined) {
      // A class: the mean of its ROIs' means, with whiskers over the ROI means
      const means = atDistance.map((measurement) => measurement.values.mean).filter(isFiniteNumber);
      return {
        mean: means.length > 0 ? means.reduce((sum, value) => sum + value, 0) / means.length : null,
        low: means.length > 0 ? Math.min(...means) : null,
        high: means.length > 0 ? Math.max(...means) : null,
        spread: 'ROI means',
      };
    }
    const measurement = atDistance[0];
    const directions = measurement ? directionValues(measurement.values).map(({ value }) => value) : [];
    return {
      mean: measurement && isFiniteNumber(measurement.values.mean) ? measurement.values.mean : null,
      low: directions.length > 0 ? Math.min(...directions) : null,
      high: directions.length > 0 ? Math.max(...directions) : null,
      spread: 'directions',
    };
  });
  const scale = niceScale(bars.flatMap((bar) => [bar.mean, bar.low, bar.high]).filter(isFiniteNumber), { includeZero: true });
  const [left, right, top, bottom] = [PAD.left, width - PAD.right, PAD.top, height - PAD.bottom];
  const y = linear([scale.min, scale.max], [bottom, top]);
  const band = (right - left) / Math.max(series.length, 1);
  const x = (index: number) => left + band * (index + 0.5);
  const barWidth = Math.max(4, Math.min(48, band * 0.6));
  return (
    <g>
      <YAxis scale={scale} y={y} left={left} right={right} top={top} bottom={bottom} title={featureName} />
      {series.map((entry, index) => {
        const bar = bars[index];
        if (bar.mean === null) {
          return null;
        }
        return (
          <g key={entry.key} {...seriesProps(entry, index)}>
            <title>{`${entry.label}: mean ${formatValue(bar.mean)}${bar.low !== null ? `, ${bar.spread} ${formatValue(bar.low)} to ${formatValue(bar.high)}` : ''}`}</title>
            <rect
              data-testid="plot-bar"
              data-value={bar.mean}
              x={x(index) - barWidth / 2}
              y={Math.min(y(bar.mean), y(0))}
              width={barWidth}
              height={Math.max(1, Math.abs(y(bar.mean) - y(0)))}
              fill={colors[index]}
              fillOpacity={0.75}
            />
            {bar.low !== null && bar.high !== null && (
              <path
                d={`M${x(index)} ${y(bar.low)}V${y(bar.high)}M${x(index) - barWidth / 4} ${y(bar.low)}h${barWidth / 2}M${x(index) - barWidth / 4} ${y(bar.high)}h${barWidth / 2}`}
                stroke="var(--mantine-color-text)"
                fill="none"
              />
            )}
          </g>
        );
      })}
      <CategoryLabels series={series} x={x} band={band} y={bottom + 16} />
    </g>
  );
}

function BoxChart({ width, height, series, colors, featureName, seriesProps }: ChartProps) {
  const boxes = series.map((entry) => {
    const values = entry.measurements.flatMap((measurement) => {
      const directions = directionValues(measurement.values).map(({ value }) => value);
      return directions.length > 0 ? directions : [measurement.values.mean].filter(isFiniteNumber);
    });
    return boxStats(values);
  });
  const scale = niceScale(boxes.flatMap((box) => (box ? [box.min, box.max] : [])));
  const [left, right, top, bottom] = [PAD.left, width - PAD.right, PAD.top, height - PAD.bottom];
  const y = linear([scale.min, scale.max], [bottom, top]);
  const band = (right - left) / Math.max(series.length, 1);
  const x = (index: number) => left + band * (index + 0.5);
  const boxWidth = Math.max(6, Math.min(40, band * 0.5));
  return (
    <g>
      <YAxis scale={scale} y={y} left={left} right={right} top={top} bottom={bottom} title={featureName} />
      {series.map((entry, index) => {
        const box = boxes[index];
        if (!box) {
          return null;
        }
        const cx = x(index);
        return (
          <g key={entry.key} {...seriesProps(entry, index)}>
            <title>{`${entry.label}: median ${formatValue(box.median)}, quartiles ${formatValue(box.q1)} to ${formatValue(box.q3)}, range ${formatValue(box.min)} to ${formatValue(box.max)} (${box.count} values)`}</title>
            <path d={`M${cx} ${y(box.min)}V${y(box.q1)}M${cx} ${y(box.q3)}V${y(box.max)}`} stroke={colors[index]} fill="none" />
            <rect
              data-testid="plot-box"
              data-median={box.median}
              x={cx - boxWidth / 2}
              y={y(box.q3)}
              width={boxWidth}
              height={Math.max(1, y(box.q1) - y(box.q3))}
              fill={colors[index]}
              fillOpacity={0.3}
              stroke={colors[index]}
            />
            <line x1={cx - boxWidth / 2} x2={cx + boxWidth / 2} y1={y(box.median)} y2={y(box.median)} stroke={colors[index]} strokeWidth={2} />
          </g>
        );
      })}
      <CategoryLabels series={series} x={x} band={band} y={bottom + 16} />
    </g>
  );
}

/** Direction angles counter-clockwise from the positive x axis; a GLCM counts both neighbours, so θ + 180° is the same */
function PolarChart({ width, height, series, colors, distance, featureName, seriesProps }: ChartProps) {
  const legend = legendLayout(series, width);
  const points = series.map((entry) => {
    const measurement = entry.measurements.find((candidate) => candidate.distance === distance);
    return measurement ? directionValues(measurement.values) : [];
  });
  const scale = niceScale(points.flatMap((list) => list.map(({ value }) => value)));
  const top = PAD.top + legend.height;
  const cx = width / 2;
  const cy = (top + height - 8) / 2;
  const radius = Math.max(10, Math.min(width - 2 * PAD.right, height - 8 - top) / 2 - 16);
  // The inner 15% stays empty, so the smallest value is not drawn as a point at the centre
  const r = (value: number) => radius * (0.15 + 0.85 * ((value - scale.min) / (scale.max - scale.min || 1)));
  const at = (angle: number, distanceFromCentre: number) => {
    const radians = (angle * Math.PI) / 180;
    return [cx + distanceFromCentre * Math.cos(radians), cy - distanceFromCentre * Math.sin(radians)] as const;
  };
  return (
    <g>
      <Legend series={series} colors={colors} width={width} seriesProps={seriesProps} />
      {scale.ticks.map((tick) => {
        // Between the 90° and 135° spokes, clear of the spoke labels
        const [lx, ly] = at(112.5, r(tick));
        return (
          <g key={tick}>
            <circle cx={cx} cy={cy} r={r(tick)} fill="none" stroke={AXIS} strokeDasharray="2 3" />
            <text x={lx} y={ly} dy="0.32em" textAnchor="middle" fontSize={FONT_SIZE - 1} fill={LABEL}>
              {formatValue(tick)}
            </text>
          </g>
        );
      })}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
        const [x2, y2] = at(angle, radius);
        const [lx, ly] = at(angle, radius + 10);
        return (
          <g key={angle}>
            <line x1={cx} y1={cy} x2={x2} y2={y2} stroke={AXIS} strokeDasharray={angle >= 180 ? '1 3' : undefined} />
            {angle < 180 && (
              <text x={lx} y={ly} dy="0.32em" textAnchor="middle" fontSize={FONT_SIZE} fill={LABEL}>
                {angle}°
              </text>
            )}
          </g>
        );
      })}
      {series.map((entry, index) => {
        const list = points[index];
        if (list.length === 0) {
          return null;
        }
        const vertices = [0, 180].flatMap((offset) => list.map(({ direction, value }) => at(Number(direction) + offset, r(value))));
        return (
          <g key={entry.key} {...seriesProps(entry, index)}>
            <title>{`${entry.label}: ${list.map(({ direction, value }) => `${direction}° ${formatValue(value)}`).join(', ')}`}</title>
            <polygon
              data-testid="plot-polar"
              data-values={JSON.stringify(list.map(({ value }) => value))}
              points={vertices.map(([px, py]) => `${px},${py}`).join(' ')}
              fill={colors[index]}
              fillOpacity={0.12}
              stroke={colors[index]}
              strokeWidth={1.5}
            />
          </g>
        );
      })}
      <text x={width - PAD.right} y={height - 4} textAnchor="end" fontSize={FONT_SIZE} fill={LABEL}>
        {featureName}, d = {distance}
      </text>
    </g>
  );
}

function DistanceChart({ width, height, series, colors, featureName, seriesProps }: ChartProps) {
  const legend = legendLayout(series, width);
  const distances = distancesOf(series.flatMap((entry) => entry.measurements));
  const scale = niceScale(series.flatMap((entry) => entry.measurements.map((measurement) => measurement.values.mean)).filter(isFiniteNumber));
  const [left, right, top, bottom] = [PAD.left, width - PAD.right - 8, PAD.top + legend.height, height - PAD.bottom];
  const y = linear([scale.min, scale.max], [bottom, top]);
  const first = distances[0] ?? 1;
  const last = distances[distances.length - 1] ?? 1;
  const x = first === last ? () => (left + right) / 2 : linear([first, last], [left + 8, right]);
  return (
    <g>
      <Legend series={series} colors={colors} width={width} seriesProps={seriesProps} />
      <YAxis scale={scale} y={y} left={left} right={right} top={top} bottom={bottom} title={featureName} />
      {distances.map((d) => (
        <text key={d} x={x(d)} y={bottom + 14} textAnchor="middle" fontSize={FONT_SIZE} fill={LABEL}>
          {d}
        </text>
      ))}
      <text x={(left + right) / 2} y={bottom + 28} textAnchor="middle" fontSize={FONT_SIZE} fill={LABEL}>
        distance d (pixels)
      </text>
      {series.map((entry, index) => {
        const line = entry.measurements.filter((measurement) => isFiniteNumber(measurement.values.mean));
        return (
          <g key={entry.key} {...seriesProps(entry, index)}>
            <title>{`${entry.label}: ${line.map((measurement) => `d ${measurement.distance} ${formatValue(measurement.values.mean)}`).join(', ')}`}</title>
            <polyline
              data-testid="plot-line"
              points={line.map((measurement) => `${x(measurement.distance)},${y(measurement.values.mean!)}`).join(' ')}
              fill="none"
              stroke={colors[index]}
              strokeWidth={1.5}
            />
            {line.map((measurement) => (
              <circle key={measurement.distance} data-testid="plot-point" cx={x(measurement.distance)} cy={y(measurement.values.mean!)} r={3} fill={colors[index]} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

/** The chart drawings, also used by the report (report/reportAssets.tsx) */
export const CHARTS: Record<ChartKind, (props: ChartProps) => React.JSX.Element> = { bars: BarsChart, box: BoxChart, polar: PolarChart, distance: DistanceChart };

export function chartCaption(kind: ChartKind, distance: number, distances: number, byClass: boolean): string {
  switch (kind) {
    case 'bars':
      return byClass
        ? `Mean over the ROIs of each class of their means at d = ${distance}; whiskers span the ROI means.`
        : `Mean over the directions at d = ${distance}; whiskers span the direction values.`;
    case 'box':
      return byClass ? 'Direction values of every ROI of each class at every distance: median, quartiles and range.' : 'Direction values at every distance: median, quartiles and range.';
    case 'polar':
      return `Value per direction at d = ${distance}; θ and θ + 180° are the same.`;
    default:
      return distances < 2 ? 'Measure with several distances to see how the value changes with d.' : 'Mean over the directions against the distance d.';
  }
}

export function ResultsPlot() {
  const runs = useResults((state) => state.runs);
  const rois = useRois((state) => state.rois);
  const classes = useRois((state) => state.classes);
  const [groupByClass, setGroupByClass] = useState(false);
  const hoveredId = useRois((state) => state.hoveredId);
  const imageName = useViewer((state) => state.image?.info.name ?? null);
  const catalog = useQuery(CATALOG_QUERY);
  const [kind, setKind] = useState<ChartKind>('bars');
  const [featureChoice, setFeatureChoice] = useState<string | null>(null);
  const [distanceChoice, setDistanceChoice] = useState<number | null>(null);
  const { ref, width, height } = useElementSize();
  const svgRef = useRef<SVGSVGElement>(null);

  const features = useMemo(() => plotFeatures(runs, catalog.data?.features ?? []), [runs, catalog.data]);
  const feature = features.find((candidate) => candidate.id === featureChoice) ?? features[0] ?? null;
  const measurements = useMemo(() => (feature ? latestMeasurements(runs, feature.id) : []), [runs, feature]);
  const hasClasses = measurements.some((measurement) => measurement.roiClass);
  const byClass = groupByClass && hasClasses && (kind === 'bars' || kind === 'box');
  const series = useMemo(() => (byClass ? classSeriesOf(measurements) : seriesOf(measurements)), [measurements, byClass]);
  const distances = useMemo(() => distancesOf(measurements), [measurements]);
  const distance = distanceChoice !== null && distances.includes(distanceChoice) ? distanceChoice : (distances[0] ?? 1);

  // ROIs of the open image keep their colour from the ROI Manager
  const colors = series.map(
    (entry, index) =>
      (entry.className !== undefined
        ? classes.find((roiClass) => roiClass.name === entry.className)?.color
        : entry.imageName === imageName
          ? rois.find((roi) => roi.id === entry.roiId)?.color
          : undefined) || roiColor(index),
  );
  const hoverable = (entry: Series) => entry.imageName === imageName && rois.some((roi) => roi.id === entry.roiId);
  const emphasised = series.some((entry) => hoverable(entry) && entry.roiId === hoveredId);
  const seriesProps: SeriesProps = (entry) => ({
    'data-roi': entry.roiId,
    opacity: emphasised && entry.roiId !== hoveredId ? 0.3 : undefined,
    onMouseEnter: hoverable(entry) ? () => useRois.getState().setHovered(entry.roiId) : undefined,
    onMouseLeave: hoverable(entry) ? () => useRois.getState().setHovered(null) : undefined,
  });

  const save = () => {
    if (!svgRef.current || !feature) {
      return;
    }
    const background = getComputedStyle(svgRef.current.closest('section') ?? document.body).backgroundColor;
    const stem = imageName && new Set(series.map((entry) => entry.imageName)).size <= 1 ? fileStem(imageName) : 'results';
    downloadText(standaloneSvg(svgRef.current, background), `${stem}-${feature.id}-${kind}.svg`, 'image/svg+xml');
  };

  const Chart = CHARTS[kind];
  return (
    <div className="results-plot" data-testid="results-plot">
      <Group gap={6} px={6} py={4} wrap="wrap">
        <SegmentedControl
          size="xs"
          aria-label="Chart"
          value={kind}
          onChange={(value) => setKind(value as ChartKind)}
          data={[
            { value: 'bars', label: 'Bars' },
            { value: 'box', label: 'Box' },
            { value: 'polar', label: 'Directions' },
            { value: 'distance', label: 'Distance' },
          ]}
        />
        <Select
          size="xs"
          w={190}
          aria-label="Feature"
          allowDeselect={false}
          data={features.map(({ id, name }) => ({ value: id, label: name }))}
          value={feature?.id ?? null}
          onChange={setFeatureChoice}
        />
        {(kind === 'bars' || kind === 'polar') && distances.length > 1 && (
          <Select
            size="xs"
            w={90}
            aria-label="Distance"
            allowDeselect={false}
            data={distances.map((d) => ({ value: String(d), label: `d = ${d}` }))}
            value={String(distance)}
            onChange={(value) => setDistanceChoice(value === null ? null : Number(value))}
          />
        )}
        {hasClasses && (kind === 'bars' || kind === 'box') && (
          <Switch size="xs" label="Group by class" checked={groupByClass} onChange={(event) => setGroupByClass(event.currentTarget.checked)} />
        )}
        <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 160 }}>
          {chartCaption(kind, distance, distances.length, byClass)}
        </Text>
        <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconDownload size={12} />} disabled={series.length === 0} onClick={save}>
          Save SVG
        </Button>
      </Group>
      <div className="results-plot-chart" ref={ref}>
        {series.length === 0 ? (
          <Text size="sm" c="dimmed" p="sm">
            No measured values to plot.
          </Text>
        ) : (
          width > 0 &&
          height > 0 && (
            <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${feature?.name} chart`}>
              <Chart width={width} height={height} series={series} colors={colors} distance={distance} featureName={feature?.name ?? ''} seriesProps={seriesProps} />
            </svg>
          )
        )}
      </div>
    </div>
  );
}
