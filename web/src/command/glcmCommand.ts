// Copy as Command: the image argument and the settings, ROI set and script files saved next to the glcm measure command
// (the command itself is built by measureCommand in @glcm/api)

import { colourConversionOption, type AnalysisSettings, type ColourConversion, type ImageInfo, type RoiSetDocument } from '@glcm/api';
import { strToU8, zipSync } from 'fflate';
import { fileStem } from '../files/download';

/**
 * The file an image argument names: the uploaded file, or for an image converted from a colour image the colour image's
 * file, whose conversion the command repeats with --colour
 */
export function imageSource(info: Pick<ImageInfo, 'name' | 'colourSource'>): { file: string; colour?: ColourConversion } {
  const conversion = info.colourSource?.conversion;
  if (!conversion) {
    return { file: info.name };
  }
  const suffix = ` [${colourConversionOption(conversion).suffix}]`;
  return { file: info.name.endsWith(suffix) ? info.name.slice(0, -suffix.length) : info.name, colour: conversion };
}

/** File names of the files saved next to the command, from the image name (or "batch") */
export function commandFileNames(baseName: string): { settings: string; rois: string; script: string; results: string; archive: string } {
  const stem = fileStem(baseName);
  return {
    settings: `${stem}.settings.json`,
    rois: `${stem}.roi.json`,
    script: `${stem}-measure.sh`,
    results: `${stem}-results.csv`,
    archive: `${stem}-glcm-command.zip`,
  };
}

/** A shell script that runs the command from the folder it is in */
export function commandScript(command: string): string {
  return `#!/bin/sh\n# Run in the folder with the images, the settings and the ROI set\ncd "$(dirname "$0")" || exit 1\n${command}\n`;
}

/** A ZIP of the settings, the ROI set (unless the command reads an ROI file of its own) and the script */
export function commandArchive(files: { settings: [string, AnalysisSettings]; rois?: [string, RoiSetDocument]; script: [string, string] }): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [files.settings[0]]: strToU8(`${JSON.stringify(files.settings[1], null, 2)}\n`),
    [files.script[0]]: strToU8(files.script[1]),
  };
  if (files.rois) {
    entries[files.rois[0]] = strToU8(`${JSON.stringify(files.rois[1], null, 2)}\n`);
  }
  return zipSync(entries);
}
