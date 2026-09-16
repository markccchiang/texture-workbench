// File ▸ Save Report…: a title, notes and the sections the report should contain.

import { Button, Group, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { CATALOG_QUERY } from '../api/queryClient';
import { useViewer } from '../stores/viewerStore';
import { usePreferences } from '../stores/preferences';
import { useResults } from '../results/resultsStore';
import type { ReportSections } from './reportHtml';
import { reportSummary } from './reportModel';
import { buildCurrentModel, saveReportFile } from './saveReport';

const SECTION_LABELS: Array<{ id: keyof ReportSections; label: string; description: string }> = [
  { id: 'image', label: 'Images', description: 'A picture of each measured image, the open one with its ROIs' },
  { id: 'rois', label: 'ROI list', description: 'Name, class, shape, pixels and area of every ROI' },
  { id: 'settings', label: 'Analysis settings', description: 'The settings each measurement was computed with' },
  { id: 'results', label: 'Results table', description: 'Every row of the Results panel' },
  { id: 'charts', label: 'Charts', description: 'A bar chart per feature, as in the Plot view' },
];

export function ReportContent({ onClose }: { onClose(): void }) {
  const imageName = useViewer((state) => state.image?.info.name ?? null);
  const runs = useResults((state) => state.runs);
  const sections = usePreferences((state) => state.reportSections);
  const catalog = useQuery(CATALOG_QUERY);
  const [title, setTitle] = useState(imageName ? `Texture analysis of ${imageName}` : 'Texture analysis report');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Counts shown before saving; the model is cheap to build and draws nothing. Only the runs and the catalog change
  // them, so the title and the notes are not dependencies.
  const summary = useMemo(() => reportSummary(buildCurrentModel(catalog.data?.features ?? [], '', '', '')), [runs, catalog.data]);

  const setSection = (id: keyof ReportSections, value: boolean) => usePreferences.getState().setReportSections({ ...sections, [id]: value });

  return (
    <Stack gap="md">
      <Text size="sm">
        One HTML file with everything measured in this session: the images, ROIs, settings, results and charts. Open it in a browser and use
        Print ▸ Save as PDF for a PDF.
      </Text>
      <TextInput label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={200} />
      <Textarea
        label="Notes"
        description="Shown under the title, for example what was measured and why"
        value={notes}
        onChange={(event) => setNotes(event.currentTarget.value)}
        autosize
        minRows={2}
        maxRows={6}
        maxLength={2000}
      />
      <Stack gap={6}>
        {SECTION_LABELS.map(({ id, label, description }) => (
          <Switch key={id} checked={sections[id]} onChange={(event) => setSection(id, event.currentTarget.checked)} label={label} description={description} />
        ))}
      </Stack>
      <Text size="xs" c="dimmed" data-testid="report-summary">
        {summary.images === 0
          ? 'Nothing measured yet: the report would be empty.'
          : `${summary.images} ${summary.images === 1 ? 'image' : 'images'} · ${summary.rois} ${summary.rois === 1 ? 'ROI' : 'ROIs'} · ${summary.rows} result ${summary.rows === 1 ? 'row' : 'rows'}${sections.charts ? ` · ${summary.charts} ${summary.charts === 1 ? 'chart' : 'charts'}` : ''}`}
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={saving}
          disabled={summary.images === 0}
          onClick={async () => {
            setSaving(true);
            const saved = await saveReportFile({ title, notes, sections });
            setSaving(false);
            if (saved) {
              onClose();
            }
          }}
        >
          Save Report
        </Button>
      </Group>
    </Stack>
  );
}
