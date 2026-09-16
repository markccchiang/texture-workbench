// Analysis Settings panel (doc/ui-design-plan.md, section 6.3.1).

import type { Aggregation, AnalysisSettings, CatalogResponse, Direction, QuantizationMethod, ScoreProfile } from '@glcm/api';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Group,
  List,
  Menu,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconArrowBackUp, IconArrowForwardUp, IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CATALOG_QUERY } from '../api/queryClient';
import { useViewer } from '../stores/viewerStore';
import {
  adaptToImage,
  applyPreset,
  checkSettings,
  CUSTOM_PRESET,
  defaultSettings,
  GRAY_LEVEL_CHOICES,
  matchingPreset,
  maxIntensity,
  parseDistances,
} from '@glcm/api';
import { useAnalysisSettings } from './settingsStore';
import { formatLength, formatSpacing, isAnisotropic, offsetLengthsMm } from '../image/spacing';

export const NON_STANDARD_NOTE = 'Non-standard: follows Yang et al. (2012) as printed; see Feature Equations.';

const GROUP_LABELS: Record<string, string> = {
  regionStatistics: 'First-order statistics',
  haralick: 'Haralick',
  other: 'Other',
  runLength: 'Run length (GLRLM)',
  sizeZone: 'Size zone (GLSZM)',
  grayToneDifference: 'Gray tone difference (NGTDM)',
  localBinaryPattern: 'Local binary patterns (LBP)',
  shape: 'Shape (2D)',
};

const QUANTIZATION_OPTIONS: Array<{ value: QuantizationMethod; label: string }> = [
  { value: 'fixedRange', label: 'Fixed range' },
  { value: 'roiMinMax', label: 'ROI min–max' },
  { value: 'fixedBinWidth', label: 'Fixed bin width' },
  { value: 'none', label: 'None' },
];

const AGGREGATION_OPTIONS: Array<{ value: Aggregation; label: string }> = [
  { value: 'perDirectionAndMean', label: 'Per direction + mean' },
  { value: 'meanOnly', label: 'Mean only' },
  { value: 'meanAndRange', label: 'Mean + range (Haralick 1973)' },
];

const COEFFICIENT_LABELS = ['Age', 'Mean', 'Entropy', 'Contrast'];

function FeaturePicker({
  opened,
  onClose,
  catalog,
  selected,
  onChange,
}: {
  opened: boolean;
  onClose(): void;
  catalog: CatalogResponse;
  selected: string[];
  onChange(features: string[]): void;
}) {
  const [search, setSearch] = useState('');
  const chosen = new Set(selected);
  const query = search.trim().toLowerCase();
  const visible = catalog.features.filter((feature) => !query || feature.name.toLowerCase().includes(query) || feature.id.toLowerCase().includes(query));
  const commit = (ids: Set<string>) => onChange(catalog.features.filter((feature) => ids.has(feature.id)).map((feature) => feature.id));

  return (
    <Modal opened={opened} onClose={onClose} title="Features" size="lg">
      <Stack gap="sm">
        <TextInput placeholder="Search features" leftSection={<IconSearch size={14} />} value={search} onChange={(event) => setSearch(event.currentTarget.value)} data-autofocus />
        <Group gap="xs">
          <Button size="compact-xs" variant="light" onClick={() => commit(new Set([...chosen, ...visible.map((feature) => feature.id)]))}>
            Select {query ? 'matching' : 'all'}
          </Button>
          <Button size="compact-xs" variant="light" onClick={() => commit(new Set([...chosen].filter((id) => !visible.some((feature) => feature.id === id))))}>
            Clear {query ? 'matching' : 'all'}
          </Button>
          <Text size="xs" c="dimmed" ml="auto">
            {selected.length} selected
          </Text>
        </Group>
        <ScrollArea.Autosize mah="60vh">
          <Stack gap="md">
            {Object.entries(GROUP_LABELS).map(([group, label]) => {
              const features = visible.filter((feature) => feature.group === group);
              if (features.length === 0) {
                return null;
              }
              return (
                <Stack key={group} gap={6}>
                  <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                    {label}
                  </Text>
                  {features.map((feature) => (
                    <Checkbox
                      key={feature.id}
                      checked={chosen.has(feature.id)}
                      onChange={(event) => {
                        const next = new Set(chosen);
                        if (event.currentTarget.checked) {
                          next.add(feature.id);
                        } else {
                          next.delete(feature.id);
                        }
                        commit(next);
                      }}
                      label={
                        <Group gap={6}>
                          <span>{feature.name}</span>
                          {feature.nonStandard && (
                            <Tooltip label={feature.nonStandardReason || NON_STANDARD_NOTE} multiline w={280}>
                              <Badge size="xs" color="yellow" variant="light">
                                ⚠ non-standard
                              </Badge>
                            </Tooltip>
                          )}
                          {feature.cost === 'slow' && (
                            <Badge size="xs" color="gray" variant="light">
                              slow
                            </Badge>
                          )}
                        </Group>
                      }
                    />
                  ))}
                </Stack>
              );
            })}
          </Stack>
        </ScrollArea.Autosize>
      </Stack>
    </Modal>
  );
}

