// Analysis jobs (doc/ui-design-plan.md, section 6.3.3). Each ROI × distance pair is one job, run with the addon's
// AsyncWorker on a Scheduler, which runs at most `concurrency` tasks of all analyses and feature maps at a time. Analyses
// take turns, one job each, so a large analysis does not hold up the ones started after it, and at most `maxPendingJobs`
// tasks are queued or running.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  AnalysisEvent,
  AnalysisInfo,
  AnalysisRequest,
  AnalysisResults,
  AnalysisStatus,
  ImageInfo,
  MeasurementResult,
  Roi,
} from '@glcm/api';
import * as native from '@glcm/native';
import { Scheduler } from './Scheduler.js';

export function newAnalysisId(): string {
  return `ana_${randomUUID().replaceAll('-', '')}`;
}

interface Job {
  /** Position in the result order: ROI index × distance count + distance index */
  index: number;
  roi: Roi;
  distance: number;
}

export interface AnalysisState {
  info: AnalysisInfo;
  /** Finished jobs by index */
  results: Array<MeasurementResult | undefined>;
  /** Emits 'event' with AnalysisEvent values */
  events: EventEmitter;
}

interface InternalState extends AnalysisState {
  image: ImageInfo;
  request: AnalysisRequest;
  /** The pixels of each slice the ROIs lie on (1 for a single image); released when the analysis finishes */
  pixels: Map<number, Buffer> | null;
  running: number;
  cancelRequested: boolean;
}

export interface JobManagerOptions {
  /** Jobs running at the same time, when no scheduler is given */
  concurrency: number;
  /** Scheduler shared with feature maps; by default the manager has its own */
  scheduler?: Scheduler;
  /** Tasks queued or running on the scheduler; start() refuses analyses that do not fit */
  maxPendingJobs: number;
  /** Finished analyses kept in memory; the oldest are forgotten first */
  retainFinished: number;
  /** Called once an analysis has finished, e.g. to store its results */
  onFinished?: (state: AnalysisState) => Promise<void> | void;
}

/**
 * Thrown by JobManager.start() when an analysis does not fit into maxPendingJobs: "tooLarge" if it could never fit,
 * "busy" if it fits once other analyses have progressed
 */
export class JobLimitError extends Error {
  constructor(
    readonly reason: 'tooLarge' | 'busy',
    readonly jobs: number,
    readonly pending: number,
    readonly limit: number,
  ) {
    super(
      reason === 'tooLarge'
        ? `The analysis has ${jobs} jobs, more than the limit of ${limit}`
        : `${pending} jobs are pending; ${jobs} more would exceed the limit of ${limit}`,
    );
    this.name = 'JobLimitError';
  }
}

const FINISHED: ReadonlySet<AnalysisStatus> = new Set(['completed', 'cancelled', 'failed']);

export function isFinished(status: AnalysisStatus): boolean {
  return FINISHED.has(status);
}

function failedResult(job: Job, message: string): MeasurementResult {
  return {
    roiId: job.roi.id,
    roiName: job.roi.name,
    ...(job.roi.class ? { roiClass: job.roi.class } : {}),
    distance: job.distance,
    status: 'failed',
    error: message,
    pixelCount: 0,
    pairCounts: { '0': 0, '45': 0, '90': 0, '135': 0 },
    quantization: { lower: 0, upper: 0 },
    values: {},
    score: null,
    warnings: [],
  };
}

export class JobManager {
  private readonly analyses = new Map<string, InternalState>();
  private readonly scheduler: Scheduler;
  /** onFinished calls that have not settled yet */
  private readonly pendingFinishes = new Set<Promise<unknown>>();

  constructor(private readonly options: JobManagerOptions) {
    this.scheduler = options.scheduler ?? new Scheduler(options.concurrency);
  }

  /**
   * Queues the jobs of an analysis; the request must already be validated. Throws JobLimitError when the jobs do not
   * fit into maxPendingJobs.
   */
  start(request: AnalysisRequest, image: ImageInfo, pixels: Map<number, Buffer>): AnalysisState {
    const { distances } = request.settings;
    const total = request.rois.length * distances.length;
    if (total > this.options.maxPendingJobs) {
      throw new JobLimitError('tooLarge', total, this.pendingJobs, this.options.maxPendingJobs);
    }
    if (this.pendingJobs + total > this.options.maxPendingJobs) {
      throw new JobLimitError('busy', total, this.pendingJobs, this.options.maxPendingJobs);
    }

    const jobs: Job[] = [];
    request.rois.forEach((roi, roiIndex) => {
      distances.forEach((distance, distanceIndex) => jobs.push({ index: roiIndex * distances.length + distanceIndex, roi, distance }));
    });

    const events = new EventEmitter();
    events.setMaxListeners(0);
    const state: InternalState = {
      info: {
        analysisId: newAnalysisId(),
        imageId: image.imageId,
        imageName: image.name,
        imageSha256: image.sha256,
        status: 'queued',
        total: jobs.length,
        completed: 0,
        error: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        coreVersion: native.coreVersion(),
        settings: request.settings,
        // Image infos saved before pixel spacing existed have no field
        pixelSpacing: request.pixelSpacing === undefined ? (image.pixelSpacing ?? null) : request.pixelSpacing,
        ...(image.valueConversion ? { valueConversion: image.valueConversion.description } : {}),
      },
      results: new Array<MeasurementResult | undefined>(jobs.length),
      events,
      image,
      request,
      pixels,
      running: 0,
      cancelRequested: false,
    };
    this.analyses.set(state.info.analysisId, state);
    this.forgetOldAnalyses();

    this.scheduler.enqueue(state, jobs.map((job) => (release) => this.run(state, job, release)));
    return state;
  }

