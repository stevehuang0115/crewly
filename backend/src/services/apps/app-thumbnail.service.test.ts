/**
 * Tests for AppThumbnailService: browser lookup, the capture pipeline with a
 * fake browser, fallbacks, cleanup, and that the open link never leaks.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AppThumbnailService, browserArgs, findBrowser } from './app-thumbnail.service.js';

const logCalls: unknown[][] = [];
jest.mock('../core/logger.service.js', () => {
  const rec = (...a: unknown[]): void => void logCalls.push(a);
  return { LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: rec, warn: rec, debug: rec, error: rec }) }) } };
});

const ID = '28au74d9cj';
const SECRET_URL = `https://apps.crewlyai.com/${ID}?k=SECRETTOKEN`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5000, 1)]);

let tmp: string;
let request: jest.Mock;

beforeEach(async () => {
  logCalls.length = 0;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-test-'));
  request = jest.fn(async (method: string, p: string) => {
    if (method === 'POST' && p.endsWith('/open-links')) return { linkId: 'lnk_1', url: SECRET_URL, expiresAt: 'e' };
    return { ok: true };
  });
});
afterEach(async () => fs.rm(tmp, { recursive: true, force: true }));

/** A "browser" that writes the screenshot file named in its args. */
const fakeRun = (png: Buffer | null = PNG) =>
  jest.fn(async (_bin: string, args: string[]) => {
    const shot = args.find((a) => a.startsWith('--screenshot='))!.slice('--screenshot='.length);
    if (png) await fs.writeFile(shot, png);
    return png !== null;
  });

const make = (over: Partial<ConstructorParameters<typeof AppThumbnailService>[0]> = {}) =>
  new AppThumbnailService({
    client: { request } as never,
    registry: { list: async () => [], get: async () => null },
    findBrowser: async () => '/fake/chrome',
    run: fakeRun(),
    shrink: async () => null,
    tmpDir: () => tmp,
    ...over,
  });

describe('findBrowser', () => {
  it('uses CREWLY_CHROME_PATH when it is executable, and nothing else when it is not', async () => {
    const bin = path.join(tmp, 'mychrome');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    expect(await findBrowser({ CREWLY_CHROME_PATH: bin, PATH: '' }, 'linux')).toBe(bin);
    expect(await findBrowser({ CREWLY_CHROME_PATH: path.join(tmp, 'nope'), PATH: tmp }, 'linux')).toBeNull();
  });

  it('finds chromium on PATH on Linux', async () => {
    const bin = path.join(tmp, 'chromium');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    expect(await findBrowser({ PATH: tmp }, 'linux')).toBe(bin);
  });

  it('returns null when nothing is installed', async () => {
    expect(await findBrowser({ PATH: tmp }, 'win32')).toBeNull();
  });
});

describe('browserArgs', () => {
  it('is the documented headless screenshot command with the URL last', () => {
    const args = browserArgs('/t/shot.png', '/t/profile', 'https://x/y');
    expect(args).toEqual(expect.arrayContaining(['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=390,844', '--virtual-time-budget=6000', '--screenshot=/t/shot.png', '--user-data-dir=/t/profile']));
    expect(args[args.length - 1]).toBe('https://x/y');
    expect(args).not.toContain('--no-sandbox');
    expect(browserArgs('/a', '/b', 'u', true)).toContain('--no-sandbox');
  });
});

