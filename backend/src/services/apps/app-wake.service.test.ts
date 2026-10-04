/**
 * Tests for AppWakeService — owner-only filter, batching window, cooldown
 * (also across a restart), ask routing (publisher's team, running only),
 * cursor handling (head start, pending batches, no duplicates after a
 * restart), delivery retries + orchestrator notice, batch caps, per-app
 * backoff, request timeout and bounded concurrency.
 */

import { AppWakeService, ORC_RECIPIENT, type AppWakeClient } from './app-wake.service.js';
import { AppsCloudError } from './apps-cloud.client.js';
import type { AppRegistryEntry, AppsRegistryService } from './apps-registry.service.js';
import type { AppChange } from './app-wake-message.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const ID = '28au74d9cj';
const ID2 = 'xyzabcdefg';
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
  async setProgress(id: string, cursor: number, delivered: number[]) {
    const e = this.apps.get(id);
    if (!e) return;
    e.cursor = cursor;
    e.delivered = delivered.filter((n) => n > cursor).sort((a, b) => a - b);
  }
  async setLastWake(id: string, recipient: string, at: number) {
    const e = this.apps.get(id);
    if (e) e.wakes = { ...(e.wakes ?? {}), [recipient]: at };
  }
  async markDeleted(id: string) {
    const e = this.apps.get(id);
    if (e) e.deleted = true;
  }
}

type Query = Record<string, string | number | undefined>;

/** A Cloud change log per app, served like GET /apps/:id/changes. */
class FakeCloud implements AppWakeClient {
  log = new Map<string, AppChange[]>();
  available = true;
  failFor = new Map<string, Error>();
  hang: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;
  calls: Array<{ path: string; query?: Query; timeoutMs?: number }> = [];
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
  async request<T>(_m: string, path: string, opts?: { query?: Query; timeoutMs?: number }): Promise<T> {
    this.calls.push({ path, query: opts?.query, timeoutMs: opts?.timeoutMs });
    const appId = path.split('/')[2];
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.hang) await this.hang;
      const fail = this.failFor.get(appId);
      if (fail) throw fail;
      const list = this.log.get(appId) ?? [];
      if (opts?.query?.since === undefined) return { changes: [], seq: list.length } as T;
      const since = Number(opts.query.since);
      const page = list.filter((c) => c.seq > since).slice(0, 200);
      return { changes: page, seq: page.length ? page[page.length - 1].seq : since } as T;
    } finally {
      this.inFlight--;
    }
  }
}

const ownerData = (docId = 'milk', op = 'update') => ({ kind: 'data', collection: 'items', docId, op, rev: 2, actor: { kind: 'owner', id: 'u1' }, at: '2026-10-04T14:00:00.000Z' });
const agentData = (id = 'dev-ella') => ({ kind: 'data', collection: 'items', docId: 'x', op: 'set', rev: 1, actor: { kind: 'agent', id, instanceId: 'i' }, at: '2026-10-04T14:00:00.000Z' });
const ownerEvent = (type: string, text: string, agent?: string) => ({ kind: 'event', event: { type, text, ...(agent ? { agent } : {}) }, actor: { kind: 'owner', id: 'u1' }, at: '2026-10-04T14:00:00.000Z' });

let registry: FakeRegistry;
let cloud: FakeCloud;
let deliver: jest.Mock;
let resolveAgent: jest.Mock;
let running: Set<string>;
let svc: AppWakeService;