  get(analysisId: string): AnalysisState | undefined {
    return this.analyses.get(analysisId);
  }

  /** Drops the queued jobs of an analysis; running jobs finish, then it is marked cancelled. False if unknown. */
  cancel(analysisId: string): boolean {
    const state = this.analyses.get(analysisId);
    if (!state) {
      return false;
    }
    if (isFinished(state.info.status)) {
      return true;
    }
    state.cancelRequested = true;
    this.scheduler.drop(state);
    if (state.running === 0) {
      this.finish(state, 'cancelled');
    }
    return true;
  }

  results(state: AnalysisState): AnalysisResults {
    return {
      format: 'glcm-results',
      version: 1,
      analysisId: state.info.analysisId,
      status: state.info.status,
      coreVersion: state.info.coreVersion,
      timestamp: state.info.finishedAt ?? new Date().toISOString(),
      image: {
        id: state.info.imageId,
        name: state.info.imageName,
        sha256: state.info.imageSha256,
        ...(state.info.pixelSpacing ? { pixelSpacing: state.info.pixelSpacing } : {}),
        ...(state.info.valueConversion ? { valueConversion: state.info.valueConversion } : {}),
      },
      settings: state.info.settings,
      results: state.results.filter((result): result is MeasurementResult => result !== undefined),
    };
  }

  /** Number of queued or running tasks on the scheduler, including those of feature maps */
  get pendingJobs(): number {
    return this.scheduler.pending;
  }

  private emit(state: AnalysisState, event: AnalysisEvent): void {
    state.events.emit('event', event);
  }

  private async run(state: InternalState, job: Job, release: () => void): Promise<void> {
    state.running += 1;
    if (state.info.status === 'queued') {
      state.info.status = 'running';
    }

    let result: MeasurementResult;
    try {
      const { image, request } = state;
      const json = await native.runAnalysis(
        state.pixels!.get(job.roi.slice ?? 1)!,
        image.width,
        image.height,
        image.bitDepth,
        JSON.stringify([job.roi]),
        JSON.stringify({ ...request.settings, distances: [job.distance] }),
        state.info.pixelSpacing ?? null,
      );
      result = (JSON.parse(json) as { results: MeasurementResult[] }).results[0];
    } catch (error) {
      result = failedResult(job, error instanceof Error ? error.message : String(error));
    } finally {
      release();
      state.running -= 1;
    }

    state.results[job.index] = result;
    state.info.completed += 1;
    this.emit(state, { event: 'result', data: { index: job.index, result } });
    this.emit(state, { event: 'progress', data: { completed: state.info.completed, total: state.info.total } });

    if (state.info.completed === state.info.total) {
      this.finish(state, 'completed');
    } else if (state.cancelRequested && state.running === 0) {
      this.finish(state, 'cancelled');
    }
  }

  private finish(state: InternalState, status: AnalysisStatus, error: string | null = null): void {
    state.info.status = status;
    state.info.error = error;
    state.info.finishedAt = new Date().toISOString();
    state.pixels = null;
    this.emit(state, {
      event: 'finished',
      data: { status, completed: state.info.completed, total: state.info.total, error },
    });
    const storing: Promise<unknown> = Promise.resolve()
      .then(() => this.options.onFinished?.(state))
      .catch((failure: unknown) => console.error(`Could not store analysis ${state.info.analysisId}`, failure))
      .finally(() => this.pendingFinishes.delete(storing));
    this.pendingFinishes.add(storing);
  }

  /** Resolves once the onFinished calls of finished analyses have settled, e.g. before the server closes */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingFinishes]);
  }

  /** Forgets finished analyses that finished before a time (milliseconds since the epoch) */
  forgetFinishedBefore(cutoff: number): number {
    let forgotten = 0;
    for (const [id, state] of this.analyses) {
      if (isFinished(state.info.status) && Date.parse(state.info.finishedAt ?? state.info.createdAt) < cutoff) {
        this.analyses.delete(id);
        forgotten += 1;
      }
    }
    return forgotten;
  }

  private forgetOldAnalyses(): void {
    const finished = [...this.analyses.values()].filter((state) => isFinished(state.info.status));
    for (const state of finished.slice(0, Math.max(0, finished.length - this.options.retainFinished))) {
      this.analyses.delete(state.info.analysisId);
    }
  }
}
