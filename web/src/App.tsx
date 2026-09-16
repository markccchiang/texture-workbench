import { useHotkeys } from '@mantine/hooks';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Group as PanelGroup, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useAuth } from './api/auth';
import { getHealth } from './api/client';
import { SettingsPanel } from './analysis/SettingsPanel';
import { TokenPrompt } from './components/TokenPrompt';
import { MenuBar } from './components/MenuBar';
import { AppModals } from './components/Modals';
import { PanelSection } from './components/PanelSection';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { continueProjectWithImage, importRoiSetFile, openProjectFile } from './files/actions';
import { IMAGE_FILE_TYPES } from './files/fileTypes';
import { ROI_SET_FILE_TYPES } from './files/roiSet';
import { layoutStorage } from './layout/layoutStorage';
import { ResultsPanel } from './results/ResultsPanel';
import { RoiManager } from './rois/RoiManager';
import { useRois } from './rois/roiStore';
import { openImageFile } from './stores/imageLoader';
import { useUi, type FileKind } from './stores/uiStore';
import { useViewer } from './stores/viewerStore';
import { CanvasArea } from './viewer/CanvasArea';
import { VolumeImportDialog } from './volumes/VolumeImportDialog';

const ACCEPTED_TYPES: Record<FileKind, string> = {
  image: IMAGE_FILE_TYPES,
  projectImage: IMAGE_FILE_TYPES,
  project: '.glcmproj,.json,application/json',
  roiSet: ROI_SET_FILE_TYPES,
};

function openChosenFile(file: File, kind: FileKind): void {
  switch (kind) {
    case 'project':
      void openProjectFile(file);
      break;
    case 'roiSet':
      void importRoiSetFile(file);
      break;
    case 'projectImage':
      void continueProjectWithImage(file);
      break;
    default:
      void openImageFile(file);
  }
}

/** Dropped files: projects and ROI sets (also ImageJ's .roi and RoiSet.zip) by extension, anything else as an image */
function kindOfDroppedFile(file: File): FileKind {
  if (/\.glcmproj$/i.test(file.name)) {
    return 'project';
  }
  return /\.(json|roi|zip)$/i.test(file.name) ? 'roiSet' : 'image';
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function Workspace() {
  const vertical = useDefaultLayout({ id: 'workspace-vertical', storage: layoutStorage });
  const horizontal = useDefaultLayout({ id: 'workspace-horizontal', storage: layoutStorage });
  const sidebar = useDefaultLayout({ id: 'workspace-sidebar', storage: layoutStorage });

  return (
    <PanelGroup orientation="vertical" className="workspace" defaultLayout={vertical.defaultLayout} onLayoutChanged={vertical.onLayoutChanged}>
      <Panel id="main" minSize="30">
        <PanelGroup orientation="horizontal" defaultLayout={horizontal.defaultLayout} onLayoutChanged={horizontal.onLayoutChanged}>
          <Panel id="canvas" minSize="30">
            <CanvasArea />
          </Panel>
          <Separator className="separator separator-vertical" />
          <Panel id="sidebar" defaultSize={340} minSize={240} maxSize="50" collapsible>
            <PanelGroup orientation="vertical" defaultLayout={sidebar.defaultLayout} onLayoutChanged={sidebar.onLayoutChanged}>
              <Panel id="roi-manager" defaultSize="40" minSize={100}>
                <RoiManager />
              </Panel>
              <Separator className="separator separator-horizontal" />
              <Panel id="analysis-settings" minSize={100}>
                <PanelSection title="Analysis Settings">
                  <SettingsPanel />
                </PanelSection>
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </Panel>
      <Separator className="separator separator-horizontal" />
      <Panel id="results" defaultSize={200} minSize={60} collapsible>
        <ResultsPanel />
      </Panel>
    </PanelGroup>
  );
}

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileKindRef = useRef<FileKind>('image');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const layoutVersion = useUi((state) => state.layoutVersion);
  const fileRequest = useUi((state) => state.fileRequest);

  // Ask for the access token right away when the server requires one
  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal)
      .then((health) => {
        if (health.authentication === 'bearer' && !useAuth.getState().token) {
          useAuth.getState().requireToken();
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const input = fileInputRef.current;
    if (fileRequest && input) {
      fileKindRef.current = fileRequest.kind;
      input.accept = ACCEPTED_TYPES[fileRequest.kind];
      input.click();
    }
  }, [fileRequest]);

  const withImage = (action: () => void) => () => {
    if (useViewer.getState().image) {
      action();
    }
  };

  useHotkeys([
    ['mod+O', () => useUi.getState().requestFile('image')],
    ['mod+S', withImage(() => useUi.getState().setModal('saveProject'))],
    ['mod+comma', () => useUi.getState().setModal('preferences')],
    ['mod+Z', withImage(() => useRois.getState().undo())],
    ['mod+shift+Z', withImage(() => useRois.getState().redo())],
    ['mod+A', withImage(() => useRois.getState().selectAll())],
  ]);

  const onDragEnter = (event: DragEvent) => {
    if (hasFiles(event)) {
      dragDepth.current += 1;
      setDragging(true);
    }
  };
  const onDragLeave = (event: DragEvent) => {
    if (hasFiles(event)) {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      setDragging(dragDepth.current > 0);
    }
  };
  const onDragOver = (event: DragEvent) => {
    if (hasFiles(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      openChosenFile(file, kindOfDroppedFile(file));
    }
  };

  return (
    <div className="app" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
      <MenuBar />
      <Toolbar />
      <main className="app-main">
        <Workspace key={layoutVersion} />
      </main>
      <StatusBar />
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_FILE_TYPES}
        hidden
        data-testid="file-input"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) {
            openChosenFile(file, fileKindRef.current);
          }
        }}
      />
      <AppModals />
      <VolumeImportDialog />
      <TokenPrompt />
      {dragging && (
        <div className="drop-overlay">
          <div>Drop an image (also DICOM or NIfTI), a project (.glcmproj) or ROIs (.roi.json, or ImageJ .roi and RoiSet.zip)</div>
        </div>
      )}
    </div>
  );
}
