import { create } from 'zustand';

export type ModalName = 'imageInfo' | 'preferences' | 'shortcuts' | 'about' | 'samples' | 'saveProject' | 'exportRoiImages' | 'equations' | 'batch' | 'featureMap' | 'thresholdRoi' | 'growRoi' | 'roiClasses' | 'report' | 'profile' | 'histogram' | 'colourConversion' | 'copyCommand';

/** What a file chosen in the file dialog is used for */
export type FileKind = 'image' | 'project' | 'roiSet' | 'projectImage' | 'dicomSeries';

export interface UiState {
  modal: ModalName | null;
  windowPanelOpen: boolean;
  /** Incremented by View ▸ Reset Layout to remount the panel groups */
  layoutVersion: number;
  /** Asks the app to show the file dialog; the counter makes repeated requests distinct */
  fileRequest: { kind: FileKind; counter: number } | null;
  /** View ▸ Show ROI Labels */
  showRoiLabels: boolean;
  /** ROI whose name the ROI Manager is editing */
  renamingRoiId: string | null;
  setModal(modal: ModalName | null): void;
  setWindowPanelOpen(open: boolean): void;
  resetLayout(): void;
  requestFile(kind: FileKind): void;
  requestOpenFile(): void;
  toggleRoiLabels(): void;
  setRenamingRoiId(id: string | null): void;
}

export const useUi = create<UiState>()((set, get) => ({
  modal: null,
  windowPanelOpen: false,
  layoutVersion: 0,
  fileRequest: null,
  showRoiLabels: false,
  renamingRoiId: null,
  setModal: (modal) => set({ modal }),
  setWindowPanelOpen: (windowPanelOpen) => set({ windowPanelOpen }),
  resetLayout: () => set({ layoutVersion: get().layoutVersion + 1 }),
  requestFile: (kind) => set({ fileRequest: { kind, counter: (get().fileRequest?.counter ?? 0) + 1 } }),
  requestOpenFile: () => get().requestFile('image'),
  toggleRoiLabels: () => set({ showRoiLabels: !get().showRoiLabels }),
  setRenamingRoiId: (renamingRoiId) => set({ renamingRoiId }),
}));

export const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
