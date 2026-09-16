import { ActionIcon, Loader, Text, Tooltip } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { cancelMeasurement } from '../analysis/measure';
import { areaMm2, formatArea } from '../image/spacing';
import { isRunning, useResults } from '../results/resultsStore';
import { useRois } from '../rois/roiStore';
import { useRoiStatistics } from '../rois/useRoiStatistics';
import { useViewer, type RendererKind } from '../stores/viewerStore';
import { formatRuler, measureRuler } from '../viewer/ruler';

const RENDERER_LABELS: Record<RendererKind, string> = {
  webgl2: 'WebGL2',
  lut: 'Lookup table',
  server: 'Server rendering',
};

export function StatusBar() {
  const hover = useViewer((state) => state.hover);
  const image = useViewer((state) => state.image);
  const scale = useViewer((state) => state.viewport.scale);
  const rendererKind = useViewer((state) => state.rendererKind);
  const pixelSpacing = useViewer((state) => state.pixelSpacing);
  const ruler = useViewer((state) => state.ruler);
  // Select the stored array and filter here: Zustand selectors must return stable references
  const runs = useResults((state) => state.runs).filter(isRunning);
  const rois = useRois((state) => state.rois);
  const selectedIds = useRois((state) => state.selectedIds);
  const statistics = useRoiStatistics();
  const info = image?.info;
  const selected = selectedIds.length === 1 ? rois.find((roi) => roi.id === selectedIds[0]) : undefined;
  const selectedPixels = selected ? statistics.get(selected.id)?.pixelCount : undefined;
  const completed = runs.reduce((sum, run) => sum + run.completed, 0);
  const total = runs.reduce((sum, run) => sum + run.total, 0);

  return (
    <footer className="status-bar" data-testid="status-bar">
      <Text size="xs" className="mono" w={230} data-testid="pixel-readout">
        {hover ? `x ${hover.x}  y ${hover.y}  value ${hover.value ?? '…'}` : 'x –  y –  value –'}
      </Text>
      <Text size="xs" className="mono" w={80}>
        {info ? `zoom ${Math.round(scale * 100)}%` : ''}
      </Text>
      {info && (
        <Text size="xs" truncate>
          {info.name} {info.width}×{info.height}
          {info.slices > 1 ? `×${info.slices} slices` : ''} {info.bitDepth}-bit
          {info.sourceChannels > 1 ? ' (converted to grayscale)' : ''}
        </Text>
      )}
      {selected && (
        <Text size="xs" className="mono" truncate>
          {selected.name} {selectedPixels === undefined ? '…' : `${selectedPixels.toLocaleString()} px`}
          {selectedPixels !== undefined && pixelSpacing ? ` · ${formatArea(areaMm2(selectedPixels, pixelSpacing))}` : ''}
        </Text>
      )}
      {selectedIds.length > 1 && <Text size="xs">{selectedIds.length} ROIs selected</Text>}
      {ruler && (
        <Text size="xs" className="mono" data-testid="ruler-readout">
          ruler {formatRuler(measureRuler(ruler, pixelSpacing))}
        </Text>
      )}
      <span style={{ marginLeft: 'auto' }} />
      {runs.length > 0 && (
        <span className="status-jobs" data-testid="measurement-progress">
          <Loader size={10} />
          <Text size="xs" className="mono">
            {completed}/{total} jobs
          </Text>
          <Tooltip label="Cancel the measurement">
            <ActionIcon size="xs" variant="subtle" color="gray" aria-label="Cancel measurement" onClick={() => runs.forEach((run) => void cancelMeasurement(run.analysisId))}>
              <IconX size={12} />
            </ActionIcon>
          </Tooltip>
        </span>
      )}
      {rendererKind && (
        <Text size="xs" c="dimmed">
          {RENDERER_LABELS[rendererKind]}
        </Text>
      )}
    </footer>
  );
}