function makeService(): AppWakeService {
  return new AppWakeService({
    client: cloud,
    registry: registry as unknown as AppsRegistryService,
    deliver,
    resolveAgent,
    isRunning: (s) => running.has(s),
    skillsPath: '/skills/agent',
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  registry = new FakeRegistry();
  cloud = new FakeCloud();
  deliver = jest.fn().mockResolvedValue(true);
  resolveAgent = jest.fn().mockResolvedValue(null);
  running = new Set();
  svc = makeService();
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

  it('batches owner changes within the window into one message to the publisher, which may be started', async () => {
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
    const [session, text, opts] = deliver.mock.calls[0];
    expect(session).toBe('dev-ella');
    expect(opts).toEqual({ activate: true });
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
    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect(deliver).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(MIN + 1000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][1]).toContain('(2): items/b updated (rev 2) · items/c updated (rev 2)');
  });

  it('keeps the cooldown across a restart (persisted last wake)', async () => {
    registry.add(ID);
    cloud.push(ID, ownerData('a'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(registry.apps.get(ID)?.wakes?.['dev-ella']).toBe(Date.now());

    svc.stop();
    svc = makeService(); // restart: no in-memory state
    cloud.push(ID, ownerData('b'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000 + 1000);
    expect(deliver).toHaveBeenCalledTimes(1); // still cooling down
    await jest.advanceTimersByTimeAsync(4 * MIN);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('persists the cursor before a pending batch so a restart re-reads it', async () => {
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

  it('does not redeliver a batch that went out while another one for the same app was pending (restart)', async () => {
    registry.add(ID, { cursor: 0 });
    // A recent wake for dev-ella: its next batch waits for the cooldown…
    const entry = registry.apps.get(ID);
    if (entry) entry.wakes = { 'dev-ella': Date.now() };
    running.add('dev-bob');
    resolveAgent.mockImplementation(async (name: string) => (name === 'Bob' ? 'dev-bob' : null));
    cloud.push(ID, ownerData('a')); // seq 1 → dev-ella (cooling down)
    cloud.push(ID, ownerEvent('ask', 'hi bob', 'Bob')); // seq 2 → dev-bob (90 s)
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe('dev-bob');
    expect(registry.apps.get(ID)).toMatchObject({ cursor: 0, delivered: [2] });

    svc.stop();
    svc = makeService();
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    const bob = deliver.mock.calls.filter(([s]) => s === 'dev-bob');
    expect(bob).toHaveLength(1); // not again
    expect(deliver.mock.calls.filter(([s]) => s === 'dev-ella')).toHaveLength(1);
    expect(registry.apps.get(ID)).toMatchObject({ cursor: 2 });
  });

  it('routes an ask only to a running agent of the publisher’s team; never starts it', async () => {
    registry.add(ID);
    resolveAgent.mockImplementation(async (name: string, publisher: string) => {
      expect(publisher).toBe('dev-ella');
      return name === 'Bob' ? 'dev-bob' : name === 'Sleepy' ? 'dev-sleepy' : null;
    });
    running.add('dev-bob');
    cloud.push(ID, ownerEvent('ask', 'can you check prices?', 'Bob'));
    cloud.push(ID, ownerEvent('ask', 'wake up', 'Sleepy'));
    cloud.push(ID, ownerEvent('ask', 'hello?', 'Outsider'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);

    expect(deliver).toHaveBeenCalledTimes(2);
    const calls = Object.fromEntries(deliver.mock.calls.map(([s, t, o]) => [s, { t, o }]));
    expect(calls['dev-bob'].o).toEqual({ activate: false });
    expect(calls['dev-bob'].t).toContain('addressed you');
    expect(calls['dev-ella'].t).toContain('wake up');
    expect(calls['dev-ella'].t).toContain('hello?');
    expect(calls['dev-sleepy']).toBeUndefined();
  });

  it('wakes the orchestrator when no agent is recorded', async () => {
    registry.add(ID, { agentSession: null });
    cloud.push(ID, ownerEvent('ask', 'hi', 'Bob'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledWith(null, expect.stringContaining('[APP CHANGES]'), { activate: true });
    expect(resolveAgent).not.toHaveBeenCalled();
    expect(registry.apps.get(ID)?.wakes?.[ORC_RECIPIENT]).toBeDefined();
  });

  it('on delivery failure keeps the cursor, retries with backoff and tells the orchestrator once', async () => {
    registry.add(ID);
    deliver.mockImplementation(async (s: string | null) => s === null);
    cloud.push(ID, ownerData());
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000); // try 1
    expect(registry.apps.get(ID)?.cursor).toBe(0);
    expect(svc.pendingKeys()).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(MIN); // try 2
    await jest.advanceTimersByTimeAsync(2 * MIN); // try 3 → orc notice
    const toElla = () => deliver.mock.calls.filter(([s]) => s === 'dev-ella').length;
    expect(toElla()).toBe(3);
    const orc = deliver.mock.calls.filter(([s]) => s === null);
    expect(orc).toHaveLength(1);
    expect(orc[0][1]).toContain('could not be delivered to dev-ella after 3 tries');

    await jest.advanceTimersByTimeAsync(4 * MIN); // try 4 — no second notice
    expect(toElla()).toBe(4);
    expect(deliver.mock.calls.filter(([s]) => s === null)).toHaveLength(1);

    deliver.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(8 * MIN);
    expect(toElla()).toBe(5);
    expect(svc.pendingKeys()).toEqual([]);
    expect(registry.apps.get(ID)?.cursor).toBe(1);
  });

  it('caps what a batch keeps while counting everything', async () => {
    registry.add(ID);
    for (let i = 0; i < 230; i++) cloud.push(ID, ownerData(`d${i}`, 'set'));
    for (let i = 0; i < 25; i++) cloud.push(ID, ownerEvent('notify', `n${i}`));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    const text: string = deliver.mock.calls[0][1];
    expect(text).toContain('Data changes by the owner (230)');
    expect(text).toContain('plus 30 earlier change(s) not listed');
    expect(text).toContain('Messages the app sent (25)');
    expect(text).toContain('| n24');
    expect(text).not.toContain('| n0\n');
  });

  it('ignores unknown change kinds and event types', async () => {
    registry.add(ID);
    cloud.push(ID, { kind: 'mystery', actor: { kind: 'owner' } } as unknown as AppChange);
    cloud.push(ID, ownerEvent('shout', 'x'));
    await svc.tick();
    expect(svc.pendingKeys()).toEqual([]);
  });

  it('reads several pages in one tick, with the short request timeout', async () => {
    registry.add(ID);
    for (let i = 0; i < 450; i++) cloud.push(ID, agentData());
    await svc.tick();
    expect(registry.apps.get(ID)?.cursor).toBe(450);
    expect(cloud.calls).toHaveLength(3);
    expect(cloud.calls.every((c) => c.timeoutMs === 20_000)).toBe(true);
  });

  it('marks an app deleted on 404 and stops polling it', async () => {
    registry.add(ID);
    cloud.failFor.set(ID, new AppsCloudError(404, 'not_found', 'App not found.'));
    await svc.tick();
    expect(registry.apps.get(ID)?.deleted).toBe(true);
    cloud.calls = [];
    await svc.tick();
    expect(cloud.calls).toHaveLength(0);
  });

  it('backs off per app: a failing app waits, the others keep polling', async () => {
    registry.add(ID);
    registry.add(ID2);
    cloud.failFor.set(ID, new AppsCloudError(502, 'network', 'down'));
    await svc.tick();
    expect(svc.appBackoff(ID)).toMatchObject({ failures: 1 });
    expect(svc.appBackoff(ID2)).toBeNull();

    cloud.calls = [];
    await jest.advanceTimersByTimeAsync(30_000);
    await svc.tick(); // ID not due yet (60 s backoff)
    expect(cloud.calls.map((c) => c.path.split('/')[2])).toEqual([ID2]);

    await jest.advanceTimersByTimeAsync(31_000);
    await svc.tick();
    expect(svc.appBackoff(ID)).toMatchObject({ failures: 2 });

    for (let i = 0; i < 6; i++) {
      await jest.advanceTimersByTimeAsync(5 * MIN);
      await svc.tick();
    }
    const b = svc.appBackoff(ID);
    expect(b).not.toBeNull();
    expect((b?.nextAt ?? Infinity) - Date.now()).toBeLessThanOrEqual(5 * MIN);

    cloud.failFor.clear();
    await jest.advanceTimersByTimeAsync(5 * MIN);
    await svc.tick();
    expect(svc.appBackoff(ID)).toBeNull();
  });

  it('polls at most 4 apps at a time', async () => {
    const ids = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee', 'ffffffffff', 'gggggggggg'];
    for (const id of ids) registry.add(id);
    let release!: () => void;
    cloud.hang = new Promise<void>((r) => (release = r));
    const t = svc.tick();
    await jest.advanceTimersByTimeAsync(0);
    expect(cloud.inFlight).toBe(4);
    release();
    cloud.hang = null;
    await t;
    expect(cloud.maxInFlight).toBe(4);
    expect(new Set(cloud.calls.map((c) => c.path)).size).toBe(7);
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
});

describe('AppWakeService — anonymous visitor submissions (P3)', () => {
  const visitorData = (docId: string, collection = 'votes') => ({
    kind: 'data',
    collection,
    docId,
    op: 'set',
    rev: 1,
    actor: { kind: 'visitor', id: 'anonymous' },
    at: '2026-10-04T14:00:00.000Z',
  });

  it('wakes the publisher like owner changes, in the same batch, labelled apart and UNTRUSTED', async () => {
    registry.add(ID);
    cloud.push(ID, visitorData('v1'));
    cloud.push(ID, ownerData('milk'));
    cloud.push(ID, visitorData('v2'));
    cloud.push(ID, agentData('dev-ella'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [session, text, opts] = deliver.mock.calls[0];
    expect(session).toBe('dev-ella');
    expect(opts).toEqual({ activate: true });
    expect(text).toContain('Data changes by the owner (1): items/milk updated (rev 2)');
    expect(text).toContain('Anonymous submissions from public visitors (2): votes/v1 added · votes/v2 added');
    expect(text).toContain('UNTRUSTED: written by anonymous visitors on the public internet');
    expect(registry.apps.get(ID)?.cursor).toBe(4);
  });

  it('visitor-only batches say so in the header and follow the cooldown', async () => {
    registry.add(ID);
    cloud.push(ID, visitorData('v1'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toMatch(/^\[APP CHANGES\] Public visitors submitted to your app "Groceries"/);

    cloud.push(ID, visitorData('v2'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect(deliver).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3 * MIN + 1000);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('ignores anything a visitor sends that is not data', async () => {
    registry.add(ID);
    cloud.push(ID, { kind: 'event', event: { type: 'notify', text: 'hi' }, actor: { kind: 'visitor', id: 'anonymous' }, at: 't' });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).not.toHaveBeenCalled();
  });
});
