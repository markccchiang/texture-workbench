// The `glcm` command: open images, measure ROIs, select regions and compute feature maps without a browser.
// Every command works either in this process or against a running server (--server), and has a --json form for scripts.

import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { combineResultsCsv, encodeFloat32Tiff, type AnalysisSettings, type Direction, type ImageInfo, type Roi } from '@glcm/api';
import { ApiError, createClient, type ApiClient } from './client.js';
import * as operations from '@glcm/client';
import { openImageTarget, readRois, readSettings, writeRoiSet } from './files.js';
import { bytes, number, pairs, table } from './output.js';
import { VERSION } from './version.js';

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

type OptionConfig = Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }>;

const GLOBAL_OPTIONS: OptionConfig = {
  server: { type: 'string' },
  token: { type: 'string' },
  'data-dir': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

interface Context {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  io: Io;
  json: boolean;
  client(): Promise<ApiClient>;
}

interface Command {
  summary: string;
  usage: string;
  details?: string[];
  options?: OptionConfig;
  run(context: Context): Promise<number>;
}

const text = (context: Context, name: string): string | undefined => {
  const value = context.values[name];
  return typeof value === 'string' ? value : undefined;
};

const flag = (context: Context, name: string): boolean => context.values[name] === true;

function integer(context: Context, name: string, fallback?: number): number | undefined {
  const value = text(context, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ApiError(0, 'BadOption', `--${name} must be a whole number, not "${value}"`);
  }
  return parsed;
}

/** A number from 0 to 1 */
function fraction(context: Context, name: string): number {
  const value = Number(text(context, name));
  if (!(value >= 0 && value <= 1)) {
    throw new ApiError(0, 'BadOption', `--${name} must be a number from 0 to 1`);
  }
  return value;
}

function numbers(value: string | undefined): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parts = value
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    throw new ApiError(0, 'BadOption', `"${value}" is not a list of numbers`);
  }
  return parts;
}

async function settingsOverrides(context: Context): Promise<operations.SettingsOverrides> {
  const resample = numbers(text(context, 'resample'));
  if (resample && (resample.length !== 2 || !resample.every((value) => value > 0))) {
    throw new ApiError(0, 'BadOption', '--resample takes the new pixel width and height in millimetres, e.g. --resample 0.5,0.5');
  }
  const resampling = resample ? { x: resample[0], y: resample[1] } : undefined;
  const logSigmaText = text(context, 'log-sigma');
  const logSigma = logSigmaText === undefined ? undefined : Number(logSigmaText);
  if (logSigma !== undefined && !(logSigma > 0)) {
    throw new ApiError(0, 'BadOption', '--log-sigma takes the sigma of the Laplacian of Gaussian, e.g. --log-sigma 2');
  }
  const waveletBand = text(context, 'wavelet')?.toUpperCase();
  if (waveletBand !== undefined && !isWaveletBand(waveletBand)) {
    throw new ApiError(0, 'BadOption', '--wavelet takes the sub-band LL, LH, HL or HH');
  }
  if (waveletBand !== undefined && logSigma !== undefined) {
    throw new ApiError(0, 'BadOption', 'Choose one filter: --log-sigma or --wavelet');
  }
  const quantization = text(context, 'quantization');
  const parsedQuantization = quantization
    ? (() => {
        const [method, ...rest] = quantization.split(',');
        const values = rest.map(Number);
        if (!['fixedRange', 'roiMinMax', 'fixedBinWidth', 'none'].includes(method)) {
          throw new ApiError(0, 'BadOption', `--quantization must start with fixedRange, roiMinMax, fixedBinWidth or none`);
        }
        return {
          method: method as AnalysisSettings['quantization']['method'],
          ...(method === 'fixedRange' && values.length === 2 ? { min: values[0], max: values[1] } : {}),
          ...(method === 'fixedBinWidth' && values.length === 1 ? { binWidth: values[0] } : {}),
        };
      })()
    : undefined;
  const file = text(context, 'settings');
  return {
    ...(file ? { settings: (await readSettings(file)) as operations.SettingsOverrides['settings'] } : {}),
    preset: text(context, 'preset'),
    features: text(context, 'features')
      ?.split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
    grayLevels: integer(context, 'gray-levels'),
    distances: numbers(text(context, 'distances')),
    directions: numbers(text(context, 'directions')) as Direction[] | undefined,
    aggregation: text(context, 'aggregation') as AnalysisSettings['aggregation'] | undefined,
    logBase: text(context, 'log-base') as AnalysisSettings['logBase'] | undefined,
    quantization: parsedQuantization,
    ...(flag(context, 'score') ? { score: true } : {}),
    ...(resampling ? { resampling } : {}),
    ...(logSigma !== undefined ? { logSigma } : {}),
    ...(waveletBand !== undefined ? { waveletBand } : {}),
  };
}

