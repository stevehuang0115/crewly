/**
 * `computer` tool — desktop control for the in-process runtime.
 *
 * Phase 3 of docs/research/computer-use-capability-assessment.md. The
 * computer-use skill could already drive the desktop, but an in-process agent
 * reached it the long way round: `bash_exec` the script, read the JSON, then
 * `read_file` the screenshot it wrote. Two tool calls per step, and a weak
 * model had to remember a shell invocation and a file path to get one look at
 * the screen.
 *
 * This is one call that returns the result *and* the new screenshot, which is
 * what every published computer-use agent expects.
 *
 * Two deliberate choices:
 *
 * The action names and the coordinate convention match Anthropic's
 * `computer_20250124` tool. Claude-family models have seen that shape in
 * training and need no instruction; for every other model there is a large
 * body of public examples to imitate. Inventing our own names would cost
 * accuracy for nothing. Crewly's element-level actions (`snapshot`,
 * `click_ref`, `fill_ref`, `wait_for`) are added alongside — they have no
 * equivalent in that spec and are the ones a weak model should reach for
 * first, because naming `@e12` cannot miss the way a coordinate can.
 *
 * Nothing here talks to the mouse. Every action shells out to the
 * computer-use skill, so the safety rails — permissions, stop switch, desktop
 * lock, destructive-key and password-field refusals, the audit log — apply
 * exactly once, in one place, to every runtime. A second implementation here
 * would be a second thing to keep in step, and the rails are the part that
 * must not drift.
 *
 * @module runtime/computer.tool
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { ToolDefinition } from './types.js';

/**
 * Width every screenshot is scaled to before the model sees it.
 *
 * Anthropic's guidance, and the reason is worth keeping in mind: accuracy
 * falls off above roughly this width because the image is downsampled before
 * the model ever sees it, and a model reasoning in the original coordinate
 * space then points at the wrong place. The model works in scaled
 * coordinates; this tool converts them back.
 */
const TARGET_WIDTH = 1280;

/** Actions that move or type, and so return a fresh screenshot afterwards. */
const MUTATING = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'mouse_move', 'key', 'type', 'scroll', 'click_ref', 'fill_ref',
]);

/** How long an action may take before the tool gives up on the skill. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Injectable IO, for tests. */
export interface ComputerToolDeps {
  /** Run the skill and return its stdout. */
  runSkill?: (input: Record<string, unknown>) => Promise<string>;
  /** Read a screenshot file as base64. */
  readImage?: (file: string) => Promise<{ data: string; bytes: number }>;
  /** Crewly install directory, holding config/skills. */
  installDir?: string;
}

/** One screen, as the skill reports it. */
interface DisplayInfo {
  frame: [number, number, number, number];
  scale: number;
  main: boolean;
}

/**
 * Run the computer-use skill with a JSON payload.
 *
 * Failures come back as the skill's own JSON where possible: its refusals
 * (`permission_required`, `screen_locked`, `destructive_blocked`…) already
 * say what to do about them, and rewording them here would only blur that.
 *
 * @param input - The skill's JSON input
 * @param deps - Injected IO
 * @returns Parsed skill output
 */
async function runSkill(input: Record<string, unknown>, deps: ComputerToolDeps): Promise<Record<string, unknown>> {
  if (deps.runSkill) {
    const raw = await deps.runSkill(input);
    return parseSkillOutput(raw);
  }

  const installDir = deps.installDir ?? process.env['CREWLY_INSTALL_DIR'] ?? process.cwd();
  const script = path.join(installDir, 'config', 'skills', 'agent', 'computer-use', 'execute.sh');

  return new Promise((resolve) => {
    const child = spawn('bash', [script, JSON.stringify(input)], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        success: false,
        reason: 'timeout',
        message: `The desktop action did not finish within ${DEFAULT_TIMEOUT_MS / 1000}s.`,
      });
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, reason: 'skill_unavailable', message: err.message, script });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseSkillOutput(stdout || stderr));
    });
  });
}

/**
 * Parse the skill's stdout.
 *
 * The skill prints one JSON object, but a shell warning can precede it (the
 * shared runner warns when CREWLY_SESSION_NAME is unset), so the last
 * JSON-looking line wins.
 *
 * @param raw - Captured output
 * @returns The parsed object, or a described failure when there is none
 */
export function parseSkillOutput(raw: string): Record<string, unknown> {
  const lines = (raw ?? '').trim().split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not the JSON line after all — keep looking backwards.
    }
  }
  // Multi-line pretty-printed JSON (jq's default) is one object across lines.
  const joined = lines.join('\n');
  const start = joined.indexOf('{');
  if (start >= 0) {
    try {
      return JSON.parse(joined.slice(start)) as Record<string, unknown>;
    } catch {
      // Fall through to the described failure.
    }
  }
  return { success: false, reason: 'unparsable', message: raw?.slice(0, 500) || 'The skill produced no output.' };
}

