import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EvalResult } from '../types/eval.types.js';
import {
  SCORE_TOLERANCE,
  diffResults,
  findLatestBaselineDir,
  hasRegression,
  loadResults,
  recordBaseline,
  renderDiffMarkdown,
} from './baseline-diff.js';

/** The checked-in baseline, read relative to this test file. */
const REAL_BASELINES = resolve(__dirname, '../../baselines');

/** A result with `passed` checks out of `total`, scored `score`. */
function result(taskId: string, passed: number, total: number, score: number, extra: Partial<EvalResult> = {}): EvalResult {
  return {
    taskId,
    runtime: 'claude-code',
    startedAt: '2026-10-26T00:00:00.000Z',
    completedAt: '2026-10-26T00:01:00.000Z',
    durationSeconds: 60,
    completionType: 'agent_done',
    verificationResults: Array.from({ length: total }, (_, i) => ({ name: `c${i}`, passed: i < passed, output: '', exitCode: i < passed ? 0 : 1 })),
    scores: { d1Correctness: 0, d2CodeQuality: 0, d3Reasoning: 0, d4Autonomy: 0, d5ContextMgmt: 0, d6Collaboration: 0, d7CostEfficiency: 0 },
    overallScore: score,
    toolCallCount: 5,
    estimatedCostUsd: 0.01,
    logPath: `logs/${taskId}.log`,
    ...extra,
  };
}

const DIRS = { baselineDir: 'baselines/2026-04-01', currentDir: 'results' };

describe('diffResults', () => {
  it('regresses when fewer checks pass, whatever the score says', () => {
    const r = diffResults([result('A1', 2, 2, 60)], [result('A1', 1, 2, 90)], DIRS);
    expect(r.tasksCompared).toBe(1);
    expect(r.rows[0].verdict).toBe('regressed');
    expect(r.rows[0].reason).toBe('checks 2/2 → 1/2');
    expect(hasRegression(r)).toBe(true);
  });

  it('regresses when a completed task now times out or errors', () => {
    const r = diffResults([result('A1', 1, 1, 80)], [result('A1', 1, 1, 80, { completionType: 'timeout' })], DIRS);
    expect(r.rows[0].verdict).toBe('regressed');
    expect(r.rows[0].reason).toBe('completion agent_done → timeout');
  });

  it('improves when more checks pass or completion comes back', () => {
    expect(diffResults([result('A1', 0, 2, 20)], [result('A1', 2, 2, 20)], DIRS).rows[0].verdict).toBe('improved');
    expect(
      diffResults([result('A1', 1, 1, 50, { completionType: 'error' })], [result('A1', 1, 1, 50)], DIRS).rows[0].verdict,
    ).toBe('improved');
  });

  it('treats a score move within the tolerance as unchanged, beyond it as a change', () => {
    const base = [result('A1', 1, 1, 80)];
    expect(diffResults(base, [result('A1', 1, 1, 80 - SCORE_TOLERANCE)], DIRS).rows[0].verdict).toBe('unchanged');
    expect(diffResults(base, [result('A1', 1, 1, 80 - SCORE_TOLERANCE - 1)], DIRS).rows[0].verdict).toBe('regressed');
    expect(diffResults(base, [result('A1', 1, 1, 80 + SCORE_TOLERANCE + 1)], DIRS).rows[0].verdict).toBe('improved');
    expect(hasRegression(diffResults(base, [result('A1', 1, 1, 78)], DIRS))).toBe(false);
  });

  it('marks tasks only on one side as missing or new and does not count them as compared', () => {
    const r = diffResults([result('A1', 1, 1, 80), result('B1', 1, 1, 80)], [result('B1', 1, 1, 80), result('C1', 1, 1, 80)], DIRS);
    expect(r.tasksCompared).toBe(1);
    expect(r.tasksMissing).toBe(1);
    expect(r.tasksNew).toBe(1);
    expect(r.rows.map((x) => [x.taskId, x.verdict])).toEqual([['A1', 'missing'], ['B1', 'unchanged'], ['C1', 'new']]);
    expect(hasRegression(r)).toBe(false);
  });

  it('keeps runtimes apart: the same task on two runtimes is two rows', () => {
    const r = diffResults(
      [result('A1', 1, 1, 80), result('A1', 1, 1, 80, { runtime: 'codex-cli' })],
      [result('A1', 1, 1, 80), result('A1', 0, 1, 80, { runtime: 'codex-cli' })],
      DIRS,
    );
    expect(r.tasksCompared).toBe(2);
    expect(r.rows.map((x) => x.verdict)).toEqual(['unchanged', 'regressed']);
  });
});

describe('the not-yet set in a diff', () => {
  it('names a flagged task whose current run passes every check', () => {
    const r = diffResults([], [result('Z9', 2, 2, 70), result('A1', 1, 2, 50)], DIRS, { notYetIds: ['Z9', 'A1'] });
    expect(r.notYetNowPassing).toEqual(['Z9']);
    expect(renderDiffMarkdown(r)).toContain('Not-yet tasks now passing every check: Z9.');
  });

  it('does not promote a timed-out run, a partial pass, or an unflagged task', () => {
    const cur = [result('Z9', 2, 2, 70, { completionType: 'timeout' }), result('Z8', 1, 2, 50), result('A1', 2, 2, 90)];
    const r = diffResults([], cur, DIRS, { notYetIds: ['Z9', 'Z8'] });
    expect(r.notYetNowPassing).toEqual([]);
    expect(renderDiffMarkdown(r)).not.toContain('Not-yet tasks');
  });

  it('defaults to an empty set', () => {
    expect(diffResults([], [result('A1', 1, 1, 80)], DIRS).notYetNowPassing).toEqual([]);
  });
});