function isWaveletBand(band: string): band is 'LL' | 'LH' | 'HL' | 'HH' {
  return band === 'LL' || band === 'LH' || band === 'HL' || band === 'HH';
}

const SETTINGS_OPTIONS: OptionConfig = {
  settings: { type: 'string' },
  resample: { type: 'string' },
  'log-sigma': { type: 'string' },
  wavelet: { type: 'string' },
  preset: { type: 'string' },
  features: { type: 'string' },
  'gray-levels': { type: 'string' },
  distances: { type: 'string' },
  directions: { type: 'string' },
  aggregation: { type: 'string' },
  'log-base': { type: 'string' },
  quantization: { type: 'string' },
  score: { type: 'boolean' },
};

function describeImage(image: ImageInfo): Array<[string, string]> {
  return [
    ['Name', image.name],
    ['Image id', image.imageId],
    ['Size', `${image.width} × ${image.height} px${image.slices > 1 ? ` × ${image.slices} slices` : ''}, ${image.bitDepth}-bit`],
    ['File size', bytes(image.sizeBytes)],
    ['Pixel spacing', image.pixelSpacing ? `${number(image.pixelSpacing.x)} × ${number(image.pixelSpacing.y)} mm` : 'not set'],
    ['Default window', `${image.windowMin} – ${image.windowMax}`],
    ...(image.valueConversion ? ([['Values', image.valueConversion.description]] as Array<[string, string]>) : []),
    ['SHA-256', image.sha256],
  ];
}

