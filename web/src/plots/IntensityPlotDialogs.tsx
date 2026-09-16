// Analyze ▸ Plot Profile and Analyze ▸ Histogram: charts of the intensities along the ruler line and in an ROI, drawn as
// plain SVG like the Results panel's plots, with their values to copy or save

import { Button, Group, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconDownload } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { getLineProfile, getRoiHistogram } from '../api/client';
import { downloadText, fileStem } from '../files/download';
import { formatValue } from '../results/rows';
import { niceScale, type Scale } from '../results/plotData';
import { standaloneSvg } from '../results/svgExport';
import { useRois } from '../rois/roiStore';
import { sliceField, useViewer } from '../stores/viewerStore';
import { binsOf, histogramCsv, histogramTarget, profileCsv, profileOf, type HistogramBin, type Profile } from './intensityPlots';

const WIDTH = 560;
const HEIGHT = 300;
const PAD = { left: 62, right: 16, top: 12, bottom: 38 };
const AXIS = 'var(--mantine-color-default-border)';
const LABEL = 'var(--mantine-color-dimmed)';
const LINE = 'var(--mantine-color-blue-5)';
const FONT_SIZE = 10;

const linear = (domain: [number, number], range: [number, number]) => (value: number) =>
  range[0] + ((value - domain[0]) / (domain[1] - domain[0] || 1)) * (range[1] - range[0]);