function SettingsForm({ settings, catalog, bitDepth }: { settings: AnalysisSettings; catalog: CatalogResponse; bitDepth: 8 | 16 }) {
  const update = useAnalysisSettings((state) => state.update);
  const canUndo = useAnalysisSettings((state) => state.past.length > 0);
  const canRedo = useAnalysisSettings((state) => state.future.length > 0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [distanceError, setDistanceError] = useState<string | null>(null);
  const pixelSpacing = useViewer((state) => state.pixelSpacing);
  const issues = checkSettings(settings, bitDepth, catalog, pixelSpacing);
  const presetId = matchingPreset(settings.features, catalog.presets);
  const limit = maxIntensity(bitDepth);
  const selectedFeatures = catalog.features.filter((feature) => settings.features.includes(feature.id));
  const set = (change: Partial<AnalysisSettings>) => update((current) => ({ ...current, ...change }));
  const setQuantization = (change: Partial<AnalysisSettings['quantization']>) =>
    update((current) => ({ ...current, quantization: { ...current.quantization, ...change } }));
  const setScore = (change: Partial<AnalysisSettings['score']>) => update((current) => ({ ...current, score: { ...current.score, ...change } }));

  return (
    <Stack gap="xs">
      <Group justify="flex-end" gap={2}>
        <Tooltip label="Undo settings change">
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Undo settings change" disabled={!canUndo} onClick={() => useAnalysisSettings.getState().undo()}>
            <IconArrowBackUp size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Redo settings change">
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Redo settings change" disabled={!canRedo} onClick={() => useAnalysisSettings.getState().redo()}>
            <IconArrowForwardUp size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Select
        size="xs"
        label="Preset"
        allowDeselect={false}
        value={presetId}
        data={[...catalog.presets.map((preset) => ({ value: preset.id, label: preset.name })), { value: CUSTOM_PRESET, label: 'Custom', disabled: true }]}
        onChange={(value) => {
          const preset = catalog.presets.find((candidate) => candidate.id === value);
          if (preset) {
            update((current) => applyPreset(current, preset));
          }
        }}
      />

      <Stack gap={4}>
        <Group justify="space-between" gap="xs">
          <Text size="xs" fw={500}>
            Features
          </Text>
          <Button size="compact-xs" variant="light" onClick={() => setPickerOpen(true)} data-testid="feature-picker-button">
            {settings.features.length} selected…
          </Button>
        </Group>
        <Text size="xs" c="dimmed" lineClamp={2}>
          {selectedFeatures.map((feature) => (feature.nonStandard ? `${feature.name} ⚠` : feature.name)).join(', ') || 'None'}
        </Text>
      </Stack>

      <NumberInput
        size="xs"
        label="Gray levels (Ng)"
        min={catalog.limits.minGrayLevels}
        max={catalog.limits.maxGrayLevels}
        allowDecimal={false}
        value={settings.grayLevels}
        onChange={(value) => typeof value === 'number' && set({ grayLevels: value })}
        rightSectionWidth={28}
        rightSection={
          <Menu position="bottom-end">
            <Menu.Target>
              <Button size="compact-xs" variant="subtle" color="gray" px={4} aria-label="Common gray levels">
                <IconChevronDown size={12} />
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {GRAY_LEVEL_CHOICES.map((choice) => (
                <Menu.Item key={choice} onClick={() => set({ grayLevels: choice })}>
                  {choice}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        }
      />

      <Select
        size="xs"
        label="Quantization"
        allowDeselect={false}
        value={settings.quantization.method}
        data={QUANTIZATION_OPTIONS}
        onChange={(value) => value && setQuantization({ method: value as QuantizationMethod })}
      />
      {settings.quantization.method === 'fixedRange' && (
        <Group grow gap="xs">
          <NumberInput size="xs" label="Min" min={0} max={limit} allowDecimal={false} value={settings.quantization.min} onChange={(value) => typeof value === 'number' && setQuantization({ min: value })} />
          <NumberInput size="xs" label="Max" min={0} max={limit} allowDecimal={false} value={settings.quantization.max} onChange={(value) => typeof value === 'number' && setQuantization({ max: value })} />
        </Group>
      )}
      {settings.quantization.method === 'fixedBinWidth' && (
        <NumberInput size="xs" label="Bin width" min={0} decimalScale={4} value={settings.quantization.binWidth} onChange={(value) => typeof value === 'number' && setQuantization({ binWidth: value })} />
      )}

      <TextInput
        key={settings.distances.join(',')}
        size="xs"
        label="Distances"
        description="Pixels between pair members, e.g. 1, 2, 4"
        defaultValue={settings.distances.join(', ')}
        error={distanceError}
        onChange={() => setDistanceError(null)}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        onBlur={(event) => {
          const distances = parseDistances(event.currentTarget.value);
          if (distances === null) {
            setDistanceError('Enter positive integers separated by commas');
          } else {
            set({ distances });
          }
        }}
      />

      <Checkbox.Group
        size="xs"
        label="Directions"
        value={settings.directions.map(String)}
        onChange={(values) => set({ directions: values.map((value) => Number(value) as Direction) })}
      >
        <Group gap="sm" mt={4}>
          {[0, 45, 90, 135].map((angle) => (
            <Checkbox key={angle} value={String(angle)} label={`${angle}°`} />
          ))}
        </Group>
      </Checkbox.Group>
      <AnisotropyNote distances={settings.distances} />

      <Select
        size="xs"
        label="Aggregation"
        allowDeselect={false}
        value={settings.aggregation}
        data={AGGREGATION_OPTIONS}
        onChange={(value) => value && set({ aggregation: value as Aggregation })}
      />

      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        justify="flex-start"
        leftSection={advancedOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        Advanced (filter, resampling, log base, score)
      </Button>
      <Collapse expanded={advancedOpen}>
        <Stack gap="xs" pl="xs">
          <Select
            size="xs"
            label="Filter"
            allowDeselect={false}
            value={settings.filter?.type ?? 'none'}
            data={[
              { value: 'none', label: 'None (the intensities)' },
              { value: 'laplacianOfGaussian', label: 'Laplacian of Gaussian' },
              { value: 'wavelet', label: 'Wavelet (Coiflet 1)' },
            ]}
            onChange={(value) => {
              if (value === 'laplacianOfGaussian' || value === 'wavelet') {
                // A filtered image has real values: PyRadiomics' default bin width unless a binning that fits is chosen
                update((current) => ({
                  ...current,
                  filter: value === 'laplacianOfGaussian' ? { type: value, sigma: 1 } : { type: value, band: 'LL' },
                  ...(current.quantization.method === 'fixedBinWidth' || current.quantization.method === 'roiMinMax'
                    ? {}
                    : { quantization: { ...current.quantization, method: 'fixedBinWidth', binWidth: 25 } }),
                }));
              } else if (value === 'none') {
                update(({ filter: _removed, ...current }) => current);
              }
            }}
          />
          {settings.filter?.type === 'laplacianOfGaussian' && (
            <>
              <NumberInput
                size="xs"
                label={`Sigma (${pixelSpacing ? 'mm' : 'pixels'})`}
                min={0}
                decimalScale={4}
                value={settings.filter.sigma}
                onChange={(value) => typeof value === 'number' && set({ filter: { type: 'laplacianOfGaussian', sigma: value } })}
              />
              <Text size="xs" c="dimmed">
                Measures the Laplacian of Gaussian of the image, as PyRadiomics computes it: edges and blobs of about the size of sigma
                stand out. Its values are real numbers, binned as PyRadiomics bins them; local binary patterns and the score are not
                available.
              </Text>
            </>
          )}
          {settings.filter?.type === 'wavelet' && (
            <>
              <Select
                size="xs"
                label="Sub-band"
                allowDeselect={false}
                value={settings.filter.band}
                data={[
                  { value: 'LL', label: 'LL (low-pass, the approximation)' },
                  { value: 'LH', label: 'LH (low along x, high along y)' },
                  { value: 'HL', label: 'HL (high along x, low along y)' },
                  { value: 'HH', label: 'HH (high-pass, diagonal detail)' },
                ]}
                onChange={(value) =>
                  (value === 'LL' || value === 'LH' || value === 'HL' || value === 'HH') && set({ filter: { type: 'wavelet', band: value } })
                }
              />
              <Text size="xs" c="dimmed">
                Measures one sub-band of the stationary wavelet transform (Coiflet 1, one level), as PyRadiomics computes it: LL keeps
                the smooth part, LH brings out horizontal edges, HL vertical ones and HH fine diagonal detail. Its values are real
                numbers, binned as PyRadiomics bins them; local binary patterns and the score are not available.
              </Text>
            </>
          )}
          <Switch
            size="xs"
            label="Resample before measuring"
            checked={settings.resampling !== undefined}
            onChange={(event) => {
              if (event.currentTarget.checked) {
                // Square pixels of the finer spacing, or 1 mm without a spacing
                const side = pixelSpacing ? Math.min(pixelSpacing.x, pixelSpacing.y) : 1;
                set({ resampling: { x: side, y: side } });
              } else {
                update(({ resampling: _removed, ...current }) => current);
              }
            }}
          />
          {settings.resampling && (
            <>
              <SimpleGrid cols={2} spacing="xs" verticalSpacing="xs">
                {(['x', 'y'] as const).map((axis) => (
                  <NumberInput
                    key={axis}
                    size="xs"
                    label={axis === 'x' ? 'Pixel width (mm)' : 'Pixel height (mm)'}
                    min={0}
                    decimalScale={6}
                    value={settings.resampling![axis]}
                    onChange={(value) => typeof value === 'number' && set({ resampling: { ...settings.resampling!, [axis]: value } })}
                  />
                ))}
              </SimpleGrid>
              {pixelSpacing && (
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() => {
                    const side = Math.min(pixelSpacing.x, pixelSpacing.y);
                    set({ resampling: { x: side, y: side } });
                  }}
                >
                  Square pixels of {formatLength(Math.min(pixelSpacing.x, pixelSpacing.y))}
                </Button>
              )}
              <Text size="xs" c="dimmed">
                The image is resampled with a cubic B-spline and the ROIs are laid on the new pixels, as PyRadiomics does;
                pixel counts, areas and shape features then count the new pixels.
                {pixelSpacing ? ` The image has ${formatSpacing(pixelSpacing)} pixels.` : ''}
              </Text>
            </>
          )}
          <Select
            size="xs"
            label="Log base"
            allowDeselect={false}
            value={settings.logBase}
            data={[
              { value: 'natural', label: 'Natural (ln)' },
              { value: 'log2', label: 'log₂ (PyRadiomics, mahotas)' },
            ]}
            onChange={(value) => value && set({ logBase: value as AnalysisSettings['logBase'] })}
          />
          <Switch size="xs" label="Age-based score" checked={settings.score.enabled} onChange={(event) => setScore({ enabled: event.currentTarget.checked })} />
          {settings.score.enabled && (
            <>
              <NumberInput size="xs" label="Age (years)" min={0} decimalScale={2} value={settings.score.age} onChange={(value) => typeof value === 'number' && setScore({ age: value })} />
              <SimpleGrid cols={2} spacing="xs" verticalSpacing="xs">
                {COEFFICIENT_LABELS.map((label, i) => (
                  <NumberInput
                    key={label}
                    size="xs"
                    label={`${label} coefficient`}
                    decimalScale={6}
                    value={settings.score.coefficients[i]}
                    onChange={(value) => {
                      if (typeof value === 'number') {
                        const coefficients = [...settings.score.coefficients] as AnalysisSettings['score']['coefficients'];
                        coefficients[i] = value;
                        setScore({ coefficients });
                      }
                    }}
                  />
                ))}
              </SimpleGrid>
              <Select
                size="xs"
                label="Score profile"
                allowDeselect={false}
                value={settings.score.profile}
                data={[
                  { value: 'calibration', label: 'Calibration (Ng 256, d 1, all directions)' },
                  { value: 'currentSettings', label: 'Current settings' },
                ]}
                onChange={(value) => value && setScore({ profile: value as ScoreProfile })}
              />
              <Button
                size="compact-xs"
                variant="light"
                onClick={() => {
                  const c = catalog.limits.defaultScoreCoefficients;
                  setScore({ coefficients: [c.age, c.mean, c.entropy, c.contrast], age: 40 });
                }}
              >
                Reset age and coefficients
              </Button>
            </>
          )}
        </Stack>
      </Collapse>

      <Button size="compact-xs" variant="subtle" color="gray" onClick={() => useAnalysisSettings.getState().setSettings(defaultSettings(catalog, bitDepth), { history: 'record' })}>
        Reset to defaults
      </Button>

      {(issues.errors.length > 0 || issues.warnings.length > 0) && (
        <List size="xs" spacing={2} data-testid="settings-issues">
          {issues.errors.map((error) => (
            <List.Item key={error} c="red">
              {error}
            </List.Item>
          ))}
          {issues.warnings.map((warning) => (
            <List.Item key={warning} c="yellow">
              {warning}
            </List.Item>
          ))}
        </List>
      )}

      <FeaturePicker opened={pickerOpen} onClose={() => setPickerOpen(false)} catalog={catalog} selected={settings.features} onChange={(features) => set({ features })} />
    </Stack>
  );
}

/** With non-square pixels, the neighbours at distance d lie at different physical distances in each direction */
function AnisotropyNote({ distances }: { distances: readonly number[] }) {
  const spacing = useViewer((state) => state.pixelSpacing);
  if (!spacing || !isAnisotropic(spacing)) {
    return null;
  }
  const distance = distances[0] ?? 1;
  const lengths = offsetLengthsMm(spacing, distance);
  return (
    <Text size="xs" c="yellow" data-testid="anisotropy-note">
      The pixels are {formatSpacing(spacing)}, so at d = {distance} the neighbour is {formatLength(lengths.horizontal)} away at 0°,{' '}
      {formatLength(lengths.vertical)} at 90° and {formatLength(lengths.diagonal)} at 45° and 135°. Directional values and their mean mix these
      lengths.
    </Text>
  );
}

export function SettingsPanel() {
  const catalog = useQuery(CATALOG_QUERY);
  const bitDepth = useViewer((state) => state.image?.info.bitDepth ?? 8);
  const imageId = useViewer((state) => state.image?.info.imageId ?? null);
  const settings = useAnalysisSettings((state) => state.settings);

  // Defaults on first use; stored settings are fitted to each opened image
  useEffect(() => {
    if (catalog.data && !settings) {
      useAnalysisSettings.getState().setSettings(defaultSettings(catalog.data, bitDepth));
    }
  }, [catalog.data, settings, bitDepth]);

  useEffect(() => {
    const current = useAnalysisSettings.getState().settings;
    if (current && imageId) {
      const adapted = adaptToImage(current, bitDepth);
      if (JSON.stringify(adapted) !== JSON.stringify(current)) {
        useAnalysisSettings.getState().setSettings(adapted);
      }
    }
  }, [imageId, bitDepth]);

  if (catalog.isError) {
    return (
      <Text size="xs" c="red">
        The feature catalog could not be loaded: {catalog.error.message}
      </Text>
    );
  }
  if (!catalog.data || !settings) {
    return (
      <Text size="xs" c="dimmed">
        Loading…
      </Text>
    );
  }
  return <SettingsForm settings={settings} catalog={catalog.data} bitDepth={bitDepth} />;
}