describe('AppThumbnailService.capture', () => {
  it('mints a link, renders it, uploads the PNG as-is when small, revokes the link and removes temp files', async () => {
    const run = fakeRun();
    const svc = make({ run });
    const r = await svc.capture(ID, 'dev-ella');

    expect(r).toEqual({ ok: true, appId: ID, bytes: PNG.length });
    expect(run).toHaveBeenCalledWith('/fake/chrome', expect.arrayContaining([SECRET_URL]), 30_000);
    expect(request).toHaveBeenCalledWith('POST', `/apps/${ID}/open-links`, { body: { ttlDays: 1 }, agent: 'dev-ella' });
    const put = request.mock.calls.find(([m]) => m === 'PUT')!;
    expect(put[1]).toBe(`/apps/${ID}/thumbnail`);
    expect(put[2].raw.contentType).toBe('image/png');
    expect(put[2].raw.data.equals(PNG)).toBe(true);
    expect(request).toHaveBeenLastCalledWith('DELETE', `/apps/${ID}/open-links/lnk_1`, { agent: 'dev-ella' });
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it('uploads the shrunk JPEG when a shrinker is available', async () => {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300, 2)]);
    const svc = make({
      shrink: async (_in, base) => {
        await fs.writeFile(`${base}.jpg`, jpg);
        return `${base}.jpg`;
      },
    });
    await svc.capture(ID);
    const put = request.mock.calls.find(([m]) => m === 'PUT')!;
    expect(put[2].raw).toEqual({ data: jpg, contentType: 'image/jpeg' });
    expect(put[2].agent).toBeUndefined();
  });

  it('skips with no_browser, logging the warning once, and never mints a link', async () => {
    const svc = make({ findBrowser: async () => null });
    expect(await svc.capture(ID)).toMatchObject({ ok: false, reason: 'no_browser' });
    await svc.capture(ID);
    expect(request).not.toHaveBeenCalled();
    expect(logCalls.filter((c) => String(c[0]).includes('No Chrome'))).toHaveLength(1);
  });

  it('reports render_failed when the browser fails or times out, and still revokes the link', async () => {
    const svc = make({ run: fakeRun(null) });
    expect(await svc.capture(ID)).toMatchObject({ ok: false, reason: 'render_failed' });
    expect(request).toHaveBeenCalledWith('DELETE', `/apps/${ID}/open-links/lnk_1`, {});
    expect(request.mock.calls.some(([m]) => m === 'PUT')).toBe(false);
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it('reports too_large when the screenshot is over the cap and cannot be shrunk', async () => {
    const svc = make({ run: fakeRun(Buffer.alloc(301 * 1024, 1)) });
    expect(await svc.capture(ID)).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('reports no_link when Cloud does not return a usable link', async () => {
    request.mockImplementation(async () => ({ linkId: 'l', url: 'https://evil.example/x?k=1' }));
    expect(await make().capture(ID)).toMatchObject({ ok: false, reason: 'no_link' });
  });

  it('reports upload_failed and revokes the link when Cloud refuses the upload', async () => {
    request.mockImplementation(async (m: string, p: string) => {
      if (m === 'PUT') throw new Error(`rejected ${SECRET_URL}`);
      if (p.endsWith('/open-links')) return { linkId: 'lnk_1', url: SECRET_URL, expiresAt: 'e' };
      return {};
    });
    const r = await make().capture(ID);
    expect(r).toMatchObject({ ok: false, reason: 'upload_failed' });
    expect(JSON.stringify(r)).not.toContain('SECRETTOKEN');
    expect(request).toHaveBeenLastCalledWith('DELETE', `/apps/${ID}/open-links/lnk_1`, {});
  });

  it('never writes the open-link token to a log', async () => {
    await make().capture(ID);
    await make({ run: fakeRun(null) }).capture(ID);
    expect(JSON.stringify(logCalls)).not.toContain('SECRETTOKEN');
  });
});

describe('the real process runner', () => {
  it('accepts a browser that writes the screenshot and exits non-zero (Chrome does)', async () => {
    const bin = path.join(tmp, 'fakechrome.sh');
    await fs.writeFile(bin, '#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) printf "\\211PNG-fake-%05000d" 1 > "${a#--screenshot=}";; esac; done\nexit 2\n', { mode: 0o755 });
    const svc = new AppThumbnailService({
      client: { request } as never,
      registry: { list: async () => [], get: async () => null },
      findBrowser: async () => bin,
      shrink: async () => null,
      tmpDir: () => tmp,
    });
    const r = await svc.capture(ID);
    expect(r).toMatchObject({ ok: true, appId: ID });
    expect(request.mock.calls.some(([m]) => m === 'PUT')).toBe(true);
  });
});

describe('scheduling and backfill', () => {
  it('schedule() runs in the background, one at a time, once per app, and never throws', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = jest.fn(async (_b: string, args: string[]) => {
      order.push(args[args.length - 1]!.includes(ID) ? 'a' : 'b');
      await gate;
      const shot = args.find((a) => a.startsWith('--screenshot='))!.slice(13);
      await fs.writeFile(shot, PNG);
      return true;
    });
    request.mockImplementation(async (m: string, p: string) => (m === 'POST' ? { linkId: 'l', url: `https://apps.crewlyai.com/${p.split('/')[2]}?k=T` } : {}));
    const svc = make({ run });
    svc.schedule(ID);
    svc.schedule(ID); // de-duplicated while pending
    svc.schedule('bcdfghjkmn');
    await new Promise((r) => setTimeout(r, 20));
    expect(run).toHaveBeenCalledTimes(1); // the second app waits its turn
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(run).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['a', 'b']);
  });

  it('registeredApps lists live registry apps with their agent; captureAll runs them in order', async () => {
    const svc = make({
      registry: {
        list: async () => [
          { appId: ID, agentSession: 'dev-ella', deleted: false },
          { appId: 'bcdfghjkmn', agentSession: null, deleted: true },
        ] as never,
        get: async () => null,
      },
    });
    expect(await svc.registeredApps()).toEqual([{ appId: ID, agent: 'dev-ella' }]);
    const out = await svc.captureAll([{ appId: ID, agent: 'dev-ella' }]);
    expect(out).toEqual([{ ok: true, appId: ID, bytes: PNG.length }]);
  });
});