function Axes({
  x,
  y,
  xScale,
  yScale,
  xTitle,
  yTitle,
}: {
  x(value: number): number;
  y(value: number): number;
  xScale: Scale;
  yScale: Scale;
  xTitle: string;
  yTitle: string;
}) {
  const [left, right, top, bottom] = [PAD.left, WIDTH - PAD.right, PAD.top, HEIGHT - PAD.bottom];
  return (
    <g>
      {yScale.ticks.map((tick) => (
        <g key={`y${tick}`}>
          <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke={AXIS} strokeDasharray="2 3" />
          <text x={left - 4} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={FONT_SIZE} fill={LABEL}>
            {formatValue(tick)}
          </text>
        </g>
      ))}
      {xScale.ticks.map((tick) => (
        <text key={`x${tick}`} x={x(tick)} y={bottom + 14} textAnchor="middle" fontSize={FONT_SIZE} fill={LABEL}>
          {formatValue(tick)}
        </text>
      ))}
      <line x1={left} x2={right} y1={bottom} y2={bottom} stroke={AXIS} />
      <text x={(left + right) / 2} y={bottom + 30} textAnchor="middle" fontSize={FONT_SIZE} fill={LABEL}>
        {xTitle}
      </text>
      <text transform={`translate(11 ${(top + bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize={FONT_SIZE} fill={LABEL}>
        {yTitle}
      </text>
    </g>
  );
}

function ProfileChart({ profile, svgRef }: { profile: Profile; svgRef: React.Ref<SVGSVGElement> }) {
  const values = profile.points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const xScale = niceScale(
    profile.points.map((point) => point.distance),
    { includeZero: true },
  );
  const yScale = niceScale(values);
  const x = linear([xScale.min, xScale.max], [PAD.left, WIDTH - PAD.right]);
  const y = linear([yScale.min, yScale.max], [HEIGHT - PAD.bottom, PAD.top]);
  // Samples outside the image break the line
  const segments: string[][] = [[]];
  for (const point of profile.points) {
    if (point.value === null) {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(`${x(point.distance)},${y(point.value)}`);
    }
  }
  return (
    <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="img" aria-label="Line profile" data-testid="profile-chart">
      <Axes x={x} y={y} xScale={xScale} yScale={yScale} xTitle={`distance (${profile.unit === 'mm' ? 'mm' : 'pixels'})`} yTitle="value" />
      {segments
        .filter((segment) => segment.length > 0)
        .map((segment, index) => (
          <polyline key={index} points={segment.join(' ')} fill="none" stroke={LINE} strokeWidth={1.5} data-testid="profile-line" />
        ))}
    </svg>
  );
}

function HistogramChart({ bins, svgRef }: { bins: HistogramBin[]; svgRef: React.Ref<SVGSVGElement> }) {
  const first = bins[0]?.start ?? 0;
  const last = (bins[bins.length - 1]?.end ?? 0) + 1;
  const xScale = niceScale([first, last]);
  const yScale = niceScale(
    bins.map((bin) => bin.count),
    { includeZero: true },
  );
  const x = linear([xScale.min, xScale.max], [PAD.left, WIDTH - PAD.right]);
  const y = linear([yScale.min, yScale.max], [HEIGHT - PAD.bottom, PAD.top]);
  return (
    <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="img" aria-label="Histogram" data-testid="histogram-chart">
      <Axes x={x} y={y} xScale={xScale} yScale={yScale} xTitle="value" yTitle="pixels" />
      {bins.map((bin) => (
        <rect
          key={bin.start}
          data-testid="histogram-bar"
          data-value={bin.count}
          x={x(bin.start)}
          y={y(bin.count)}
          width={Math.max(0.5, x(bin.end + 1) - x(bin.start))}
          height={y(0) - y(bin.count)}
          fill={LINE}
        >
          <title>{bin.start === bin.end ? `${bin.start}: ${bin.count}` : `${bin.start}–${bin.end}: ${bin.count}`}</title>
        </rect>
      ))}
    </svg>
  );
}

function saveSvg(svg: SVGSVGElement | null, fileName: string): void {
  if (!svg) {
    return;
  }
  const background = getComputedStyle(svg.closest('section') ?? document.body).backgroundColor;
  downloadText(standaloneSvg(svg, background), fileName, 'image/svg+xml');
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notifications.show({ color: 'green', title: 'Copied', message: 'The values are on the clipboard.', autoClose: 2500 });
  } catch (error) {
    notifications.show({ color: 'red', title: 'Could not copy', message: (error as Error).message });
  }
}

function Buttons({ csv, name, svgRef }: { csv: string; name: string; svgRef: React.RefObject<SVGSVGElement | null> }) {
  return (
    <Group justify="flex-end" gap="xs">
      <Button size="xs" variant="default" leftSection={<IconCopy size={14} />} onClick={() => void copyText(csv.replaceAll(',', '\t'))}>
        Copy Values
      </Button>
      <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={() => downloadText(csv, `${name}.csv`, 'text/csv')}>
        Save CSV
      </Button>
      <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={() => saveSvg(svgRef.current, `${name}.svg`)}>
        Save SVG
      </Button>
    </Group>
  );
}

export function ProfileContent() {
  const image = useViewer((state) => state.image);
  const ruler = useViewer((state) => state.ruler);
  const spacing = useViewer((state) => state.pixelSpacing);
  const svgRef = useRef<SVGSVGElement>(null);
  const slice = image?.slice ?? 1;
  const query = useQuery({
    queryKey: ['line-profile', image?.info.imageId, slice, ruler],
    queryFn: ({ signal }) => getLineProfile(image!.info.imageId, { from: ruler!.start, to: ruler!.end, ...sliceField(slice) }, signal),
    enabled: image !== null && ruler !== null,
  });

  if (!image || !ruler) {
    return (
      <Text size="sm" c="dimmed">
        Draw a line with the ruler (L) first; the profile shows the values along it.
      </Text>
    );
  }
  if (query.error) {
    return (
      <Text size="sm" c="red">
        {query.error.message}
      </Text>
    );
  }
  if (!query.data) {
    return <Text size="sm">Reading the values…</Text>;
  }
  const profile = profileOf(query.data, ruler, spacing);
  const values = profile.points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const last = profile.points[profile.points.length - 1];
  return (
    <Stack gap="xs">
      <ProfileChart profile={profile} svgRef={svgRef} />
      <Text size="xs" c="dimmed" data-testid="profile-summary">
        {profile.points.length} samples over {formatValue(last.distance)} {profile.unit === 'mm' ? 'mm' : 'pixels'}
        {image.info.slices > 1 ? ` on slice ${slice}` : ''}
        {values.length > 0 ? ` · min ${formatValue(Math.min(...values))} · max ${formatValue(Math.max(...values))}` : ''}
        {values.length < profile.points.length ? ` · ${profile.points.length - values.length} outside the image` : ''}
      </Text>
      <Buttons csv={profileCsv(profile)} name={`${fileStem(image.info.name)}-profile`} svgRef={svgRef} />
    </Stack>
  );
}

const BIN_CHOICES = ['16', '32', '64', '128', '256', '1024'];

export function HistogramContent() {
  const image = useViewer((state) => state.image);
  const rois = useRois((state) => state.rois);
  const selectedIds = useRois((state) => state.selectedIds);
  const activeShape = useRois((state) => state.activeShape);
  const currentSlice = useRois((state) => state.currentSlice);
  const [bins, setBins] = useState('256');
  const svgRef = useRef<SVGSVGElement>(null);
  const target = image ? histogramTarget(image.info, image.slice ?? 1, rois, selectedIds, activeShape, currentSlice) : null;
  const query = useQuery({
    queryKey: ['roi-histogram', image?.info.imageId, target, bins],
    queryFn: ({ signal }) => getRoiHistogram(image!.info.imageId, { shape: target!.shape, bins: Number(bins), ...sliceField(target!.slice) }, signal),
    enabled: target !== null,
    placeholderData: keepPreviousData,
  });

  if (!image || !target) {
    return (
      <Text size="sm" c="dimmed">
        Open an image first.
      </Text>
    );
  }
  const data = query.data;
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="sm" data-testid="histogram-target">
          Histogram of {target.label}
          {image.info.slices > 1 ? ` (slice ${target.slice})` : ''}
        </Text>
        <Select
          size="xs"
          w={130}
          aria-label="Bins"
          label={null}
          allowDeselect={false}
          data={BIN_CHOICES.map((value) => ({ value, label: `≤ ${value} bins` }))}
          value={bins}
          onChange={(value) => value && setBins(value)}
        />
      </Group>
      {query.error && (
        <Text size="sm" c="red">
          {query.error.message}
        </Text>
      )}
      {!data && !query.error && <Text size="sm">Counting the pixels…</Text>}
      {data && data.pixelCount === 0 && (
        <Text size="sm" c="dimmed">
          The ROI contains no pixels of the image.
        </Text>
      )}
      {data && data.pixelCount > 0 && (
        <>
          <HistogramChart bins={binsOf(data)} svgRef={svgRef} />
          <Text size="xs" c="dimmed" data-testid="histogram-summary">
            {data.pixelCount.toLocaleString()} pixels · min {data.min} · max {data.max} · mean {formatValue(data.mean)} · std {formatValue(data.std)} · mode{' '}
            {data.mode} · bin width {data.binWidth}
          </Text>
          <Buttons csv={histogramCsv(binsOf(data))} name={`${fileStem(image.info.name)}-histogram`} svgRef={svgRef} />
        </>
      )}
    </Stack>
  );
}
