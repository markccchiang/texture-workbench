// Analyze ▸ Batch Measure…: the ROIs of the ROI Manager or of an ROI set file, measured on several images with the
// current analysis settings

import type { RoiSetDocument } from '@glcm/api';
import { Badge, Button, FileInput, Group, ScrollArea, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CATALOG_QUERY } from '../api/queryClient';
import { CommandPanel } from '../command/CommandPanel';
import { useAnalysisSettings } from '../analysis/settingsStore';
import { IMAGE_FILE_TYPES } from '../files/fileTypes';
import { buildRoiSet, readRoiSetFile, ROI_SET_FILE_TYPES } from '../files/roiSet';
import { useRois } from '../rois/roiStore';
import { useViewer } from '../stores/viewerStore';
import { useBatch } from './batchStore';
import { downloadBatchResults } from './exportBatch';
import type { BatchItem, BatchItemStatus } from './runBatch';

const STATUS: Record<BatchItemStatus, { label: string; color: string }> = {
  waiting: { label: 'Waiting', color: 'gray' },
  uploading: { label: 'Uploading', color: 'blue' },
  measuring: { label: 'Measuring', color: 'blue' },
  done: { label: 'Done', color: 'green' },
  skipped: { label: 'Skipped', color: 'yellow' },
  failed: { label: 'Failed', color: 'red' },
  cancelled: { label: 'Cancelled', color: 'gray' },
};

function progressText(item: BatchItem): string {
  if (item.status === 'uploading') {
    return `${Math.round((item.uploaded ?? 0) * 100)} %`;
  }
  if (item.total !== undefined) {
    return `${item.completed ?? 0} / ${item.total} jobs`;
  }
  return '';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function BatchContent({ onClose }: { onClose(): void }) {
  const image = useViewer((state) => state.image);
  const roiCount = useRois((state) => state.rois.length);
  const settings = useAnalysisSettings((state) => state.settings);
  const catalog = useQuery(CATALOG_QUERY);
  const items = useBatch((state) => state.items);
  const running = useBatch((state) => state.running);
  const managerAvailable = image !== null && roiCount > 0;
  const [source, setSource] = useState<'manager' | 'file'>(managerAvailable ? 'manager' : 'file');
  const [roiFile, setRoiFile] = useState<File | null>(null);
  const [images, setImages] = useState<File[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [showCommand, setShowCommand] = useState(false);

  const roisChosen = source === 'manager' ? managerAvailable : roiFile !== null;
  const ready = settings !== null && catalog.data !== undefined && images.length > 0 && roisChosen;
  const finishedIds = items.filter((item) => item.status === 'done' && item.analysisId).map((item) => item.analysisId!);
  const counts = items.reduce<Record<string, number>>((all, item) => ({ ...all, [item.status]: (all[item.status] ?? 0) + 1 }), {});

  const start = async () => {
    if (!settings || !catalog.data) {
      return;
    }
    let roiSet: RoiSetDocument;
    try {
      if (source === 'manager') {
        roiSet = buildRoiSet(image!.info, useRois.getState().rois, useRois.getState().classes);
      } else {
        const read = await readRoiSetFile(roiFile!);
        roiSet = read.document;
        if (read.warnings.length > 0) {
          notifications.show({ color: 'yellow', title: `Reading ${roiFile!.name}`, message: read.warnings.join(' '), autoClose: 10000 });
        }
      }
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not read the ROI set', message: (error as Error).message });
      return;
    }
    if (roiSet.rois.length === 0) {
      notifications.show({ color: 'yellow', title: 'No ROIs to measure', message: 'The ROI set contains no ROIs.' });
      return;
    }
    await useBatch.getState().start({ files: images, roiSet, settings, catalog: catalog.data });
  };

  const download = async () => {
    setDownloading(true);
    try {
      await downloadBatchResults(finishedIds);
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not download the results', message: (error as Error).message });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Stack gap="md">
      <Text size="sm">
        Measures the same ROIs on several images with the current analysis settings. Each image is added to the Results table; ROIs are clipped to
        images of another size.
      </Text>

      <Stack gap={6}>
        <Text size="sm" fw={500}>
          ROIs
        </Text>
        <SegmentedControl
          disabled={running}
          value={source}
          onChange={(value) => setSource(value as 'manager' | 'file')}
          data={[
            { value: 'manager', label: `ROI Manager (${roiCount})`, disabled: !managerAvailable },
            { value: 'file', label: 'ROI set file' },
          ]}
        />
        {source === 'file' && (
          <FileInput
            size="sm"
            disabled={running}
            accept={ROI_SET_FILE_TYPES}
            placeholder="Choose an ROI set (.roi.json, or ImageJ .roi / RoiSet.zip)"
            aria-label="ROI set file"
            clearable
            value={roiFile}
            onChange={setRoiFile}
          />
        )}
      </Stack>

      <FileInput
        size="sm"
        label="Images"
        multiple
        disabled={running}
        accept={IMAGE_FILE_TYPES}
        placeholder="Choose PNG, JPEG, BMP or TIFF images"
        clearable
        value={images}
        onChange={setImages}
      />

      {settings && (
        <Text size="xs" c="dimmed">
          Settings: {plural(settings.features.length, 'feature')}, Ng {settings.grayLevels}, {settings.quantization.method}, distance
          {settings.distances.length === 1 ? '' : 's'} {settings.distances.join(', ')}; fitted to each image&apos;s bit depth.
        </Text>
      )}

      {items.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed" data-testid="batch-summary">
            {Object.entries(counts)
              .map(([status, count]) => `${count} ${STATUS[status as BatchItemStatus].label.toLowerCase()}`)
              .join(', ')}
          </Text>
          <ScrollArea.Autosize mah={260}>
            <Table verticalSpacing={4} fz="xs" data-testid="batch-items">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Image</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th ta="right">Progress</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((item, index) => (
                  <Table.Tr key={`${index}:${item.fileName}`} data-status={item.status}>
                    <Table.Td>
                      <Text size="xs">{item.fileName}</Text>
                      {(item.message || item.reused) && (
                        <Text size="xs" c="dimmed">
                          {[item.reused ? 'Already on the server.' : '', item.message ?? ''].filter(Boolean).join(' ')}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color={STATUS[item.status].color}>
                        {STATUS[item.status].label}
                      </Badge>
                    </Table.Td>
                    <Table.Td ta="right" className="mono">
                      {progressText(item)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Stack>
      )}

      {showCommand && settings && images.length > 0 && roisChosen && (
        <CommandPanel
          source={{
            baseName: 'batch',
            images: images.map((file) => file.name),
            settings,
            rois: source === 'manager' ? buildRoiSet(image!.info, useRois.getState().rois, useRois.getState().classes) : { fileName: roiFile!.name },
          }}
        />
      )}

      <Group justify="flex-end">
        <Button variant="subtle" disabled={images.length === 0 || !roisChosen || !settings} onClick={() => setShowCommand((shown) => !shown)} mr="auto">
          {showCommand ? 'Hide Command' : 'Copy as Command…'}
        </Button>
        {!running && finishedIds.length > 0 && (
          <Button variant="light" loading={downloading} onClick={() => void download()}>
            Download combined CSV
          </Button>
        )}
        {running ? (
          <Button color="red" variant="light" onClick={() => useBatch.getState().cancel()}>
            Cancel batch
          </Button>
        ) : (
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
        )}
        <Button disabled={!ready || running} loading={running} onClick={() => void start()}>
          {images.length > 0 ? `Measure ${plural(images.length, 'image')}` : 'Measure'}
        </Button>
      </Group>
    </Stack>
  );
}
