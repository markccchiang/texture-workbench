// The slice dialog shown when a NIfTI volume opens: orientation, slice and volume, with a preview rendered by the server

import type { SliceOrientation } from '@glcm/api';
import { Button, Group, List, Loader, Modal, SegmentedControl, Slider, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { deleteVolume, fetchVolumePreview } from '../api/client';
import { openVolumeSlice, openVolumeStack } from '../stores/imageLoader';
import { ORIENTATION_LABELS, ORIENTATIONS, previewSize, sliceSummary, useVolumeImport, volumeSummary } from './volumeImport';

const PREVIEW_SIZE = 320;
/** Requests wait this long, so dragging the slider does not render every slice it passes */
const PREVIEW_DELAY_MS = 50;

interface Preview {
  url: string;
  /** What the image shows, for tests */
  key: string;
}

function usePreview(volumeId: string | null, orientation: SliceOrientation, slice: number, volumeIndex: number) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!volumeId) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      // Twice the size for high-density screens
      fetchVolumePreview(volumeId, { orientation, slice, volume: volumeIndex, maxSize: PREVIEW_SIZE * 2 }, controller.signal)
        .then((blob) => {
          if (urlRef.current) {
            URL.revokeObjectURL(urlRef.current);
          }
          urlRef.current = URL.createObjectURL(blob);
          setPreview({
            url: urlRef.current,
            key: `${orientation}:${slice}:${volumeIndex}`,
          });
          setError(null);
        })
        .catch((reason: Error) => {
          if (!controller.signal.aborted) {
            setError(reason.message);
          }
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [volumeId, orientation, slice, volumeIndex]);

  useEffect(
    () => () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    },
    [volumeId],
  );

  return { preview: volumeId ? preview : null, error };
}

export function VolumeImportDialog() {
  const volume = useVolumeImport((state) => state.volume);
  const orientation = useVolumeImport((state) => state.orientation);
  const slices = useVolumeImport((state) => state.slices);
  const volumeIndex = useVolumeImport((state) => state.volumeIndex);
  const store = useVolumeImport.getState;
  const slice = slices[orientation];
  const { preview, error } = usePreview(volume?.volumeId ?? null, orientation, slice, volumeIndex);

  if (!volume) {
    return null;
  }
  const geometry = volume.slices[orientation];
  const size = previewSize(volume, orientation, PREVIEW_SIZE);
  const expectedKey = `${orientation}:${slice}:${volumeIndex}`;

  const cancel = () => {
    store().close();
    void deleteVolume(volume.volumeId).catch(() => undefined);
  };
  const open = () => {
    store().close();
    void openVolumeSlice(volume, orientation, slice, volumeIndex).finally(() => deleteVolume(volume.volumeId).catch(() => undefined));
  };
  const openStack = () => {
    store().close();
    void openVolumeStack(volume, orientation, volumeIndex, slice).finally(() => deleteVolume(volume.volumeId).catch(() => undefined));
  };

  return (
    <Modal opened onClose={cancel} title={`Open ${volume.name}`} size="auto">
      <Stack gap="sm" className="volume-import">
        <Text size="sm" c="dimmed">
          {volumeSummary(volume)}
        </Text>
        <SegmentedControl
          value={orientation}
          onChange={(value) => store().setOrientation(value as SliceOrientation)}
          data={ORIENTATIONS.map((value) => ({
            value,
            label: ORIENTATION_LABELS[value],
          }))}
          aria-label="Orientation"
        />
        <div className="volume-preview-frame">
          {preview && (
            <img
              src={preview.url}
              alt={`${ORIENTATION_LABELS[orientation]} slice ${slice}`}
              data-testid="volume-preview"
              data-shows={preview.key}
              style={{ width: size.width, height: size.height }}
            />
          )}
          {preview?.key !== expectedKey && !error && <Loader size="sm" className="volume-preview-loader" />}
          {error && (
            <Text size="sm" c="red" className="volume-preview-error">
              {error}
            </Text>
          )}
          <span className="volume-preview-edge volume-preview-edge-top">{orientation === 'axial' ? 'A' : 'S'}</span>
          <span className="volume-preview-edge volume-preview-edge-left">{orientation === 'sagittal' ? 'P' : 'L'}</span>
          <span className="volume-preview-edge volume-preview-edge-right">{orientation === 'sagittal' ? 'A' : 'R'}</span>
        </div>
        <Stack gap={2}>
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              Slice
            </Text>
            <Text size="sm" className="mono" data-testid="volume-slice-readout">
              {slice} / {geometry.count - 1}
            </Text>
          </Group>
          <Slider
            min={0}
            max={Math.max(0, geometry.count - 1)}
            value={slice}
            onChange={(value) => store().setSlice(value)}
            disabled={geometry.count <= 1}
            thumbLabel="Slice"
            label={null}
          />
        </Stack>
        {volume.volumes > 1 && (
          <Stack gap={2}>
            <Group justify="space-between">
              <Text size="sm" fw={500}>
                Volume
              </Text>
              <Text size="sm" className="mono" data-testid="volume-index-readout">
                {volumeIndex} / {volume.volumes - 1}
              </Text>
            </Group>
            <Slider min={0} max={volume.volumes - 1} value={volumeIndex} onChange={(value) => store().setVolumeIndex(value)} thumbLabel="Volume" label={null} />
          </Stack>
        )}
        <Text size="xs" c="dimmed">
          {sliceSummary(volume, orientation)}
          {volume.valueConversion ? ` · ${volume.valueConversion.description}` : ''}
        </Text>
        {volume.warnings.length > 0 && (
          <List size="xs" c="yellow">
            {volume.warnings.map((warning) => (
              <List.Item key={warning}>{warning}</List.Item>
            ))}
          </List>
        )}
        <Text size="xs" c="dimmed">
          Open All Slices opens the {geometry.count} {ORIENTATION_LABELS[orientation].toLowerCase()} slices as a stack named “{volume.name} [{orientation}
          {volume.volumes > 1 ? `, volume ${volumeIndex}` : ''}]”, showing slice {slice + 1} of it; Open Slice opens only this slice as a 2D image.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="default" onClick={open}>
            Open Slice
          </Button>
          <Button onClick={openStack} disabled={geometry.count <= 1}>
            Open All Slices
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
