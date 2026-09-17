import { ActionIcon, Button, Group, NumberInput, Popover, RangeSlider, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconAdjustmentsHorizontal, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { colorStops, colorTableById, COLOR_TABLES, cssGradient } from '../image/colorTables';
import { histogramPath, valueToHistogramX } from '../image/histogram';
import { usePreferences } from '../stores/preferences';
import { useUi } from '../stores/uiStore';
import { maxSampleValue, useViewer } from '../stores/viewerStore';

const HISTOGRAM_WIDTH = 256;
const HISTOGRAM_HEIGHT = 72;

/** Windows the user saved, offered for images of the same bit depth */
function SavedWindows({ bitDepth, min, max, maxValue }: { bitDepth: number; min: number; max: number; maxValue: number }) {
  const allPresets = usePreferences((state) => state.windowPresets);
  const [name, setName] = useState('');
  const presets = allPresets.filter((preset) => preset.bitDepth === bitDepth);
  const save = () => {
    const trimmed = name.trim();
    if (trimmed) {
      usePreferences.getState().saveWindowPreset({ name: trimmed, bitDepth, min, max });
      setName('');
    }
  };

  return (
    <Stack gap={6}>
      <Text size="xs" fw={500}>
        Saved windows
      </Text>
      {presets.length === 0 ? (
        <Text size="xs" c="dimmed">
          None saved for {bitDepth}-bit images yet.
        </Text>
      ) : (
        <Group gap={6}>
          {presets.map((preset) => (
            <Button.Group key={preset.name}>
              <Button
                size="compact-xs"
                variant="default"
                title={`${preset.min}–${preset.max}`}
                onClick={() => useViewer.getState().setWindow(Math.min(preset.min, maxValue), Math.min(preset.max, maxValue))}
              >
                {preset.name}
              </Button>
              <Button
                size="compact-xs"
                variant="default"
                px={4}
                aria-label={`Remove saved window ${preset.name}`}
                onClick={() => usePreferences.getState().removeWindowPreset(preset.name, bitDepth)}
              >
                <IconX size={10} />
              </Button>
            </Button.Group>
          ))}
        </Group>
      )}
      <Group gap={6} wrap="nowrap">
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          placeholder={`Name for ${min}–${max}`}
          aria-label="Name of the saved window"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              save();
            }
          }}
        />
        <Button size="compact-xs" disabled={!name.trim()} onClick={save}>
          Save
        </Button>
      </Group>
    </Stack>
  );
}

/** The colour tables of the display, each with a swatch */
function ColorTablePicker() {
  const current = useViewer((state) => state.colorTable);
  return (
    <Stack gap={4}>
      <Text size="xs" fw={500}>
        Colour table
      </Text>
      <Group gap={4} role="radiogroup" aria-label="Colour table" wrap="nowrap">
        {COLOR_TABLES.map((table) => (
          <UnstyledButton
            key={table.id}
            role="radio"
            aria-checked={current === table.id}
            aria-label={table.name}
            className="colour-table-option"
            data-selected={current === table.id || undefined}
            onClick={() => useViewer.getState().setColorTable(table.id)}
          >
            <span className="colour-table-swatch" style={{ background: cssGradient(table) }} />
            <Text size="xs">{table.name}</Text>
          </UnstyledButton>
        ))}
      </Group>
    </Stack>
  );
}

