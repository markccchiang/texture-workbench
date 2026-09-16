// Actions shared by keyboard shortcuts, menus and toolbar buttons.

import { measure } from '../analysis/measure';
import { useRois } from '../rois/roiStore';
import { showSlice, targetSlice } from '../stores/imageLoader';
import { useUi } from '../stores/uiStore';
import { useViewer } from '../stores/viewerStore';
import type { ViewerAction } from '../viewer/keyboard';

export function runAppAction(action: ViewerAction): void {
  const rois = useRois.getState();
  switch (action.kind) {
    case 'addRoi':
      rois.addActiveRoi();
      break;
    case 'measure':
      void measure(action.scope);
      break;
    case 'deleteSelection':
      rois.deleteRois(rois.selectedIds);
      break;
    case 'cancel':
      rois.setActiveShape(null);
      rois.select([]);
      useViewer.getState().setRuler(null);
      break;
    case 'assignClass': {
      const roiClass = action.index === null ? null : rois.classes[action.index];
      if (action.index === null) {
        rois.assignClass(rois.selectedIds, null);
      } else if (roiClass) {
        rois.assignClass(rois.selectedIds, roiClass.name);
      }
      break;
    }
    case 'slice': {
      const image = useViewer.getState().image;
      // From the slice on its way, so quick presses add up
      const target = targetSlice() + action.step;
      if (image && target >= 1 && target <= image.info.slices) {
        void showSlice(target);
      }
      break;
    }
    case 'removeLastVertex':
      // Handled by the canvas, which owns the polygon being drawn
      break;
    default:
      useViewer.getState().runAction(action);
  }
}

export function renameSelectedRoi(): void {
  const { selectedIds } = useRois.getState();
  if (selectedIds.length === 1) {
    useUi.getState().setRenamingRoiId(selectedIds[0]);
  }
}
