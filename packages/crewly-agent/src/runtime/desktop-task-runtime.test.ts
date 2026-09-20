/**
 * Tests for the desktop task runtime.
 *
 * The rule these exist to hold: a subgoal is done when its checkpoint holds,
 * never when the agent says so. Every other behaviour here — budgets,
 * surprise handling, confirmation — is in service of a forty-step task not
 * ending in a confident, false report.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  beginTask, step, chooseRoute, needsConfirmation, awaitConfirmation,
  resolveConfirmation, summarize, activeSubgoal, DEFAULT_TASK_BUDGET,
  type Subgoal, type TaskState,
} from './desktop-task-runtime.js';
import type { Scene } from './desktop-recovery.js';

/** A plan of two subgoals, each checked against a file. */
function plan(): Subgoal[] {
  return [
    { id: 's1', goal: 'write the note', checkpoint: { kind: 'file-contains', path: '/tmp/a', text: 'ok' }, maxSteps: 3 },
    { id: 's2', goal: 'rename it', checkpoint: { kind: 'file-exists', path: '/tmp/b' }, maxSteps: 3 },
  ];
}

/** An empty screen — nothing surprising on it. */
const CALM: Scene = { elements: [] };

/** Checkpoint IO that answers from a fake filesystem. */
function fakeFs(files: Record<string, string>) {
  return {
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    },
    statFile: async (p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return { size: files[p]!.length };
    },
  };
}

describe('checkpoints decide, not the agent', () => {
  it('keeps the agent on a subgoal until the world matches, and says what is wrong', async () => {
    const state = beginTask('write and rename', plan());
    const files: Record<string, string> = {};

    // The agent has "done" the work, but the file is not there.
    const first = await step(state, CALM, fakeFs(files));
    expect(first.kind).toBe('continue');
    expect((first as { hint?: string }).hint).toContain('/tmp/a');
    expect(activeSubgoal(state)!.subgoal.id).toBe('s1');

    // Now it really is.
    files['/tmp/a'] = 'ok';
    const second = await step(state, CALM, fakeFs(files));
    expect(second.kind).toBe('advance');
    expect((second as { next: Subgoal }).next.id).toBe('s2');
  });

  it('calls an empty file out rather than passing it — that is the unfinished save', async () => {
    const state = beginTask('save', [
      { id: 's1', goal: 'save the file', checkpoint: { kind: 'file-exists', path: '/tmp/a' } },
    ]);
    const out = await step(state, CALM, fakeFs({ '/tmp/a': '' }));
    expect(out.kind).toBe('continue');
    expect((out as { hint?: string }).hint).toMatch(/empty|did not complete/i);
  });

  it('reports done only when every checkpoint held', async () => {
    const state = beginTask('write and rename', plan());
    const files = { '/tmp/a': 'ok', '/tmp/b': 'x' };
    expect((await step(state, CALM, fakeFs(files))).kind).toBe('advance');
    expect((await step(state, CALM, fakeFs(files))).kind).toBe('done');
    expect(summarize(state)).toContain('2/2 verified');
  });

  it('escalates a subgoal that burns its budget, and does not move on', async () => {
    const state = beginTask('write', [
      { id: 's1', goal: 'write the note', checkpoint: { kind: 'file-exists', path: '/tmp/never' }, maxSteps: 2 },
      { id: 's2', goal: 'later work', checkpoint: { kind: 'file-exists', path: '/tmp/b' } },
    ]);
    expect((await step(state, CALM, fakeFs({}))).kind).toBe('continue');
    const out = await step(state, CALM, fakeFs({}));
    expect(out.kind).toBe('escalate');
    // The later subgoal assumed this one worked, so it must not start.
    expect(state.progress[1]!.state).toBe('pending');
    expect((out as { detail: string }).detail).toContain('later subgoals assume');
  });
});

describe('budgets', () => {
  it('stops on the step ceiling and says what got done', async () => {
    const state = beginTask('long task', plan(), { ...DEFAULT_TASK_BUDGET, maxSteps: 1 });
    await step(state, CALM, fakeFs({}));
    const out = await step(state, CALM, fakeFs({}));
    expect(out.kind).toBe('budget-exhausted');
    expect((out as { remaining: string[] }).remaining).toContain('write the note');
  });

  it('stops on the clock', async () => {
    let clock = 1_000;
    const state = beginTask('slow task', plan(), { ...DEFAULT_TASK_BUDGET, maxDurationMs: 100 }, () => clock);
    clock += 500;
    const out = await step(state, CALM, fakeFs({}), () => clock);
    expect(out.kind).toBe('budget-exhausted');
    expect((out as { reason: string }).reason).toMatch(/longer than/);
  });
});

