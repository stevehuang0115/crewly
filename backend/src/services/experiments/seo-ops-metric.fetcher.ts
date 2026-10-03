/**
 * Fetch an experiment's metric with the seo-ops skill (issue #986).
 *
 * Runs `python3 seo_ops.py --config <cfg> metric …` and parses its JSON. The
 * skill owns Search Console / GA4 access (service-account credentials named
 * in its site config), so the backend holds no Google analytics code.
 *
 * specs/experiment-cards.md
 *
 * @module services/experiments/seo-ops-metric.fetcher
 */

import { execFile } from 'child_process';
import path from 'path';
import { EXPERIMENT_CONSTANTS } from '../../constants.js';
import type { ExperimentMetric, Measurement, MeasurementDay } from '../../types/experiment.types.js';
import type { DateRange } from './experiment-verdict.js';

/** Fetch one metric over one window. */
export type MetricFetcher = (metric: ExperimentMetric, range: DateRange) => Promise<Measurement>;

/** Runs a program; resolves stdout, rejects with stderr in the error. */
export type ProgramRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

/** Options of {@link createSeoOpsMetricFetcher}. */
export interface SeoOpsMetricFetcherOptions {
  /** Crewly package root (the script is under it) */
  packageRoot: string;
  python?: string;
  timeoutMs?: number;
  run?: ProgramRunner;
  now?: () => Date;
}

/**
 * The seo-ops command line for one metric and window.
 *
 * @param metric - Metric definition
 * @param range - Window
 * @returns Arguments after the script path
 */
export function metricArgs(metric: ExperimentMetric, range: DateRange): string[] {
  const args = ['--config', metric.config, 'metric', '--source', metric.source, '--measure', metric.measure, '--start', range.start, '--end', range.end];
  if (metric.page) args.push('--page', metric.page, '--page-match', metric.pageMatch ?? 'exact');
  if (metric.query) args.push('--query', metric.query, '--query-match', metric.queryMatch ?? 'exact');
  if (metric.event) args.push('--event', metric.event);
  if (metric.channel) args.push('--channel', metric.channel);
  return args;
}

/**
 * Is this a finite number?
 *
 * @param v - Value
 * @returns True for a finite number
 */
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Parse seo-ops `metric` output.
 *
 * @param stdout - The command's stdout
 * @param fetchedAt - When it was fetched (ISO)
 * @returns Measurement
 * @throws Error when the output is not the expected JSON
 */
export function parseMetricOutput(stdout: string, fetchedAt: string): Measurement {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`seo-ops metric printed something that is not JSON: ${stdout.trim().slice(0, 200)}`);
  }
  const errors = Array.isArray(data.errors) ? (data.errors as Array<Record<string, unknown>>) : [];
  if (errors.length > 0) {
    throw new Error(`seo-ops metric failed: ${errors.map((e) => String(e.message ?? e)).join('; ').slice(0, 500)}`);
  }
  if (typeof data.start !== 'string' || typeof data.end !== 'string' || !Array.isArray(data.days)) {
    throw new Error('seo-ops metric output is missing start / end / days');
  }
  const days: MeasurementDay[] = (data.days as Array<Record<string, unknown>>).map((d) => ({
    date: String(d.date),
    value: isNum(d.value) ? d.value : null,
    volume: isNum(d.volume) ? d.volume : 0,
    ...(isNum(d.clicks) ? { clicks: d.clicks } : {}),
    ...(isNum(d.impressions) ? { impressions: d.impressions } : {}),
  }));
  return {
    start: data.start,
    end: data.end,
    total: isNum(data.total) ? data.total : null,
    volume: isNum(data.volume) ? data.volume : 0,
    ...(isNum(data.clicks) ? { clicks: data.clicks } : {}),
    ...(isNum(data.impressions) ? { impressions: data.impressions } : {}),
    days,
    fetchedAt,
  };
}

/**
 * The `errors[].message` of a seo-ops JSON output, joined ('' when none).
 *
 * @param stdout - The command's stdout
 * @returns Messages
 */
export function jsonErrors(stdout: string): string {
  try {
    const data = JSON.parse(stdout.trim()) as { errors?: Array<{ message?: unknown }> };
    return (data.errors ?? []).map((e) => String(e?.message ?? '')).filter(Boolean).join('; ').slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Default runner: execFile with a timeout; the error carries seo-ops' own message.
 *
 * @param file - Program
 * @param args - Arguments
 * @param timeoutMs - Timeout
 * @returns stdout
 */
export const execProgram: ProgramRunner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // seo-ops prints its errors in the JSON on stdout as well as on stderr.
        const said = String(stderr ?? '').trim().split('\n').filter(Boolean).join(' ').slice(0, 500) || jsonErrors(String(stdout ?? ''));
        reject(new Error(said || err.message));
        return;
      }
      resolve(String(stdout));
    });
  });

/**
 * A fetcher that runs the bundled seo-ops skill.
 *
 * @param options - Package root, runner and clock
 * @returns Fetcher
 */
export function createSeoOpsMetricFetcher(options: SeoOpsMetricFetcherOptions): MetricFetcher {
  const script = path.join(options.packageRoot, EXPERIMENT_CONSTANTS.SEO_OPS_SCRIPT);
  const run = options.run ?? execProgram;
  const now = options.now ?? (() => new Date());
  return async (metric, range) => {
    const stdout = await run(options.python ?? EXPERIMENT_CONSTANTS.PYTHON_BIN, [script, ...metricArgs(metric, range)], options.timeoutMs ?? EXPERIMENT_CONSTANTS.FETCH_TIMEOUT_MS);
    return parseMetricOutput(stdout, now().toISOString());
  };
}
