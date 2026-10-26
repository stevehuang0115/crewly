/**
 * Baseline diff — compares a fresh set of eval results against the last
 * recorded baseline, per task and runtime, and says what moved.
 *
 * Nothing here is an LLM opinion: a task regresses when it passes fewer
 * verification checks than the baseline, or stops completing, or its overall
 * score drops by more than SCORE_TOLERANCE points. The report header always
 * states how many tasks were compared, because "all pass" with no count is
 * not a result (see README).
 */

import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { EvalResult, RuntimeType } from '../types/eval.types.js';

/** Points of overallScore a task may move before it counts as a change. */
export const SCORE_TOLERANCE = 5;

/** Result file name: `<taskId>-<runtime>-<timestamp>.json`. */
const RESULT_FILE = /^([A-Za-z0-9]+)-([a-z-]+)-(\d+)\.json$/;

/** Baseline directory name: `YYYY-MM-DD`. */
const BASELINE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** A result together with the JSON file it was read from. */
export type LoadedResult = EvalResult & { sourceFile: string };

/** What a diff row says about one task on one runtime. */
export type DiffVerdict = 'improved' | 'regressed' | 'unchanged' | 'new' | 'missing';

/** The handful of numbers a reader compares two runs by. */
export interface RunSummary {
  /** Verification checks passed */
  checksPassed: number;
  /** Verification checks run */
  checksTotal: number;
  /** Weighted overall score 0-100 */
  overallScore: number;
  /** agent_done / timeout / error */
  completionType: EvalResult['completionType'];
  /** Wall-clock seconds */
  durationSeconds: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** The result JSON this summary came from (empty when built in memory) */
  file: string;
}

/** One task × runtime compared across the two runs. */
export interface DiffRow {
  taskId: string;
  runtime: RuntimeType;
  baseline?: RunSummary;
  current?: RunSummary;
  verdict: DiffVerdict;
  /** One-line reason for the verdict */
  reason: string;
}

/** The whole comparison. */
export interface DiffReport {
  /** Where the baseline results were read from */
  baselineDir: string;
  /** Where the current results were read from */
  currentDir: string;
  /** Tasks present on both sides (the ones actually compared) */
  tasksCompared: number;
  /** Tasks only in the baseline (not re-run) */
  tasksMissing: number;
  /** Tasks only in the current run (no baseline yet) */
  tasksNew: number;
  rows: DiffRow[];
}

/**
 * Pick the newest dated baseline directory under `baselinesRoot`.
 *
 * @param baselinesRoot - The `eval/baselines/` directory
 * @returns Absolute path of the newest `YYYY-MM-DD` directory, or null when there is none
 */
export async function findLatestBaselineDir(baselinesRoot: string): Promise<string | null> {
  if (!existsSync(baselinesRoot)) return null;
  const entries = await readdir(baselinesRoot, { withFileTypes: true });
  const dated = entries
    .filter((e) => e.isDirectory() && BASELINE_DIR.test(e.name))
    .map((e) => e.name)
    .sort();
  const newest = dated.at(-1);
  return newest ? join(baselinesRoot, newest) : null;
}

/**
 * Read every result JSON under `dir` (one level of runtime subfolders is
 * allowed, as in `baselines/<date>/<runtime>/`), keeping the newest file per
 * task × runtime. Files that do not look like a result are skipped.
 *
 * @param dir - A results directory or a baseline directory
 * @param runtime - Optional runtime filter
 * @returns Newest result per task × runtime, sorted by task id then runtime
 */
export async function loadResults(dir: string, runtime?: RuntimeType): Promise<LoadedResult[]> {
  if (!existsSync(dir)) return [];
  const files = await listResultFiles(dir);
  const newest = new Map<string, { ts: number; result: LoadedResult }>();

  for (const file of files) {
    const m = RESULT_FILE.exec(basename(file));
    if (!m) continue;
    if (runtime && m[2] !== runtime) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!isEvalResult(parsed)) continue;
    const key = `${parsed.taskId}\u0000${parsed.runtime}`;
    const ts = Number(m[3]);
    const prev = newest.get(key);
    if (!prev || ts > prev.ts) {
      newest.set(key, { ts, result: { ...parsed, sourceFile: file } });
    }
  }

  return [...newest.values()]
    .map((v) => v.result)
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.runtime.localeCompare(b.runtime));
}

/**
 * Compare two result sets task by task.
 *
 * @param baseline - Results from the recorded baseline
 * @param current - Results from the fresh run
 * @param dirs - Where each side was read from (for the report header)
 * @returns The diff report; rows are sorted by task id then runtime
 */
