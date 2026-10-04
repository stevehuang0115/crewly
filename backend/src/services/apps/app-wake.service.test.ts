/**
 * Tests for AppWakeService — owner-only filter, batching window, cooldown,
 * ask routing, cursor handling (head start, persistence while a batch is
 * pending), 404 → deleted, error backoff.
 */

import { AppWakeService, type AppWakeClient } from './app-wake.service.js';
import { AppsCloudError } from './apps-cloud.client.js';
import type { AppRegistryEntry, AppsRegistryService } from './apps-registry.service.js';
import type { AppChange } from './app-wake-message.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const ID = '28au74d9cj';
const MIN = 60_000;

class FakeRegistry {
  apps = new Map<string, AppRegistryEntry>();
  add(appId: string, patch: Partial<AppRegistryEntry> = {}): void {
    this.apps.set(appId, {
      appId,
      name: 'Groceries',
      url: `https://apps.crewlyai.com/${appId}`,
      agentSession: 'dev-ella',
      source: null,
      currentVersion: 1,
      cursor: 0,
      createdAt: 't',
      updatedAt: 't',
      ...patch,
    });
  }
  async list() {
    return [...this.apps.values()].map((e) => ({ ...e }));
  }
  async get(id: string) {
    const e = this.apps.get(id);
    return e ? { ...e } : null;
  }
  async setCursor(id: string, cursor: number) {
    const e = this.apps.get(id);
    if (e) e.cursor = cursor;
  }
  async markDeleted(id: string) {
    const e = this.apps.get(id);
    if (e) e.deleted = true;
  }
}

/** A Cloud change log per app, served like GET /apps/:id/changes. */
class FakeCloud implements AppWakeClient {
  log = new Map<string, AppChange[]>();
  available = true;
  failWith: Error | null = null;
  calls: Array<{ path: string; query?: Record<string, string | number | undefined> }> = [];
  isAvailable() {
    return this.available;
  }
  push(appId: string, c: Omit<AppChange, 'seq'>): number {
    const list = this.log.get(appId) ?? [];
    const seq = list.length + 1;
    list.push({ ...c, seq } as AppChange);
    this.log.set(appId, list);
    return seq;
  }
  async request<T>(_m: string, path: string, opts?: { query?: Record<string, string | number | undefined> }): Promise<T> {
    this.calls.push({ path, query: opts?.query });
    if (this.failWith) throw this.failWith;
    const appId = path.split('/')[2];
    const list = this.log.get(appId) ?? [];
    const head = list.length;
    if (opts?.query?.since === undefined) return { changes: [], seq: head } as T;
    const since = Number(opts.query.since);
    const page = list.filter((c) => c.seq > since).slice(0, 200);
    return { changes: page, seq: page.length ? page[page.length - 1].seq : since } as T;
  }
}

const ownerData = (docId = 'milk', op = 'update') => ({ kind: 'data', collection: 'items', docId, op, rev: 2, actor: { kind: 'owner', id: 'u1' }, at: '2026-10-04T14:00:00.000Z' });
const agentData = (id = 'dev-ella') => ({ kind: 'data', collection: 'items', docId: 'x', op: 'set', rev: 1, actor: { kind: 'agent', id, instanceId: 'i' }, at: '2026-10-04T14:00:00.000Z' });
const ownerEvent = (type: string, text: string, agent?: string) => ({ kind: 'event', event: { type, text, ...(agent ? { agent } : {}) }, actor: { kind: 'owner', id: 'u1' }, at: '2026-10-04T14:00:00.000Z' });

let registry: FakeRegistry;
let cloud: FakeCloud;
let deliver: jest.Mock;
let resolveAgent: jest.Mock;
let svc: AppWakeService;

beforeEach(() => {
  jest.useFakeTimers();
  registry = new FakeRegistry();
  cloud = new FakeCloud();
  deliver = jest.fn().mockResolvedValue(true);
  resolveAgent = jest.fn().mockResolvedValue(null);
  svc = new AppWakeService({
    client: cloud,
    registry: registry as unknown as AppsRegistryService,
    deliver,
    resolveAgent,
    skillsPath: '/skills/agent',
  });
});

afterEach(() => {
  svc.stop();
  jest.useRealTimers();
});

