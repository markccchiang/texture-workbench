// Measure Selected / Measure All (doc/ui-design-plan.md, section 6.3.3).

import type { AnalysisEvent, AnalysisFinishedEvent, AnalysisResultEvent } from '@glcm/api';
import { notifications } from '@mantine/notifications';
import { analysisEventsUrl, cancelAnalysis, getAnalysisResults, startAnalysis } from '../api/client';
import { loadCatalog } from '../api/queryClient';
import { useResults } from '../results/resultsStore';
import { useRois, type ManagedRoi } from '../rois/roiStore';
import { useViewer } from '../stores/viewerStore';
import { adaptToImage, checkSettings, requestSettings } from '@glcm/api';
import { useAnalysisSettings } from './settingsStore';
import { readEventStream } from './sse';
import { waitForFinalResults } from './waitForResults';

function fail(title: string, message: string): void {
  notifications.show({ color: 'red', title, message, autoClose: 8000 });
}

/** The ROIs to measure; the active ROI is added to the manager first when it is the only candidate */
function targetRois(scope: 'selected' | 'all'): ManagedRoi[] {
  const rois = useRois.getState();
  if (scope === 'all') {
    if (rois.rois.length === 0) {
      rois.addActiveRoi();
    }
    return useRois.getState().rois;
  }
  if (rois.selectedIds.length === 0) {
    const id = rois.addActiveRoi();
    return id ? useRois.getState().rois.filter((roi) => roi.id === id) : [];
  }
  return rois.rois.filter((roi) => rois.selectedIds.includes(roi.id));
}

export async function measure(scope: 'selected' | 'all'): Promise<void> {
  const { image, window } = useViewer.getState();
  if (!image) {
    return;
  }
  const stored = useAnalysisSettings.getState().settings;
  if (!stored) {
    fail('Cannot measure', 'The analysis settings are not loaded yet.');
    return;
  }

  const { bitDepth, imageId } = image.info;
  const settings = adaptToImage(stored, bitDepth);
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (error) {
    fail('Cannot measure', (error as Error).message);
    return;
  }
  const { errors } = checkSettings(settings, bitDepth, catalog, useViewer.getState().pixelSpacing);
  if (errors.length > 0) {
    fail('Check the analysis settings', errors.join(' '));
    return;
  }

  const rois = targetRois(scope);
  if (rois.length === 0) {
    fail('Nothing to measure', scope === 'all' ? 'Draw an ROI first.' : 'Select an ROI in the ROI Manager or draw one.');
    return;
  }

  let info;
  try {
    info = await startAnalysis({
      imageId,
      rois: rois.map(({ id, name, color, shape, className }) => ({ id, name, color, shape, ...(className ? { class: className } : {}) })),
      settings: requestSettings(settings, bitDepth, window),
      pixelSpacing: useViewer.getState().pixelSpacing,
    });
  } catch (error) {
    fail('Could not start the measurement', (error as Error).message);
    return;
  }

  const results = useResults.getState();
  const { analysisId } = info;
  results.startRun(info);

  // Set by the event callback (an object, because TypeScript does not follow assignments inside callbacks)
  const stream: { finished: AnalysisFinishedEvent | null } = { finished: null };
  try {
    await readEventStream(analysisEventsUrl(analysisId), (message) => {
      const event = { event: message.event, data: JSON.parse(message.data) } as AnalysisEvent;
      if (event.event === 'result') {
        const { index, result } = event.data as AnalysisResultEvent;
        useResults.getState().addResult(analysisId, index, result);
      } else if (event.event === 'progress') {
        useResults.getState().setProgress(analysisId, event.data.completed, event.data.total);
      } else if (event.event === 'finished') {
        stream.finished = event.data;
      }
    });
  } catch (error) {
    notifications.show({
      color: 'yellow',
      title: 'Lost the connection to the measurement',
      message: `${(error as Error).message}. The results are loaded when the measurement finishes.`,
      autoClose: 8000,
    });
  }

  try {
    // Without a "finished" event the stream ended early, while the analysis may still be running on the server
    const final = stream.finished
      ? await getAnalysisResults(analysisId)
      : await waitForFinalResults(() => getAnalysisResults(analysisId), {
          onPending: (partial) => useResults.getState().setProgress(analysisId, partial.results.length, info.total),
        });
    useResults.getState().finishRun(analysisId, final.status, final.results, final.timestamp);
    const failedCount = final.results.filter((result) => result.status !== 'ok').length;
    if (final.status === 'cancelled') {
      notifications.show({ color: 'gray', title: 'Measurement cancelled', message: `${final.results.length} of ${info.total} jobs finished.` });
    } else if (failedCount > 0) {
      notifications.show({
        color: 'yellow',
        title: 'Some ROIs were not measured',
        message: `${failedCount} of ${final.results.length} results were skipped or failed; see the Status column.`,
      });
    }
  } catch (error) {
    useResults.getState().finishRun(analysisId, stream.finished?.status ?? 'failed');
    fail('Could not load the results', (error as Error).message);
  }
}

export async function cancelMeasurement(analysisId: string): Promise<void> {
  try {
    await cancelAnalysis(analysisId);
  } catch (error) {
    fail('Could not cancel', (error as Error).message);
  }
}
