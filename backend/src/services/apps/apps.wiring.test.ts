/**
 * Tests for the Crewly Apps wiring — instance id source, shared parts,
 * poller start (delivery split, ask resolution), card notifier.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const mockRegistry = { getInstanceId: jest.fn(), resolveInstanceId: jest.fn() };
jest.mock('../slack/slack-instance-registry.service.js', () => ({
  getSlackInstanceRegistryService: jest.fn(() => mockRegistry),
}));
const mockDeliverReply = jest.fn();
jest.mock('../orc/reply-destination.wiring.js', () => ({ deliverReply: (...a: unknown[]) => mockDeliverReply(...a) }));
jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

import { getSlackInstanceRegistryService } from '../slack/slack-instance-registry.service.js';
import { currentInstanceId, getAppsParts, setAppsParts, startAppWake, stopAppWake } from './apps.wiring.js';
import { AppWakeService } from './app-wake.service.js';

let home: string;
const prevHome = process.env.CREWLY_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'apps-wiring-'));
  process.env.CREWLY_HOME = home;
  setAppsParts(null);
  mockRegistry.getInstanceId.mockReset();
  mockRegistry.resolveInstanceId.mockReset();
  mockDeliverReply.mockReset();
});

afterEach(async () => {
  stopAppWake();
  setAppsParts(null);
  if (prevHome === undefined) delete process.env.CREWLY_HOME;
  else process.env.CREWLY_HOME = prevHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe('currentInstanceId', () => {
  it('uses the resolved id, else resolves it, else null without a registry', async () => {
    mockRegistry.getInstanceId.mockReturnValueOnce('inst-1');
    expect(await currentInstanceId()).toBe('inst-1');

    mockRegistry.getInstanceId.mockReturnValueOnce(null);
    mockRegistry.resolveInstanceId.mockResolvedValueOnce('inst-2');
    expect(await currentInstanceId()).toBe('inst-2');

    (getSlackInstanceRegistryService as jest.Mock).mockReturnValueOnce(null);
    expect(await currentInstanceId()).toBeNull();
  });
});

describe('getAppsParts', () => {
  it('builds once and keeps the registry under CREWLY_HOME', async () => {
    const a = getAppsParts();
    expect(getAppsParts()).toBe(a);
    await a.registry.upsert('28au74d9cj', { name: 'G' });
    await expect(fs.stat(path.join(home, 'apps', 'registry.json'))).resolves.toBeTruthy();
  });

  it('posts the card through deliverReply as a new message', async () => {
    const { service } = getAppsParts();
    mockDeliverReply.mockResolvedValueOnce({ ok: false, error: 'nowhere to reply' });
    // Reach the private notifier through a publish with a stubbed client.
    const parts = getAppsParts() as unknown as { client: { request: jest.Mock } };
    parts.client.request = jest.fn(async (m: string, p: string) =>
      m === 'POST' && p === '/apps' ? { appId: '28au74d9cj', name: 'G', url: 'u' } : { version: 1 },
    );
    const out = await service.publish({ files: [{ path: 'index.html', contentBase64: 'eA==' }], name: 'G', notify: true }, { agentSession: 'dev-ella' });
    expect(mockDeliverReply).toHaveBeenCalledWith({ session: 'dev-ella', content: '📱 G · [Open app](https://apps.crewlyai.com/28au74d9cj)', addsNew: true });
    expect(out).toMatchObject({ notified: false, notifyError: 'nowhere to reply' });
  });
});

describe('startAppWake', () => {
  it('starts once, routes null to the orchestrator and resolves ask targets by session or name', async () => {
    const sendToAgent = jest.fn().mockResolvedValue(true);
    const sendToOrchestrator = jest.fn().mockResolvedValue(true);
    const getTeams = jest.fn().mockResolvedValue([{ members: [{ sessionName: 'team-dev-bob', name: 'Bob' }, { name: 'no session' }] }, {}]);
    const start = jest.spyOn(AppWakeService.prototype, 'start').mockImplementation(() => undefined);

    const wake = startAppWake({ skillsPath: '/s', sendToAgent, sendToOrchestrator, getTeams });
    expect(startAppWake({ skillsPath: '/s', sendToAgent, sendToOrchestrator, getTeams })).toBe(wake);
    expect(start).toHaveBeenCalledTimes(1);

    const deps = (wake as unknown as { deps: { deliver: (s: string | null, t: string) => Promise<boolean>; resolveAgent: (n: string) => Promise<string | null> } }).deps;
    await deps.deliver(null, 'x');
    expect(sendToOrchestrator).toHaveBeenCalledWith('x');
    await deps.deliver('dev-ella', 'y');
    expect(sendToAgent).toHaveBeenCalledWith('dev-ella', 'y');
    expect(await deps.resolveAgent(' bob ')).toBe('team-dev-bob');
    expect(await deps.resolveAgent('TEAM-DEV-BOB')).toBe('team-dev-bob');
    expect(await deps.resolveAgent('nobody')).toBeNull();
    start.mockRestore();
  });
});
