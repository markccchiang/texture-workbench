import { Anchor, Badge, Button, Checkbox, Group, Kbd, List, Modal, NavLink, NumberInput, ScrollArea, SegmentedControl, Stack, Switch, Table, Text } from '@mantine/core';
import type { HealthResponse, ImageInfo, SampleInfo } from '@glcm/api';
import { API_PREFIX } from '@glcm/api';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { getSamples } from '../api/client';
import { BatchContent } from '../batch/BatchDialog';
import { FeatureMapContent } from '../featureMaps/FeatureMapDialog';
import { ThresholdRoiContent } from '../rois/ThresholdDialog';
import { RoiClassesContent } from '../rois/ClassesDialog';
import { ReportContent } from '../report/ReportDialog';
import { CATALOG_QUERY } from '../api/queryClient';
import { useAnalysisSettings } from '../analysis/settingsStore';
import { exportRoiImagesFile, saveProjectFile } from '../files/actions';
import { formatSpacing, isAnisotropic, sameSpacing } from '../image/spacing';
import { useRois } from '../rois/roiStore';
import { openSample } from '../stores/imageLoader';
import { usePreferences } from '../stores/preferences';
import { MOD_KEY, useUi, type ModalName } from '../stores/uiStore';
import { useViewer } from '../stores/viewerStore';
import type { ScrollBehaviour } from '../viewer/wheel';

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function InfoRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <Table withRowBorders={false} verticalSpacing={4}>
      <Table.Tbody>
        {rows.map(([label, value]) => (
          <Table.Tr key={label}>
            <Table.Td w={140}>
              <Text size="sm" c="dimmed">
                {label}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" style={{ wordBreak: 'break-all' }}>
                {value}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

const MAX_SPACING_MM = 1e6;

const validSpacing = (value: string | number) => typeof value === 'number' && value > 0 && value <= MAX_SPACING_MM;

/** Pixel spacing of the open image: from the file, entered here, or none */
function PixelSpacingEditor({ info }: { info: ImageInfo }) {
  const spacing = useViewer((state) => state.pixelSpacing);
  const [width, setWidth] = useState<string | number>(spacing?.x ?? '');
  const [height, setHeight] = useState<string | number>(spacing?.y ?? '');
  const choose = (next: typeof spacing) => {
    useViewer.getState().setPixelSpacing(next);
    setWidth(next?.x ?? '');
    setHeight(next?.y ?? '');
  };
  const source = !spacing ? 'none' : sameSpacing(spacing, info.pixelSpacing) ? 'from the file' : 'entered';
  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        Pixel spacing
      </Text>
      <Group gap="xs" align="flex-end">
        <NumberInput size="xs" w={130} label="Pixel width (mm)" min={0} hideControls value={width} onChange={setWidth} />
        <NumberInput size="xs" w={130} label="Pixel height (mm)" min={0} hideControls value={height} onChange={setHeight} />
        <Button size="xs" disabled={!validSpacing(width) || !validSpacing(height)} onClick={() => choose({ x: Number(width), y: Number(height) })}>
          Apply
        </Button>
        {info.pixelSpacing && !sameSpacing(spacing, info.pixelSpacing) && (
          <Button size="xs" variant="subtle" onClick={() => choose(info.pixelSpacing)}>
            Use the file&apos;s spacing
          </Button>
        )}
        {spacing && (
          <Button size="xs" variant="subtle" color="gray" onClick={() => choose(null)}>
            Clear
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed" data-testid="pixel-spacing-status">
        {spacing ? `${formatSpacing(spacing)} per pixel (${source}). ` : 'No pixel spacing: sizes are given in pixels only. '}
        {spacing && isAnisotropic(spacing) ? 'The pixels are not square. ' : ''}
        The spacing adds a scale bar and ROI areas in mm², and is remembered for this image. Features are always computed in pixels.
      </Text>
    </Stack>
  );
}

function ImageInfoContent() {
  const image = useViewer((state) => state.image);
  const rendererKind = useViewer((state) => state.rendererKind);
  if (!image) {
    return <Text c="dimmed">No image is open.</Text>;
  }
  const { info } = image;
  return (
    <Stack gap="sm">
      <InfoRows
        rows={[
          ['Name', info.name],
          ['File size', formatBytes(info.sizeBytes)],
          ['Dimensions', `${info.width} × ${info.height} px`],
          ['Bit depth', `${info.bitDepth}-bit`],
          ['Channels', info.sourceChannels > 1 ? `${info.sourceChannels} (converted to grayscale)` : '1 (grayscale)'],
          ...(info.valueConversion ? [['Values', info.valueConversion.description] as [string, string]] : []),
          ['Default window', `${info.windowMin} – ${info.windowMax}`],
          ['Pixel transfer', info.transfer === 'raw' ? 'Raw samples, rendered in the browser' : 'Server-rendered display.png'],
          ['Renderer', rendererKind ?? '–'],
          ['SHA-256', <span className="mono">{info.sha256}</span>],
          ['Image id', <span className="mono">{info.imageId}</span>],
          ['Uploaded', new Date(info.createdAt).toLocaleString()],
        ]}
      />
      <PixelSpacingEditor key={info.imageId} info={info} />
      {info.warnings.length > 0 && (
        <List size="sm" c="yellow">
          {info.warnings.map((warning) => (
            <List.Item key={warning}>{warning}</List.Item>
          ))}
        </List>
      )}
    </Stack>
  );
}

function PreferencesContent() {
  const scrollBehaviour = usePreferences((state) => state.scrollBehaviour);
  const useWebGl = usePreferences((state) => state.useWebGl);
  const preferences = usePreferences.getState;
  return (
    <Stack gap="lg">
      <Stack gap={6}>
        <Text size="sm" fw={500}>
          Scroll behaviour
        </Text>
        <SegmentedControl
          value={scrollBehaviour}
          onChange={(value) => preferences().setScrollBehaviour(value as ScrollBehaviour)}
          data={[
            { value: 'auto', label: 'Auto' },
            { value: 'zoom', label: 'Always zoom' },
            { value: 'pan', label: 'Always pan' },
          ]}
        />
        <Text size="xs" c="dimmed">
          Auto: a mouse wheel zooms and a trackpad two-finger scroll pans. Pinch and {MOD_KEY === '⌘' ? '⌘' : 'Ctrl'} + scroll always zoom.
        </Text>
      </Stack>
      <Switch
        checked={useWebGl}
        onChange={(event) => preferences().setUseWebGl(event.currentTarget.checked)}
        label="Render with WebGL2"
        description="Turn off to use the slower lookup-table renderer. Both give identical pixels."
      />
    </Stack>
  );
}

const SHORTCUTS: [string, string][] = [
  [`${MOD_KEY}O`, 'Open image'],
  [`${MOD_KEY}S`, 'Save project'],
  ['R / E / P / F / W', 'Rectangle, ellipse, polygon, freehand, magic wand tool'],
  ['B / X', 'Brush, eraser (change the selected ROI)'],
  ['I', 'Livewire: outline that follows edges'],
  ['⇧1 … ⇧9 / ⇧0', 'Give the selected ROIs a class / remove it'],
  ['L', 'Ruler: drag to measure a distance (Shift: 45° steps)'],
  ['T', 'Add the drawn ROI to the ROI Manager'],
  ['M / ⇧M', 'Measure selected / all ROIs'],
  [`${MOD_KEY}Z / ${MOD_KEY}⇧Z`, 'Undo / redo ROI edits'],
  ['Z', 'Zoom to the selected ROIs'],
  ['⌫', 'Delete the selected ROIs'],
  [`${MOD_KEY},`, 'Preferences'],
  ['+ / −', 'Zoom in / out around the view centre'],
  ['1', 'Zoom to 100 %'],
  ['0', 'Fit the image to the window'],
  ['N', 'Show or hide the navigator'],
  ['Arrow keys', 'Pan by 50 px (Shift: by one view)'],
  ['Space + drag', 'Pan (also middle-button drag or the Pan tool)'],
  ['Mouse wheel', 'Zoom around the cursor'],
  ['Pinch', 'Zoom around the fingers'],
  ['Two-finger scroll', 'Pan'],
];

function ShortcutsContent() {
  return (
    <Table verticalSpacing={4}>
      <Table.Tbody>
        {SHORTCUTS.map(([keys, action]) => (
          <Table.Tr key={keys}>
            <Table.Td w={150}>
              <Kbd size="xs">{keys}</Kbd>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{action}</Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

const FEATURE_GROUP_LABELS: Record<string, string> = {
  regionStatistics: 'First-order statistics',
  haralick: 'Haralick features',
  other: 'Other co-occurrence features',
  runLength: 'Run length features (GLRLM)',
  sizeZone: 'Size zone features (GLSZM)',
  grayToneDifference: 'Neighbourhood gray tone difference features (NGTDM)',
  localBinaryPattern: 'Local binary pattern features (LBP)',
};

/** Where the server serves the built Sphinx documentation (GLCM_DOCS_DIR) */
const DOCS_URL = '/docs/';

function EquationsContent() {
  const catalog = useQuery(CATALOG_QUERY);
  // The documentation is served only when it has been built, so check before linking to it
  const docs = useQuery({
    queryKey: ['docs-available'],
    queryFn: async ({ signal }) => (await fetch(`${DOCS_URL}equations.html`, { method: 'HEAD', signal })).ok,
    staleTime: Infinity,
    retry: false,
  });
  if (catalog.isPending) {
    return <Text c="dimmed">Loading…</Text>;
  }
  if (catalog.isError) {
    return <Text c="red">{catalog.error.message}</Text>;
  }
  const { features } = catalog.data;
  const groups = [...new Set(features.map((feature) => feature.group))];

  return (
    <Stack gap="md">
      {docs.data ? (
        <Text size="sm">
          Definitions, conventions and references for every feature are in the documentation.{' '}
          <Anchor href={`${DOCS_URL}equations.html`} target="_blank" rel="noopener">
            Open the equations
          </Anchor>
        </Text>
      ) : (
        <Text size="sm" c="dimmed">
          The equations are in doc/equations.rst. To open them from here, build the documentation with{' '}
          <span className="mono">doc/.venv/bin/sphinx-build -b html doc doc/_build/html</span> and restart the server.
        </Text>
      )}
      {groups.map((group) => {
        const members = features.filter((feature) => feature.group === group);
        const anchor = members[0]?.docAnchor;
        return (
          <Stack key={group} gap={4}>
            <Group justify="space-between" gap="xs">
              <Text fw={600} size="sm">
                {FEATURE_GROUP_LABELS[group] ?? group}
              </Text>
              {docs.data && anchor && (
                <Anchor size="xs" href={`${DOCS_URL}${anchor}`} target="_blank" rel="noopener">
                  Equations
                </Anchor>
              )}
            </Group>
            <List size="sm" spacing={2}>
              {members.map((feature) => (
                <List.Item key={feature.id}>
                  {feature.name}
                  {feature.cost === 'slow' && (
                    <Badge size="xs" variant="light" color="gray" ml={6}>
                      slow
                    </Badge>
                  )}
                  {feature.nonStandard && (
                    <Text size="xs" c="yellow">
                      ⚠ Non-standard: {feature.nonStandardReason}
                    </Text>
                  )}
                </List.Item>
              ))}
            </List>
          </Stack>
        );
      })}
    </Stack>
  );
}

function AboutContent() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async ({ signal }) => (await (await fetch(`${API_PREFIX}/health`, { signal })).json()) as HealthResponse,
  });
  return (
    <Stack gap="xs">
      <Text size="sm">
        Texture features of regions of interest in grayscale images: co-occurrence (Haralick) features, first-order statistics,
        GLRLM, GLSZM, NGTDM and LBP.
      </Text>
      <InfoRows rows={[['Core version', health.data?.coreVersion ?? '…']]} />
      <Text size="xs" c="dimmed">
        Feature equations and references are in the Sphinx documentation (doc/).
      </Text>
    </Stack>
  );
}

function SamplesContent({ onClose }: { onClose(): void }) {
  const samples = useQuery({ queryKey: ['samples'], queryFn: ({ signal }) => getSamples(signal) });
  if (samples.isPending) {
    return <Text c="dimmed">Loading…</Text>;
  }
  if (samples.isError) {
    return <Text c="red">{samples.error.message}</Text>;
  }
  if (samples.data.samples.length === 0) {
    return <Text c="dimmed">The server has no sample images.</Text>;
  }

  const groups = new Map<string, SampleInfo[]>();
  for (const sample of samples.data.samples) {
    groups.set(sample.group, [...(groups.get(sample.group) ?? []), sample]);
  }
  return (
    <ScrollArea.Autosize mah="60vh">
      <Stack gap="xs">
        {[...groups].map(([group, entries]) => (
          <Stack key={group} gap={0}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} px="xs">
              {group || 'General'}
            </Text>
            {entries.map((sample) => (
              <NavLink
                key={sample.path}
                label={sample.name}
                rightSection={
                  <Badge size="xs" variant="light" color="gray">
                    {formatBytes(sample.sizeBytes)}
                  </Badge>
                }
                onClick={() => {
                  onClose();
                  void openSample(sample.path);
                }}
              />
            ))}
          </Stack>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

function SaveProjectContent({ onClose }: { onClose(): void }) {
  const image = useViewer((state) => state.image);
  const [embed, setEmbed] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!image) {
    return <Text c="dimmed">Open an image first.</Text>;
  }
  return (
    <Stack gap="md">
      <Text size="sm">
        The project file keeps the ROIs, the analysis settings and the results. It refers to the image by name and SHA-256; when the server does not
        have that image, opening the project asks for the file.
      </Text>
      <Checkbox
        checked={embed}
        onChange={(event) => setEmbed(event.currentTarget.checked)}
        label="Embed the image"
        description={`Makes the project portable; adds about ${formatBytes(Math.ceil((image.info.sizeBytes * 4) / 3))}.`}
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={saving}
          onClick={async () => {
            setSaving(true);
            const saved = await saveProjectFile({ embedImage: embed });
            setSaving(false);
            if (saved) {
              onClose();
            }
          }}
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}

function ExportRoiImagesContent({ onClose }: { onClose(): void }) {
  const image = useViewer((state) => state.image);
  const roiCount = useRois((state) => state.rois.length);
  const selectedCount = useRois((state) => state.selectedIds.length);
  const grayLevels = useAnalysisSettings((state) => state.settings?.grayLevels);
  // All ROIs by default: a newly added ROI is selected, so defaulting to the selection would usually export just that one
  const [scope, setScope] = useState<'selected' | 'all'>('all');
  const [transparentOutside, setTransparentOutside] = useState(false);
  const [includeQuantized, setIncludeQuantized] = useState(false);
  const [exporting, setExporting] = useState(false);
  const sixteenBit = image?.info.bitDepth === 16;

  return (
    <Stack gap="md">
      <SegmentedControl
        value={scope}
        onChange={(value) => setScope(value as 'selected' | 'all')}
        data={[
          { value: 'selected', label: `Selected ROIs (${selectedCount})`, disabled: selectedCount === 0 },
          { value: 'all', label: `All ROIs (${roiCount})` },
        ]}
      />
      <Text size="sm">
        Each ROI is exported as the crop of its bounding box ({sixteenBit ? '16-bit TIFF' : 'PNG'}) with the pixels outside the ROI set to 0, a mask
        and a manifest.json with the geometry, in one ZIP file.
      </Text>
      <Checkbox
        checked={transparentOutside && !sixteenBit}
        disabled={sixteenBit}
        onChange={(event) => setTransparentOutside(event.currentTarget.checked)}
        label="Transparent outside the ROI"
        description={sixteenBit ? 'Only for 8-bit images' : 'PNG alpha channel instead of 0'}
      />
      <Checkbox
        checked={includeQuantized}
        onChange={(event) => setIncludeQuantized(event.currentTarget.checked)}
        label="Include quantized gray levels"
        description={`<name>_q${grayLevels ?? 'Ng'}.png, quantized with the current analysis settings`}
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={exporting}
          disabled={roiCount === 0}
          onClick={async () => {
            setExporting(true);
            const exported = await exportRoiImagesFile({ scope, transparentOutside, includeQuantized });
            setExporting(false);
            if (exported) {
              onClose();
            }
          }}
        >
          Export
        </Button>
      </Group>
    </Stack>
  );
}

const TITLES: Record<ModalName, string> = {
  imageInfo: 'Image Info',
  preferences: 'Preferences',
  shortcuts: 'Keyboard Shortcuts',
  about: 'About Texture Workbench',
  samples: 'Open Sample Image',
  saveProject: 'Save Project',
  exportRoiImages: 'Export ROI Images',
  equations: 'Feature Equations',
  batch: 'Batch Measure',
  featureMap: 'Feature Map',
  thresholdRoi: 'Threshold ROI',
  roiClasses: 'ROI Classes',
  report: 'Save Report',
};

export function AppModals() {
  const modal = useUi((state) => state.modal);
  const close = () => useUi.getState().setModal(null);
  return (
    <Modal opened={modal !== null} onClose={close} title={modal ? TITLES[modal] : ''} size={modal === 'imageInfo' || modal === 'equations' || modal === 'batch' ? 'lg' : 'md'}>
      {modal === 'imageInfo' && <ImageInfoContent />}
      {modal === 'preferences' && <PreferencesContent />}
      {modal === 'shortcuts' && <ShortcutsContent />}
      {modal === 'equations' && <EquationsContent />}
      {modal === 'batch' && <BatchContent onClose={close} />}
      {modal === 'featureMap' && <FeatureMapContent onClose={close} />}
      {modal === 'thresholdRoi' && <ThresholdRoiContent onClose={close} />}
      {modal === 'roiClasses' && <RoiClassesContent onClose={close} />}
      {modal === 'about' && <AboutContent />}
      {modal === 'samples' && <SamplesContent onClose={close} />}
      {modal === 'saveProject' && <SaveProjectContent onClose={close} />}
      {modal === 'report' && <ReportContent onClose={close} />}
      {modal === 'exportRoiImages' && <ExportRoiImagesContent onClose={close} />}
    </Modal>
  );
}
