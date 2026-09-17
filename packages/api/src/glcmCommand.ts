// The glcm measure command that repeats a measurement (the web app's Copy as Command), and splitting it back into words

import type { ColourConversion } from './colour.js';
import type { PixelSpacing } from './schemas.js';

export interface CommandRequest {
  /** Image arguments: file names, or image ids */
  images: string[];
  /** Name of the settings file the command reads */
  settingsFile: string;
  /** Name of the ROI set file the command reads (also an ImageJ .roi or RoiSet.zip) */
  roisFile: string;
  colour?: ColourConversion;
  /** Pixel spacing entered for the image, which its file does not carry */
  spacing?: PixelSpacing;
  out: string;
  /** Address of a running server; the command then needs no API of its own */
  server?: string;
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One shell word: unchanged when safe, else in single quotes (POSIX shells; PowerShell reads the same unless the word holds a quote) */
export function shellQuote(word: string): string {
  if (word !== '' && SAFE.test(word)) {
    return word;
  }
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Splits a command written by measureCommand back into its words (single quotes and '\'' only) */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (char === '\\') {
      word = (word ?? '') + command[i + 1];
      i += 1;
    } else if (char === ' ') {
      if (word !== null) {
        words.push(word);
      }
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) {
    words.push(word);
  }
  return words;
}

function number(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/** The command's words, starting with glcm */
export function measureArguments(request: CommandRequest): string[] {
  return [
    'glcm',
    'measure',
    ...request.images,
    '--settings',
    request.settingsFile,
    '--rois',
    request.roisFile,
    ...(request.colour ? ['--colour', request.colour] : []),
    ...(request.spacing ? ['--spacing', `${number(request.spacing.x)},${number(request.spacing.y)}`] : []),
    '--out',
    request.out,
    ...(request.server ? ['--server', request.server] : []),
  ];
}

export function measureCommand(request: CommandRequest): string {
  return measureArguments(request).map(shellQuote).join(' ');
}
