// Plain text for a terminal: aligned tables and short numbers. Every command also has a --json form, which is what
// scripts should read.

export function table(headers: readonly string[], rows: readonly (readonly string[])[], rightAligned: readonly boolean[] = []): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (rightAligned[column] ? (cell ?? '').padStart(widths[column]) : (cell ?? '').padEnd(widths[column])))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '─'.repeat(width))), ...rows.map(line)].join('\n');
}

/** Label and value lines, without the header a table would have */
export function pairs(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

export function number(value: number, digits = 6): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return String(Number(value.toPrecision(digits)));
}

export function bytes(size: number): string {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
