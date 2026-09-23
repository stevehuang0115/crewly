/**
 * Remote desktop — the owner watches and drives this machine from the portal
 * or the phone.
 *
 * Agents already drive the desktop through the computer-use skill. This is
 * the owner's half: see the screen live, click where they tap, type, press
 * keys, scroll. Every action still goes through the same skill, so the rails
 * that protect agents' use protect this too: a locked screen is refused, the
 * banner shows who is in control, destructive keys and password fields are
 * refused, and each action is in the audit log.
 *
 * Off by default, and only switchable on the machine itself — the switch is
 * not reachable over the relay. Seeing a screen and moving a real mouse from
 * the internet should need someone at the Mac to have said yes first.
 *
 * @module services/desktop/desktop-remote.service
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { DESKTOP_REMOTE_CONSTANTS } from '../../constants.js';

const execFileAsync = promisify(execFile);

/** Runs one computer-use skill action (see the desktop controller). */
export type DesktopActionRunner = (
  input: Record<string, unknown>,
  agentSession?: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** One frame of the screen, ready to show. */
export interface DesktopFrame {
  base64: string;
  mimeType: string;
  /** Size of the picture, in pixels */
  width: number;
  height: number;
  capturedAt: number;
}

/** One input from the owner. Coordinates are 0..1 across the picture. */
export type DesktopRemoteInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right'; double?: boolean }
  | { type: 'move'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; x: number; y: number; dy: number };

/** Why something could not happen, in a shape the portal can show. */
export type DesktopRemoteRefusal = { success: false; reason: string; message: string } & Record<string, unknown>;

/** Collaborators, injectable for tests. */
export interface DesktopRemoteDeps {
  run: DesktopActionRunner;
  home: () => string;
  /** Convert a PNG to a JPEG of at most `maxWidth` pixels (macOS `sips`) */
  toJpeg: (pngPath: string, jpgPath: string, maxWidth: number) => Promise<void>;
  now: () => number;
}

/** Name the skill shows on the banner and writes in the audit log. */
export const OWNER_REMOTE_SESSION = 'owner (remote)';

/** Remote desktop for the owner. */
export class DesktopRemoteService {
  private static instance: DesktopRemoteService | null = null;
  private readonly logger: ComponentLogger;
  /** Screen size in points, from the skill; cached — it rarely changes */
  private screen: { w: number; h: number } | null = null;

  constructor(private readonly deps: DesktopRemoteDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('DesktopRemote');
  }

  /**
   * @param run - The skill runner (the desktop controller's)
   * @returns The process-wide instance
   */
  static getInstance(run: DesktopActionRunner): DesktopRemoteService {
    if (!DesktopRemoteService.instance) {
      DesktopRemoteService.instance = new DesktopRemoteService({
        run,
        home: () => getCrewlyHomePath(),
        toJpeg: async (png, jpg, maxWidth) => {
          await execFileAsync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(DESKTOP_REMOTE_CONSTANTS.JPEG_QUALITY), '--resampleWidth', String(maxWidth), png, '--out', jpg]);
        },
        now: () => Date.now(),
      });
    }
    return DesktopRemoteService.instance;
  }

  /** Test affordance. */
  static resetInstance(): void {
    DesktopRemoteService.instance = null;
  }

  private settingsPath(): string {
    return path.join(this.deps.home(), DESKTOP_REMOTE_CONSTANTS.SETTINGS_FILE);
  }

  /** @returns Whether the owner has allowed remote control on this machine */
  async isEnabled(): Promise<boolean> {
    try {
      const raw = JSON.parse(await fs.readFile(this.settingsPath(), 'utf8')) as { enabled?: unknown };
      return raw.enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Allow or forbid remote control. Local only — see the module note.
   *
   * @param enabled - The new setting
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await fs.mkdir(this.deps.home(), { recursive: true });
    await fs.writeFile(this.settingsPath(), JSON.stringify({ enabled, changedAt: new Date(this.deps.now()).toISOString() }, null, 2));
    this.logger.info(enabled ? 'Remote desktop control allowed on this machine' : 'Remote desktop control turned off');
  }

  /**
   * Capture the screen as a JPEG small enough to send over the relay.
   *
   * @param maxWidth - Widest picture wanted
   * @returns The frame, or why not (off, locked, no permission)
   */
  async frame(maxWidth: number = DESKTOP_REMOTE_CONSTANTS.FRAME_MAX_WIDTH): Promise<DesktopFrame | DesktopRemoteRefusal> {
    const off = await this.refuseIfOff();
    if (off) return off;
    const width = Math.max(320, Math.min(maxWidth, DESKTOP_REMOTE_CONSTANTS.FRAME_MAX_WIDTH));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-desk-'));
    const png = path.join(dir, 'screen.png');
    const jpg = path.join(dir, 'screen.jpg');
    try {
      const shot = await this.deps.run({ action: 'screenshot', output: png }, OWNER_REMOTE_SESSION);
      if (shot.body['success'] === false) return asRefusal(shot.body);
      await this.deps.toJpeg(png, jpg, width);
      const data = await fs.readFile(jpg);
      const sw = Number(shot.body['width']);
      const sh = Number(shot.body['height']);
      if (sw > 0 && sh > 0) this.screen = { w: sw, h: sh };
      const height = sw > 0 && sh > 0 ? Math.round((sh / sw) * width) : 0;
      return { base64: data.toString('base64'), mimeType: 'image/jpeg', width, height, capturedAt: this.deps.now() };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Carry out one input from the owner.
   *
   * @param input - What to do; positions as fractions of the picture
   * @returns The skill's answer, or why not
   */
  async input(input: DesktopRemoteInput): Promise<Record<string, unknown> | DesktopRemoteRefusal> {
    const off = await this.refuseIfOff();
    if (off) return off;
    const payload = await this.toSkillPayload(input);
    if ('reason' in payload && payload['success'] === false) return payload as unknown as DesktopRemoteRefusal;
    this.logger.info('Owner remote desktop input', { type: input.type, ...(input.type === 'key' ? { key: input.key } : {}) });
    const { body } = await this.deps.run(payload, OWNER_REMOTE_SESSION);
    return body;
  }

  /**
   * Map a portal input to a skill payload, turning fractions into screen points.
   *
   * @param input - The owner's input
   * @returns The payload, or a refusal for a malformed one
   */
  async toSkillPayload(input: DesktopRemoteInput): Promise<Record<string, unknown>> {
    const at = async (fx: number, fy: number) => {
      const s = await this.screenSize();
      return { x: Math.round(clamp01(fx) * s.w), y: Math.round(clamp01(fy) * s.h) };
    };
    switch (input?.type) {
      case 'click': {
        if (!isFraction(input.x) || !isFraction(input.y)) return bad('click needs x and y between 0 and 1');
        const p = await at(input.x, input.y);
        return { action: 'click', ...p, button: input.button === 'right' ? 'right' : input.double ? 'double' : 'left' };
      }
      case 'move': {
        // Mouse mode: the pointer follows the owner's finger, so hover
        // states (menus, tooltips) show before anything is clicked.
        if (!isFraction(input.x) || !isFraction(input.y)) return bad('move needs x and y between 0 and 1');
        return { action: 'move', ...(await at(input.x, input.y)) };
      }
      case 'type':
        if (typeof input.text !== 'string' || !input.text) return bad('type needs text');
        return { action: 'type', text: input.text.slice(0, DESKTOP_REMOTE_CONSTANTS.MAX_TYPE_CHARS) };
      case 'key':
        if (typeof input.key !== 'string' || !/^[a-z0-9+_-]{1,40}$/i.test(input.key)) return bad('key must look like "enter" or "cmd+r"');
        return { action: 'key', key: input.key.toLowerCase() };
      case 'scroll': {
        if (!isFraction(input.x) || !isFraction(input.y) || typeof input.dy !== 'number') return bad('scroll needs x, y and dy');
        const p = await at(input.x, input.y);
        // The skill's dy is lines, positive scrolling up (CoreGraphics); the
        // portal's is a swipe, positive meaning "further down the page".
        const lines = Math.min(20, Math.max(1, Math.round(Math.abs(input.dy))));
        return { action: 'scroll', ...p, dy: input.dy > 0 ? -lines : lines };
      }
      default:
        return bad('type must be click, move, type, key or scroll');
    }
  }

  /** Screen size in points (what the skill clicks in). */
  private async screenSize(): Promise<{ w: number; h: number }> {
    if (this.screen) return this.screen;
    const res = await this.deps.run({ action: 'displays' });
    const displays = (res.body['displays'] as Array<{ main?: boolean; frame?: number[] }> | undefined) ?? [];
    const main = displays.find((d) => d.main) ?? displays[0];
    const frame = main?.frame ?? [0, 0, 1440, 900];
    this.screen = { w: Number(frame[2]) || 1440, h: Number(frame[3]) || 900 };
    return this.screen;
  }

  private async refuseIfOff(): Promise<DesktopRemoteRefusal | null> {
    if (await this.isEnabled()) return null;
    return {
      success: false,
      reason: 'remote_disabled',
      message: 'Remote desktop is off on this machine. Turn it on at the machine: Settings → Desktop, or `crewly desktop remote on`.',
    };
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function isFraction(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function bad(message: string): DesktopRemoteRefusal {
  return { success: false, reason: 'validation', message };
}

function asRefusal(body: Record<string, unknown>): DesktopRemoteRefusal {
  return {
    success: false,
    reason: typeof body['reason'] === 'string' ? (body['reason'] as string) : 'failed',
    message: typeof body['message'] === 'string' ? (body['message'] as string) : 'The screen could not be captured.',
  };
}
