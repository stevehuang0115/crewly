/**
 * Desktop control over HTTP.
 *
 * Phase 6 of docs/research/computer-use-capability-assessment.md. Until now
 * desktop control was reachable only by a process on the machine itself: an
 * agent in a shell, running the skill. Nothing at the portal, on the phone,
 * or on another Mac could see or touch it, so "check what that machine is
 * doing" meant walking over to it.
 *
 * This is the same shape `/api/browser/*` already has, deliberately. It does
 * not invent a transport: the REST-over-relay path the mobile app uses
 * carries these routes once they are allowlisted, so the portal and the phone
 * reach a machine's desktop through machinery that already exists and is
 * already authenticated.
 *
 * Every route shells out to the computer-use skill. That keeps the safety
 * rails — permissions, stop switch, pause, desktop lock, destructive-key and
 * password-field refusals, the banner, the audit log — in one place. A second
 * implementation behind an HTTP route would be a second thing to keep in
 * step, and it would be the one reachable from the internet.
 *
 * @module controllers/desktop/desktop.controller
 */

import { spawn } from 'child_process';
import * as path from 'path';
import type { Request, Response } from 'express';
import { LoggerService, type ComponentLogger } from '../../services/core/logger.service.js';

let logger: ComponentLogger | null = null;
function log(): ComponentLogger {
  logger ??= LoggerService.getInstance().createComponentLogger('DesktopController');
  return logger;
}

/** How long one desktop action may take. */
const TIMEOUT_MS = 60_000;

/**
 * Actions this route will run.
 *
 * An allowlist rather than a pass-through: these routes are reachable from
 * the relay, so the set of things the internet can ask a Mac to do should be
 * written down in one visible place rather than inferred from whatever the
 * skill happens to support today.
 *
 * `read` actions are safe to expose broadly. `act` actions move the mouse and
 * keyboard, so they are gated separately below.
 */
export const DESKTOP_READ_ACTIONS = new Set([
  'check-permissions', 'displays', 'screenshot', 'snapshot', 'resolve', 'ocr', 'list-apps', 'find', 'wait-for',
]);

export const DESKTOP_ACT_ACTIONS = new Set([
  'click', 'move', 'scroll', 'drag', 'type', 'key', 'focus', 'open-url', 'click-text', 'click-ref', 'fill-ref',
]);

/** Where the skill lives. */
function skillPath(): string {
  const installDir = process.env['CREWLY_INSTALL_DIR'] ?? process.cwd();
  return path.join(installDir, 'config', 'skills', 'agent', 'computer-use', 'execute.sh');
}

/**
 * Run the skill and return whatever JSON it printed.
 *
 * The skill's own refusals are passed through untouched: they already name
 * the reason and what to do about it, and rewording them at this layer would
 * blur the one thing a caller needs.
 *
 * @param input - Skill payload
 * @param agentSession - Who is asking, for the audit log and the banner
 * @returns The parsed reply and the HTTP status to send it with
 */
export async function runDesktopAction(
  input: Record<string, unknown>,
  agentSession?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const script = skillPath();
  const raw = await new Promise<string>((resolve) => {
    const child = spawn('bash', [script, JSON.stringify(input)], {
      env: {
        ...process.env,
        ...(agentSession ? { CREWLY_SESSION_NAME: agentSession } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(JSON.stringify({ success: false, reason: 'timeout', message: `No answer within ${TIMEOUT_MS / 1000}s.` }));
    }, TIMEOUT_MS);
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(JSON.stringify({ success: false, reason: 'skill_unavailable', message: e.message, script }));
    });
    child.on('close', () => { clearTimeout(timer); resolve(out || err); });
  });

  const body = parseSkillJson(raw);
  // A refusal is a 409: the request was well formed and the machine simply
  // will not do it right now (locked, paused, another agent holds it). That
  // is a different thing from a bad request, and a caller retries it.
  const refused = body['success'] === false;
  const status = refused ? (body['reason'] === 'permission_required' ? 503 : 409) : 200;
  return { status, body };
}

/**
 * Parse the skill's output, which is one JSON object possibly preceded by a
 * shell warning.
 *
 * @param raw - Captured stdout/stderr
 * @returns The object, or a described failure
 */
export function parseSkillJson(raw: string): Record<string, unknown> {
  const text = (raw ?? '').trim();
  // Last JSON line first. The shared skill runner prints a warning line when
  // CREWLY_SESSION_NAME is unset, and parsing from the first `{` swallowed
  // that warning plus the real answer into one unparsable string — which
  // would have made every call from an unnamed caller fail.
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not it — keep looking backwards.
    }
  }
  // jq pretty-prints by default, so the object may span every line.
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start)) as Record<string, unknown>;
    } catch {
      // Fall through to the described failure.
    }
  }
  return { success: false, reason: 'unparsable', message: text.slice(0, 300) || 'The skill produced no output.' };
}

/**
 * Decide whether an action may run, and say why not.
 *
 * @param action - Requested action
 * @param allowActing - Whether mouse/keyboard actions are permitted here
 * @returns null when allowed, otherwise the refusal body
 */
