import { Badge, Button, Group, Menu, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { LogoMark } from './Logo';
import { useAuth } from '../api/auth';
import { CATALOG_QUERY } from '../api/queryClient';
import { measure } from '../analysis/measure';
import { applyPreset, matchingPreset } from '@glcm/api';
import { useAnalysisSettings } from '../analysis/settingsStore';
import { renameSelectedRoi } from '../app/actions';
import { combineSelectedRois } from '../rois/editActions';
import { exportImageJRoisFile, exportResultsFile, exportRoiSetFile } from '../files/actions';
import { clearStoredLayouts } from '../layout/layoutStorage';
import { useResults } from '../results/resultsStore';
import { useRois } from '../rois/roiStore';
import { cancelImageLoad } from '../stores/imageLoader';
import { MOD_KEY, useUi } from '../stores/uiStore';
import { isNavigatorVisible, useViewer, type Tool } from '../stores/viewerStore';
import { usePreferences } from '../stores/preferences';
import { COLOR_TABLES } from '../image/colorTables';
import { useEdgeMap } from '../viewer/edgeMap';

function Shortcut({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" c="dimmed">
      {children}
    </Text>
  );
}

function TopMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menu position="bottom-start" offset={2} shadow="md" width={260} trigger="click-hover" openDelay={0} closeDelay={150}>
      <Menu.Target>
        <Button variant="subtle" color="gray" size="compact-sm">
          {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>{children}</Menu.Dropdown>
    </Menu>
  );
}