const COMMANDS: Record<string, Command> = {
  features: {
    summary: 'List the texture features and the presets',
    usage: 'glcm features [--presets] [--json]',
    options: { presets: { type: 'boolean' } },
    async run(context) {
      const catalog = await operations.getCatalog(await context.client());
      if (context.json) {
        context.io.out(JSON.stringify(flag(context, 'presets') ? catalog.presets : catalog.features, null, 2));
        return EXIT_OK;
      }
      if (flag(context, 'presets')) {
        context.io.out(
          table(
            ['Preset', 'Name', 'Features'],
            catalog.presets.map((preset) => [preset.id, preset.name, String(preset.features.length)]),
            [false, false, true],
          ),
        );
        return EXIT_OK;
      }
      const nonStandard = catalog.features.some((feature) => feature.nonStandard);
      context.io.out(
        table(
          ['Feature', 'Name', 'Group', ...(nonStandard ? ['Note'] : [])],
          catalog.features.map((feature) => [feature.id, feature.name, feature.group, ...(nonStandard ? [feature.nonStandard ? 'non-standard' : ''] : [])]),
        ),
      );
      return EXIT_OK;
    },
  },

  samples: {
    summary: 'List the sample images the server offers',
    usage: 'glcm samples [--json]',
    async run(context) {
      const samples = await operations.listSamples(await context.client());
      if (context.json) {
        context.io.out(JSON.stringify(samples, null, 2));
        return EXIT_OK;
      }
      context.io.out(
        table(
          ['Sample', 'Size'],
          samples.map((sample) => [`sample:${sample.path}`, bytes(sample.sizeBytes)]),
          [false, true],
        ),
      );
      return EXIT_OK;
    },
  },

  info: {
    summary: 'Show what the server knows about an image',
    usage: 'glcm info <image> [--json]',
    details: ['<image> is a file, sample:<path> from "glcm samples", or an image id.'],
    async run(context) {
      const [target] = context.positionals;
      if (!target) {
        throw new ApiError(0, 'BadOption', 'Name an image: a file, sample:<path> or an image id');
      }
      const { info, reused } = await openImageTarget(await context.client(), target);
      if (context.json) {
        context.io.out(JSON.stringify(info, null, 2));
        return EXIT_OK;
      }
      context.io.out(pairs(describeImage(info)));
      for (const warning of info.warnings) {
        context.io.err(`warning: ${warning}`);
      }
      if (reused) {
        context.io.err('The server already had this image; nothing was uploaded.');
      }
      return EXIT_OK;
    },
  },

  measure: {
    summary: 'Measure texture features of ROIs in one or more images',
    usage: 'glcm measure <image...> [--rois <file>] [--preset <id>] [--out <file>]',
    details: [
      'Without --rois the whole image is measured as one ROI; for a stack, the whole of every slice, or of --slice <n> (from 1).',
      '--rois takes an ROI set (.roi.json), a project (.glcmproj), an array of ROIs, or ImageJ ROIs (.roi or RoiSet.zip).',
      'Settings come from the defaults, then --settings <file>, then --preset, then the single options.',
      'Several images are measured in turn and their rows merged into one file when their settings match.',
      '--resample 0.5,0.5 resamples the image and the ROIs to that pixel spacing (mm) first; the image needs a pixel spacing (or --spacing).',
      '--log-sigma 2 measures the Laplacian of Gaussian (sigma in mm with a pixel spacing), with --quantization fixedBinWidth,25 or roiMinMax.',
      '--wavelet LH measures that sub-band of the Coiflet 1 stationary wavelet transform (L low-pass, H high-pass; x first), with the same quantizations.',
    ],
    options: {
      ...SETTINGS_OPTIONS,
      rois: { type: 'string' },
      slice: { type: 'string' },
      spacing: { type: 'string' },
      out: { type: 'string', short: 'o' },
      format: { type: 'string' },
    },
    async run(context) {
      if (context.positionals.length === 0) {
        throw new ApiError(0, 'BadOption', 'Name at least one image to measure');
      }
      const format = text(context, 'format') ?? (context.json ? 'json' : 'csv');
      if (format !== 'csv' && format !== 'json') {
        throw new ApiError(0, 'BadOption', '--format must be csv or json');
      }
      const spacing = numbers(text(context, 'spacing'));
      if (spacing && spacing.length !== 2) {
        throw new ApiError(0, 'BadOption', '--spacing takes the pixel width and height in millimetres, e.g. --spacing 0.5,0.5');
      }
      const client = await context.client();
      const catalog = await operations.getCatalog(client);
      const rois = text(context, 'rois') ? await readRois(text(context, 'rois')!, (message) => context.io.err(`warning: ${message}`)) : null;
      const slice = text(context, 'slice') !== undefined ? integer(context, 'slice')! : undefined;
      if (slice !== undefined && rois) {
        throw new ApiError(0, 'BadOption', '--slice chooses the slice of the whole image; ROIs from --rois lie on their own slices');
      }
      const overrides = await settingsOverrides(context);

      const csvTexts: string[] = [];
      const documents: unknown[] = [];
      for (const target of context.positionals) {
        const { info } = await openImageTarget(client, target);
        const settings = operations.buildSettings(catalog, info.bitDepth, overrides);
        const issues = operations.validateSettings(
          settings,
          info.bitDepth,
          catalog,
          spacing ? { x: spacing[0], y: spacing[1] } : (info.pixelSpacing ?? null),
        );
        for (const warning of issues.warnings) {
          context.io.err(`warning: ${warning}`);
        }
        if (issues.errors.length > 0) {
          issues.errors.forEach((error) => context.io.err(`error: ${error}`));
          return EXIT_USAGE;
        }
        const measurement = await operations.measure(client, {
          imageId: info.imageId,
          rois: rois ?? operations.wholeImageRois(info, slice),
          settings,
          ...(spacing ? { pixelSpacing: { x: spacing[0], y: spacing[1] } } : {}),
        });
        csvTexts.push(measurement.csv);
        documents.push(measurement.document);
        const rows = measurement.document.results.length;
        context.io.err(`${info.name}: ${rows} ${rows === 1 ? 'measurement' : 'measurements'} of ${measurement.analysis.total} jobs`);
      }

      const out = text(context, 'out');
      if (format === 'json') {
        const body = JSON.stringify(documents.length === 1 ? documents[0] : documents, null, 2);
        if (out) {
          await fs.writeFile(out, `${body}\n`);
          context.io.err(`Wrote ${out}`);
        } else {
          context.io.out(body);
        }
        return EXIT_OK;
      }

      // Files measured with the same settings share one table, as the app's batch export does
      const groups = combineResultsCsv(csvTexts);
      if (!out) {
        context.io.out(groups.map((group) => group.text).join('\n'));
        return EXIT_OK;
      }
      const stem = out.replace(/\.csv$/i, '');
      for (const [index, group] of groups.entries()) {
        const file = groups.length === 1 ? (out.endsWith('.csv') ? out : `${out}.csv`) : `${stem}-${index + 1}.csv`;
        await fs.writeFile(file, group.text);
        context.io.err(`Wrote ${file} (${group.images} ${group.images === 1 ? 'image' : 'images'})`);
      }
      return EXIT_OK;
    },
  },

  regions: {
    summary: 'Select regions by intensity and save them as an ROI set',
    usage: 'glcm regions <image> [--min <v> --max <v>] [--at <x,y> --tolerance <v>] [--out <file>]',
    details: [
      'Without --at, the regions are the connected areas whose intensities lie between --min and --max,',
      'with at least --min-pixels (50) and at most --max-pixels pixels and a sphericity of at least --min-sphericity (0 to 1).',
      'With --at they are the one region around that pixel, as the magic wand gives it.',
      'The ROI set can then be measured: glcm measure <image> --rois <file>',
      'An --out name ending in .zip writes a RoiSet.zip for ImageJ instead of an ROI set.',
      'For a stack, --slice <n> (from 1, default 1) chooses the slice; the ROIs are saved on that slice.',
    ],
    options: {
      min: { type: 'string' },
      max: { type: 'string' },
      'min-pixels': { type: 'string' },
      'max-pixels': { type: 'string' },
      'min-sphericity': { type: 'string' },
      'max-regions': { type: 'string' },
      at: { type: 'string' },
      tolerance: { type: 'string' },
      slice: { type: 'string' },
      out: { type: 'string', short: 'o' },
    },
    async run(context) {
      const [target] = context.positionals;
      if (!target) {
        throw new ApiError(0, 'BadOption', 'Name an image');
      }
      const client = await context.client();
      const { info } = await openImageTarget(client, target);
      const slice = integer(context, 'slice', 1)!;
      const at = numbers(text(context, 'at'));
      let regions: operations.RegionResult[];
      let total: number;
      if (at) {
        if (at.length !== 2) {
          throw new ApiError(0, 'BadOption', '--at takes a pixel, e.g. --at 120,80');
        }
        const region = await operations.selectRegionAt(client, info.imageId, {
          x: at[0],
          y: at[1],
          tolerance: integer(context, 'tolerance', Math.round((info.windowMax - info.windowMin) * 0.05))!,
          ...(slice > 1 ? { slice } : {}),
        });
        regions = region ? [region] : [];
        total = regions.length;
      } else {
        const found = await operations.selectThresholdRegions(client, info.imageId, {
          min: integer(context, 'min', info.windowMin)!,
          max: integer(context, 'max', info.windowMax)!,
          minPixels: integer(context, 'min-pixels', 50)!,
          maxRegions: integer(context, 'max-regions', 20)!,
          ...(text(context, 'max-pixels') !== undefined ? { maxPixels: integer(context, 'max-pixels')! } : {}),
          ...(text(context, 'min-sphericity') !== undefined ? { minSphericity: fraction(context, 'min-sphericity') } : {}),
          ...(slice > 1 ? { slice } : {}),
        });
        regions = found.regions;
        total = found.total;
      }

      const document = operations.roiSetOf(info, regions, 'Region', slice);
      const out = text(context, 'out');
      if (context.json && !out) {
        context.io.out(JSON.stringify(document, null, 2));
        return EXIT_OK;
      }
      if (out) {
        const notes = await writeRoiSet(out, document, info);
        notes.forEach((note) => context.io.err(`note: ${note}`));
        context.io.err(`Wrote ${out}`);
      }
      if (!context.json) {
        context.io.out(
          table(
            ['ROI', 'Pixels', 'Box'],
            regions.map((region, index) => [
              document.rois[index].name,
              region.pixelCount.toLocaleString(),
              region.boundingBox ? `${region.boundingBox.x},${region.boundingBox.y} ${region.boundingBox.width}×${region.boundingBox.height}` : '',
            ]),
            [false, true, false],
          ),
        );
        if (total > regions.length) {
          context.io.err(`${total} regions were found; ${regions.length} are in the file (raise --max-regions for more).`);
        }
      }
      return EXIT_OK;
    },
  },

  'feature-map': {
    summary: 'Compute one feature across a whole image and save it as a 32-bit TIFF',
    usage: 'glcm feature-map <image> --feature <id> [--window <px>] [--out <file.tif>]',
    options: {
      ...SETTINGS_OPTIONS,
      feature: { type: 'string' },
      window: { type: 'string' },
      step: { type: 'string' },
      slice: { type: 'string' },
      out: { type: 'string', short: 'o' },
    },
    async run(context) {
      const [target] = context.positionals;
      const feature = text(context, 'feature');
      if (!target || !feature) {
        throw new ApiError(0, 'BadOption', 'Name an image and a feature, e.g. glcm feature-map brick.png --feature Contrast');
      }
      const client = await context.client();
      const catalog = await operations.getCatalog(client);
      const { info } = await openImageTarget(client, target);
      const settings = operations.buildSettings(catalog, info.bitDepth, await settingsOverrides(context));
      const map = await operations.computeFeatureMap(
        client,
        info.imageId,
        {
          feature,
          window: integer(context, 'window', 31)!,
          step: text(context, 'step') ? integer(context, 'step')! : null,
          grayLevels: settings.grayLevels,
          quantization: settings.quantization,
          distance: settings.distances[0],
          directions: settings.directions,
          logBase: settings.logBase,
        },
        text(context, 'slice') !== undefined ? integer(context, 'slice')! : undefined,
      );

      const range = operations.valueRange(map.values);
      const summary = { feature, columns: map.info.columns, rows: map.info.rows, step: map.info.step, ...range, emptyWindows: range.empty };
      const out = text(context, 'out');
      if (out) {
        const description = JSON.stringify({ feature, window: integer(context, 'window', 31), step: map.info.step, image: info.name });
        await fs.writeFile(out, encodeFloat32Tiff(map.values, map.info.columns, map.info.rows, description));
        context.io.err(`Wrote ${out}`);
      }
      context.io.out(
        context.json
          ? JSON.stringify(summary, null, 2)
          : pairs([
              ['Feature', feature],
              ['Grid', `${summary.columns} × ${summary.rows} points, step ${summary.step} px`],
              ['Values', summary.minimum === null ? 'none' : `${number(summary.minimum)} – ${number(summary.maximum!)}`],
              ['Empty windows', String(summary.emptyWindows)],
            ]),
      );
      return EXIT_OK;
    },
  },
};

