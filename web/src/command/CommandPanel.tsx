// The glcm measure command of a measurement, with Copy Command and Save Files: Analyze ▸ Copy as Command… for the open
// image, and the Command line section of Batch Measure

import { adaptToImage, measureCommand, requestSettings, type AnalysisSettings, type CommandRequest, type HealthResponse, type RoiSetDocument } from '@glcm/api';
import { Button, Code, Group, Stack, Switch, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getHealth } from '../api/client';
import { useAnalysisSettings } from '../analysis/settingsStore';
import { downloadBlob } from '../files/download';
import { buildRoiSet } from '../files/roiSet';
import { sameSpacing } from '../image/spacing';
import { useRois } from '../rois/roiStore';
import { useViewer } from '../stores/viewerStore';
import { commandArchive, commandFileNames, commandScript, imageSource } from './glcmCommand';

export interface CommandSource {
  /** Base of the file names: the image name, or "batch" */
  baseName: string;
  images: string[];
  settings: AnalysisSettings;
  /** The ROI set saved next to the command, or the name of an ROI file the user already has */
  rois: RoiSetDocument | { fileName: string };
  colour?: CommandRequest['colour'];
  spacing?: CommandRequest['spacing'];
}

const HEALTH_QUERY = { queryKey: ['health'], queryFn: ({ signal }: { signal: AbortSignal }) => getHealth(signal), staleTime: Infinity };

export function CommandPanel({ source }: { source: CommandSource }) {
  const health = useQuery<HealthResponse>(HEALTH_QUERY);
  const serverMode = health.data?.mode === 'server';
  const [useServer, setUseServer] = useState<boolean | null>(null);
  const sendToServer = useServer ?? serverMode;
  const names = commandFileNames(source.baseName);
  const ownRois = 'fileName' in source.rois ? null : source.rois;
  const command = measureCommand({
    images: source.images,
    settingsFile: names.settings,
    roisFile: ownRois ? names.rois : (source.rois as { fileName: string }).fileName,
    colour: source.colour,
    spacing: source.spacing,
    out: names.results,
    server: sendToServer ? window.location.origin : undefined,
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      notifications.show({ color: 'green', title: 'Copied', message: 'The command is on the clipboard.', autoClose: 2500 });
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not copy', message: (error as Error).message });
    }
  };
  const save = () => {
    const zip = commandArchive({
      settings: [names.settings, source.settings],
      ...(ownRois ? { rois: [names.rois, ownRois] as [string, RoiSetDocument] } : {}),
      script: [names.script, commandScript(command)],
    });
    downloadBlob(new Blob([zip.slice().buffer], { type: 'application/zip' }), names.archive);
  };

  return (
    <Stack gap="xs">
      <Code block data-testid="glcm-command" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {command}
      </Code>
      <Text size="xs" c="dimmed">
        Save Files downloads {names.archive}: the settings{ownRois ? ', the ROI set' : ''} and {names.script}. Unpack it in the folder with{' '}
        {source.images.length === 1 ? source.images[0] : 'the images'}
        {ownRois ? '' : ` and ${(source.rois as { fileName: string }).fileName}`}, then run the command there; the results go to {names.results}.
      </Text>
      <Switch
        size="sm"
        checked={sendToServer}
        onChange={(event) => setUseServer(event.currentTarget.checked)}
        label={`Send to this server (${window.location.origin})`}
        description={
          sendToServer
            ? health.data?.authentication === 'bearer'
              ? 'The server must be running, and GLCM_API_TOKEN set to its access token.'
              : 'The server must be running when the command runs.'
            : 'The command measures in its own process; while this app runs on the same data folder, it asks to send the command here instead.'
        }
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={save}>
          Save Files
        </Button>
        <Button onClick={() => void copy()}>Copy Command</Button>
      </Group>
    </Stack>
  );
}

/** Analyze ▸ Copy as Command…: every ROI of the ROI Manager on the open image, with the current settings */
export function CopyCommandContent() {
  const image = useViewer((state) => state.image);
  const window_ = useViewer((state) => state.window);
  const spacing = useViewer((state) => state.pixelSpacing);
  const rois = useRois((state) => state.rois);
  const classes = useRois((state) => state.classes);
  const stored = useAnalysisSettings((state) => state.settings);

  if (!image || rois.length === 0 || !stored) {
    return (
      <Text size="sm" c="dimmed">
        {!image ? 'Open an image first.' : rois.length === 0 ? 'Add ROIs to the ROI Manager first.' : 'The analysis settings are not loaded yet.'}
      </Text>
    );
  }
  const { info } = image;
  const { file, colour } = imageSource(info);
  const settings = requestSettings(adaptToImage(stored, info.bitDepth), info.bitDepth, window_);
  return (
    <Stack gap="sm">
      <Text size="sm">
        Repeats Measure All from the command line: the {rois.length === 1 ? 'ROI' : `${rois.length} ROIs`} of the ROI Manager on {file}
        {colour ? ' converted the same way' : ''}, with the current analysis settings. Change the image names to measure other images the same way.
      </Text>
      <CommandPanel
        source={{
          baseName: file,
          images: [file],
          settings,
          rois: buildRoiSet(info, rois, classes),
          colour,
          spacing: spacing && !sameSpacing(spacing, info.pixelSpacing) ? spacing : undefined,
        }}
      />
    </Stack>
  );
}
