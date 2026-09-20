/**
 * Tests for the `desktop_task` tool.
 *
 * Phase 4 built the machinery; this is what connects it, and the connection
 * is where it can be got wrong. The property under test throughout: an agent
 * cannot mark its own work done, and a turn that ends with unverified work
 * says so.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDesktopTaskTool, resetDesktopTasks, answerDesktopConfirmation, unverifiedDesktopWork,
} from './desktop-task.tool.js';

const SESSION = 'test-agent';

/** A perceive stub backed by a scriptable scene. */
function perceiver(scene: Record<string, unknown> = { success: true, app: 'TextEdit', elements: [] }) {
  return vi.fn(async () => scene);
}

/** A two-subgoal plan checked against shell commands we control. */
function plan(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'plan' as const,
    goal: 'write and check a file',
    subgoals: [
      { goal: 'write the note', checkpoint: { kind: 'shell' as const, command: 'test -f /tmp/crewly-tt-a' } },
      { goal: 'clean up', checkpoint: { kind: 'file-absent' as const, path: '/tmp/crewly-tt-a' } },
    ],
    ...overrides,
  };
}

describe('planning', () => {
  beforeEach(resetDesktopTasks);

  it('refuses a plan with no subgoals — a task with no checkpoints proves nothing', async () => {
    const tool = createDesktopTaskTool(SESSION);
    expect(await tool.execute({ operation: 'plan', goal: 'do it' })).toMatchObject({ reason: 'validation' });
  });

  it('advises a route per subgoal, while it can still change what the agent does', async () => {
    const tool = createDesktopTaskTool(SESSION, { availableSkills: ['gmail-send'] });
    const out = (await tool.execute({
      operation: 'plan',
      goal: 'summarise and send',
      subgoals: [
        { goal: 'read the report in Preview', checkpoint: { kind: 'app-frontmost', app: 'Preview' } },
        { goal: 'send it by email', checkpoint: { kind: 'shell', command: 'true' } },
      ],
    })) as { routes: Array<Record<string, unknown>> };
    // The point of routing: not opening Mail.app for something a skill does.
    expect(out.routes[1]).toMatchObject({ route: 'skill', use: 'gmail-send' });
  });

  it('will not step before a plan exists', async () => {
    const tool = createDesktopTaskTool(SESSION);
    expect(await tool.execute({ operation: 'step' })).toMatchObject({ reason: 'no_task' });
  });
});

describe('the agent cannot declare itself done', () => {
  beforeEach(resetDesktopTasks);

  it('holds the subgoal until the checkpoint holds, and says what is wrong', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute(plan());

    const first = (await tool.execute({ operation: 'step' })) as Record<string, unknown>;
    expect(first['directive']).toBe('continue');
    expect(String(first['hint'])).toContain('test -f');

    // Now make it true.
    const { writeFileSync, unlinkSync } = await import('fs');
    writeFileSync('/tmp/crewly-tt-a', 'x');
    try {
      const second = (await tool.execute({ operation: 'step' })) as Record<string, unknown>;
      expect(second['directive']).toBe('advance');
      expect(second['verified']).toBe('write the note');
    } finally {
      unlinkSync('/tmp/crewly-tt-a');
    }
  });

  it('reports outstanding work as unverified rather than rounding it up', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute(plan());
    const out = (await tool.execute({ operation: 'summary' })) as Record<string, unknown>;
    expect(out['complete']).toBe(false);
    expect(out['unverified']).toEqual(['write the note', 'clean up']);
  });

  it('makes the whole turn incomplete while a subgoal is unverified', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute(plan());
    // This is what the runner asks before letting a reply go out. A model
    // that stopped because it believed it was finished is exactly the case.
    const outstanding = unverifiedDesktopWork(SESSION);
    expect(outstanding?.goals).toContain('write the note');
  });

  it('reports nothing outstanding once every checkpoint held', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute({
      operation: 'plan',
      goal: 'trivial',
      subgoals: [{ goal: 'nothing to do', checkpoint: { kind: 'shell', command: 'true' } }],
    });
    await tool.execute({ operation: 'step' });
    expect(unverifiedDesktopWork(SESSION)).toBeNull();
  });

  it('knows nothing about a session that never planned anything', () => {
    expect(unverifiedDesktopWork('never-planned')).toBeNull();
  });
});

