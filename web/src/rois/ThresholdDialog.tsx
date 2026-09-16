// ROI ▸ Threshold ROI…: every connected part of the pixels inside the display window becomes an ROI

import { MAX_ROIS_PER_REQUEST } from '@glcm/api';
import { Button, Group, NumberInput, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { selectThresholdRois } from '../api/client';
import { useViewer, sliceField } from '../stores/viewerStore';
import { addThresholdRois, thresholdFilterFields, type ThresholdFilters } from './regionActions';
import { DEFAULT_THRESHOLD_MIN_PIXELS } from './regions';

export function ThresholdRoiContent({ onClose }: { onClose(): void }) {
  const image = useViewer((state) => state.image);
  const window = useViewer((state) => state.window);
  const [minPixels, setMinPixels] = useState<number | string>(DEFAULT_THRESHOLD_MIN_PIXELS);
  const [maxPixels, setMaxPixels] = useState<number | string>('');
  const [minSphericity, setMinSphericity] = useState<number | string>(0);
  // Each value on its own: a new object every render would restart the debounce forever
  const [debouncedMinPixels] = useDebouncedValue(minPixels, 250);
  const [debouncedMaxPixels] = useDebouncedValue(maxPixels, 250);
  const [debouncedMinSphericity] = useDebouncedValue(minSphericity, 250);
  const [adding, setAdding] = useState(false);
  const imageId = image?.info.imageId ?? null;
  const slice = image?.slice ?? 1;
  const filters = validFilters(debouncedMinPixels, debouncedMaxPixels, debouncedMinSphericity);

  const count = useQuery({
    queryKey: ['threshold-rois', imageId, slice, window.min, window.max, filters],
    queryFn: ({ signal }) =>
      selectThresholdRois(imageId!, { min: window.min, max: window.max, ...thresholdFilterFields(filters!), maxRegions: 0, ...sliceField(slice) }, signal),
    enabled: imageId !== null && filters !== null,
    staleTime: Infinity,
  });

  if (!image || !imageId) {
    return (
      <Text size="sm" c="dimmed">
        Open an image first.
      </Text>
    );
  }

  const total = count.data?.total;
  const adds = total === undefined ? 0 : Math.min(total, MAX_ROIS_PER_REQUEST);
  let summary = 'Enter whole numbers of pixels, the largest size at least the smallest, and a sphericity from 0 to 1.';
  if (filters !== null) {
    if (count.isError) {
      summary = (count.error as Error).message;
    } else if (total === undefined) {
      summary = 'Counting regions…';
    } else {
      const size = filters.maxPixels === null ? `at least ${filters.minPixels.toLocaleString()}` : `${filters.minPixels.toLocaleString()} to ${filters.maxPixels.toLocaleString()}`;
      const shape = filters.minSphericity > 0 ? ` and a sphericity of at least ${filters.minSphericity}` : '';
      summary = `${total.toLocaleString()} ${total === 1 ? 'region' : 'regions'} of ${size} pixels${shape}.`;
      if (total > MAX_ROIS_PER_REQUEST) {
        summary += ` Only the largest ${MAX_ROIS_PER_REQUEST.toLocaleString()} are added; raise the minimum size to add fewer.`;
      }
    }
  }

  const add = async () => {
    setAdding(true);
    try {
      await addThresholdRois(imageId, filters!, adds);
      onClose();
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not add the ROIs', message: (error as Error).message });
    } finally {
      setAdding(false);
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm">
        Selects the pixels from <strong className="mono">{window.min}</strong> to <strong className="mono">{window.max}</strong>, the current display
        window. Each connected part (pixels touching at an edge or a corner) becomes a polygon ROI, with its holes filled.
      </Text>
      <Text size="xs" c="dimmed">
        To select other intensities, close this dialog and change the window first.
      </Text>
      <Group grow align="flex-start">
        <NumberInput label="Minimum size" description="Pixels, holes included" min={1} allowDecimal={false} value={minPixels} onChange={setMinPixels} />
        <NumberInput label="Maximum size" description="Empty for no limit" min={1} allowDecimal={false} value={maxPixels} onChange={setMaxPixels} />
      </Group>
      <NumberInput
        label="Minimum sphericity"
        description="1 for a circle, lower for elongated or ragged outlines (see the shape features); 0 keeps every shape"
        min={0}
        max={1}
        step={0.05}
        decimalScale={3}
        value={minSphericity}
        onChange={setMinSphericity}
      />
      <Text size="sm" data-testid="threshold-summary">
        {summary}
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={adding} disabled={adds === 0 || filters === null || count.isFetching} onClick={() => void add()}>
          {adds === 1 ? 'Add 1 ROI' : `Add ${adds.toLocaleString()} ROIs`}
        </Button>
      </Group>
    </Stack>
  );
}

/** The filters as numbers, or null while one of them is not valid */
function validFilters(minPixels: number | string, maxPixels: number | string, minSphericity: number | string): ThresholdFilters | null {
  const whole = (value: number | string): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
  if (!whole(minPixels) || (maxPixels !== '' && (!whole(maxPixels) || maxPixels < minPixels))) {
    return null;
  }
  const sphericity = minSphericity === '' ? 0 : minSphericity;
  if (typeof sphericity !== 'number' || !(sphericity >= 0 && sphericity <= 1)) {
    return null;
  }
  return { minPixels, maxPixels: maxPixels === '' ? null : maxPixels, minSphericity: sphericity };
}
