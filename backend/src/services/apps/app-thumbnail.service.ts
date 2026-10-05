/**
 * AppThumbnailService — a small screenshot of a published app for the
 * portal's Apps list.
 *
 * After a publish this instance opens the app in the locally installed
 * Chrome / Chromium (headless), takes a phone-sized screenshot, shrinks it
 * and uploads it (`PUT /apps/:appId/thumbnail`). No browser dependency is
 * added to Crewly: the binary is only looked up on the machine, and a machine
 * without one just has no thumbnails (logged once).
 *
 * The app is opened through a short-lived signed open-link minted for the
 * capture and revoked right after. That link is a credential: it is only ever
 * an argument to the browser process and is never logged or returned.
 *
 * Capturing is always best effort and never part of the publish itself.
 *
 * @module services/apps/app-thumbnail.service
 */

import { execFile } from 'child_process';
import { promises as fs, constants as fsConstants } from 'fs';
import os from 'os';
import path from 'path';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import type { AppsCloudClient } from './apps-cloud.client.js';
import { redactOpenLinkTokens, usableMintedLink } from './app-open-link.js';
import type { AppsRegistryService } from './apps-registry.service.js';

const T = CREWLY_APPS_CONSTANTS.THUMBNAIL;

/** Outcome of one capture. */
export type ThumbnailResult =
  | { ok: true; appId: string; bytes: number }
  | { ok: false; appId: string; reason: 'no_browser' | 'no_link' | 'render_failed' | 'too_large' | 'upload_failed' | 'disabled'; message: string };

/** Runs the browser; injectable for tests. Resolves false when it could not start or had to be killed (the screenshot file is what counts). */
export type BrowserRunner = (binary: string, args: string[], timeoutMs: number) => Promise<boolean>;

/** Shrinks an image; resolves the new file path, or null when no tool is available. */
export type ImageShrinker = (input: string, outputBase: string) => Promise<string | null>;

/** Constructor dependencies. */
export interface AppThumbnailDeps {
  client: Pick<AppsCloudClient, 'request'>;
  registry: Pick<AppsRegistryService, 'list' | 'get'>;
  /** Find the browser (default: {@link findBrowser}) */
  findBrowser?: () => Promise<string | null>;
  run?: BrowserRunner;
  shrink?: ImageShrinker;
  tmpDir?: () => string;
}

/**
 * Locate a Chrome / Chromium binary: `$CREWLY_CHROME_PATH`, the macOS
 * application bundles, then common Linux names on PATH.
 *
 * @param env - Environment (tests)
 * @param platform - OS platform (tests)
 * @returns Absolute path, or null when none is installed
 */
export async function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const executable = async (p: string): Promise<boolean> => {
    try {
      await fs.access(p, fsConstants.X_OK);
      return (await fs.stat(p)).isFile();
    } catch {
      return false;
    }
  };
  const explicit = env.CREWLY_CHROME_PATH?.trim();
  if (explicit) return (await executable(explicit)) ? explicit : null;
  if (platform === 'darwin') {
    for (const p of T.MAC_BROWSERS) if (await executable(p)) return p;
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of T.LINUX_BROWSERS) {
      const p = path.join(dir, name);
      if (await executable(p)) return p;
    }
  }
  if (platform === 'linux') {
    for (const p of T.LINUX_FIXED_PATHS) if (await executable(p)) return p;
  }
  return null;
}

/** The headless screenshot arguments (the URL goes last). */
export function browserArgs(shotFile: string, profileDir: string, url: string, asRoot = false): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${T.WIDTH},${T.HEIGHT}`,
    `--virtual-time-budget=${T.VIRTUAL_TIME_BUDGET_MS}`,
    `--screenshot=${shotFile}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    ...(asRoot ? ['--no-sandbox'] : []),
    url,
  ];
}

/**
 * Default runner. The `--screenshot` CLI mode does not work for Crewly Apps:
 * it captures before the sandboxed iframe has fetched and rendered the bundle
 * (blank shell), and on macOS headless Chrome does not exit afterwards.
 * Drive the same Chrome over CDP with playwright-core instead (no bundled
 * browser): wait for `load`, give the app time to read its data, then shoot.
 * The arguments come from {@link browserArgs} (`--screenshot=`, `--window-size=`,
 * `--user-data-dir=`, the URL last). Resolves false on any failure.
 */
