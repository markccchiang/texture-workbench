// User preferences, kept in localStorage (doc/ui-design-plan.md, section 5.1).

import type { PixelSpacing } from '@glcm/api';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_SECTIONS, type ReportSections } from '../report/reportHtml';
import type { ScrollBehaviour } from '../viewer/wheel';

/** A display window saved by the user; offered for images of the same bit depth */
export interface WindowPreset {
  name: string;
  bitDepth: number;
  min: number;
  max: number;
}

export interface PreferencesState {
  scrollBehaviour: ScrollBehaviour;
  /** Use the WebGL2 renderer when available (the lookup-table renderer otherwise) */
  useWebGl: boolean;
  windowPresets: WindowPreset[];
  /** Pixel spacing chosen for an image (by SHA-256): a spacing, or null to ignore the file's; the most recent ones */
  pixelSpacings: Record<string, PixelSpacing | null>;
  showScaleBar: boolean;
  /** Sections chosen in the Save Report dialog */
  reportSections: ReportSections;
  setScrollBehaviour(scrollBehaviour: ScrollBehaviour): void;
  setUseWebGl(useWebGl: boolean): void;
  /** Adds a preset, replacing one with the same name and bit depth */
  saveWindowPreset(preset: WindowPreset): void;
  removeWindowPreset(name: string, bitDepth: number): void;
  /** undefined forgets the choice, so the image uses the spacing of its file again */
  rememberPixelSpacing(sha256: string, spacing: PixelSpacing | null | undefined): void;
  setShowScaleBar(showScaleBar: boolean): void;
  setReportSections(reportSections: ReportSections): void;
}

const MAX_REMEMBERED_SPACINGS = 200;

const samePreset = (preset: WindowPreset, name: string, bitDepth: number) => preset.name === name && preset.bitDepth === bitDepth;

/** localStorage that silently does nothing when storage is blocked */
export const safeStorage = createJSONStorage(() => {
  try {
    const probe = '__glcm_probe__';
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  }
});

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      scrollBehaviour: 'auto',
      useWebGl: true,
      windowPresets: [],
      pixelSpacings: {},
      showScaleBar: true,
      reportSections: DEFAULT_SECTIONS,
      setScrollBehaviour: (scrollBehaviour) => set({ scrollBehaviour }),
      setUseWebGl: (useWebGl) => set({ useWebGl }),
      saveWindowPreset: (preset) =>
        set((state) => ({ windowPresets: [...state.windowPresets.filter((existing) => !samePreset(existing, preset.name, preset.bitDepth)), preset] })),
      removeWindowPreset: (name, bitDepth) =>
        set((state) => ({ windowPresets: state.windowPresets.filter((existing) => !samePreset(existing, name, bitDepth)) })),
      rememberPixelSpacing: (sha256, spacing) =>
        set((state) => {
          const entries = Object.entries(state.pixelSpacings).filter(([key]) => key !== sha256);
          if (spacing !== undefined) {
            entries.push([sha256, spacing]);
          }
          return { pixelSpacings: Object.fromEntries(entries.slice(-MAX_REMEMBERED_SPACINGS)) };
        }),
      setShowScaleBar: (showScaleBar) => set({ showScaleBar }),
      setReportSections: (reportSections) => set({ reportSections }),
    }),
    { name: 'glcm.preferences', version: 1, storage: safeStorage },
  ),
);
