// Feature maps: the rows of a map are split into bands of about equal computing work (glcm::FeatureMapRowWork), each
// computed by the addon's computeFeatureMap as a task on the shared Scheduler, so maps and analyses share the worker
// limit and take turns. Cancelling stops running bands through a CancelToken. Maps are kept in memory only.

import { randomUUID } from 'node:crypto';
import type { FeatureMapInfo, FeatureMapSettings, FeatureMapStatus, ImageInfo } from '@glcm/api';
import * as native from '@glcm/native';
import { JobLimitError } from './JobManager.js';
import type { Scheduler } from './Scheduler.js';

/**
 * Estimated work of one band (units of glcm::FeatureMapRowWork, about 1.6 ns each on an Apple M-series core), so a band
 * takes about a second. A band has at least one row, however much work the row is.
 */
export const FEATURE_MAP_BAND_WORK = 6e8;

export function newFeatureMapId(): string {
  return `fmap_${randomUUID().replaceAll('-', '')}`;
}

export interface FeatureMapState {
  info: FeatureMapInfo;
  /** rows × columns values, row-major; NaN until computed and where a window has no pixel pairs */
  values: Float32Array;
}

interface InternalState extends FeatureMapState {
  image: ImageInfo;
  /** Released when the map finishes */
  pixels: Buffer | null;
  running: number;
  queued: number;
  cancelRequested: boolean;
  /** Stops the running bands */
  cancelToken: native.CancelToken;
}

export interface FeatureMapManagerOptions {
  scheduler: Scheduler;
  /** Tasks queued or running over all analyses and maps; start() refuses maps that do not fit */
  maxPendingJobs: number;
  /** Bands of one map; start() refuses larger maps */
  maxBands: number;
  /** Finished maps kept in memory; the oldest are forgotten first */
  retainFinished: number;
  /** Estimated work per band; FEATURE_MAP_BAND_WORK by default */
  bandWork?: number;
}

const FINISHED: ReadonlySet<FeatureMapStatus> = new Set(['completed', 'cancelled', 'failed']);

export class FeatureMapManager {
  private readonly maps = new Map<string, InternalState>();

  constructor(private readonly options: FeatureMapManagerOptions) {}

  /**
   * Queues the bands of a map; throws an Error with code INVALID_ARGUMENT for invalid settings and JobLimitError when the
   * map has more bands than maxBands or than fit into maxPendingJobs
   */
  start(settings: FeatureMapSettings, image: ImageInfo, pixels: Buffer, slice = 1): FeatureMapState {
    const settingsJson = JSON.stringify(settings);
    const grid = native.featureMapGrid(settingsJson, image.width, image.height);
    const bandWork = this.options.bandWork ?? FEATURE_MAP_BAND_WORK;
    const bandRows = Math.min(grid.rows, Math.max(1, Math.floor(bandWork / grid.workPerRow)));
    const bands = Math.ceil(grid.rows / bandRows);
    const { scheduler, maxPendingJobs, maxBands } = this.options;
    const limit = Math.min(maxBands, maxPendingJobs);
    if (bands > limit) {
      throw new JobLimitError('tooLarge', bands, scheduler.pending, limit);
    }
    if (scheduler.pending + bands > maxPendingJobs) {
      throw new JobLimitError('busy', bands, scheduler.pending, maxPendingJobs);
    }

    const state: InternalState = {
      info: {
        featureMapId: newFeatureMapId(),
        imageId: image.imageId,
        imageName: image.name,
        slice,
        status: 'queued',
        settings,
        step: grid.step,
        columns: grid.columns,
        rows: grid.rows,
        completedRows: 0,
        error: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        coreVersion: native.coreVersion(),
      },
      values: new Float32Array(grid.rows * grid.columns).fill(Number.NaN),
      image,
      pixels,
      running: 0,
      queued: bands,
      cancelRequested: false,
      cancelToken: new native.CancelToken(),
    };
    this.maps.set(state.info.featureMapId, state);
    this.forgetOldMaps();

    const tasks = Array.from({ length: bands }, (_, band) => {
      const firstRow = band * bandRows;
      return (release: () => void) => this.runBand(state, settingsJson, firstRow, Math.min(bandRows, grid.rows - firstRow), release);
    });
    scheduler.enqueue(state, tasks);
    return state;
  }

  get(featureMapId: string): FeatureMapState | undefined {
    return this.maps.get(featureMapId);
  }

  /** Cancels a queued or running map (running bands stop after their current point), or forgets a finished one. False if unknown. */
  cancel(featureMapId: string): boolean {
    const state = this.maps.get(featureMapId);
    if (!state) {
      return false;
    }
    if (FINISHED.has(state.info.status)) {
      this.maps.delete(featureMapId);
      return true;
    }
    this.stop(state);
    if (state.running === 0) {
      this.finish(state, 'cancelled');
    }
    return true;
  }

  /** Drops the queued bands and stops the running ones */
  private stop(state: InternalState): void {
    state.cancelRequested = true;
    state.queued -= this.options.scheduler.drop(state);
    state.cancelToken.cancel();
  }

  private async runBand(state: InternalState, settingsJson: string, firstRow: number, rowCount: number, release: () => void): Promise<void> {
    state.queued -= 1;
    state.running += 1;
    if (state.info.status === 'queued') {
      state.info.status = 'running';
    }
    const { image } = state;
    let failure: string | null = null;
    try {
      const values = await native.computeFeatureMap(
        state.pixels!,
        image.width,
        image.height,
        image.bitDepth,
        settingsJson,
        firstRow,
        rowCount,
        state.cancelToken,
      );
      state.values.set(values, firstRow * state.info.columns);
      state.info.completedRows += rowCount;
    } catch (error) {
      // A band stopped by stop() is not a failure
      if ((error as { code?: string }).code !== 'CANCELLED') {
        failure = error instanceof Error ? error.message : String(error);
      }
    } finally {
      release();
      state.running -= 1;
    }

    if (FINISHED.has(state.info.status)) {
      return;
    }
    if (failure !== null && state.info.error === null) {
      // One failing band fails the map; the other bands would fail the same way
      state.info.error = failure;
      this.stop(state);
    }
    if (state.running > 0 || state.queued > 0) {
      return;
    }
    if (state.info.error !== null) {
      this.finish(state, 'failed');
    } else {
      this.finish(state, state.cancelRequested ? 'cancelled' : 'completed');
    }
  }

  private finish(state: InternalState, status: FeatureMapStatus): void {
    state.info.status = status;
    state.info.finishedAt = new Date().toISOString();
    state.pixels = null;
  }

  private forgetOldMaps(): void {
    const finished = [...this.maps.values()].filter((state) => FINISHED.has(state.info.status));
    for (const state of finished.slice(0, Math.max(0, finished.length - this.options.retainFinished))) {
      this.maps.delete(state.info.featureMapId);
    }
  }
}
