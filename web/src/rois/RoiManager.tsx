// ROI Manager (doc/ui-design-plan.md, section 6.2).

import { ActionIcon, Button, Menu, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCopy, IconDots, IconEye, IconEyeOff, IconPlus, IconTrash } from '@tabler/icons-react';
import type { MouseEvent } from 'react';
import { PanelSection } from '../components/PanelSection';
import { exportImageJRoisFile, exportRoiSetFile } from '../files/actions';
import { showSlice } from '../stores/imageLoader';
import { useUi } from '../stores/uiStore';
import { useViewer } from '../stores/viewerStore';
import { ROI_COLORS, SHAPE_LABELS, shapeBounds, shapeKind } from './geometry';
import { useRois, type ManagedRoi } from './roiStore';
import { roiProblem, useRoiStatistics } from './useRoiStatistics';
import { areaMm2, formatArea } from '../image/spacing';
import { combineSelectedRois } from './editActions';
import { openGrowDialog } from './GrowDialog';

function RoiRow({ roi, pixelCount, problem }: { roi: ManagedRoi; pixelCount: number | undefined; problem: string | null }) {
  const pixelSpacing = useViewer((state) => state.pixelSpacing);
  const selected = useRois((state) => state.selectedIds.includes(roi.id));
  const hovered = useRois((state) => state.hoveredId === roi.id);
  const renaming = useUi((state) => state.renamingRoiId === roi.id);
  const classes = useRois((state) => state.classes);
  const slices = useViewer((state) => state.image?.info.slices ?? 1);
  const store = useRois.getState;

  const onClick = (event: MouseEvent) => {
    // An ROI on another slice of the stack: show its slice first, which clears a selection on the slice shown
    const { image } = useViewer.getState();
    if (roi.slice !== undefined && image && (image.slice ?? 1) !== roi.slice) {
      void showSlice(roi.slice).then((shown) => shown && store().select([roi.id]));
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      store().toggleSelected(roi.id);
    } else if (event.shiftKey) {
      store().selectRange(roi.id);
    } else {
      store().select([roi.id]);
    }
  };

  const finishRename = (name: string | null) => {
    if (name !== null) {
      store().renameRoi(roi.id, name);
    }
    useUi.getState().setRenamingRoiId(null);
  };

  return (
    <div
      className="roi-row"
      role="option"
      aria-selected={selected}
      data-hovered={hovered || undefined}
      data-testid="roi-row"
      onClick={onClick}
      onDoubleClick={() => useUi.getState().setRenamingRoiId(roi.id)}
      onMouseEnter={() => store().setHovered(roi.id)}
      onMouseLeave={() => store().setHovered(null)}
    >
      <ActionIcon
        size="sm"
        variant="subtle"
        color="gray"
        aria-label={roi.visible ? 'Hide ROI' : 'Show ROI'}
        onClick={(event) => {
          event.stopPropagation();
          store().setVisible(roi.id, !roi.visible);
        }}
      >
        {roi.visible ? <IconEye size={14} /> : <IconEyeOff size={14} />}
      </ActionIcon>
      <span className="roi-swatch" style={{ background: roi.color }} />
      {renaming ? (
        <TextInput
          size="xs"
          autoFocus
          defaultValue={roi.name}
          aria-label="ROI name"
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => finishRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              finishRename(event.currentTarget.value);
            } else if (event.key === 'Escape') {
              finishRename(null);
            }
          }}
        />
      ) : (
        <Text size="sm" truncate title={roi.className ? `${roi.name} (${roi.className})` : roi.name}>
          {roi.name}
          {roi.className && (
            <span className="roi-class-tag" data-testid="roi-class-tag">
              {' '}
              · {roi.className}
            </span>
          )}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {roi.slice !== undefined && <span data-testid="roi-slice">{`slice ${roi.slice} · `}</span>}
        {SHAPE_LABELS[shapeKind(roi.shape)]}
      </Text>
      <Text size="xs" className="mono roi-pixels" ta="right">
        {problem ? (
          <Tooltip label={problem} multiline w={220}>
            <span className="roi-problem">
              <IconAlertTriangle size={12} /> {pixelCount ?? ''}
            </span>
          </Tooltip>
        ) : pixelCount === undefined ? (
          '…'
        ) : (
          <>
            {`${pixelCount.toLocaleString()} px`}
            {pixelSpacing && <span className="roi-area">{formatArea(areaMm2(pixelCount, pixelSpacing))}</span>}
          </>
        )}
      </Text>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label="ROI actions" onClick={(event) => event.stopPropagation()}>
            <IconDots size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
          <Menu.Item
            onClick={() => {
              store().select([roi.id]);
              useViewer.getState().zoomToRegion(shapeBounds(roi.shape));
            }}
          >
            Zoom to ROI
          </Menu.Item>
          <Menu.Item onClick={() => useUi.getState().setRenamingRoiId(roi.id)}>Rename</Menu.Item>
          <Menu.Label>Colour</Menu.Label>
          <div className="roi-colour-choices" role="group" aria-label="ROI colour">
            {ROI_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="roi-colour-choice"
                style={{ background: color }}
                aria-label={`Colour ${color}`}
                aria-pressed={roi.color.toUpperCase() === color}
                onClick={() => store().recolorRoi(roi.id, color)}
              />
            ))}
          </div>
          <Menu.Label>Class</Menu.Label>
          <Menu.Item onClick={() => store().assignClass([roi.id], null)} fw={roi.className ? undefined : 600}>
            No class
          </Menu.Item>
          {classes.map((roiClass) => (
            <Menu.Item
              key={roiClass.name}
              leftSection={<span className="roi-swatch" style={{ background: roiClass.color }} />}
              fw={roi.className === roiClass.name ? 600 : undefined}
              onClick={() => store().assignClass([roi.id], roiClass.name)}
            >
              {roiClass.name}
            </Menu.Item>
          ))}
          <Menu.Item onClick={() => useUi.getState().setModal('roiClasses')}>Manage Classes…</Menu.Item>
          <Menu.Divider />
          <Menu.Item onClick={() => store().duplicateRois([roi.id])}>Duplicate</Menu.Item>
          {slices > 1 && <Menu.Item onClick={() => store().copyToAllSlices([roi.id], slices)}>Copy to All Slices</Menu.Item>}
          <Menu.Item color="red" onClick={() => store().deleteRois([roi.id])}>
            Delete
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