export function checkAction(action: string, allowActing: boolean): Record<string, unknown> | null {
  if (!action) return { success: false, reason: 'validation', message: 'action is required' };
  if (DESKTOP_READ_ACTIONS.has(action)) return null;
  if (DESKTOP_ACT_ACTIONS.has(action)) {
    return allowActing
      ? null
      : {
          success: false,
          reason: 'read_only',
          message:
            `"${action}" moves the mouse or keyboard, which this caller may not do. ` +
            'Reading the screen is allowed.',
        };
  }
  return {
    success: false,
    reason: 'unknown_action',
    message: `No desktop action called "${action}".`,
    actions: [...DESKTOP_READ_ACTIONS, ...DESKTOP_ACT_ACTIONS].sort(),
  };
}

/** Who is asking. */
function agentOf(req: Request): string | undefined {
  const header = req.get('X-Agent-Session');
  const body = (req.body ?? {}) as { agentSession?: unknown };
  const raw = header || (typeof body.agentSession === 'string' ? body.agentSession : '');
  return raw.trim() || undefined;
}

/**
 * POST /api/desktop/act — run one desktop action.
 *
 * @param req - Body is the skill payload, `{ action, … }`
 * @param res - The skill's own JSON
 */
export async function desktopAct(req: Request, res: Response): Promise<void> {
  const input = (req.body ?? {}) as Record<string, unknown>;
  const action = typeof input['action'] === 'string' ? input['action'] : '';
  const refusal = checkAction(action, true);
  if (refusal) {
    res.status(refusal['reason'] === 'validation' ? 400 : 403).json(refusal);
    return;
  }
  const agent = agentOf(req);
  log().info('Desktop action requested', { action, agent });
  const { status, body } = await runDesktopAction(input, agent);
  res.status(status).json(body);
}

/**
 * POST /api/desktop/look — the reading half, for callers that may watch but
 * not touch (the portal showing what a machine is doing, say).
 *
 * @param req - Body is the skill payload
 * @param res - The skill's own JSON
 */
export async function desktopLook(req: Request, res: Response): Promise<void> {
  const input = (req.body ?? {}) as Record<string, unknown>;
  const action = typeof input['action'] === 'string' ? input['action'] : '';
  const refusal = checkAction(action, false);
  if (refusal) {
    res.status(refusal['reason'] === 'validation' ? 400 : 403).json(refusal);
    return;
  }
  const { status, body } = await runDesktopAction(input, agentOf(req));
  res.status(status).json(body);
}

/**
 * GET /api/desktop/status — is desktop control usable, and is anyone using it.
 *
 * The one call the portal needs to show a machine's state, and the one that
 * must work even when everything else is refused.
 *
 * @param _req - Unused
 * @param res - Permissions, presence, and whether it is paused or stopped
 */
export async function desktopStatus(_req: Request, res: Response): Promise<void> {
  const permissions = await runDesktopAction({ action: 'check-permissions' });
  const presence = await readPresence();
  res.json({
    success: true,
    data: {
      permissions: permissions.body,
      ...presence,
    },
  });
}

/**
 * POST /api/desktop/stop — halt everything, from anywhere.
 *
 * The remote twin of the ⌃⌥⌘. hotkey, so an owner who is not at the machine
 * can still take the mouse back. Deliberately not gated behind the acting
 * allowlist: stopping is always allowed.
 *
 * @param req - Body `{ resume: true }` to lift it instead
 * @param res - The new state
 */
export async function desktopStop(req: Request, res: Response): Promise<void> {
  const { promises: fs } = await import('fs');
  const home = process.env['CREWLY_HOME'] ?? path.join(process.env['HOME'] ?? '.', '.crewly');
  const stopFile = path.join(home, 'desktop.stop');
  const resume = ((req.body ?? {}) as { resume?: unknown }).resume === true;
  try {
    if (resume) {
      await fs.unlink(stopFile).catch(() => undefined);
    } else {
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(stopFile, 'remote\n');
    }
    log().info(resume ? 'Desktop control resumed remotely' : 'Desktop control stopped remotely');
    res.json({ success: true, data: { stopped: !resume } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** What the banner is showing, if anything. */
async function readPresence(): Promise<Record<string, unknown>> {
  const { promises: fs } = await import('fs');
  const home = process.env['CREWLY_HOME'] ?? path.join(process.env['HOME'] ?? '.', '.crewly');
  const exists = async (name: string) =>
    fs.access(path.join(home, name)).then(() => true).catch(() => false);
  let presence: Record<string, unknown> | null = null;
  try {
    presence = JSON.parse(await fs.readFile(path.join(home, 'desktop-presence.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    presence = null;
  }
  return {
    busy: presence !== null,
    ...(presence ? { agent: presence['agent'], goal: presence['goal'] } : {}),
    paused: await exists('desktop.pause'),
    stopped: await exists('desktop.stop'),
  };
}