describe('renderDiffMarkdown', () => {
  it('puts the task count in the first line and one row per task', () => {
    const md = renderDiffMarkdown(diffResults([result('A1', 2, 2, 81), result('B1', 1, 2, 60)], [result('A1', 2, 2, 82), result('B1', 0, 2, 40)], DIRS));
    const lines = md.split('\n');
    expect(lines[0]).toBe('# Eval diff: 2 task(s) compared');
    expect(lines[3]).toContain('1 regressed, 0 improved, 1 unchanged, 0 not re-run, 0 new');
    expect(md).toContain('| A1 | claude-code | • unchanged | 2/2 → 2/2 | 81 → 82 |');
    expect(md).toContain('| B1 | claude-code | ❌ regressed | 1/2 → 0/2 | 60 → 40 |');
  });

  it('says so when nothing could be compared', () => {
    const md = renderDiffMarkdown(diffResults([], [result('A1', 1, 1, 80)], DIRS));
    expect(md).toContain('# Eval diff: 0 task(s) compared');
    expect(md).toContain('nothing was compared');
  });
});

describe('the checked-in baseline', () => {
  it('is found as the latest and loads three tasks per runtime', async () => {
    const dir = await findLatestBaselineDir(REAL_BASELINES);
    expect(dir).not.toBeNull();
    expect(dir!.endsWith('2026-04-01') || /\d{4}-\d{2}-\d{2}$/.test(dir!)).toBe(true);
    const claude = await loadResults(dir!, 'claude-code');
    expect(claude.map((r) => r.taskId)).toEqual(['A1', 'B1', 'C1']);
    const all = await loadResults(dir!);
    expect(all.length).toBe(12); // 3 tasks × 4 runtimes
    // A run that re-plays the baseline against itself is all unchanged.
    const self = diffResults(all, all, { baselineDir: dir!, currentDir: dir! });
    expect(self.tasksCompared).toBe(12);
    expect(self.rows.every((r) => r.verdict === 'unchanged')).toBe(true);
  });
});

describe('on disk', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'eval-diff-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('loadResults keeps the newest file per task and ignores stray JSON', async () => {
    const results = join(tmp, 'results');
    await mkdir(join(results, 'logs'), { recursive: true });
    await writeFile(join(results, 'A1-claude-code-100.json'), JSON.stringify(result('A1', 0, 1, 10)));
    await writeFile(join(results, 'A1-claude-code-200.json'), JSON.stringify(result('A1', 1, 1, 90)));
    await writeFile(join(results, 'notes.json'), '{"hello":"world"}');
    await writeFile(join(results, 'B1-claude-code-300.json'), 'not json');
    const loaded = await loadResults(results);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].overallScore).toBe(90);
    expect(loaded[0].sourceFile).toBe(join(results, 'A1-claude-code-200.json'));
  });

  it('findLatestBaselineDir picks the newest date and ignores other folders', async () => {
    const root = join(tmp, 'baselines');
    for (const d of ['2026-04-01', '2026-10-26', 'scratch']) await mkdir(join(root, d), { recursive: true });
    expect(await findLatestBaselineDir(root)).toBe(join(root, '2026-10-26'));
    expect(await findLatestBaselineDir(join(tmp, 'nope'))).toBeNull();
  });

  it('recordBaseline copies the newest results into baselines/<date>/<runtime>/ with eval-relative log paths', async () => {
    const evalRoot = tmp;
    const results = join(evalRoot, 'results');
    await mkdir(results, { recursive: true });
    const absLog = join(evalRoot, 'results', 'logs', 'A1.log');
    await writeFile(join(results, 'A1-claude-code-100.json'), JSON.stringify(result('A1', 1, 1, 50, { logPath: absLog })));
    await writeFile(join(results, 'A1-claude-code-200.json'), JSON.stringify(result('A1', 1, 1, 80, { logPath: absLog })));
    await writeFile(join(results, 'A1-codex-cli-200.json'), JSON.stringify(result('A1', 1, 1, 70, { runtime: 'codex-cli', logPath: '/elsewhere/A1.log' })));
    await writeFile(join(results, 'eval-report-200.md'), '# report');

    const written = await recordBaseline(results, join(evalRoot, 'baselines'), '2026-10-26', evalRoot);
    expect(written.filter((f) => f.endsWith('.json'))).toHaveLength(2);
    const copied = JSON.parse(await readFile(join(evalRoot, 'baselines', '2026-10-26', 'claude-code', 'A1-claude-code-200.json'), 'utf-8')) as EvalResult;
    expect(copied.overallScore).toBe(80);
    expect(copied.logPath).toBe('eval/results/logs/A1.log');
    expect('sourceFile' in copied).toBe(false);
    const codex = JSON.parse(await readFile(join(evalRoot, 'baselines', '2026-10-26', 'codex-cli', 'A1-codex-cli-200.json'), 'utf-8')) as EvalResult;
    expect(codex.logPath).toBe('/elsewhere/A1.log'); // outside the package: left alone
    expect(written.filter((f) => f.endsWith('eval-report-200.md'))).toHaveLength(2);
    expect(await findLatestBaselineDir(join(evalRoot, 'baselines'))).toBe(join(evalRoot, 'baselines', '2026-10-26'));
  });

  it('recordBaseline refuses a bad date or an empty results dir', async () => {
    await expect(recordBaseline(tmp, join(tmp, 'b'), 'today', tmp)).rejects.toThrow('YYYY-MM-DD');
    await expect(recordBaseline(join(tmp, 'empty'), join(tmp, 'b'), '2026-10-26', tmp)).rejects.toThrow('No results');
  });
});