/**
 * The scale between the coordinates the model uses and real screen points.
 *
 * @param displays - What the skill reported
 * @returns Factor to multiply model coordinates by, and the scaled size
 */
export function scaleFor(displays: DisplayInfo[]): { factor: number; width: number; height: number; screen: [number, number] } {
  const main = displays.find((d) => d.main) ?? displays[0];
  const [, , w, h] = main?.frame ?? [0, 0, TARGET_WIDTH, 800];
  // Never scale up: a small screen is already easier to point at than a large
  // one, and enlarging it would invent precision the model does not have.
  const factor = w > TARGET_WIDTH ? w / TARGET_WIDTH : 1;
  return {
    factor,
    width: Math.round(w / factor),
    height: Math.round(h / factor),
    screen: [w, h],
  };
}

/**
 * Convert a model coordinate into a screen point.
 *
 * @param value - Coordinate in the scaled space the model sees
 * @param factor - From {@link scaleFor}
 * @returns Screen point
 */
export function toScreen(value: number, factor: number): number {
  return Math.round(value * factor);
}

/**
 * Take a screenshot scaled for the model.
 *
 * @param deps - Injected IO
 * @returns Image payload, or null when the screenshot failed
 */
async function capture(
  deps: ComputerToolDeps,
): Promise<{ data: string; bytes: number; file: string } | null> {
  const file = path.join(os.tmpdir(), `crewly-computer-${process.pid}-${Date.now()}.png`);
  // maxWidth is what makes the screenshot match the coordinate space the
  // model is told to use; without it the two drift and every click is off.
  const shot = await runSkill(
    { action: 'screenshot', output: file, maxWidth: Math.round(TARGET_WIDTH) },
    deps,
  );
  const written = (shot['path'] as string) ?? file;
  try {
    if (deps.readImage) {
      const { data, bytes } = await deps.readImage(written);
      return { data, bytes, file: written };
    }
    const buffer = await fs.readFile(written);
    await fs.unlink(written).catch(() => undefined);
    return { data: buffer.toString('base64'), bytes: buffer.length, file: written };
  } catch {
    return null;
  }
}

