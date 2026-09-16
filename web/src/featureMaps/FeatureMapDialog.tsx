// Analyze ▸ Feature Map…: a co-occurrence feature computed in a sliding window over the whole image, with the gray levels,
// quantization, directions and log base of the analysis settings

import { Button, Group, NumberInput, SegmentedControl, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CATALOG_QUERY } from '../api/queryClient';
import { useAnalysisSettings } from '../analysis/settingsStore';
import { useViewer, sliceField } from '../stores/viewerStore';
import { useFeatureMap } from './featureMapStore';
import {
  automaticStep,
  buildFeatureMapSettings,
  choiceProblem,
  DEFAULT_MAP_FEATURE,
  DEFAULT_MAP_WINDOW,
  describeQuantization,
  mapGrid,
  mappableFeatures,
} from './settings';

const GROUP_NAMES: Record<string, string> = { haralick: 'Haralick', other: 'Other' };

export function FeatureMapContent({ onClose }: { onClose(): void }) {
  const image = useViewer((state) => state.image);
  const settings = useAnalysisSettings((state) => state.settings);
  const catalog = useQuery(CATALOG_QUERY);
  const last = useFeatureMap((state) => state.lastChoice);
  const width = image?.info.width ?? 1;
  const height = image?.info.height ?? 1;

  const [feature, setFeature] = useState(last?.feature ?? DEFAULT_MAP_FEATURE);
  const [windowSize, setWindowSize] = useState<number | string>(last?.window ?? DEFAULT_MAP_WINDOW);
  const [automatic, setAutomatic] = useState(last ? last.step === null : true);
  const [manualStep, setManualStep] = useState<number | string>(last?.step ?? automaticStep(width, height));
  const [distance, setDistance] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  if (!image || !settings || !catalog.data) {
    return (
      <Text size="sm" c="dimmed">
        Open an image to compute a feature map.
      </Text>
    );
  }

  const features = mappableFeatures(catalog.data);
  const distances = [...new Set(settings.distances)].sort((a, b) => a - b);
  const chosenDistance = distance !== null && distances.includes(Number(distance)) ? Number(distance) : distances[0];
  const choice = {
    feature: features.some((info) => info.id === feature) ? feature : DEFAULT_MAP_FEATURE,
    window: Number(windowSize),
    step: automatic ? null : Number(manualStep),
    distance: chosenDistance,
  };
  const problem = windowSize === '' || (!automatic && manualStep === '') ? 'Enter the window and step' : choiceProblem(choice, width, height);
  const grid = problem ? null : mapGrid(width, height, choice.step);
  const directions = settings.directions.length === 4 ? 'all four directions' : `${[...settings.directions].sort((a, b) => a - b).join('°, ')}°`;

  const compute = async () => {
    setStarting(true);
    try {
      await useFeatureMap
        .getState()
        .start({ imageId: image.info.imageId, ...sliceField(image.slice ?? 1), settings: buildFeatureMapSettings(settings, choice) }, choice);
      onClose();
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not start the feature map', message: (error as Error).message });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Stack gap="sm">
      <Select
        label="Feature"
        searchable
        allowDeselect={false}
        data={['haralick', 'other'].map((group) => ({
          group: GROUP_NAMES[group],
          items: features.filter((info) => info.group === group).map((info) => ({ value: info.id, label: info.name })),
        }))}
        value={choice.feature}
        onChange={(value) => value && setFeature(value)}
      />
      <Group grow align="flex-start">
        <NumberInput label="Window" description="Odd side, in pixels" min={3} max={127} step={2} allowDecimal={false} value={windowSize} onChange={setWindowSize} />
        <Select
          label="Distance"
          description="From the analysis settings"
          allowDeselect={false}
          data={distances.map(String)}
          value={String(chosenDistance)}
          onChange={setDistance}
        />
      </Group>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Step
        </Text>
        <Group gap="xs" wrap="nowrap" align="center">
          <SegmentedControl
            size="xs"
            data={[
              { value: 'auto', label: 'Automatic' },
              { value: 'manual', label: 'Manual' },
            ]}
            value={automatic ? 'auto' : 'manual'}
            onChange={(value) => setAutomatic(value === 'auto')}
          />
          <NumberInput
            size="xs"
            aria-label="Step in pixels"
            min={1}
            allowDecimal={false}
            disabled={automatic}
            value={automatic ? automaticStep(width, height) : manualStep}
            onChange={setManualStep}
            w={90}
          />
          <Text size="xs" c="dimmed">
            px
          </Text>
        </Group>
      </Stack>
      <Text size="xs" c="dimmed" data-testid="feature-map-grid">
        {grid
          ? `The map has ${grid.columns} × ${grid.rows} points, one window every ${grid.step} px over the whole image.`
          : problem}
      </Text>
      <Text size="xs" c="dimmed">
        Each point is the mean over {directions} with {settings.grayLevels} gray levels ({describeQuantization(settings.quantization)}, applied to the whole
        image) and {settings.logBase === 'log2' ? 'log₂' : 'natural'} logarithms, as in the analysis settings.
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={starting} disabled={problem !== null} onClick={() => void compute()}>
          Compute
        </Button>
      </Group>
    </Stack>
  );
}