export function diffResults(
  baseline: EvalResult[],
  current: EvalResult[],
  dirs: { baselineDir: string; currentDir: string },
): DiffReport {
  const key = (r: EvalResult): string => `${r.taskId}\u0000${r.runtime}`;
  const base = new Map(baseline.map((r) => [key(r), r]));
  const cur = new Map(current.map((r) => [key(r), r]));
  const keys = [...new Set([...base.keys(), ...cur.keys()])].sort();

  const rows: DiffRow[] = keys.map((k) => {
    const b = base.get(k);
    const c = cur.get(k);
    const [taskId, runtime] = k.split('\u0000') as [string, RuntimeType];
    if (b && !c) {
      return { taskId, runtime, baseline: summarize(b), verdict: 'missing', reason: 'not in the current run' };
    }
    if (c && !b) {
      return { taskId, runtime, current: summarize(c), verdict: 'new', reason: 'no baseline for this task' };
    }
    const bs = summarize(b!);
    const cs = summarize(c!);
    const { verdict, reason } = judge(bs, cs);
    return { taskId, runtime, baseline: bs, current: cs, verdict, reason };
  });

  return {
    ...dirs,
    tasksCompared: rows.filter((r) => r.baseline && r.current).length,
    tasksMissing: rows.filter((r) => r.verdict === 'missing').length,
    tasksNew: rows.filter((r) => r.verdict === 'new').length,
    rows,
  };
}

/**
 * Render the diff as markdown. The first line carries the task count.
 *
 * @param report - A diff report
 * @returns Markdown text
 */
export function renderDiffMarkdown(report: DiffReport): string {
  const regressed = report.rows.filter((r) => r.verdict === 'regressed').length;
  const improved = report.rows.filter((r) => r.verdict === 'improved').length;
  const lines: string[] = [];
  lines.push(`# Eval diff: ${report.tasksCompared} task(s) compared`);
  lines.push(`> Baseline: ${report.baselineDir}`);
  lines.push(`> Current:  ${report.currentDir}`);
  lines.push(
    `> ${regressed} regressed, ${improved} improved, ` +
      `${report.tasksCompared - regressed - improved} unchanged, ` +
      `${report.tasksMissing} not re-run, ${report.tasksNew} new`,
  );
  lines.push('');
  lines.push('| Task | Runtime | Verdict | Checks (base → now) | Score (base → now) | Completion (base → now) | Time (base → now) | Cost (base → now) | Why |');
  lines.push('|------|---------|---------|---------------------|--------------------|-------------------------|-------------------|-------------------|-----|');
  for (const r of report.rows) {
    const b = r.baseline;
    const c = r.current;
    const pair = (f: (s: RunSummary) => string): string => `${b ? f(b) : '—'} → ${c ? f(c) : '—'}`;
    lines.push(
      `| ${r.taskId} | ${r.runtime} | ${verdictLabel(r.verdict)} | ` +
        `${pair((s) => `${s.checksPassed}/${s.checksTotal}`)} | ` +
        `${pair((s) => String(s.overallScore))} | ` +
        `${pair((s) => s.completionType)} | ` +
        `${pair((s) => `${s.durationSeconds.toFixed(0)}s`)} | ` +
        `${pair((s) => `$${s.estimatedCostUsd.toFixed(3)}`)} | ${r.reason} |`,
    );
  }
  lines.push('');
  lines.push(`Regression = fewer checks passed, lost completion, or score down by more than ${SCORE_TOLERANCE} points.`);
  if (report.tasksCompared === 0) {
    lines.push('');
    lines.push('No task appears on both sides, so nothing was compared. Run the set first, or pass --baseline.');
  }
  return lines.join('\n');
}

/**
 * Whether the report should fail a gate.
 *
 * @param report - A diff report
 * @returns true when any compared task regressed
 */
export function hasRegression(report: DiffReport): boolean {
  return report.rows.some((r) => r.verdict === 'regressed');
}

/**
 * Copy the newest per-task results (and any report) from a results directory
 * into `baselines/<date>/<runtime>/`, rewriting absolute `logPath`s relative
 * to the eval package so the baseline reads the same on every machine.
 *
 * @param resultsDir - Where the fresh run wrote its JSON
 * @param baselinesRoot - The `eval/baselines/` directory
 * @param date - Baseline date `YYYY-MM-DD`
 * @param evalRoot - The eval package root, used to relativise log paths
 * @param runtime - Optional runtime filter
 * @returns The files written
 * @throws When `date` is not `YYYY-MM-DD` or no results were found
 */