/** Arguments the model may send. */
const computerSchema = z.object({
  action: z.enum([
    // Anthropic computer_20250124 vocabulary.
    'screenshot', 'left_click', 'right_click', 'middle_click', 'double_click',
    'triple_click', 'left_click_drag', 'mouse_move', 'key', 'type', 'scroll',
    'wait', 'cursor_position',
    // Crewly's element-level additions.
    'snapshot', 'click_ref', 'fill_ref', 'wait_for', 'ocr', 'displays',
  ]).describe('What to do. Prefer snapshot + click_ref/fill_ref over coordinates when the app exposes elements.'),
  coordinate: z.array(z.number()).length(2).optional()
    .describe('[x, y] in the screenshot you were shown, not screen pixels. The tool converts.'),
  start_coordinate: z.array(z.number()).length(2).optional()
    .describe('[x, y] to drag from, for left_click_drag.'),
  text: z.string().optional()
    .describe('Text to type, the key combo for `key` (e.g. "command+s"), or the value for fill_ref.'),
  ref: z.string().optional().describe('Element reference from a snapshot, e.g. "@e12".'),
  app: z.string().optional().describe('Application to snapshot or wait for; defaults to the frontmost.'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().optional().describe('Scroll clicks; defaults to 3.'),
  duration: z.number().optional().describe('Seconds to wait, for `wait`.'),
});

/**
 * Translate the tool's arguments into the skill's own input.
 *
 * @param args - Validated tool arguments
 * @param factor - Coordinate scale
 * @returns The skill payload, or a refusal when the arguments do not fit
 */
export function toSkillInput(
  args: z.infer<typeof computerSchema>,
  factor: number,
): Record<string, unknown> | { error: string } {
  const point = (pair?: number[]) =>
    pair ? { x: toScreen(pair[0]!, factor), y: toScreen(pair[1]!, factor) } : null;

  switch (args.action) {
    case 'screenshot':
      return { action: 'screenshot' };
    case 'displays':
      return { action: 'displays' };
    case 'cursor_position':
      // The skill has no cursor read; a screenshot answers the same question
      // and is what the model will ask for next anyway.
      return { action: 'screenshot' };

    case 'left_click':
    case 'right_click':
    case 'double_click': {
      const p = point(args.coordinate);
      if (!p) return { error: `${args.action} needs a coordinate.` };
      const button = args.action === 'right_click' ? 'right' : args.action === 'double_click' ? 'double' : 'left';
      return { action: 'click', ...p, button };
    }
    case 'middle_click':
    case 'triple_click': {
      // Neither exists in the skill. Saying so beats silently doing something
      // else: a model told "not supported" picks another route, one told
      // "done" builds on a click that never happened.
      return { error: `${args.action} is not supported on this platform. Use left_click, or select the text another way.` };
    }
    case 'mouse_move': {
      const p = point(args.coordinate);
      if (!p) return { error: 'mouse_move needs a coordinate.' };
      return { action: 'move', ...p };
    }
    case 'left_click_drag': {
      const from = point(args.start_coordinate);
      const to = point(args.coordinate);
      if (!from || !to) return { error: 'left_click_drag needs start_coordinate and coordinate.' };
      return { action: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
    }
    case 'key':
      if (!args.text) return { error: 'key needs `text`, e.g. "command+s".' };
      return { action: 'key', key: args.text };
    case 'type':
      if (!args.text) return { error: 'type needs `text`.' };
      return { action: 'type', text: args.text };
    case 'scroll': {
      const p = point(args.coordinate);
      return {
        action: 'scroll',
        ...(p ?? {}),
        direction: args.scroll_direction ?? 'down',
        amount: args.scroll_amount ?? 3,
      };
    }

    case 'snapshot':
      return { action: 'snapshot', ...(args.app ? { app: args.app } : {}) };
    case 'click_ref':
      if (!args.ref) return { error: 'click_ref needs `ref`, e.g. "@e12" from a snapshot.' };
      return { action: 'click-ref', ref: args.ref };
    case 'fill_ref':
      if (!args.ref || args.text === undefined) return { error: 'fill_ref needs `ref` and `text`.' };
      return { action: 'fill-ref', ref: args.ref, text: args.text };
    case 'ocr':
      return { action: 'ocr' };
    case 'wait_for':
      if (!args.app && !args.ref && !args.text) {
        return { error: 'wait_for needs one of `app`, `ref` or `text`.' };
      }
      return {
        action: 'wait-for',
        ...(args.app ? { app: args.app } : {}),
        ...(args.ref ? { ref: args.ref } : {}),
        ...(args.text ? { text: args.text } : {}),
      };
    case 'wait':
      return { action: 'wait-for', idle: true, timeoutMs: Math.round((args.duration ?? 1) * 1000) };
  }
}

/**
 * Build the `computer` tool.
 *
 * @param deps - Injected IO for tests
 * @returns The tool definition
 *
 * @example
 * ```ts
 * const tools = { computer: createComputerTool() };
 * ```
 */
export function createComputerTool(deps: ComputerToolDeps = {}): ToolDefinition {
  return {
    description:
      'Control this Mac: look at the screen and act on it. ' +
      'Prefer `snapshot` then `click_ref`/`fill_ref` — naming an element cannot miss the way a coordinate can, ' +
      'and it keeps working when the window moves. Fall back to coordinates for canvases and custom-drawn UI. ' +
      'Coordinates are in the screenshot you were shown, not screen pixels. ' +
      'Destructive key combos, password fields and credential apps are refused, and the owner can stop everything at any time.',
    inputSchema: computerSchema,
    sensitivity: 'destructive',
    execute: async (rawArgs) => {
      const args = rawArgs as z.infer<typeof computerSchema>;

      // The scale has to come from the live display: the owner may have
      // changed resolution or moved to another screen since the last call.
      const displayResult = await runSkill({ action: 'displays' }, deps);
      const displays = (displayResult['displays'] as DisplayInfo[] | undefined) ?? [];
      const scale = scaleFor(displays);

      const payload = toSkillInput(args, scale.factor);
      if ('error' in payload) {
        return { success: false, reason: 'bad_arguments', message: payload.error };
      }

      // A bare screenshot is taken once, by the capture step below. Running
      // the skill's screenshot here as well would shoot the screen twice for
      // one request — slow, and the two images could even differ.
      const result = args.action === 'screenshot'
        ? { success: true }
        : await runSkill(payload, deps);

      // A refusal is returned as it stands. The rails phrase their own
      // reasons and tell the agent what to do; a screenshot alongside would
      // just be the same screen it could not act on.
      if (result['success'] === false) return result;

      const out: Record<string, unknown> = {
        ...result,
        action: args.action,
        screen: { width: scale.width, height: scale.height, actual: scale.screen },
      };

      // One call, one look. Showing the result of an action is what lets a
      // model check its own work instead of assuming the click landed.
      if (MUTATING.has(args.action) || args.action === 'screenshot') {
        const image = await capture(deps);
        if (image) {
          out['type'] = 'image';
          out['mimeType'] = 'image/png';
          out['data'] = image.data;
          out['sizeBytes'] = image.bytes;
          out['note'] = `Screenshot is ${scale.width}×${scale.height}; give coordinates in that space.`;
        }
      }
      return out;
    },
  };
}
