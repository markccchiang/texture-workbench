// ROI ▸ Enlarge or Shrink… and ROI ▸ Make Band…: one dialog for the selected ROIs, computed on the pixel grid by the server

import type { GrowOperation } from '@glcm/api';
import { Button, Group, NumberInput, SegmentedControl, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { create } from 'zustand';
import { formatSpacing, isAnisotropic } from '../image/spacing';
import { useUi } from '../stores/uiStore';
import { useViewer } from '../stores/viewerStore';
import { formatDistance, growSelectedRois, type DistanceUnit } from './editActions';
import { useRois } from './roiStore';

interface GrowDialogState {
  operation: GrowOperation;
  distance: number;
  unit: DistanceUnit;
}

/** The dialog's last values, kept while the app is open */
const useGrowDialog = create<GrowDialogState>()(() => ({ operation: 'enlarge', distance: 5, unit: 'px' }));

/** Opens the dialog with an operation chosen */
export function openGrowDialog(operation: GrowOperation): void {
  useGrowDialog.setState({ operation });
  useUi.getState().setModal('growRoi');
}

const DESCRIPTIONS: Record<GrowOperation, string> = {
  enlarge: 'Adds the pixels within the distance of each selected ROI.',
  shrink: 'Keeps the pixels of each selected ROI that are farther than the distance from every pixel outside it, also from the image border.',
  band: 'Adds a new ROI around each selected ROI: the pixels within the distance of it, but not in it. The ROIs themselves stay.',
};

export function GrowRoiContent({ onClose }: { onClose(): void }) {
  const initial = useGrowDialog.getState();
  const [operation, setOperation] = useState<GrowOperation>(initial.operation);
  const spacing = useViewer((state) => state.pixelSpacing);
  const [unit, setUnit] = useState<DistanceUnit>(initial.unit === 'mm' && spacing ? 'mm' : 'px');
  const [distance, setDistance] = useState<number | string>(initial.distance);
  const [running, setRunning] = useState(false);
  const selectedCount = useRois((state) => state.selectedIds.length);

  const valid = typeof distance === 'number' && Number.isFinite(distance) && distance > 0;
  const apply = async () => {
    if (!valid) {
      return;
    }
    useGrowDialog.setState({ operation, distance, unit });
    setRunning(true);
    try {
      if ((await growSelectedRois({ operation, distance, unit })) > 0) {
        onClose();
      }
    } finally {
      setRunning(false);
    }
  };

  const verb = operation === 'enlarge' ? 'Enlarge' : operation === 'shrink' ? 'Shrink' : 'Add bands to';
  const rois = selectedCount === 1 ? '1 ROI' : `${selectedCount} ROIs`;
  return (
    <Stack gap="sm">
      <SegmentedControl
        aria-label="Operation"
        value={operation}
        onChange={(value) => setOperation(value as GrowOperation)}
        data={[
          { value: 'enlarge', label: 'Enlarge' },
          { value: 'shrink', label: 'Shrink' },
          { value: 'band', label: 'Band' },
        ]}
      />
      <Text size="sm">{DESCRIPTIONS[operation]}</Text>
      <Group align="flex-end" gap="sm" wrap="nowrap">
        <NumberInput
          label="Distance"
          description="Between pixel centres"
          min={0}
          decimalScale={4}
          value={distance}
          onChange={setDistance}
          error={valid ? undefined : 'Enter a distance above 0'}
          style={{ flex: 1 }}
        />
        <SegmentedControl
          aria-label="Unit"
          value={unit}
          onChange={(value) => setUnit(value as DistanceUnit)}
          data={[
            { value: 'px', label: 'px' },
            { value: 'mm', label: 'mm', disabled: !spacing },
          ]}
        />
      </Group>
      <Text size="xs" c="dimmed">
        {spacing
          ? `Pixels are ${formatSpacing(spacing)}${isAnisotropic(spacing) ? ' (not square); a distance in millimetres reaches different numbers of columns and rows' : ''}.`
          : 'Millimetres need a pixel spacing, which you can set in Image Info.'}
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={running} disabled={!valid || selectedCount === 0} onClick={() => void apply()}>
          {selectedCount === 0 ? 'Select ROIs first' : `${verb} ${rois}${valid ? ` by ${formatDistance(distance, unit)}` : ''}`}
        </Button>
      </Group>
    </Stack>
  );
}
