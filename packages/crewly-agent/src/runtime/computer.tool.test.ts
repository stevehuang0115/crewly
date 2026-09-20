/**
 * Tests for the `computer` tool.
 *
 * Two things matter most here. The coordinate conversion: the model points at
 * a 1280-wide screenshot and the click has to land on the real screen, so an
 * off-by-a-factor here misses every button. And the routing: every action
 * must go through the computer-use skill, because that is where the safety
 * rails live — a shortcut straight to the mouse would be a second
 * implementation with no rails on it.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createComputerTool,
  parseSkillOutput,
  scaleFor,
  toScreen,
  toSkillInput,
} from './computer.tool.js';

/** A 1728×1117 Retina Mac — the machine this was written on. */
const MACBOOK = [{ frame: [0, 0, 1728, 1117] as [number, number, number, number], scale: 2, main: true }];

/** Capture what the tool asks the skill to do. */
function recorder(responses: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const runSkill = vi.fn(async (input: Record<string, unknown>) => {
    calls.push(input);
    const action = String(input['action']);
    if (action === 'displays') return JSON.stringify({ success: true, displays: MACBOOK });
    if (action === 'screenshot') return JSON.stringify({ action: 'screenshot', path: '/tmp/shot.png', width: 1280, height: 827 });
    return JSON.stringify(responses[action] ?? { success: true, action });
  });
  const readImage = vi.fn(async () => ({ data: 'aGVsbG8=', bytes: 5 }));
  return { calls, runSkill, readImage };
}

describe('scaleFor', () => {
  it('scales a wide screen down to the width the model reasons in', () => {
    const out = scaleFor(MACBOOK);
    expect(out.width).toBe(1280);
    expect(out.factor).toBeCloseTo(1728 / 1280, 5);
    expect(out.screen).toEqual([1728, 1117]);
    // Aspect ratio is kept, or the model's vertical aim would be off.
    expect(out.height).toBe(Math.round(1117 / out.factor));
  });

  it('never enlarges a screen that is already narrow', () => {
    const out = scaleFor([{ frame: [0, 0, 1024, 768], scale: 1, main: true }]);
    expect(out.factor).toBe(1);
    expect(out.width).toBe(1024);
  });

  it('falls back to something usable when no display is reported', () => {
    expect(scaleFor([]).factor).toBeGreaterThan(0);
  });

  it('prefers the main display when several are attached', () => {
    const out = scaleFor([
      { frame: [0, 0, 3840, 2160], scale: 2, main: false },
      { frame: [0, 0, 1440, 900], scale: 2, main: true },
    ]);
    expect(out.screen).toEqual([1440, 900]);
  });
});

describe('toScreen', () => {
  it('maps a model coordinate onto the real screen', () => {
    const { factor } = scaleFor(MACBOOK);
    // Middle of the model's view is the middle of the screen.
    expect(toScreen(640, factor)).toBe(864);
    expect(toScreen(0, factor)).toBe(0);
    expect(toScreen(1280, factor)).toBe(1728);
  });
});

describe('toSkillInput', () => {
  const factor = 1728 / 1280;

  it('converts a click into screen points', () => {
    expect(toSkillInput({ action: 'left_click', coordinate: [640, 400] }, factor)).toEqual({
      action: 'click', x: 864, y: 540, button: 'left',
    });
  });

  it('maps the three click flavours onto the skill button names', () => {
    expect(toSkillInput({ action: 'right_click', coordinate: [10, 10] }, 1)).toMatchObject({ button: 'right' });
    expect(toSkillInput({ action: 'double_click', coordinate: [10, 10] }, 1)).toMatchObject({ button: 'double' });
  });

  it('converts both ends of a drag', () => {
    expect(toSkillInput({ action: 'left_click_drag', start_coordinate: [100, 100], coordinate: [200, 200] }, 2))
      .toEqual({ action: 'drag', fromX: 200, fromY: 200, toX: 400, toY: 400 });
  });

  it('says plainly when an action is not supported instead of doing something else', () => {
    // A model told "not supported" picks another route; one told "done"
    // builds on a click that never happened.
    expect(toSkillInput({ action: 'middle_click', coordinate: [1, 1] }, 1)).toMatchObject({ error: expect.stringContaining('not supported') });
    expect(toSkillInput({ action: 'triple_click', coordinate: [1, 1] }, 1)).toMatchObject({ error: expect.stringContaining('not supported') });
  });

  it('refuses an action whose arguments are missing, naming what it needs', () => {
    expect(toSkillInput({ action: 'left_click' }, 1)).toMatchObject({ error: expect.stringContaining('coordinate') });
    expect(toSkillInput({ action: 'key' }, 1)).toMatchObject({ error: expect.stringContaining('text') });
    expect(toSkillInput({ action: 'click_ref' }, 1)).toMatchObject({ error: expect.stringContaining('ref') });
    expect(toSkillInput({ action: 'fill_ref', ref: '@e1' }, 1)).toMatchObject({ error: expect.stringContaining('text') });
    expect(toSkillInput({ action: 'wait_for' }, 1)).toMatchObject({ error: expect.stringContaining('app') });
  });

  it('passes element actions through by ref, with no coordinates involved', () => {
    expect(toSkillInput({ action: 'click_ref', ref: '@e12' }, 99)).toEqual({ action: 'click-ref', ref: '@e12' });
    expect(toSkillInput({ action: 'fill_ref', ref: '@e7', text: 'hi' }, 99)).toEqual({ action: 'fill-ref', ref: '@e7', text: 'hi' });
  });

  it('turns `wait` into waiting for the screen to settle', () => {
    expect(toSkillInput({ action: 'wait', duration: 2.5 }, 1)).toEqual({ action: 'wait-for', idle: true, timeoutMs: 2500 });
  });

  it('defaults a scroll rather than refusing it', () => {
    expect(toSkillInput({ action: 'scroll', coordinate: [100, 100] }, 1))
      .toMatchObject({ action: 'scroll', direction: 'down', amount: 3 });
  });
});

