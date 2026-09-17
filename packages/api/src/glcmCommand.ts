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

// Words left unquoted: no shell expands them. A leading = (zsh expands =name) or @ is quoted too.
const SAFE = /^[A-Za-z0-9_%+:,./-][A-Za-z0-9_@%+=:,./-]*$/;

/** One shell word for POSIX shells (sh, bash, zsh): unchanged when safe, else in single quotes */
export function shellQuote(word: string): string {
  if (word !== '' && SAFE.test(word)) {
    return word;
  }
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Splits a command written by measureCommand back into its words: single quotes, backslash escapes and blanks between
 * words (not double quotes or expansions). Throws for an unterminated quote or a trailing backslash.
 */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) {
        throw new Error('The command has an unterminated quote');
      }
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (char === '\\') {
      if (i + 1 >= command.length) {
        throw new Error('The command ends with a backslash');
      }
      word = (word ?? '') + command[i + 1];
      i += 1;
    } else if (char === ' ' || char === '\t' || char === '\n') {
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

/** A file name that could be taken for an option (it starts with -) as a path in the current folder */
function fileArgument(name: string): string {
  return name.startsWith('-') ? `./${name}` : name;
}

/** The command's words, starting with glcm */
export function measureArguments(request: CommandRequest): string[] {
  return [
    'glcm',
    'measure',
    ...request.images.map(fileArgument),
    '--settings',
    fileArgument(request.settingsFile),
    '--rois',
    fileArgument(request.roisFile),
    ...(request.colour ? ['--colour', request.colour] : []),
    ...(request.spacing ? ['--spacing', `${number(request.spacing.x)},${number(request.spacing.y)}`] : []),
    '--out',
    fileArgument(request.out),
    ...(request.server ? ['--server', request.server] : []),
  ];
}

export function measureCommand(request: CommandRequest): string {
  return measureArguments(request).map(shellQuote).join(' ');
}