function usage(io: Io): void {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  io.out(
    [
      'glcm — Texture Workbench without a browser',
      '',
      'Usage: glcm <command> [options]',
      '',
      ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`),
      `  ${'mcp'.padEnd(width)}  Serve the same operations to an AI agent over MCP`,
      '',
      'Options for every command:',
      '  --server <url>    a running server; without it the API runs in this process',
      '  --token <token>   access token of that server (or GLCM_API_TOKEN)',
      '  --data-dir <dir>  where images and results are kept in this process (or GLCM_DATA_DIR)',
      '  --json            machine-readable output',
      '  --help            this text, or the options of a command',
      '',
      'Example:',
      '  glcm regions sample:medical/ct-chest.png --min 1200 --max 1600 --out lungs.roi.json',
      '  glcm measure sample:medical/ct-chest.png --rois lungs.roi.json --preset haralick --out lungs.csv',
    ].join('\n'),
  );
}

function commandUsage(io: Io, name: string, command: Command): void {
  io.out([command.summary, '', `Usage: ${command.usage}`, ...(command.details ? ['', ...command.details] : [])].join('\n'));
}

export async function run(argv: readonly string[], io: Io = { out: (t) => console.log(t), err: (t) => console.error(t) }): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    usage(io);
    return name ? EXIT_OK : EXIT_USAGE;
  }
  if (name === '--version' || name === 'version') {
    io.out(VERSION);
    return EXIT_OK;
  }
  if (name === 'mcp') {
    if (rest.includes('--help') || rest.includes('-h')) {
      io.out(
        [
          'Serve the same operations to an AI agent over MCP, on standard input and output',
          '',
          'Usage: glcm mcp [--server <url>] [--token <token>] [--data-dir <dir>]',
          '',
          'An assistant starts this command itself; add it to the assistant\'s MCP configuration, for example',
          '  claude mcp add texture-workbench -- node /path/to/texture-workbench/cli/bin/glcm.mjs mcp',
        ].join('\n'),
      );
      return EXIT_OK;
    }
    if (process.stdin.isTTY) {
      // Standard output belongs to the protocol, so the hint goes to standard error
      io.err('Waiting for an MCP client on standard input. An AI assistant starts this command itself; press Ctrl+C to stop.');
    }
    try {
      const { serveMcp } = await import('./mcp.js');
      await serveMcp(rest);
      return EXIT_OK;
    } catch (error) {
      // The packages MCP needs are optional, so an installation can leave them out (the Docker image does)
      if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
        io.err('MCP support is not installed here. Install @modelcontextprotocol/sdk and zod, or use a clone of the repository.');
        return EXIT_FAILED;
      }
      throw error;
    }
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`There is no command "${name}".`);
    usage(io);
    return EXIT_USAGE;
  }

  let parsed;
  try {
    parsed = parseArgs({ args: [...rest], options: { ...GLOBAL_OPTIONS, ...command.options }, allowPositionals: true, strict: true });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    commandUsage(io, name, command);
    return EXIT_USAGE;
  }
  if (parsed.values.help === true) {
    commandUsage(io, name, command);
    return EXIT_OK;
  }

  const connection: { client: ApiClient | null } = { client: null };
  const context: Context = {
    values: parsed.values as Context['values'],
    positionals: parsed.positionals,
    io,
    json: parsed.values.json === true,
    async client() {
      connection.client ??= await createClient({
        server: (parsed.values.server as string | undefined) ?? process.env.GLCM_SERVER,
        token: parsed.values.token as string | undefined,
        dataDir: parsed.values['data-dir'] as string | undefined,
      });
      return connection.client;
    },
  };

  try {
    return await command.run(context);
  } catch (error) {
    if (error instanceof ApiError) {
      io.err(`error: ${error.message}`);
      return error.code === 'BadOption' || error.code === 'UnknownPreset' || error.code === 'UnknownFeature' ? EXIT_USAGE : EXIT_FAILED;
    }
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  } finally {
    await connection.client?.close();
  }
}

// Run when this file is the command itself (`tsx cli/src/main.ts …`). Started through bin/glcm.mjs, or imported by a
// test, the entry point is another file and this does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