describe('parseSkillOutput', () => {
  it('reads the JSON line even when a shell warning came first', () => {
    const raw = '{"warning":"CREWLY_SESSION_NAME is not set"}\n{"success":true,"action":"click"}';
    expect(parseSkillOutput(raw)).toEqual({ success: true, action: 'click' });
  });

  it('reads jq pretty-printed output, which spans lines', () => {
    expect(parseSkillOutput('{\n  "success": false,\n  "reason": "screen_locked"\n}'))
      .toEqual({ success: false, reason: 'screen_locked' });
  });

  it('describes the failure rather than throwing when there is no JSON', () => {
    expect(parseSkillOutput('bash: command not found')).toMatchObject({ success: false, reason: 'unparsable' });
    expect(parseSkillOutput('')).toMatchObject({ success: false, reason: 'unparsable' });
  });
});

describe('computer tool', () => {
  it('routes every action through the skill rather than touching the mouse itself', async () => {
    const { calls, runSkill, readImage } = recorder();
    const tool = createComputerTool({ runSkill, readImage });
    await tool.execute({ action: 'left_click', coordinate: [640, 400] });
    // displays (to learn the scale), the click, then the screenshot.
    expect(calls.map((c) => c['action'])).toEqual(['displays', 'click', 'screenshot']);
    expect(calls[1]).toMatchObject({ x: 864, y: 540 });
  });

  it('returns the new screenshot with the action, so one call shows its own result', async () => {
    const { runSkill, readImage } = recorder();
    const tool = createComputerTool({ runSkill, readImage });
    const out = (await tool.execute({ action: 'left_click', coordinate: [10, 10] })) as Record<string, unknown>;
    expect(out['type']).toBe('image');
    expect(out['data']).toBe('aGVsbG8=');
    expect(out['screen']).toMatchObject({ width: 1280 });
    expect(String(out['note'])).toContain('1280');
  });

  it('asks for the screenshot at the width the model is told to use', async () => {
    const { calls, runSkill, readImage } = recorder();
    const tool = createComputerTool({ runSkill, readImage });
    await tool.execute({ action: 'screenshot' });
    const shot = calls.find((c) => c['action'] === 'screenshot');
    // Without this the image and the coordinate space drift apart and every
    // click lands somewhere else.
    expect(shot).toMatchObject({ maxWidth: 1280 });
  });

  it('does not take a screenshot after an action that changed nothing', async () => {
    const { calls, runSkill, readImage } = recorder({ snapshot: { success: true, elements: [] } });
    const tool = createComputerTool({ runSkill, readImage });
    await tool.execute({ action: 'snapshot', app: 'Finder' });
    expect(calls.map((c) => c['action'])).toEqual(['displays', 'snapshot']);
  });

  it('passes a rail refusal straight back, with no screenshot over it', async () => {
    const refusal = { success: false, reason: 'screen_locked', message: 'The screen is locked.' };
    const { calls, runSkill, readImage } = recorder({ click: refusal });
    const tool = createComputerTool({ runSkill, readImage });
    const out = (await tool.execute({ action: 'left_click', coordinate: [1, 1] })) as Record<string, unknown>;
    // The rails phrase their own reasons; a screenshot of a screen it could
    // not act on adds nothing.
    expect(out).toMatchObject({ reason: 'screen_locked' });
    expect(out['type']).toBeUndefined();
    expect(calls.some((c) => c['action'] === 'screenshot')).toBe(false);
  });

  it('refuses bad arguments before running anything', async () => {
    const { calls, runSkill, readImage } = recorder();
    const tool = createComputerTool({ runSkill, readImage });
    const out = (await tool.execute({ action: 'left_click' })) as Record<string, unknown>;
    expect(out).toMatchObject({ success: false, reason: 'bad_arguments' });
    expect(calls.map((c) => c['action'])).toEqual(['displays']);
  });

  it('re-reads the display each call, so a resolution change does not skew every click', async () => {
    const { runSkill, readImage } = recorder();
    const tool = createComputerTool({ runSkill, readImage });
    await tool.execute({ action: 'mouse_move', coordinate: [100, 100] });
    await tool.execute({ action: 'mouse_move', coordinate: [100, 100] });
    expect(runSkill.mock.calls.filter(([c]) => (c as Record<string, unknown>)['action'] === 'displays')).toHaveLength(2);
  });

  it('offers the element actions alongside the Anthropic vocabulary', () => {
    const tool = createComputerTool();
    const schema = tool.inputSchema as unknown as { shape: { action: { options: string[] } } };
    const actions = schema.shape.action.options;
    for (const anthropic of ['screenshot', 'left_click', 'key', 'type', 'scroll', 'wait']) {
      expect(actions).toContain(anthropic);
    }
    for (const crewly of ['snapshot', 'click_ref', 'fill_ref', 'wait_for']) {
      expect(actions).toContain(crewly);
    }
  });
});
