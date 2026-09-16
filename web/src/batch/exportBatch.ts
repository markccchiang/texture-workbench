// Download of the results of a batch as one CSV file, or one per group of settings in a ZIP

import { strToU8, zipSync } from 'fflate';
import { getAnalysisCsv } from '../api/client';
import { downloadBlob, downloadText } from '../files/download';
import { combineResultsCsv } from '@glcm/api';

export async function downloadBatchResults(analysisIds: readonly string[]): Promise<void> {
  const texts = await Promise.all(analysisIds.map((analysisId) => getAnalysisCsv(analysisId)));
  const files = combineResultsCsv(texts);
  if (files.length === 1) {
    downloadText(files[0].text, 'batch-results.csv', 'text/csv');
    return;
  }
  // Images whose settings differ (e.g. 8-bit and 16-bit ranges) cannot share a header: one CSV per group of settings
  const zipped = zipSync(Object.fromEntries(files.map((file, index) => [`batch-results-${index + 1}.csv`, strToU8(file.text)])));
  downloadBlob(new Blob([zipped.slice().buffer], { type: 'application/zip' }), 'batch-results.zip');
}