const defaultRun: BrowserRunner = async (binary, args, timeoutMs) => {
  const shot = args.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length);
  const size = args.find((a) => a.startsWith('--window-size='))?.slice('--window-size='.length).split(',').map(Number);
  const url = args[args.length - 1];
  if (!shot || !url) return false;
  let browser: { close(): Promise<void> } | null = null;
  const killer = setTimeout(() => void browser?.close().catch(() => undefined), timeoutMs);
  try {
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({
      executablePath: binary,
      headless: true,
      args: args.filter((a) => a.startsWith('--no-sandbox') || a === '--disable-gpu' || a === '--hide-scrollbars'),
      timeout: timeoutMs,
    });
    browser = b;
    const page = await b.newPage({ viewport: { width: size?.[0] || 390, height: size?.[1] || 844 }, colorScheme: 'dark' });
    await page.goto(url, { waitUntil: 'load', timeout: Math.max(5_000, timeoutMs - 10_000) });
    // An open link first asks "Open as <owner>?" — confirm it, or the shot is that card.
    // The card appears after an async exchange, so wait for whichever comes
    // first (isVisible() does not wait).
    const confirm = page.getByRole('button', { name: /^Open as /i }).first();
    const first = await Promise.race([
      confirm.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'confirm' as const),
      page.waitForSelector('iframe', { state: 'attached', timeout: 10_000 }).then(() => 'app' as const),
    ]).catch(() => null);
    if (first === 'confirm') {
      await confirm.click();
      await page.waitForSelector('iframe', { state: 'attached', timeout: 10_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(T.SETTLE_MS);
    // Only the app itself (the sandboxed iframe), not the Crewly shell header.
    const frame = page.locator('iframe').first();
    const shotFrame = (await frame.count()) > 0 && (await frame.isVisible().catch(() => false));
    if (shotFrame) await frame.screenshot({ path: shot });
    else await page.screenshot({ path: shot });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(killer);
    await browser?.close().catch(() => undefined);
  }
};

const exec = (file: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => execFile(file, args, { timeout: 20_000 }, (err) => resolve(!err)));

async function onPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      await fs.access(p, fsConstants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Default shrinker: `sips` (macOS), else ImageMagick; null when neither exists. */
const defaultShrink: ImageShrinker = async (input, outputBase) => {
  const out = `${outputBase}.jpg`;
  if (process.platform === 'darwin' && (await onPath('sips'))) {
    if (await exec('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(T.JPEG_QUALITY), '--resampleWidth', String(T.OUTPUT_WIDTH), input, '--out', out])) return out;
    return null;
  }
  const magick = (await onPath('magick')) ?? (await onPath('convert'));
  if (magick) {
    if (await exec(magick, [input, '-resize', `${T.OUTPUT_WIDTH}x`, '-quality', String(T.JPEG_QUALITY), out])) return out;
  }
  return null;
};

/**
 * Captures and uploads app thumbnails.
 */
export class AppThumbnailService {
  private readonly log = LoggerService.getInstance().createComponentLogger('AppThumbnail');
  private chain: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<string>();
  private warnedNoBrowser = false;
  private readonly findBin: () => Promise<string | null>;
  private readonly run: BrowserRunner;
  private readonly shrink: ImageShrinker;

  constructor(private readonly deps: AppThumbnailDeps) {
    this.findBin = deps.findBrowser ?? (() => findBrowser());
    this.run = deps.run ?? defaultRun;
    this.shrink = deps.shrink ?? defaultShrink;
  }

  /**
   * Capture in the background after a publish: queued one at a time (a
   * browser launch is heavy), de-duplicated per app, and it never throws.
   *
   * @param appId - App
   * @param agent - Agent session to attribute the Cloud calls to
   */
  schedule(appId: string, agent?: string | null): void {
    if (this.pending.has(appId)) return;
    this.pending.add(appId);
    this.chain = this.chain
      .then(() => this.capture(appId, agent))
      .catch(() => undefined)
      .finally(() => this.pending.delete(appId));
  }

  /**
   * Capture the thumbnails of many apps, one after another.
   *
   * @param apps - App ids with the agent that publishes each
   * @returns Results in order
   */
  async captureAll(apps: Array<{ appId: string; agent?: string | null }>): Promise<ThumbnailResult[]> {
    const out: ThumbnailResult[] = [];
    for (const a of apps) out.push(await this.capture(a.appId, a.agent));
    return out;
  }

  /** The non-deleted apps in the local registry, with their publishing agent. */
  async registeredApps(): Promise<Array<{ appId: string; agent: string | null }>> {
    return (await this.deps.registry.list()).filter((e) => !e.deleted).map((e) => ({ appId: e.appId, agent: e.agentSession }));
  }

  /**
   * Render the app, shrink the screenshot and upload it. Never throws.
   *
   * @param appId - App
   * @param agent - Agent session for attribution (omit for the owner)
   * @returns What happened
   */
  async capture(appId: string, agent?: string | null): Promise<ThumbnailResult> {
    const fail = (reason: Extract<ThumbnailResult, { ok: false }>['reason'], message: string): ThumbnailResult => {
      this.log.info('Thumbnail not captured', { appId, reason });
      return { ok: false, appId, reason, message };
    };
    let linkId: string | null = null;
    let dir: string | null = null;
    const agentOpt = agent ? { agent } : {};
    try {
      const binary = await this.findBin();
      if (!binary) {
        if (!this.warnedNoBrowser) {
          this.warnedNoBrowser = true;
          this.log.warn('No Chrome or Chromium found: app thumbnails are skipped (install Chrome, or set CREWLY_CHROME_PATH)');
        }
        return { ok: false, appId, reason: 'no_browser', message: 'No Chrome or Chromium is installed on this machine (set CREWLY_CHROME_PATH).' };
      }

      const minted = await this.deps.client
        .request<unknown>('POST', `/apps/${appId}/open-links`, { body: { ttlDays: T.LINK_TTL_DAYS }, ...agentOpt })
        .catch(() => null);
      const link = usableMintedLink(appId, minted);
      if (!link) return fail('no_link', 'Could not mint a short-lived link to render the app.');
      linkId = link.linkId;

      dir = await fs.mkdtemp(path.join(this.deps.tmpDir?.() ?? os.tmpdir(), 'crewly-thumb-'));
      const shot = path.join(dir, 'shot.png');
      const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      const ok = await this.run(binary, browserArgs(shot, path.join(dir, 'profile'), link.url, asRoot), T.TIMEOUT_MS);
      const png = ok ? await fs.readFile(shot).catch(() => null) : null;
      if (!png || png.length < 100) return fail('render_failed', 'The browser did not produce a screenshot.');

      let upload: { data: Buffer; contentType: string } | null = null;
      const small = await this.shrink(shot, path.join(dir, 'small')).catch(() => null);
      if (small) {
        const jpg = await fs.readFile(small).catch(() => null);
        if (jpg && jpg.length <= T.MAX_BYTES) upload = { data: jpg, contentType: 'image/jpeg' };
      }
      if (!upload && png.length <= T.MAX_BYTES) upload = { data: png, contentType: 'image/png' };
      if (!upload) return fail('too_large', 'The screenshot is over the 300 KB limit and no image tool (sips / ImageMagick) is available to shrink it.');

      try {
        await this.deps.client.request('PUT', `/apps/${appId}/thumbnail`, { raw: upload, ...agentOpt });
      } catch (err) {
        return fail('upload_failed', redactOpenLinkTokens(err instanceof Error ? err.message : String(err)));
      }
      this.log.info('Thumbnail uploaded', { appId, bytes: upload.data.length });
      return { ok: true, appId, bytes: upload.data.length };
    } catch (err) {
      return fail('render_failed', redactOpenLinkTokens(err instanceof Error ? err.message : String(err)));
    } finally {
      if (linkId) await this.deps.client.request('DELETE', `/apps/${appId}/open-links/${linkId}`, agentOpt).catch(() => undefined);
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