const TOOL_ITEMS: Array<{ tool: Tool; label: string; key: string }> = [
  { tool: 'rectangle', label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', label: 'Ellipse', key: 'E' },
  { tool: 'polygon', label: 'Polygon', key: 'P' },
  { tool: 'freehand', label: 'Freehand', key: 'F' },
  { tool: 'livewire', label: 'Livewire', key: 'I' },
  { tool: 'wand', label: 'Magic Wand', key: 'W' },
  { tool: 'brush', label: 'Brush', key: 'B' },
  { tool: 'eraser', label: 'Eraser', key: 'X' },
];

export function MenuBar() {
  const hasImage = useViewer((state) => state.image !== null);
  const tool = useViewer((state) => state.tool);
  const navigatorVisible = useViewer(isNavigatorVisible);
  const canUndo = useRois((state) => state.past.length > 0);
  const canRedo = useRois((state) => state.future.length > 0);
  const hasRois = useRois((state) => state.rois.length > 0);
  const selectedCount = useRois((state) => state.selectedIds.length);
  const hasActive = useRois((state) => state.activeShape !== null);
  const hasResults = useResults((state) => state.rows.length > 0);
  const showLabels = useUi((state) => state.showRoiLabels);
  const showScaleBar = usePreferences((state) => state.showScaleBar);
  const showEdgeMap = useEdgeMap((state) => state.shown);
  const colorTable = useViewer((state) => state.colorTable);
  const hasToken = useAuth((state) => state.token !== null);
  const catalog = useQuery(CATALOG_QUERY);
  const settings = useAnalysisSettings((state) => state.settings);
  const presetId = settings && catalog.data ? matchingPreset(settings.features, catalog.data.presets) : null;
  const viewer = useViewer.getState;
  const rois = useRois.getState;
  const ui = useUi.getState;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

  return (
    <nav className="menu-bar" aria-label="Main menu">
      <Group gap={7} wrap="nowrap" mr="sm">
        <LogoMark size={18} />
        <Text fw={700} size="sm">
          Texture Workbench
        </Text>
      </Group>

      <TopMenu label="File">
        <Menu.Item rightSection={<Shortcut>{MOD_KEY}O</Shortcut>} onClick={() => ui().requestFile('image')}>
          Open Image…
        </Menu.Item>
        <Menu.Item onClick={() => ui().setModal('samples')}>Open Sample Image…</Menu.Item>
        <Menu.Divider />
        <Menu.Item onClick={() => ui().requestFile('project')}>Open Project…</Menu.Item>
        <Menu.Item disabled={!hasImage} rightSection={<Shortcut>{MOD_KEY}S</Shortcut>} onClick={() => ui().setModal('saveProject')}>
          Save Project…
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item disabled={!hasResults} onClick={() => void exportResultsFile('csv')}>
          Export Results as CSV
        </Menu.Item>
        <Menu.Item disabled={!hasResults} onClick={() => void exportResultsFile('json')}>
          Export Results as JSON
        </Menu.Item>
        <Menu.Item disabled={!hasResults} onClick={() => ui().setModal('report')}>
          Save Report…
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          disabled={!hasImage}
          onClick={() => {
            cancelImageLoad();
            viewer().closeImage();
          }}
        >
          Close Image
        </Menu.Item>
        {hasToken && (
          <>
            <Menu.Divider />
            <Menu.Item onClick={() => useAuth.getState().requireToken()}>Change Access Token…</Menu.Item>
          </>
        )}
      </TopMenu>

      <TopMenu label="Edit">
        <Menu.Item disabled={!canUndo} rightSection={<Shortcut>{MOD_KEY}Z</Shortcut>} onClick={() => rois().undo()}>
          Undo
        </Menu.Item>
        <Menu.Item disabled={!canRedo} rightSection={<Shortcut>{MOD_KEY}⇧Z</Shortcut>} onClick={() => rois().redo()}>
          Redo
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item disabled={!hasRois} rightSection={<Shortcut>{MOD_KEY}A</Shortcut>} onClick={() => rois().selectAll()}>
          Select All ROIs
        </Menu.Item>
        <Menu.Item disabled={selectedCount === 0} rightSection={<Shortcut>⌫</Shortcut>} onClick={() => rois().deleteRois(rois().selectedIds)}>
          Delete ROI
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item rightSection={<Shortcut>{MOD_KEY},</Shortcut>} onClick={() => ui().setModal('preferences')}>
          Preferences…
        </Menu.Item>
      </TopMenu>

      <TopMenu label="Image">
        <Menu.Item disabled={!hasImage} rightSection={<Shortcut>+</Shortcut>} onClick={() => viewer().zoomStep(1)}>
          Zoom In
        </Menu.Item>
        <Menu.Item disabled={!hasImage} rightSection={<Shortcut>−</Shortcut>} onClick={() => viewer().zoomStep(-1)}>
          Zoom Out
        </Menu.Item>
        <Menu.Item disabled={!hasImage} rightSection={<Shortcut>1</Shortcut>} onClick={() => viewer().zoomToScale(1)}>
          Zoom 100 %
        </Menu.Item>
        <Menu.Item disabled={!hasImage} rightSection={<Shortcut>0</Shortcut>} onClick={() => viewer().fit()}>
          Fit to Window
        </Menu.Item>
        <Menu.Item disabled={selectedCount === 0} rightSection={<Shortcut>Z</Shortcut>} onClick={() => viewer().zoomToSelection()}>
          Zoom to Selection
        </Menu.Item>
        <Menu.Divider />
        <Menu.Label>Window/Level</Menu.Label>
        <Menu.Item disabled={!hasImage} onClick={() => viewer().resetWindow('auto')}>
          Auto (0.5–99.5 %)
        </Menu.Item>
        <Menu.Item disabled={!hasImage} onClick={() => viewer().resetWindow('full')}>
          Full Range
        </Menu.Item>
        <Menu.Item disabled={!hasImage} onClick={() => ui().setWindowPanelOpen(true)}>
          Custom…
        </Menu.Item>
        <Menu.Sub>
          <Menu.Sub.Target>
            <Menu.Sub.Item disabled={!hasImage}>Colour Table</Menu.Sub.Item>
          </Menu.Sub.Target>
          <Menu.Sub.Dropdown>
            {COLOR_TABLES.map((table) => (
              <Menu.Item
                key={table.id}
                leftSection={colorTable === table.id ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
                onClick={() => viewer().setColorTable(table.id)}
              >
                {table.name}
              </Menu.Item>
            ))}
          </Menu.Sub.Dropdown>
        </Menu.Sub>
        <Menu.Divider />
        <Menu.Item
          disabled={!hasImage}
          leftSection={tool === 'ruler' ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
          rightSection={<Shortcut>L</Shortcut>}
          onClick={() => viewer().setTool('ruler')}
        >
          Ruler
        </Menu.Item>
        <Menu.Item disabled={!hasImage} onClick={() => ui().setModal('imageInfo')}>
          Image Info
        </Menu.Item>
      </TopMenu>

      <TopMenu label="ROI">
        {TOOL_ITEMS.map((item) => (
          <Menu.Item
            key={item.tool}
            disabled={!hasImage}
            leftSection={tool === item.tool ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
            rightSection={<Shortcut>{item.key}</Shortcut>}
            onClick={() => viewer().setTool(item.tool)}
          >
            {item.label}
          </Menu.Item>
        ))}
        <Menu.Item disabled={!hasImage} onClick={() => ui().setModal('thresholdRoi')}>
          Threshold ROI…
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item disabled={selectedCount < 2} onClick={() => void combineSelectedRois('union')}>
          Union
        </Menu.Item>
        <Menu.Item disabled={selectedCount < 2} onClick={() => void combineSelectedRois('subtract')}>
          Subtract
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item disabled={!hasActive} rightSection={<Shortcut>T</Shortcut>} onClick={() => rois().addActiveRoi()}>
          Add to Manager
        </Menu.Item>
        <Menu.Item disabled={selectedCount === 0} onClick={() => rois().duplicateRois(rois().selectedIds)}>
          Duplicate
        </Menu.Item>
        <Menu.Item disabled={selectedCount !== 1} onClick={renameSelectedRoi}>
          Rename
        </Menu.Item>
        <Menu.Item onClick={() => ui().setModal('roiClasses')}>ROI Classes…</Menu.Item>
        <Menu.Divider />
        <Menu.Item disabled={!hasImage} onClick={() => ui().requestFile('roiSet')}>
          Import ROI Set…
        </Menu.Item>
        <Menu.Item disabled={!hasRois} onClick={exportRoiSetFile}>
          Export ROI Set…
        </Menu.Item>
        <Menu.Item disabled={!hasRois} onClick={exportImageJRoisFile}>
          Export ROIs for ImageJ…
        </Menu.Item>
        <Menu.Item disabled={!hasRois} onClick={() => ui().setModal('exportRoiImages')}>
          Export ROI Images…
        </Menu.Item>
      </TopMenu>

      <TopMenu label="Analyze">
        <Menu.Item disabled={!hasImage} rightSection={<Shortcut>M</Shortcut>} onClick={() => void measure('selected')}>
          Measure Selected
        </Menu.Item>
        <Menu.Item disabled={!hasImage} rightSection={<Shortcut>⇧M</Shortcut>} onClick={() => void measure('all')}>
          Measure All
        </Menu.Item>
        <Menu.Item disabled={!settings || !catalog.data} onClick={() => ui().setModal('batch')}>
          Batch Measure…
        </Menu.Item>
        <Menu.Item disabled={!hasImage} onClick={() => ui().setModal('featureMap')}>
          Feature Map…
        </Menu.Item>
        <Menu.Divider />
        <Menu.Sub>
          <Menu.Sub.Target>
            <Menu.Sub.Item disabled={!settings || !catalog.data}>Presets</Menu.Sub.Item>
          </Menu.Sub.Target>
          <Menu.Sub.Dropdown>
            {catalog.data?.presets.map((preset) => (
              <Menu.Item
                key={preset.id}
                leftSection={preset.id === presetId ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
                onClick={() => useAnalysisSettings.getState().update((current) => applyPreset(current, preset))}
              >
                {preset.name}
              </Menu.Item>
            ))}
          </Menu.Sub.Dropdown>
        </Menu.Sub>
        <Menu.Divider />
        <Menu.Item disabled={!hasResults} onClick={() => useResults.getState().clear()}>
          Clear Results
        </Menu.Item>
      </TopMenu>

      <TopMenu label="View">
        <Menu.Item disabled={!hasImage} rightSection={<Shortcut>N</Shortcut>} onClick={() => viewer().toggleNavigator()}>
          {navigatorVisible ? 'Hide Navigator' : 'Show Navigator'}
        </Menu.Item>
        <Menu.Item leftSection={showLabels ? <IconCheck size={14} /> : <span style={{ width: 14 }} />} onClick={() => ui().toggleRoiLabels()}>
          Show ROI Labels
        </Menu.Item>
        <Menu.Item
          leftSection={showScaleBar ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
          onClick={() => usePreferences.getState().setShowScaleBar(!showScaleBar)}
        >
          Show Scale Bar
        </Menu.Item>
        <Menu.Item
          disabled={!hasImage}
          leftSection={showEdgeMap ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
          onClick={() => useEdgeMap.getState().setShown(!showEdgeMap)}
        >
          Show Edge Map
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          onClick={() => {
            clearStoredLayouts();
            ui().resetLayout();
          }}
        >
          Reset Layout
        </Menu.Item>
      </TopMenu>

      <TopMenu label="Help">
        <Menu.Item onClick={() => ui().setModal('equations')}>Feature Equations</Menu.Item>
        <Menu.Item onClick={() => ui().setModal('shortcuts')}>Keyboard Shortcuts</Menu.Item>
        <Menu.Item onClick={() => ui().setModal('about')}>About</Menu.Item>
      </TopMenu>

      <Badge ml="auto" variant="dot" color={local ? 'green' : 'blue'} size="sm">
        {local ? 'Local' : window.location.hostname}
      </Badge>
    </nav>
  );
}