describe('surprises', () => {
  const dialog: Scene = {
    elements: [
      { role: 'AXSheet', name: 'Save changes?' },
      { role: 'AXButton', name: 'Save' },
      { role: 'AXButton', name: "Don't Save" },
      { role: 'AXButton', name: 'Cancel' },
    ],
  };

  it('does not test the checkpoint while a dialog is covering the window', async () => {
    const state = beginTask('edit', plan());
    const checkpoint = vi.fn();
    const out = await step(state, dialog, { statFile: checkpoint as never });
    expect(out.kind).toBe('continue');
    // Testing it now would be testing the wrong world.
    expect(checkpoint).not.toHaveBeenCalled();
    expect((out as { hint?: string }).hint).toContain("Don't Save");
  });

  it('gives up on a surprise that keeps coming back instead of looping', async () => {
    const state = beginTask('edit', plan());
    let out = await step(state, dialog, {});
    out = await step(state, dialog, {});
    out = await step(state, dialog, {});
    out = await step(state, dialog, {});
    expect(out.kind).toBe('escalate');
    expect((out as { detail: string }).detail).toMatch(/three times/);
  });

  it('never tries to answer a permission prompt on the owner\'s behalf', async () => {
    const state = beginTask('open', plan());
    const prompt: Scene = {
      elements: [
        { role: 'AXSheet', name: 'Terminal would like to access your Documents' },
        { role: 'AXButton', name: 'Allow' },
      ],
    };
    const out = await step(state, prompt, {});
    expect(out.kind).toBe('escalate');
    expect((out as { detail: string }).detail).toMatch(/their decision|owner/i);
  });

  it('stops at a login wall rather than typing credentials', async () => {
    const state = beginTask('open', plan());
    const out = await step(state, { elements: [{ role: 'AXStaticText', name: 'Sign in to continue' }] }, {});
    expect(out.kind).toBe('escalate');
    expect((out as { reason: string }).reason).toBe('login-required');
  });

  it('notices focus moving to another app and says the refs are stale', async () => {
    const state = beginTask('work in TextEdit', [
      { id: 's1', goal: 'type', checkpoint: { kind: 'app-frontmost', app: 'TextEdit' } },
    ]);
    const out = await step(state, { app: 'Safari', elements: [] }, {});
    expect(out.kind).toBe('continue');
    expect((out as { hint?: string }).hint).toMatch(/stale/);
  });
});

describe('routing', () => {
  it('prefers a skill over the screen when one exists', () => {
    const out = chooseRoute('send the summary by email', ['gmail-send']);
    expect(out.route).toBe('skill');
    expect(out.candidate).toBe('gmail-send');
  });

  it('falls back to the screen when the skill is not installed', () => {
    expect(chooseRoute('send the summary by email', []).route).toBe('element');
  });

  it('uses the browser for a page and pixels for a canvas', () => {
    expect(chooseRoute('open https://example.com and read it').route).toBe('browser');
    expect(chooseRoute('draw a line on the canvas').route).toBe('pixel');
  });

  it('hands credentials to a person', () => {
    expect(chooseRoute('log in with the password').route).toBe('human');
  });

  it('defaults to elements, not coordinates', () => {
    const out = chooseRoute('rename the file in Finder');
    expect(out.route).toBe('element');
    expect(out.because).toMatch(/cannot miss/);
  });
});

describe('irreversible actions', () => {
  it('spots the ones that cannot be undone, in either language', () => {
    for (const action of ['click the Send button', 'delete the folder', 'publish the post', '发送邮件', '删除文件']) {
      expect(needsConfirmation(action).required, action).toBe(true);
    }
  });

  it('does not stop ordinary work', () => {
    // "sender" contains "send" but is not it — the word boundary is the point.
    for (const action of ['open the document', 'read the second row', 'check the sender name']) {
      expect(needsConfirmation(action).required, action).toBe(false);
    }
  });

  it('holds the task until the owner answers, doing nothing meanwhile', async () => {
    const state = beginTask('send it', plan());
    awaitConfirmation(state, 'click Send on the email');
    const out = await step(state, CALM, fakeFs({ '/tmp/a': 'ok' }));
    // Even though the checkpoint would now pass, nothing moves.
    expect(out.kind).toBe('await-confirmation');
    expect(activeSubgoal(state)!.subgoal.id).toBe('s1');
  });

  it('carries on when approved', () => {
    const state = beginTask('send it', plan());
    awaitConfirmation(state, 'click Send');
    const out = resolveConfirmation(state, true);
    expect(out.kind).toBe('continue');
    expect(state.awaitingConfirmation).toBeUndefined();
  });

  it('stops for good when declined, and forbids working around it', () => {
    const state = beginTask('send it', plan());
    awaitConfirmation(state, 'click Send');
    const out = resolveConfirmation(state, false);
    expect(out.kind).toBe('escalate');
    expect((out as { detail: string }).detail).toMatch(/do not look for another way/i);
    expect(state.progress[0]!.state).toBe('skipped');
  });
});

describe('summary', () => {
  it('names a stuck subgoal as stuck rather than rounding up', async () => {
    const state: TaskState = beginTask('two things', plan());
    await step(state, CALM, fakeFs({ '/tmp/a': 'ok' }));   // s1 done
    state.progress[1]!.state = 'stuck';
    state.progress[1]!.blockedBy = 'the dialog never closed';
    const text = summarize(state);
    expect(text).toContain('1/2 verified');
    expect(text).toContain('✓ write the note');
    expect(text).toContain('✗ rename it');
    expect(text).toContain('the dialog never closed');
  });
});
