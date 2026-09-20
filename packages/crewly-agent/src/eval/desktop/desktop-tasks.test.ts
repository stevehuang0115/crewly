/**
 * Tests for the desktop evaluation tasks.
 *
 * These check the tasks themselves, not an agent: a benchmark whose setup is
 * broken, whose verify always passes, or which leaves files on the machine
 * reports nonsense and is worse than having none.
 */

import { describe, it, expect } from 'vitest';
import { DESKTOP_TASKS, DESKTOP_EVAL_DIR, getDesktopTaskById, desktopTasksUpTo } from './desktop-tasks.js';

describe('desktop task set', () => {
  it('has unique ids and covers every skill', () => {
    const ids = DESKTOP_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const skills = new Set(DESKTOP_TASKS.map((t) => t.skill));
    for (const skill of ['perception', 'element-action', 'coordinate-action', 'cross-app', 'recovery']) {
      expect(skills).toContain(skill);
    }
  });

  it('spans easy to hard, so a weak model has something it can clear', () => {
    const tiers = DESKTOP_TASKS.map((t) => t.tier);
    expect(tiers).toContain('basic');
    expect(tiers).toContain('intermediate');
    expect(tiers).toContain('hard');
  });

  it('gives every task a prompt, a verify and a step budget', () => {
    for (const task of DESKTOP_TASKS) {
      expect(task.prompt.length).toBeGreaterThan(30);
      expect(task.verify.trim()).not.toBe('');
      expect(task.budgetSteps).toBeGreaterThan(0);
    }
  });

  it('checks the world, not the agent\'s account of it, wherever an outcome exists', () => {
    // The failure being measured is "it said it saved the file". Any task
    // that produces a file must therefore look at that file.
    const producesFile = ['textedit-write-save', 'rename-in-finder', 'copy-between-apps', 'handle-dialog'];
    for (const id of producesFile) {
      const task = getDesktopTaskById(id)!;
      expect(task.verify).not.toBe('true');
      expect(task.verify).toContain(DESKTOP_EVAL_DIR);
    }
  });

  it('cleans up every file it creates', () => {
    for (const task of DESKTOP_TASKS) {
      if (!task.setup) continue;
      // Anything written into the eval dir has to be removed again, or the
      // next run starts from a dirty machine and scores the leftovers.
      const writesFiles = /echo .*>|\.save\(|: >/.test(task.setup);
      if (writesFiles) {
        expect(task.teardown ?? '', `${task.id} leaves files behind`).toContain('rm -f');
      }
    }
  });

  it('never touches anything outside the scratch directory', () => {
    for (const task of DESKTOP_TASKS) {
      for (const script of [task.setup, task.verify, task.teardown]) {
        if (!script) continue;
        // A stray rm outside /tmp would be run on a real machine.
        const removals = script.match(/rm -f ([^;|&]+)/g) ?? [];
        for (const removal of removals) {
          expect(removal, `${task.id}: ${removal}`).toContain(DESKTOP_EVAL_DIR);
        }
      }
    }
  });

  it('quits any app it opened, so the next task starts clean', () => {
    for (const task of DESKTOP_TASKS) {
      if (!/Open (TextEdit|Preview)/i.test(task.prompt)) continue;
      expect(task.teardown ?? '', `${task.id} leaves an app open`).toMatch(/quit saving no/);
    }
  });

  it('scores routing around a safety rail as a failure, not resourcefulness', () => {
    const task = getDesktopTaskById('refuse-destructive')!;
    expect(task.verify).toContain('pgrep -x Finder');
    expect(task.prompt).toMatch(/do not look for another way/i);
  });

  it('selects by tier so a weak model is not run against the hard set', () => {
    expect(desktopTasksUpTo('basic').every((t) => t.tier === 'basic')).toBe(true);
    expect(desktopTasksUpTo('intermediate').some((t) => t.tier === 'basic')).toBe(true);
    expect(desktopTasksUpTo('hard')).toHaveLength(DESKTOP_TASKS.length);
  });

  it('finds one by id', () => {
    expect(getDesktopTaskById('textedit-write-save')?.tier).toBe('intermediate');
    expect(getDesktopTaskById('nope')).toBeUndefined();
  });
});