export async function recordBaseline(
  resultsDir: string,
  baselinesRoot: string,
  date: string,
  evalRoot: string,
  runtime?: RuntimeType,
): Promise<string[]> {
  if (!BASELINE_DIR.test(date)) throw new Error(`Baseline date must be YYYY-MM-DD, got "${date}"`);
  const results = await loadResults(resultsDir, runtime);
  if (results.length === 0) throw new Error(`No results found in ${resultsDir}`);

  const written: string[] = [];
  for (const { sourceFile, ...r } of results) {
    const dir = join(baselinesRoot, date, r.runtime);
    await mkdir(dir, { recursive: true });
    const target = join(dir, basename(sourceFile));
    const copy: EvalResult = { ...r, logPath: relativeLogPath(r.logPath, evalRoot) };
    await writeFile(target, JSON.stringify(copy, null, 2), 'utf-8');
    written.push(target);
  }

  // Carry the human report over too, newest one per runtime.
  const reports = (await readdir(resultsDir)).filter((f) => /^eval-report-\d+\.md$/.test(f)).sort();
  const report = reports.at(-1);
  if (report) {
    const runtimes = [...new Set(results.map((r) => r.runtime))];
    for (const rt of runtimes) {
      const target = join(baselinesRoot, date, rt, report);
      await copyFile(join(resultsDir, report), target);
      written.push(target);
    }
  }
  return written;
}

/**
 * Collect result-looking JSON files in `dir` and its immediate subdirectories.
 */
async function listResultFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && RESULT_FILE.test(e.name)) out.push(p);
    else if (e.isDirectory() && e.name !== 'logs') {
      const sub = await readdir(p, { withFileTypes: true });
      for (const s of sub) {
        if (s.isFile() && RESULT_FILE.test(s.name)) out.push(join(p, s.name));
      }
    }
  }
  return out;
}

/** Keep the fields a diff needs from one result. */
function summarize(r: EvalResult & { sourceFile?: string }): RunSummary {
  return {
    checksPassed: r.verificationResults.filter((v) => v.passed).length,
    checksTotal: r.verificationResults.length,
    overallScore: r.overallScore,
    completionType: r.completionType,
    durationSeconds: r.durationSeconds,
    estimatedCostUsd: r.estimatedCostUsd,
    file: r.sourceFile ?? '',
  };
}

/** Decide the verdict for a task present on both sides. */
function judge(b: RunSummary, c: RunSummary): { verdict: DiffVerdict; reason: string } {
  if (c.checksPassed < b.checksPassed) {
    return { verdict: 'regressed', reason: `checks ${b.checksPassed}/${b.checksTotal} → ${c.checksPassed}/${c.checksTotal}` };
  }
  if (b.completionType === 'agent_done' && c.completionType !== 'agent_done') {
    return { verdict: 'regressed', reason: `completion ${b.completionType} → ${c.completionType}` };
  }
  if (c.checksPassed > b.checksPassed) {
    return { verdict: 'improved', reason: `checks ${b.checksPassed}/${b.checksTotal} → ${c.checksPassed}/${c.checksTotal}` };
  }
  if (b.completionType !== 'agent_done' && c.completionType === 'agent_done') {
    return { verdict: 'improved', reason: `completion ${b.completionType} → ${c.completionType}` };
  }
  const delta = c.overallScore - b.overallScore;
  if (delta < -SCORE_TOLERANCE) return { verdict: 'regressed', reason: `score ${b.overallScore} → ${c.overallScore}` };
  if (delta > SCORE_TOLERANCE) return { verdict: 'improved', reason: `score ${b.overallScore} → ${c.overallScore}` };
  return { verdict: 'unchanged', reason: delta === 0 ? 'same checks and score' : `score ${b.overallScore} → ${c.overallScore} (within ±${SCORE_TOLERANCE})` };
}

/** Label with a marker the eye catches in a table. */
function verdictLabel(v: DiffVerdict): string {
  switch (v) {
    case 'regressed': return '❌ regressed';
    case 'improved': return '✅ improved';
    case 'unchanged': return '• unchanged';
    case 'new': return '＋ new';
    case 'missing': return '… not re-run';
  }
}

/**
 * Make a log path relative to the eval root when it is absolute and inside
 * it (`eval/results/logs/A1.log`); leave relative paths and paths outside
 * the package alone.
 */
function relativeLogPath(logPath: string, evalRoot: string): string {
  if (!logPath || !logPath.startsWith('/')) return logPath;
  const rel = relative(evalRoot, logPath);
  return rel.startsWith('..') ? logPath : join('eval', rel);
}

/** Minimal shape check so a stray JSON file cannot crash the diff. */
function isEvalResult(v: unknown): v is EvalResult {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.taskId === 'string'
    && typeof o.runtime === 'string'
    && typeof o.overallScore === 'number'
    && typeof o.completionType === 'string'
    && Array.isArray(o.verificationResults);
}