describe('AppWakeService', () => {
  it('starts an app without a cursor from the head, never replaying history', async () => {
    registry.add(ID, { cursor: null });
    cloud.push(ID, ownerData());
    cloud.push(ID, ownerData('eggs'));

    await svc.tick();

    expect(registry.apps.get(ID)?.cursor).toBe(2);
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('batches owner changes within the window into one message to the publisher', async () => {
    registry.add(ID);
    cloud.push(ID, ownerData('milk'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(30_000);
    cloud.push(ID, ownerData('eggs', 'set'));
    cloud.push(ID, ownerEvent('notify', 'List ready'));
    await svc.tick();

    expect(deliver).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [session, text] = deliver.mock.calls[0];
    expect(session).toBe('dev-ella');
    expect(text).toContain('[APP CHANGES] The owner changed your app "Groceries"');
    expect(text).toContain('Data changes by the owner (2): items/milk updated (rev 2) · items/eggs set (rev 2)');
    expect(text).toContain('    | List ready');
    expect(registry.apps.get(ID)?.cursor).toBe(3);
  });

  it("never wakes for agent writes, the agent's own included", async () => {
    registry.add(ID);
    cloud.push(ID, agentData('dev-ella'));
    cloud.push(ID, agentData('dev-bob'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);

    expect(deliver).not.toHaveBeenCalled();
    expect(svc.pendingKeys()).toEqual([]);
    expect(registry.apps.get(ID)?.cursor).toBe(2);
  });

  it('holds the next wake until the cooldown ends and sends it as one message', async () => {
    registry.add(ID);
    cloud.push(ID, ownerData('a'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);

    cloud.push(ID, ownerData('b'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(2 * MIN);
    cloud.push(ID, ownerData('c'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(2 * MIN); // 4 min after the first wake
    expect(deliver).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(MIN + 1000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][1]).toContain('(2): items/b updated (rev 2) · items/c updated (rev 2)');
  });

  it('keeps the persisted cursor before a pending batch so a restart re-reads it', async () => {
    registry.add(ID, { cursor: 0 });
    cloud.push(ID, agentData());
    cloud.push(ID, ownerData());
    cloud.push(ID, agentData());
    await svc.tick();

    expect(svc.pendingKeys()).toHaveLength(1);
    expect(registry.apps.get(ID)?.cursor).toBe(1);

    await jest.advanceTimersByTimeAsync(90_000);
    expect(registry.apps.get(ID)?.cursor).toBe(3);
  });

  it('routes an ask to the named agent when it exists on this instance', async () => {
    registry.add(ID);
    resolveAgent.mockImplementation(async (name: string) => (name === 'Bob' ? 'dev-bob' : null));
    cloud.push(ID, ownerEvent('ask', 'can you check prices?', 'Bob'));
    cloud.push(ID, ownerEvent('ask', 'hello?', 'Nobody'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);

    expect(deliver).toHaveBeenCalledTimes(2);
    const bySession = Object.fromEntries(deliver.mock.calls.map(([s, t]) => [s, t]));
    expect(bySession['dev-bob']).toContain(`[APP CHANGES] The owner's app "Groceries" (${ID}) addressed you`);
    expect(bySession['dev-bob']).toContain('can you check prices?');
    expect(bySession['dev-ella']).toContain('hello?');
  });

  it('wakes the orchestrator when no agent is recorded', async () => {
    registry.add(ID, { agentSession: null });
    cloud.push(ID, ownerEvent('notify', 'hi'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledWith(null, expect.stringContaining('[APP CHANGES]'));
  });

  it('ignores unknown change kinds and event types', async () => {
    registry.add(ID);
    cloud.push(ID, { kind: 'mystery', actor: { kind: 'owner' } } as unknown as AppChange);
    cloud.push(ID, ownerEvent('shout', 'x'));
    await svc.tick();
    expect(svc.pendingKeys()).toEqual([]);
  });

  it('reads several pages in one tick', async () => {
    registry.add(ID);
    for (let i = 0; i < 450; i++) cloud.push(ID, agentData());
    await svc.tick();
    expect(registry.apps.get(ID)?.cursor).toBe(450);
    expect(cloud.calls.filter((c) => c.query?.since !== undefined)).toHaveLength(3);
  });

  it('marks an app deleted on 404 and stops polling it', async () => {
    registry.add(ID);
    cloud.failWith = new AppsCloudError(404, 'not_found', 'App not found.');
    await svc.tick();
    expect(registry.apps.get(ID)?.deleted).toBe(true);
    expect(svc.currentDelayMs()).toBe(30_000);

    cloud.failWith = null;
    cloud.calls = [];
    await svc.tick();
    expect(cloud.calls).toHaveLength(0);
  });

  it('backs off on errors up to the ceiling and resets on success', async () => {
    registry.add(ID);
    cloud.failWith = new AppsCloudError(502, 'network', 'down');
    await svc.tick();
    expect(svc.currentDelayMs()).toBe(60_000);
    await svc.tick();
    await svc.tick();
    await svc.tick();
    await svc.tick();
    expect(svc.currentDelayMs()).toBe(5 * MIN);

    cloud.failWith = null;
    await svc.tick();
    expect(svc.currentDelayMs()).toBe(30_000);
  });

  it('skips the tick quietly when not signed in to Cloud', async () => {
    registry.add(ID);
    cloud.available = false;
    await svc.tick();
    expect(cloud.calls).toHaveLength(0);
  });

  it('polls on its own schedule after start()', async () => {
    registry.add(ID);
    cloud.push(ID, ownerData());
    svc.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(svc.pendingKeys()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('logs and survives a failed delivery', async () => {
    registry.add(ID);
    deliver.mockRejectedValueOnce(new Error('pty gone'));
    cloud.push(ID, ownerData());
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(svc.pendingKeys()).toEqual([]);
    expect(registry.apps.get(ID)?.cursor).toBe(1);
  });
});