describe('irreversible actions', () => {
  beforeEach(resetDesktopTasks);

  it('sends one to the owner and tells the agent to stop, workarounds included', async () => {
    const enqueue = vi.fn(() => ({ id: 'ap-1' }) as never);
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver(), approvals: { enqueue } });
    await tool.execute(plan());

    const out = (await tool.execute({ operation: 'confirm', action: 'click Send on the email' })) as Record<string, unknown>;
    expect(out).toMatchObject({ required: true, approvalId: 'ap-1' });
    expect(String(out['message'])).toMatch(/not a workaround/i);
    expect(enqueue).toHaveBeenCalledWith(SESSION, 'desktop_task', 'destructive', expect.objectContaining({
      action: 'click Send on the email',
    }));
  });

  it('holds every later step until the owner answers', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute({
      operation: 'plan', goal: 'send it',
      // A checkpoint that would pass immediately, to prove the wait wins.
      subgoals: [{ goal: 'send', checkpoint: { kind: 'shell', command: 'true' } }],
    });
    await tool.execute({ operation: 'confirm', action: 'delete the folder' });
    const out = (await tool.execute({ operation: 'step' })) as Record<string, unknown>;
    expect(out['directive']).toBe('await-confirmation');
  });

  it('says so plainly when something is reversible, instead of asking anyway', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute(plan());
    const out = (await tool.execute({ operation: 'confirm', action: 'open the document' })) as Record<string, unknown>;
    // An agent that asks about everything learns nothing about where the line is.
    expect(out).toMatchObject({ required: false });
  });

  it('carries on when the owner approves', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute(plan());
    await tool.execute({ operation: 'confirm', action: 'publish the post' });
    const out = answerDesktopConfirmation(SESSION, true);
    expect(out).toMatchObject({ directive: 'continue' });
  });

  it('stops for good when the owner declines', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute(plan());
    await tool.execute({ operation: 'confirm', action: 'publish the post' });
    const out = answerDesktopConfirmation(SESSION, false) as Record<string, unknown>;
    expect(out['directive']).toBe('escalate');
    expect(String(out['message'])).toMatch(/do not look for another way/i);
  });

  it('answers nothing when nothing was waiting', () => {
    expect(answerDesktopConfirmation('idle-session', true)).toBeNull();
  });
});

describe('surprises reach the agent', () => {
  beforeEach(resetDesktopTasks);

  it('passes the dialog instruction through instead of testing the checkpoint', async () => {
    const perceive = perceiver({
      success: true, app: 'TextEdit',
      elements: [
        { role: 'AXSheet', name: 'Save changes?' },
        { role: 'AXButton', name: "Don't Save" },
      ],
    });
    const tool = createDesktopTaskTool(SESSION, { perceive });
    await tool.execute(plan());
    const out = (await tool.execute({ operation: 'step' })) as Record<string, unknown>;
    expect(out['directive']).toBe('continue');
    expect(String(out['hint'])).toContain("Don't Save");
  });

  it('treats a failed snapshot as an empty scene rather than crashing the step', async () => {
    const perceive = vi.fn(async () => ({ success: false, reason: 'screen_locked', message: 'locked' }));
    const tool = createDesktopTaskTool(SESSION, { perceive });
    await tool.execute(plan());
    const out = (await tool.execute({ operation: 'step' })) as Record<string, unknown>;
    // screen_locked is a surprise the runtime knows, and it needs a person.
    expect(out['directive']).toBe('escalate');
    expect(out['reason']).toBe('screen-locked');
  });
});

describe('abandoning', () => {
  beforeEach(resetDesktopTasks);

  it('drops the task but still hands back what was and was not done', async () => {
    const tool = createDesktopTaskTool(SESSION, { perceive: perceiver() });
    await tool.execute(plan());
    const out = (await tool.execute({ operation: 'abandon', reason: 'the app is not installed' })) as Record<string, unknown>;
    expect(String(out['message'])).toContain('the app is not installed');
    expect(out['summary']).toContain('write the note');
    // And the turn is no longer held open by a task nobody is working on.
    expect(unverifiedDesktopWork(SESSION)).toBeNull();
  });
});
