// `glcm mcp`: the same operations over MCP, so an agent can open an image, look at it, pick regions and measure them.
// An agent cannot draw an ROI, so regions come from numbers (rectangles), from the intensity tools, or from a file.

import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { ImageInfo, Roi } from '@glcm/api';
import { ApiError, createClient, requireOk, type ApiClient, type ConnectionOptions } from './client.js';
import * as operations from '@glcm/client';
import { openImageTarget, readRois, writeRoiSet } from './files.js';
import { number, table } from './output.js';
import { VERSION } from './version.js';

/** Rows of a results table sent back by default; a whole table is far more than an agent should read */
const DEFAULT_MAX_ROWS = 20;
/** Largest picture sent back, in pixels along the longer side */
const VIEW_MAX_SIZE = 768;

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean };

const asText = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

function failure(error: unknown): ToolResult {
  const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `Failed: ${message}` }], isError: true };
}

const RECTANGLE = z.object({
  name: z.string().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

function describe(image: ImageInfo, reused: boolean): string {
  const lines = [
    `${image.name} — ${image.width} × ${image.height} px, ${image.bitDepth}-bit`,
    `image id: ${image.imageId}`,
    `display window: ${image.windowMin} – ${image.windowMax}`,
    image.pixelSpacing ? `pixel spacing: ${number(image.pixelSpacing.x)} × ${number(image.pixelSpacing.y)} mm` : 'pixel spacing: not set',
  ];
  if (image.valueConversion) {
    lines.push(`values: ${image.valueConversion.description}`);
  }
  if (image.warnings.length > 0) {
    lines.push(`warnings: ${image.warnings.join('; ')}`);
  }
  lines.push(reused ? '(the server already had this image)' : '(uploaded now)');
  return lines.join('\n');
}

export interface McpDependencies {
  client(): Promise<ApiClient>;
}

/** The MCP server, with the API client injected so tests can drive it in memory */
export function createMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer({ name: 'texture-workbench', version: VERSION });
  // Regions found by select_regions, so that measure can use them without the polygons travelling through the model
  const regionSets = new Map<string, { rois: Roi[]; imageId: string }>();
  let nextRegionSet = 1;

  const resolveRois = async (
    image: ImageInfo,
    rois: string | undefined,
    rectangles: z.infer<typeof RECTANGLE>[] | undefined,
    warn: (message: string) => void,
  ): Promise<Roi[]> => {
    if (rectangles && rectangles.length > 0) {
      return rectangles.map((rectangle, index) => ({
        id: `rect${index + 1}`,
        name: rectangle.name ?? `ROI ${index + 1}`,
        shape: { type: 'rectangle' as const, x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
      }));
    }
    if (rois) {
      const stored = regionSets.get(rois);
      if (stored) {
        return stored.rois;
      }
      return readRois(rois, warn);
    }
    return [operations.wholeImageRoi(image)];
  };

  server.registerTool(
    'list_features',
    {
      title: 'List texture features',
      description: 'The texture features this server can compute, or the presets that group them. Use the ids with measure.',
      inputSchema: { presets: z.boolean().optional().describe('List the presets instead of the features') },
    },
    async ({ presets }) => {
      try {
        const catalog = await operations.getCatalog(await dependencies.client());
        if (presets) {
          return asText(table(['Preset', 'Name', 'Features'], catalog.presets.map((preset) => [preset.id, preset.name, String(preset.features.length)])));
        }
        return asText(
          table(
            ['Feature', 'Name', 'Group'],
            catalog.features.map((feature) => [feature.id, feature.name, feature.group]),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'list_samples',
    { title: 'List sample images', description: 'Sample images the server ships, including medical ones. Open them as sample:<path>.', inputSchema: {} },
    async () => {
      try {
        const samples = await operations.listSamples(await dependencies.client());
        return asText(table(['Image', 'Bytes'], samples.map((sample) => [`sample:${sample.path}`, String(sample.sizeBytes)])));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'open_image',
    {
      title: 'Open an image',
      description:
        'Opens an image file, a sample (sample:<path>) or an image the server already has, and reports its size, bit depth, display window, pixel spacing and value conversion. PNG, JPEG, BMP, TIFF, uncompressed DICOM and 2D NIfTI are read.',
      inputSchema: { image: z.string().describe('A file path, sample:<path>, or an image id') },
    },
    async ({ image }) => {
      try {
        const opened = await openImageTarget(await dependencies.client(), image);
        return asText(describe(opened.info, opened.reused));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'view_image',
    {
      title: 'Look at an image',
      description: 'Returns the image as a picture, so it can be looked at before regions are chosen: the rendering with its display window, or its edge map.',
      inputSchema: {
        image: z.string(),
        kind: z.enum(['display', 'edges']).optional().describe('display (default) or edges'),
        min: z.number().optional().describe('Display window minimum; the image default is used otherwise'),
        max: z.number().optional(),
      },
    },
    async ({ image, kind, min, max }) => {
      try {
        const client = await dependencies.client();
        const { info } = await openImageTarget(client, image);
        const query =
          kind === 'edges'
            ? { method: 'canny', sigma: 1.4, low: 0, high: 0, maxSize: VIEW_MAX_SIZE }
            : { min: min ?? info.windowMin, max: max ?? info.windowMax, maxSize: VIEW_MAX_SIZE };
        if (kind === 'edges') {
          const stats = requireOk(
            await client.request('GET', `/images/${info.imageId}/gradient-stats`, { query: { sigma: 1.4 } }),
            'The gradient statistics could not be read',
          ).json<{ percentiles: Record<string, number> }>();
          query.high = stats.percentiles['95'];
          query.low = stats.percentiles['95'] * 0.4;
        }
        const picture = requireOk(
          await client.request('GET', `/images/${info.imageId}/${kind === 'edges' ? 'edges.png' : 'display.png'}`, { query, accept: 'image/png' }),
          'The picture could not be rendered',
        );
        return {
          content: [
            { type: 'text', text: `${info.name}, ${kind === 'edges' ? 'edge map' : `window ${query.min ?? info.windowMin} – ${query.max ?? info.windowMax}`}` },
            { type: 'image', data: Buffer.from(picture.body).toString('base64'), mimeType: 'image/png' },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'select_regions',
    {
      title: 'Select regions by intensity',
      description:
        'Finds regions to measure without drawing them: the areas whose intensities lie between min and max, or the one region around a pixel. The regions are kept under an id that measure accepts.',
      inputSchema: {
        image: z.string(),
        min: z.number().optional().describe('Lowest intensity of the regions; the image window minimum by default'),
        max: z.number().optional(),
        minPixels: z.number().optional().describe('Regions smaller than this are ignored (default 50)'),
        maxPixels: z.number().optional().describe('Regions larger than this are ignored'),
        minSphericity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Regions less round than this are ignored: 1 is a circle, long or ragged outlines are lower'),
        maxRegions: z.number().optional().describe('Largest regions to keep (default 10)'),
        at: z.object({ x: z.number(), y: z.number() }).optional().describe('Select the one region around this pixel instead'),
        tolerance: z.number().optional().describe('How far a value may differ from the pixel at "at" (default 5 % of the window)'),
        saveTo: z.string().optional().describe('Write the regions as an ROI set file as well; a name ending in .zip writes a RoiSet.zip for ImageJ'),
      },
    },
    async ({ image, min, max, minPixels, maxPixels, minSphericity, maxRegions, at, tolerance, saveTo }) => {
      try {
        const client = await dependencies.client();
        const { info } = await openImageTarget(client, image);
        const regions = at
          ? [await operations.selectRegionAt(client, info.imageId, { x: at.x, y: at.y, tolerance: tolerance ?? Math.round((info.windowMax - info.windowMin) * 0.05) })]
              .filter((region) => region !== null)
              .map((region) => region!)
          : (
              await operations.selectThresholdRegions(client, info.imageId, {
                min: min ?? info.windowMin,
                max: max ?? info.windowMax,
                minPixels: minPixels ?? 50,
                maxRegions: maxRegions ?? 10,
                ...(maxPixels !== undefined ? { maxPixels } : {}),
                ...(minSphericity !== undefined ? { minSphericity } : {}),
              })
            ).regions;
        if (regions.length === 0) {
          return asText('No region matched. Widen the intensity range or lower minPixels.');
        }
        const document = operations.roiSetOf(info, regions);
        const id = `regions_${nextRegionSet++}`;
        regionSets.set(id, { rois: document.rois as Roi[], imageId: info.imageId });
        if (saveTo) {
          await writeRoiSet(saveTo, document, info);
        }
        const rows = regions.map((region, index) => [
          document.rois[index].name,
          region.pixelCount.toLocaleString(),
          region.boundingBox ? `${region.boundingBox.x},${region.boundingBox.y} ${region.boundingBox.width}×${region.boundingBox.height}` : '',
        ]);
        return asText(
          [`${regions.length} ${regions.length === 1 ? 'region' : 'regions'} in ${info.name}, kept as "${id}" for measure.`, '', table(['ROI', 'Pixels', 'Box'], rows), ...(saveTo ? ['', `Written to ${saveTo}`] : [])].join('\n'),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'measure',
    {
      title: 'Measure texture features',
      description:
        'Measures the texture of regions in an image. Without regions the whole image is measured. The table is shortened for reading; saveTo writes all of it as CSV.',
      inputSchema: {
        image: z.string(),
        rois: z.string().optional().describe('A region set id from select_regions, or the path of an ROI set file (also ImageJ .roi or RoiSet.zip)'),
        rectangles: z.array(RECTANGLE).optional().describe('Regions given as rectangles in pixels'),
        preset: z.string().optional().describe('A preset id from list_features({presets: true})'),
        features: z.array(z.string()).optional().describe('Feature ids; overrides the preset'),
        grayLevels: z.number().optional(),
        distances: z.array(z.number()).optional(),
        maxRows: z.number().optional().describe(`Rows of the table to return (default ${DEFAULT_MAX_ROWS})`),
        saveTo: z.string().optional().describe('Write the full results as a CSV file'),
      },
    },
    async ({ image, rois, rectangles, preset, features, grayLevels, distances, maxRows, saveTo }) => {
      try {
        const client = await dependencies.client();
        const catalog = await operations.getCatalog(client);
        const { info } = await openImageTarget(client, image);
        const settings = operations.buildSettings(catalog, info.bitDepth, {
          preset,
          features,
          grayLevels,
          distances,
          // One row per ROI and distance reads far better than one per direction
          aggregation: 'meanOnly',
        });
        const issues = operations.validateSettings(settings, info.bitDepth, catalog);
        if (issues.errors.length > 0) {
          return asText(`These settings cannot be used: ${issues.errors.join(' ')}`);
        }
        const fileWarnings: string[] = [];
        const roiList = await resolveRois(info, rois, rectangles, (message) => fileWarnings.push(message));
        const measurement = await operations.measure(client, { imageId: info.imageId, rois: roiList, settings });
        if (saveTo) {
          await fs.writeFile(saveTo, measurement.csv);
        }

        const results = measurement.document.results;
        const limit = maxRows ?? DEFAULT_MAX_ROWS;
        const shown = results.slice(0, limit);
        const featureIds = settings.features.filter((id) => shown.some((result) => result.values[id] !== undefined));
        const rows = shown.map((result) => [
          result.roiName,
          String(result.distance),
          result.pixelCount.toLocaleString(),
          ...featureIds.map((id) => (result.values[id]?.mean === undefined ? '' : number(result.values[id].mean!, 4))),
        ]);
        return asText(
          [
            `${info.name}: ${results.length} ${results.length === 1 ? 'measurement' : 'measurements'}, Ng ${settings.grayLevels}, distances ${settings.distances.join(', ')}, mean over ${settings.directions.length} directions.`,
            '',
            table(['ROI', 'd', 'Pixels', ...featureIds], rows, [false, true, true, ...featureIds.map(() => true)]),
            ...(results.length > shown.length ? ['', `${results.length - shown.length} more rows are not shown; pass saveTo to write them all.`] : []),
            ...(saveTo ? ['', `Written to ${saveTo}`] : []),
            ...(issues.warnings.length > 0 || fileWarnings.length > 0 ? ['', `Note: ${[...fileWarnings, ...issues.warnings].join(' ')}`] : []),
          ].join('\n'),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'feature_map',
    {
      title: 'Compute a feature map',
      description: 'Computes one co-occurrence feature in a sliding window over the whole image and reports its range; saveTo writes a 32-bit TIFF.',
      inputSchema: {
        image: z.string(),
        feature: z.string().describe('A co-occurrence feature id, e.g. Contrast'),
        window: z.number().optional().describe('Odd window side in pixels (default 31)'),
        saveTo: z.string().optional().describe('Write the values as a 32-bit floating point TIFF'),
      },
    },
    async ({ image, feature, window, saveTo }) => {
      try {
        const client = await dependencies.client();
        const catalog = await operations.getCatalog(client);
        const { info } = await openImageTarget(client, image);
        const settings = operations.buildSettings(catalog, info.bitDepth, {});
        const map = await operations.computeFeatureMap(client, info.imageId, {
          feature,
          window: window ?? 31,
          step: null,
          grayLevels: settings.grayLevels,
          quantization: settings.quantization,
          distance: settings.distances[0],
          directions: settings.directions,
          logBase: settings.logBase,
        });
        const range = operations.valueRange(map.values);
        if (saveTo) {
          const { encodeFloat32Tiff } = await import('@glcm/api');
          await fs.writeFile(saveTo, encodeFloat32Tiff(map.values, map.info.columns, map.info.rows, JSON.stringify({ feature, image: info.name })));
        }
        return asText(
          [
            `${feature} over ${info.name}: ${map.info.columns} × ${map.info.rows} points, step ${map.info.step} px, window ${window ?? 31} px.`,
            range.minimum === null ? 'no window had pixel pairs' : `values ${number(range.minimum, 4)} – ${number(range.maximum!, 4)}`,
            ...(saveTo ? [`Written to ${saveTo}`] : []),
          ].join('\n'),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

/** Serves the tools over standard input and output, the transport MCP clients start */
export async function serveMcp(args: readonly string[], transport?: Transport): Promise<void> {
  const option = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const connection: ConnectionOptions = {
    server: option('server') ?? process.env.GLCM_SERVER,
    token: option('token'),
    dataDir: option('data-dir'),
  };
  let client: ApiClient | null = null;
  const server = createMcpServer({
    async client() {
      client ??= await createClient(connection);
      return client;
    },
  });
  await server.connect(transport ?? new StdioServerTransport());
}