export function RoiManager() {
  const rois = useRois((state) => state.rois);
  const hasSelection = useRois((state) => state.selectedIds.length > 0);
  const selectedCount = useRois((state) => state.selectedIds.length);
  const hasActive = useRois((state) => state.activeShape !== null);
  const hasImage = useViewer((state) => state.image !== null);
  const slices = useViewer((state) => state.image?.info.slices ?? 1);
  const statistics = useRoiStatistics();
  const store = useRois.getState;

  return (
    <PanelSection
      title={`ROI Manager${rois.length ? ` (${rois.length})` : ''}`}
      bodyClassName="roi-list"
      actions={
        <Menu position="bottom-end">
          <Menu.Target>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="ROI Manager actions">
              <IconDots size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item disabled={rois.length === 0} onClick={() => store().setAllVisible(true)}>
              Show all
            </Menu.Item>
            <Menu.Item disabled={rois.length === 0} onClick={() => store().setAllVisible(false)}>
              Hide all
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item onClick={() => useUi.getState().setModal('roiClasses')}>Manage Classes…</Menu.Item>
            <Menu.Divider />
            <Menu.Item disabled={selectedCount < 2} onClick={() => void combineSelectedRois('union')}>
              Union
            </Menu.Item>
            <Menu.Item disabled={selectedCount < 2} onClick={() => void combineSelectedRois('subtract')}>
              Subtract
            </Menu.Item>
            <Menu.Item disabled={selectedCount < 2} onClick={() => void combineSelectedRois('intersect')}>
              Intersect
            </Menu.Item>
            <Menu.Item disabled={selectedCount < 2} onClick={() => void combineSelectedRois('xor')}>
              XOR
            </Menu.Item>
            <Menu.Item disabled={selectedCount === 0} onClick={() => openGrowDialog('enlarge')}>
              Enlarge or Shrink…
            </Menu.Item>
            <Menu.Item disabled={selectedCount === 0} onClick={() => openGrowDialog('band')}>
              Make Band…
            </Menu.Item>
            {slices > 1 && (
              <Menu.Item disabled={selectedCount === 0} onClick={() => store().copyToAllSlices(store().selectedIds, slices)}>
                Copy to All Slices
              </Menu.Item>
            )}
            <Menu.Divider />
            <Menu.Item disabled={!hasImage} onClick={() => useUi.getState().requestFile('roiSet')}>
              Import ROI Set…
            </Menu.Item>
            <Menu.Item disabled={rois.length === 0} onClick={exportRoiSetFile}>
              Export ROI Set…
            </Menu.Item>
            <Menu.Item disabled={rois.length === 0} onClick={exportImageJRoisFile}>
              Export ROIs for ImageJ…
            </Menu.Item>
            <Menu.Item disabled={rois.length === 0} onClick={() => useUi.getState().setModal('exportRoiImages')}>
              Export ROI Images…
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      }
      footer={
        <>
          <Button size="compact-xs" leftSection={<IconPlus size={12} />} disabled={!hasActive} onClick={() => store().addActiveRoi()}>
            Add (T)
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconCopy size={12} />}
            disabled={!hasSelection}
            onClick={() => store().duplicateRois(store().selectedIds)}
          >
            Duplicate
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            color="red"
            leftSection={<IconTrash size={12} />}
            disabled={!hasSelection}
            onClick={() => store().deleteRois(store().selectedIds)}
          >
            Delete
          </Button>
        </>
      }
    >
      <div role="listbox" aria-multiselectable aria-label="ROIs">
        {rois.map((roi) => {
          const roiStatistics = statistics.get(roi.id);
          return <RoiRow key={roi.id} roi={roi} pixelCount={roiStatistics?.pixelCount} problem={roiProblem(roiStatistics)} />;
        })}
      </div>
      {rois.length === 0 && (
        <Text size="sm" c="dimmed" p="sm">
          {!hasImage
            ? 'Open an image to draw ROIs.'
            : hasActive
              ? 'Press T or Add to keep the drawn ROI.'
              : 'Draw an ROI with the rectangle (R), ellipse (E), polygon (P) or freehand (F) tool.'}
        </Text>
      )}
    </PanelSection>
  );
}
