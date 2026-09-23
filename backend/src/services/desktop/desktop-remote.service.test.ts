/**
 * Tests for DesktopRemoteService — the owner watching and driving the desktop remotely.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DesktopRemoteService, OWNER_REMOTE_SESSION, type DesktopRemoteDeps } from './desktop-remote.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

describe('DesktopRemoteService', () => {
  let home: string;
  let run: jest.Mock;

  function service(over: Partial<DesktopRemoteDeps> = {}): DesktopRemoteService {
    return new DesktopRemoteService({
      run,
      home: () => home,
      toJpeg: async (_png, jpg) => {
        await fs.writeFile(jpg, Buffer.from('jpeg-bytes'));
      },
      now: () => 1_800_000_000_000,
      ...over,
    });
  }

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-desk-test-'));
    run = jest.fn(async (input: Record<string, unknown>) => {
      if (input['action'] === 'displays') return { status: 200, body: { success: true, displays: [{ main: true, frame: [0, 0, 1728, 1117] }] } };
      if (input['action'] === 'screenshot') {
        await fs.writeFile(String(input['output']), Buffer.from('png'));
        return { status: 200, body: { action: 'screenshot', width: '1728', height: '1117' } };
      }
      return { status: 200, body: { status: 'ok' } };
    });
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('refuses everything until remote control is switched on at the machine', async () => {
    const svc = service();
    expect(await svc.frame()).toMatchObject({ success: false, reason: 'remote_disabled' });
    expect(await svc.input({ type: 'key', key: 'enter' })).toMatchObject({ success: false, reason: 'remote_disabled' });
    expect(run).not.toHaveBeenCalled();
  });

  it('sends a JPEG of the screen once on', async () => {
    const svc = service();
    await svc.setEnabled(true);

    const frame = await svc.frame(800);

    expect(frame).toMatchObject({ mimeType: 'image/jpeg', width: 800, height: Math.round((1117 / 1728) * 800) });
    expect(Buffer.from((frame as { base64: string }).base64, 'base64').toString()).toBe('jpeg-bytes');
    // Captured as the owner, so the banner and audit log say who it was.
    expect(run.mock.calls[0][1]).toBe(OWNER_REMOTE_SESSION);
  });

  it('passes a locked screen through as a refusal rather than a picture', async () => {
    run.mockResolvedValueOnce({ status: 409, body: { success: false, reason: 'screen_locked', message: 'The screen is locked.' } });
    const svc = service();
    await svc.setEnabled(true);
    expect(await svc.frame()).toMatchObject({ success: false, reason: 'screen_locked' });
  });

  it('turns a tap on the picture into a click on the screen', async () => {
    const svc = service();
    await svc.setEnabled(true);

    await svc.input({ type: 'click', x: 0.5, y: 0.25 });

    const click = run.mock.calls.find(([input]) => input.action === 'click')!;
    expect(click[0]).toEqual({ action: 'click', x: 864, y: 279, button: 'left' });
    expect(click[1]).toBe(OWNER_REMOTE_SESSION);
  });

  it('maps keys, typing and scrolling, and rejects malformed input', async () => {
    const svc = service();
    expect(await svc.toSkillPayload({ type: 'key', key: 'cmd+R' })).toEqual({ action: 'key', key: 'cmd+r' });
    // Mouse mode moves the real pointer, so hover states show.
    expect(await svc.toSkillPayload({ type: 'move', x: 0.5, y: 0.5 })).toEqual({ action: 'move', x: 864, y: 559 });
    expect(await svc.toSkillPayload({ type: 'move', x: -1, y: 0 })).toMatchObject({ success: false, reason: 'validation' });
    expect(await svc.toSkillPayload({ type: 'type', text: 'hello' })).toEqual({ action: 'type', text: 'hello' });
    // A swipe further down the page is a negative CoreGraphics scroll.
    expect(await svc.toSkillPayload({ type: 'scroll', x: 0, y: 0, dy: 3 })).toMatchObject({ action: 'scroll', dy: -3 });
    expect(await svc.toSkillPayload({ type: 'click', x: 2, y: 0 })).toMatchObject({ success: false, reason: 'validation' });
    expect(await svc.toSkillPayload({ type: 'key', key: 'rm -rf /' })).toMatchObject({ success: false, reason: 'validation' });
  });
});
