// Pixel counts and statistics of the ROIs from POST /images/{id}/roi-stats, so the numbers equal those of the analysis
// (doc/ui-design-plan.md, section 6.2).

import type { RoiStatistics } from '@glcm/api';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getRoiStats } from '../api/client';
import { useViewer } from '../stores/viewerStore';
import { useRois } from './roiStore';

/** Key of the active (not yet added) ROI in the statistics map */
export const ACTIVE_ROI_ID = '__active__';

const DEBOUNCE_MS = 250;

export function useRoiStatistics(): Map<string, RoiStatistics> {
  const imageId = useViewer((state) => state.image?.info.imageId ?? null);
  const rois = useRois((state) => state.rois);
  const activeShape = useRois((state) => state.activeShape);
  const currentSlice = useRois((state) => state.currentSlice);

  const request = useMemo(
    () =>
      JSON.stringify([
        ...rois.map(({ id, shape, slice }) => ({ id, shape, ...(slice !== undefined ? { slice } : {}) })),
        ...(activeShape ? [{ id: ACTIVE_ROI_ID, shape: activeShape, ...(currentSlice !== null ? { slice: currentSlice } : {}) }] : []),
      ]),
    [rois, activeShape, currentSlice],
  );
  const [debounced] = useDebouncedValue(request, DEBOUNCE_MS);

  const query = useQuery({
    queryKey: ['roi-stats', imageId, debounced],
    queryFn: ({ signal }) => getRoiStats(imageId!, JSON.parse(debounced), signal),
    enabled: imageId !== null && debounced !== '[]',
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });

  return useMemo(() => new Map((query.data?.stats ?? []).map((statistics) => [statistics.roiId, statistics])), [query.data]);
}

/** Why an ROI cannot be measured, or null */
export function roiProblem(statistics: RoiStatistics | undefined): string | null {
  if (!statistics) {
    return null;
  }
  if (statistics.error) {
    return statistics.error;
  }
  if (statistics.pixelCount < 2) {
    return statistics.pixelCount === 0 ? 'The ROI contains no pixels (it may lie outside the image)' : 'The ROI contains fewer than 2 pixels';
  }
  return null;
}
