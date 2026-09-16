// Combines the results CSV files of several analyses (one per image, as written by glcm_core) into as few files as
// possible. Files with the same settings share one file; their rows already name the image and its SHA-256.

/** Comment lines that describe one image; they are replaced by "# images=N" in a combined file */
const PER_IMAGE_KEYS = ['timestamp', 'image', 'imageSha256', 'pixelSpacingMm'];

export interface ResultsCsvFile {
  /** Leading "# key=value" lines */
  comments: string[];
  header: string;
  /** Data records, each possibly spanning lines inside quoted fields */
  records: string[];
}

/** Splits text into CSV records at line breaks outside quoted fields */
function splitRecords(text: string): string[] {
  const records: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      quoted = !quoted;
    } else if (c === '\n' && !quoted) {
      records.push(text.slice(start, i).replace(/\r$/, ''));
      start = i + 1;
    }
  }
  if (start < text.length) {
    records.push(text.slice(start).replace(/\r$/, ''));
  }
  return records.filter((record) => record.length > 0);
}

export function parseResultsCsv(text: string): ResultsCsvFile {
  const comments: string[] = [];
  let offset = 0;
  // Comment lines come first and are read line by line: they are not quoted, so an image name may contain a quote
  while (offset < text.length && text.startsWith('#', offset)) {
    const end = text.indexOf('\n', offset);
    const line = text.slice(offset, end === -1 ? text.length : end).replace(/\r$/, '');
    comments.push(line);
    offset = end === -1 ? text.length : end + 1;
  }
  const [header, ...records] = splitRecords(text.slice(offset));
  if (!header) {
    throw new Error('The results CSV has no header row');
  }
  return { comments, header, records };
}

function commentKey(line: string): string {
  return line.slice(1).trim().split('=', 1)[0];
}

export interface CombinedCsv {
  /** Number of images (input files) in this file */
  images: number;
  text: string;
}

/**
 * Groups the files by their settings (comment lines other than the per-image ones, and the header) and writes one CSV
 * per group, keeping the order of the input files and of their rows
 */
export function combineResultsCsv(texts: readonly string[]): CombinedCsv[] {
  const groups = new Map<string, { settings: string[]; header: string; images: number; records: string[] }>();
  for (const text of texts) {
    const file = parseResultsCsv(text);
    const settings = file.comments.filter((line) => !PER_IMAGE_KEYS.includes(commentKey(line)));
    const key = `${settings.join('\n')}\n${file.header}`;
    const group = groups.get(key) ?? { settings, header: file.header, images: 0, records: [] };
    group.images += 1;
    group.records.push(...file.records);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    // "# images=N" takes the place of the per-image lines, after format, version and core version
    const [format, version, coreVersion, ...rest] = group.settings;
    const comments = [format, version, coreVersion, `# images=${group.images}`, ...rest].filter((line) => line !== undefined);
    return { images: group.images, text: `${[...comments, group.header, ...group.records].join('\n')}\n` };
  });
}
