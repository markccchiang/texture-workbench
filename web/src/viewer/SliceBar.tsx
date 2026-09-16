// The slice slider of a stack, below the image (ImageJ's stack slider): shows the slice and moves to others

import { ActionIcon, Slider, Text, Tooltip } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { showSlice } from '../stores/imageLoader';
import { useViewer } from '../stores/viewerStore';

export function SliceBar() {
  const slices = useViewer((state) => state.image?.info.slices ?? 1);
  const shown = useViewer((state) => state.image?.slice ?? 1);
  // Follows the slider at once; the image follows when the slice's samples are there
  const [value, setValue] = useState(shown);
  useEffect(() => setValue(shown), [shown]);

  if (slices <= 1) {
    return null;
  }
  const go = (slice: number) => {
    const target = Math.min(slices, Math.max(1, slice));
    setValue(target);
    void showSlice(target);
  };
  return (
    <div className="slice-bar" data-testid="slice-bar">
      <Tooltip label="Previous slice (,)">
        <ActionIcon size="sm" variant="subtle" aria-label="Previous slice" disabled={value <= 1} onClick={() => go(value - 1)}>
          <IconChevronLeft size={14} />
        </ActionIcon>
      </Tooltip>
      <Slider aria-label="Slice" size="sm" min={1} max={slices} step={1} value={value} label={null} onChange={go} style={{ flex: 1 }} />
      <Tooltip label="Next slice (.)">
        <ActionIcon size="sm" variant="subtle" aria-label="Next slice" disabled={value >= slices} onClick={() => go(value + 1)}>
          <IconChevronRight size={14} />
        </ActionIcon>
      </Tooltip>
      <Text size="xs" className="mono" data-testid="slice-readout" w={90} ta="right">
        {shown} / {slices}
      </Text>
    </div>
  );
}
