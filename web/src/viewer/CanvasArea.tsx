import { Button, Progress, Stack, Text } from '@mantine/core';
import { StartScreen } from '../components/StartScreen';
import { FeatureMapCard } from '../featureMaps/FeatureMapCard';
import { cancelImageLoad } from '../stores/imageLoader';
import { useViewer, type LoadingState } from '../stores/viewerStore';
import { EdgeMapCard } from './EdgeMapCard';
import { ImageCanvas } from './ImageCanvas';
import { ScaleBar } from './ScaleBar';
import { SliceBar } from './SliceBar';

const PHASE_LABELS: Record<LoadingState['phase'], string> = {
  downloadingSample: 'Fetching sample',
  openingSlice: 'Opening slice',
  converting: 'Converting',
  uploading: 'Uploading',
  downloading: 'Loading pixel data',
};

function LoadingOverlay({ loading }: { loading: LoadingState }) {
  const percent = loading.progress === null ? null : Math.round(loading.progress * 100);
  return (
    <div className="loading-overlay" role="status">
      <Stack gap="xs">
        <Text size="sm" truncate>
          {PHASE_LABELS[loading.phase]} {loading.name}
          {percent !== null && ` — ${percent} %`}
        </Text>
        <Progress value={percent ?? 100} animated={percent === null || (loading.phase === 'uploading' && percent === 100)} />
        <Button size="compact-xs" variant="subtle" color="gray" onClick={cancelImageLoad} style={{ alignSelf: 'flex-end' }}>
          Cancel
        </Button>
      </Stack>
    </div>
  );
}

export function CanvasArea() {
  const hasImage = useViewer((state) => state.image !== null);
  const loading = useViewer((state) => state.loading);

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <ImageCanvas />
        <ScaleBar />
        <FeatureMapCard />
        <EdgeMapCard />
        {!hasImage && !loading && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <StartScreen />
          </div>
        )}
        {loading && <LoadingOverlay loading={loading} />}
      </div>
      <SliceBar />
    </div>
  );
}