function WindowLevelPanel() {
  const image = useViewer((state) => state.image);
  const window = useViewer((state) => state.window);
  const colorTable = useViewer((state) => state.colorTable);
  const viewer = useViewer.getState;
  if (!image) {
    return null;
  }
  const maxValue = maxSampleValue(image.info.bitDepth);
  const minX = valueToHistogramX(window.min, maxValue, HISTOGRAM_WIDTH);
  const maxX = valueToHistogramX(window.max + 1, maxValue, HISTOGRAM_WIDTH);

  return (
    <Stack gap="xs" w={HISTOGRAM_WIDTH}>
      <Text size="xs" c="dimmed">
        Histogram (log scale), {image.info.bitDepth}-bit
      </Text>
      <svg className="histogram" width={HISTOGRAM_WIDTH} height={HISTOGRAM_HEIGHT} role="img" aria-label="Intensity histogram">
        <rect x={minX} y={0} width={Math.max(1, maxX - minX)} height={HISTOGRAM_HEIGHT} fill="rgba(34, 139, 230, 0.2)" />
        <path d={histogramPath(image.info.histogram, HISTOGRAM_WIDTH, HISTOGRAM_HEIGHT)} fill="#adb5bd" />
        <line x1={minX} x2={minX} y1={0} y2={HISTOGRAM_HEIGHT} stroke="#228be6" />
        <line x1={maxX} x2={maxX} y1={0} y2={HISTOGRAM_HEIGHT} stroke="#228be6" />
      </svg>
      {/* The display colours along the histogram: the first colour below the window, the last above it */}
      <svg width={HISTOGRAM_WIDTH} height={10} aria-hidden="true" data-testid="window-colours">
        <defs>
          <linearGradient id="window-colours-gradient" gradientUnits="userSpaceOnUse" x1={minX} x2={Math.max(maxX, minX + 1)} y1={0} y2={0}>
            {colorStops(colorTableById(colorTable)).map(({ offset, color }) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
        </defs>
        <rect width={HISTOGRAM_WIDTH} height={10} rx={2} fill="url(#window-colours-gradient)" />
      </svg>
      <Group gap="xs" grow>
        <NumberInput
          size="xs"
          label="Min"
          min={0}
          max={maxValue}
          allowDecimal={false}
          value={window.min}
          onChange={(value) => typeof value === 'number' && viewer().setWindow(value, Math.max(value, window.max))}
        />
        <NumberInput
          size="xs"
          label="Max"
          min={0}
          max={maxValue}
          allowDecimal={false}
          value={window.max}
          onChange={(value) => typeof value === 'number' && viewer().setWindow(Math.min(value, window.min), value)}
        />
      </Group>
      <Group gap="xs" grow>
        <Button size="compact-xs" variant="light" onClick={() => viewer().resetWindow('auto')}>
          Auto
        </Button>
        <Button size="compact-xs" variant="light" onClick={() => viewer().resetWindow('full')}>
          Full range
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Auto = the window the image opened with ({image.info.windowMin}–{image.info.windowMax}): the 0.5–99.5 percentiles, or the window stored in a DICOM file
      </Text>
      <ColorTablePicker />
      <SavedWindows bitDepth={image.info.bitDepth} min={window.min} max={window.max} maxValue={maxValue} />
    </Stack>
  );
}

export function WindowLevelControl() {
  const image = useViewer((state) => state.image);
  const window = useViewer((state) => state.window);
  const panelOpen = useUi((state) => state.windowPanelOpen);
  const maxValue = image ? maxSampleValue(image.info.bitDepth) : 255;

  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" c="dimmed">
        Window
      </Text>
      <Text size="xs" className="mono" w={40} ta="right">
        {image ? window.min : '–'}
      </Text>
      <RangeSlider
        w={180}
        size="sm"
        min={0}
        max={maxValue}
        minRange={0}
        label={null}
        disabled={!image}
        value={[window.min, window.max]}
        onChange={([min, max]) => useViewer.getState().setWindow(min, max)}
        thumbFromLabel="Window minimum"
        thumbToLabel="Window maximum"
      />
      <Text size="xs" className="mono" w={40}>
        {image ? window.max : '–'}
      </Text>
      <Popover opened={panelOpen && image !== null} onChange={(open) => useUi.getState().setWindowPanelOpen(open)} position="bottom" shadow="md" withArrow>
        <Popover.Target>
          <ActionIcon variant="subtle" color="gray" disabled={!image} aria-label="Window/level settings" onClick={() => useUi.getState().setWindowPanelOpen(!panelOpen)}>
            <IconAdjustmentsHorizontal size={18} />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown>
          <WindowLevelPanel />
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}
