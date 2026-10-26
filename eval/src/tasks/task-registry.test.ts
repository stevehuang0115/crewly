/**
 * Task registry tests.
 *
 * Every task's fixture must exist, and every business task's checker must
 * reject the bare fixture and accept the reference solution in
 * `solutions/<task>/`. That keeps the checkers honest: a checker that passes
 * an empty work directory, or rejects the solution we wrote for it, fails here
 * instead of in a paid run.
 */
import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ALL_TASKS, NOT_YET_TASKS, getTaskById, getTasksByCategory, selectTasks } from './task-registry.js';

const EVAL_ROOT = resolve(__dirname, '..', '..');

function runChecker(task: string, workDir: string): { status: number | null; output: string } {
  const checker = join(EVAL_ROOT, 'checks', task, 'check.mjs');
  const res = spawnSync('node', [checker], { cwd: workDir, encoding: 'utf8' });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

describe('task registry', () => {
  it('has unique ids and a fixture directory per task', () => {
    const ids = ALL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of ALL_TASKS) {
      expect(existsSync(join(EVAL_ROOT, t.repoPath)), `${t.id}: ${t.repoPath}`).toBe(true);
      expect(t.verification.length, `${t.id}: no verification`).toBeGreaterThan(0);
    }
  });

  it('looks tasks up by id and category', () => {
    expect(getTaskById('A1')?.category).toBe('bug_fix');
    expect(getTaskById('nope')).toBeUndefined();
    expect(getTasksByCategory('business').map((t) => t.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
  });

  it('labels every business task with where its pass condition came from', () => {
    for (const t of getTasksByCategory('business')) {
      expect(t.provenance, `${t.id}: provenance`).toBe('inferred');
      expect(t.setupCommands).toEqual([]);
      const [check] = t.verification;
      expect(check.name).toBe('checks');
      expect(check.expected).toBe('all_pass');
      const fixture = basename(t.repoPath);
      expect(check.command).toBe(`node ../../checks/${fixture}/check.mjs`);
      expect(existsSync(join(EVAL_ROOT, 'checks', fixture, 'check.mjs'))).toBe(true);
      expect(existsSync(join(EVAL_ROOT, 'solutions', fixture))).toBe(true);
    }
  });
});

describe.each(getTasksByCategory('business').map((t) => [t.id, basename(t.repoPath)] as const))(
  'business checker %s',
  (_id, fixture) => {
    it('fails on the bare fixture and passes with the reference solution', () => {
      const workDir = mkdtempSync(join(tmpdir(), `crewly-eval-${fixture}-`));
      try {
        cpSync(join(EVAL_ROOT, 'fixtures', fixture), workDir, { recursive: true });
        const bare = runChecker(fixture, workDir);
        expect(bare.status, `bare fixture should fail:\n${bare.output}`).not.toBe(0);
        expect(bare.output).toContain('FAIL');

        cpSync(join(EVAL_ROOT, 'solutions', fixture), workDir, { recursive: true });
        const solved = runChecker(fixture, workDir);
        expect(solved.status, `solution should pass:\n${solved.output}`).toBe(0);
        expect(solved.output).toContain('PASS');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  },
);

describe('the not-yet set', () => {
  it('is empty today and run --all equals the whole registry', () => {
    expect(NOT_YET_TASKS).toEqual([]);
    expect(selectTasks({ kind: 'all' })).toEqual(ALL_TASKS);
    expect(selectTasks({ kind: 'not_yet' })).toEqual([]);
  });

  it('selects by id regardless of the flag and drops unknown ids', () => {
    expect(selectTasks({ kind: 'ids', ids: ['D2', 'nope'] }).map((t) => t.id)).toEqual(['D2']);
  });

  it('every marked task carries a date and a reason', () => {
    for (const t of NOT_YET_TASKS) {
      expect(t.notYet?.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.notYet?.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
