/**
 * Tests for AppWakeService — owner-only filter, batching window, cooldown
 * (also across a restart), ask routing (publisher's team, running only),
 * cursor handling (head start, pending batches, no duplicates after a
 * restart), delivery retries + orchestrator notice, batch caps, per-app
 * backoff, request timeout and bounded concurrency.
 */

import { AppWakeService, ORC_RECIPIENT, type AppWakeClient, type MentionItem } from './app-wake.service.js';
import { AppsCloudError } from './apps-cloud.client.js';
import type { AppRegistryEntry, AppsRegistryService } from './apps-registry.service.js';
import type { AppChange, AppCommentThread } from './app-wake-message.js';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';

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
  async setVisitorWakes(id: string, state: { day: string; count: number; skipped: number }) {
    const e = this.apps.get(id);
    if (e) e.visitorWakes = { ...state };
  }
  async markDeleted(id: string) {
    const e = this.apps.get(id);
    if (e) e.deleted = true;
  }
  mentionProgress: { cursor: number | null; delivered: number[] } = { cursor: null, delivered: [] };
  async getMentionProgress() {
    return { cursor: this.mentionProgress.cursor, delivered: [...this.mentionProgress.delivered] };
  }
  async setMentionProgress(cursor: number, delivered: number[]) {
    this.mentionProgress = { cursor, delivered: delivered.filter((n) => n > cursor).sort((a, b) => a - b) };
  }
}

type Query = Record<string, string | number | undefined>;

/** A Cloud change log per app, served like GET /apps/:id/changes. */
class FakeCloud implements AppWakeClient {
  log = new Map<string, AppChange[]>();
  available = true;
  failFor = new Map<string, Error>();
  hang: Promise<void> | null = null;
  /** Apps whose next request never settles (removed once used) */
  hangOnce = new Set<string>();
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
  /** This instance's mention inbox (GET /mentions); not recorded in `calls` */
  inbox: MentionItem[] = [];
  inboxCalls: Array<Query | undefined> = [];
  inboxFail: Error | null = null;
  mention(item: Omit<MentionItem, 'seq'>): number {
    const seq = this.inbox.length + 1;
    this.inbox.push({ ...item, seq });
    return seq;
  }
  async request<T>(_m: string, path: string, opts?: { query?: Query; timeoutMs?: number }): Promise<T> {
    if (path === '/mentions') {
      this.inboxCalls.push(opts?.query);
      if (this.inboxFail) throw this.inboxFail;
      if (opts?.query?.since === undefined) return { mentions: [], seq: this.inbox.length } as T;
      const since = Number(opts.query.since);
      const page = this.inbox.filter((m) => m.seq > since).slice(0, 100);
      return { mentions: page, seq: page.length ? page[page.length - 1].seq : since } as T;
    }
    this.calls.push({ path, query: opts?.query, timeoutMs: opts?.timeoutMs });
    const appId = path.split('/')[2];
    if (this.hangOnce.delete(appId)) return new Promise<T>(() => undefined);
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
    expect(opts).toMatchObject({ activate: true });
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
    expect(calls['dev-bob'].o).toMatchObject({ activate: false });
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
    expect(deliver).toHaveBeenCalledWith(null, expect.stringContaining('[APP CHANGES]'), expect.objectContaining({ activate: true }));
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
    // Stopped publisher: the owner change in the batch may start it (P2), the visitors' may not.
    cloud.push(ID, visitorData('v1'));
    cloud.push(ID, ownerData('milk'));
    cloud.push(ID, visitorData('v2'));
    cloud.push(ID, agentData('dev-ella'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [session, text, opts] = deliver.mock.calls[0];
    expect(session).toBe('dev-ella');
    expect(opts).toMatchObject({ activate: true });
    expect(text).toContain('Data changes by the owner (1): items/milk updated (rev 2)');
    expect(text).toContain('Anonymous submissions from public visitors (2): votes/v1 added · votes/v2 added');
    expect(text).toContain('UNTRUSTED: written by anonymous visitors on the public internet');
    expect(registry.apps.get(ID)?.cursor).toBe(4);
  });

  it('visitor-only batches say so in the header and follow the cooldown', async () => {
    registry.add(ID);
    running.add('dev-ella');
    cloud.push(ID, visitorData('v1'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toMatch(/^\[APP CHANGES\] Public visitors submitted to your app "Groceries"/);
    expect(deliver.mock.calls[0][2]).toMatchObject({ activate: false });

    cloud.push(ID, visitorData('v2'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect(deliver).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3 * MIN + 1000);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('never starts a stopped publisher for visitors: the batch waits, pending, until it runs', async () => {
    registry.add(ID);
    cloud.push(ID, visitorData('v1'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(30 * MIN);
    expect(deliver).not.toHaveBeenCalled();
    expect(svc.pendingKeys()).toEqual([`${ID}\u0000dev-ella`]);
    // The cursor stays before the pending submission, so a restart re-reads it.
    await svc.tick();
    expect(registry.apps.get(ID)?.cursor).toBe(0);

    running.add('dev-ella');
    await jest.advanceTimersByTimeAsync(CREWLY_APPS_CONSTANTS.VISITOR_WAKE.PENDING_RECHECK_MS);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe('dev-ella');
    expect(deliver.mock.calls[0][2]).toMatchObject({ activate: false });
    expect(deliver.mock.calls[0][1]).toContain('Anonymous submissions from public visitors (1): votes/v1 added');
  });

  it('an owner change joining a waiting visitor batch starts the publisher as in P2', async () => {
    registry.add(ID);
    cloud.push(ID, visitorData('v1'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(5 * MIN);
    expect(deliver).not.toHaveBeenCalled();
    cloud.push(ID, ownerData('milk'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(CREWLY_APPS_CONSTANTS.VISITOR_WAKE.PENDING_RECHECK_MS);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][2]).toMatchObject({ activate: true });
    expect(deliver.mock.calls[0][1]).toContain('Data changes by the owner (1)');
    expect(deliver.mock.calls[0][1]).toContain('Anonymous submissions from public visitors (1)');
  });

  it('caps visitor-triggered wakes per app per UTC day; the next message says how many were skipped', async () => {
    const cap = CREWLY_APPS_CONSTANTS.VISITOR_WAKE.MAX_PER_DAY;
    jest.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
    registry.add(ID);
    running.add('dev-ella');
    for (let i = 0; i < cap; i++) {
      cloud.push(ID, visitorData(`v${i}`));
      await svc.tick();
      await jest.advanceTimersByTimeAsync(5 * MIN + 1000);
    }
    expect(deliver).toHaveBeenCalledTimes(cap);
    expect(registry.apps.get(ID)?.visitorWakes).toEqual({ day: '2026-10-04', count: cap, skipped: 0 });

    // Over the cap: counted, not delivered, and the cursor moves past them.
    for (let i = 0; i < 3; i++) cloud.push(ID, visitorData(`over${i}`));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).toHaveBeenCalledTimes(cap);
    expect(svc.pendingKeys()).toEqual([]);
    expect(registry.apps.get(ID)?.visitorWakes).toEqual({ day: '2026-10-04', count: cap, skipped: 3 });
    expect(registry.apps.get(ID)?.cursor).toBe(cap + 3);

    // The owner's next change is delivered and reports the skipped ones.
    cloud.push(ID, ownerData('milk'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(5 * MIN);
    expect(deliver).toHaveBeenCalledTimes(cap + 1);
    const text = deliver.mock.calls[cap][1] as string;
    expect(text).toContain('Data changes by the owner (1)');
    expect(text).toMatch(/Skipped: 3 anonymous visitor submission\(s\) were not sent to you/);
    expect(text).toContain(`limit of ${cap} visitor wakes per UTC day`);
    expect(registry.apps.get(ID)?.visitorWakes?.skipped).toBe(0);
  });

  it('reports submissions skipped over the cap on the next UTC day even if nothing new arrives', async () => {
    const cap = CREWLY_APPS_CONSTANTS.VISITOR_WAKE.MAX_PER_DAY;
    jest.setSystemTime(new Date('2026-10-04T22:00:00.000Z'));
    // Persisted state from before a restart: cap reached today, 4 skipped.
    registry.add(ID, { visitorWakes: { day: '2026-10-04', count: cap, skipped: 4 } });
    running.add('dev-ella');
    cloud.push(ID, visitorData('late'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).not.toHaveBeenCalled();
    expect(registry.apps.get(ID)?.visitorWakes?.skipped).toBe(5);

    jest.setSystemTime(new Date('2026-10-05T00:01:00.000Z'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    const text = deliver.mock.calls[0][1] as string;
    expect(text).toMatch(/^\[APP CHANGES\] Public visitors submitted to your app/);
    expect(text).toMatch(/Skipped: 5 anonymous visitor submission\(s\)/);
    expect(text).toContain('UNTRUSTED: written by anonymous visitors');
    expect(deliver.mock.calls[0][2]).toMatchObject({ activate: false });
    expect(registry.apps.get(ID)?.visitorWakes).toEqual({ day: '2026-10-05', count: 1, skipped: 0 });
  });

  it('does not count a skipped submission twice when it is re-read after a restart', async () => {
    const cap = CREWLY_APPS_CONSTANTS.VISITOR_WAKE.MAX_PER_DAY;
    jest.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
    registry.add(ID, { visitorWakes: { day: '2026-10-04', count: cap, skipped: 0 } });
    // An owner change holds the cursor (stopped agent, delivery keeps failing), then a skipped visitor one.
    deliver.mockResolvedValue(false);
    cloud.push(ID, ownerData('milk'));
    cloud.push(ID, visitorData('over'));
    await svc.tick();
    expect(registry.apps.get(ID)?.visitorWakes?.skipped).toBe(1);
    expect(registry.apps.get(ID)?.cursor).toBe(0);
    svc.stop();
    svc = makeService();
    await svc.tick();
    expect(registry.apps.get(ID)?.visitorWakes?.skipped).toBe(1);
  });

  it('ignores anything a visitor sends that is not data', async () => {
    registry.add(ID);
    cloud.push(ID, { kind: 'event', event: { type: 'notify', text: 'hi' }, actor: { kind: 'visitor', id: 'anonymous' }, at: 't' });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('AppWakeService — owner comments (crewly#1056)', () => {
  const thread = { id: 'c1', number: 1, version: 1, anchor: { tag: 'button', text: 'Save', selector: 'button#save' }, body: 'Make it green', replies: [], status: 'open' };
  const commentChange = (op: string, actor: Record<string, string> = { kind: 'owner', id: 'u1' }) =>
    ({ kind: 'comment', comment: { id: 'c1', op, thread }, actor, at: '2026-10-05T09:00:00.000Z' }) as unknown as Omit<AppChange, 'seq'>;

  it('wakes (and may start) the publisher for a new comment, a reply or a reopen by the owner', async () => {
    registry.add(ID);
    cloud.push(ID, commentChange('add'));
    cloud.push(ID, commentChange('reply'));
    cloud.push(ID, commentChange('reopen'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [session, text, opts] = deliver.mock.calls[0];
    expect(session).toBe('dev-ella');
    expect(opts).toMatchObject({ activate: true });
    expect(text).toContain('The owner commented on your app');
    expect(text).toContain('Comments from the owner (3)');
    expect(text).toContain('Owner commented on Button “Save” (#1, comment id c1; selector button#save, text "Save", app version 1):');
    expect(text).toContain('/skills/agent/core/app-comments/execute.sh --app');
  });

  it('never wakes for agent replies or resolves, nor for the owner resolving', async () => {
    registry.add(ID);
    cloud.push(ID, commentChange('reply', { kind: 'agent', id: 'dev-ella' }));
    cloud.push(ID, commentChange('resolve', { kind: 'agent', id: 'dev-ella' }));
    cloud.push(ID, commentChange('resolve'));
    cloud.push(ID, commentChange('add', { kind: 'visitor', id: 'anonymous' }));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).not.toHaveBeenCalled();
    expect(svc.pendingKeys()).toEqual([]);
  });
});

describe('AppWakeService — nothing stalls delivery (2026-10-05, 科技晨报)', () => {
  const thread = { id: 'c1', number: 1, version: 1, anchor: { tag: 'a', text: 'VoiceStudio' }, body: '@Atlas 这个可以研究一下吗', replies: [], status: 'open' };
  const ownerComment = (id = 'c1') =>
    ({ kind: 'comment', comment: { id, op: 'add', thread: { ...thread, id } }, actor: { kind: 'owner', id: 'u1' }, at: '2026-10-05T13:09:59.021Z' }) as unknown as Omit<AppChange, 'seq'>;
  const toElla = () => deliver.mock.calls.filter(([s]) => s === 'dev-ella');
  const internals = () => svc as unknown as { batches: Map<string, { timer: ReturnType<typeof setTimeout> | null }> };

  it('a poll that never settles no longer stops polling: owner comments on another app still arrive (root cause)', async () => {
    // Live state: AZ星球 (ID2) at cursor 106, 科技晨报 (ID) at cursor 1 with an agent write at 2.
    registry.add(ID2, { cursor: 0 });
    registry.add(ID, { cursor: 0 });
    cloud.push(ID, agentData());
    cloud.hangOnce.add(ID2); // this request never settles — before the fix the pass, and so the loop, waited forever
    svc.start();
    await jest.advanceTimersByTimeAsync(30_000);
    for (let i = 0; i < 5; i++) cloud.push(ID, ownerComment(`c${i}`));
    await jest.advanceTimersByTimeAsync(6 * MIN);

    expect(toElla()).toHaveLength(1);
    expect(toElla()[0][1]).toContain('Comments from the owner (5)');
    expect(registry.apps.get(ID)?.cursor).toBe(6);
    // The hung app backed off on its own and is polled again afterwards.
    expect(cloud.calls.filter((c) => c.path.includes(ID2)).length).toBeGreaterThan(1);
  });

  it('a pass whose registry read never settles is skipped; the next pass runs', async () => {
    registry.add(ID);
    const realList = registry.list.bind(registry);
    let first = true;
    registry.list = () => (first ? ((first = false), new Promise(() => undefined)) : realList());
    cloud.push(ID, ownerComment());
    svc.start();
    await jest.advanceTimersByTimeAsync(30_000 + 2 * MIN + 30_000 + 90_000 + 1000);
    expect(toElla()).toHaveLength(1);
  });

  it('a pass that never settles is abandoned after the stall limit; polling resumes and the orchestrator hears once', async () => {
    registry.add(ID);
    const pollOne = (svc as unknown as { pollOne: (a: unknown) => Promise<void> }).pollOne.bind(svc);
    let first = true;
    (svc as unknown as { pollOne: (a: unknown) => Promise<void> }).pollOne = (a) => (first ? ((first = false), new Promise(() => undefined)) : pollOne(a));
    cloud.push(ID, ownerComment());
    svc.start();
    await jest.advanceTimersByTimeAsync(30_000 + 5 * MIN + 30_000 + 90_000 + 1000);
    expect(toElla()).toHaveLength(1);
    expect(deliver.mock.calls.filter(([s, t]) => s === null && String(t).includes('stalled'))).toHaveLength(1);
  });

  it('a delivery that never settles times out, is retried, and the cursor then moves on', async () => {
    registry.add(ID);
    deliver.mockImplementationOnce(() => new Promise(() => undefined));
    cloud.push(ID, ownerComment());
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(toElla()).toHaveLength(1);
    expect(registry.apps.get(ID)?.cursor).toBe(0);

    await jest.advanceTimersByTimeAsync(5 * MIN + MIN + 1000); // timeout, then the first retry
    expect(toElla()).toHaveLength(2);
    expect(svc.pendingKeys()).toEqual([]);
    expect(registry.apps.get(ID)?.cursor).toBe(1);
  });

  it('a timed-out delivery that succeeds late settles the batch without sending it again', async () => {
    registry.add(ID);
    let finish!: (ok: boolean) => void;
    deliver.mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
    cloud.push(ID, ownerComment());
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000 + 5 * MIN + 1000); // timed out; retry due in 60 s
    finish(true);
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(toElla()).toHaveLength(1);
    expect(svc.pendingKeys()).toEqual([]);
    expect(registry.apps.get(ID)?.cursor).toBe(1);
  });

  it('changes arriving while a wake is being delivered go in the next message, not marked delivered unseen', async () => {
    registry.add(ID);
    let finish!: (ok: boolean) => void;
    deliver.mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
    cloud.push(ID, ownerComment('c1'));
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000); // delivery of c1 starts, waits behind a busy agent
    cloud.push(ID, ownerComment('c2'));
    await svc.tick();
    expect(registry.apps.get(ID)?.cursor).toBe(0);
    finish(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(registry.apps.get(ID)?.cursor).toBe(1); // c2 still pending
    await jest.advanceTimersByTimeAsync(5 * MIN + 1000); // cooldown
    expect(toElla()).toHaveLength(2);
    expect(toElla()[1][1]).toContain('comment id c2');
    expect(toElla()[1][1]).not.toContain('comment id c1');
    expect(registry.apps.get(ID)?.cursor).toBe(2);
  });

  it('after a restart with a batch pending or in flight, the comments are read again and delivered', async () => {
    registry.add(ID, { cursor: 1 });
    cloud.push(ID, agentData()); // seq 1, already read
    cloud.push(ID, agentData()); // seq 2
    deliver.mockImplementationOnce(() => new Promise(() => undefined));
    for (let i = 0; i < 5; i++) cloud.push(ID, ownerComment(`c${i}`)); // seqs 3–7
    await svc.tick();
    expect(registry.apps.get(ID)?.cursor).toBe(2);
    await jest.advanceTimersByTimeAsync(90_000); // the delivery hangs
    expect(registry.apps.get(ID)?.cursor).toBe(2);

    svc.stop();
    svc = makeService(); // backend restart
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(toElla()).toHaveLength(2);
    expect(toElla()[1][1]).toContain('Comments from the owner (5)');
    expect(registry.apps.get(ID)?.cursor).toBe(7);
  });

  it('re-arms a batch whose timer was lost', async () => {
    registry.add(ID);
    cloud.push(ID, ownerComment());
    await svc.tick();
    const batch = [...internals().batches.values()][0];
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(toElla()).toHaveLength(0);
    svc.watchdog();
    await jest.advanceTimersByTimeAsync(0);
    expect(toElla()).toHaveLength(1);
  });

  it('tells the orchestrator once when owner changes have not reached their agent after 15 min', async () => {
    registry.add(ID);
    deliver.mockImplementation(async (s: string | null) => s === null);
    cloud.push(ID, ownerComment());
    svc.start();
    await jest.advanceTimersByTimeAsync(20 * MIN);
    const stuck = deliver.mock.calls.filter(([s, t]) => s === null && String(t).includes('have waited'));
    expect(stuck).toHaveLength(1);
    expect(stuck[0][1]).toContain('1 comment(s)');
    expect(stuck[0][1]).toContain('dev-ella');
    await jest.advanceTimersByTimeAsync(20 * MIN);
    expect(deliver.mock.calls.filter(([s, t]) => s === null && String(t).includes('have waited'))).toHaveLength(1);
  });

  it('marks owner changes owner-authored with a batch ref; visitor-only batches are not', async () => {
    registry.add(ID);
    registry.add(ID2);
    running.add('dev-ella');
    cloud.push(ID, ownerComment());
    cloud.push(ID, ownerComment('c2'));
    cloud.push(ID2, { kind: 'data', collection: 'signups', docId: 'v1', op: 'set', rev: 1, actor: { kind: 'visitor', id: 'anonymous' }, at: 't' } as unknown as Omit<AppChange, 'seq'>);
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    const byApp = (id: string) => deliver.mock.calls.find(([, t]) => String(t).includes(`(${id})`));
    expect(byApp(ID)?.[2]).toEqual({ activate: true, owner: true, ref: `app:${ID}:1-2:2` });
    expect(byApp(ID2)?.[2]).toEqual({ activate: false, ref: `app:${ID2}:1-1:1` });
  });
});

describe('AppWakeService — @mentions in comments (crewly-services apps/SPEC.md §12.1)', () => {
  const ATLAS = 'crewly-research-atlas-0a1b2c3d';
  const thread = (mentions: Array<{ session: string; name: string; instanceId: string }>, replies: NonNullable<AppCommentThread['replies']> = []): AppCommentThread => ({
    id: 'c1',
    number: 4,
    version: 2,
    anchor: { tag: 'button', text: 'Buy milk', selector: 'button#buy', crewlyId: 'buy-button' },
    body: '@Atlas 这个可以研究一下吗',
    mentions,
    replies,
    status: 'open',
  });
  const atlasHere = { session: ATLAS, name: 'Atlas', instanceId: 'inst-1' };
  let local: Set<string>;
  let roster: { pushIfChanged: jest.Mock };

  function mentionService(): AppWakeService {
    return new AppWakeService({
      client: cloud,
      registry: registry as unknown as AppsRegistryService,
      deliver,
      resolveAgent,
      isRunning: (s) => running.has(s),
      isLocalAgent: async (s) => local.has(s),
      instanceId: async () => 'inst-1',
      roster,
      skillsPath: '/skills/agent',
    });
  }

  beforeEach(() => {
    local = new Set([ATLAS, 'dev-ella']);
    roster = { pushIfChanged: jest.fn().mockResolvedValue(false) };
    svc.stop();
    svc = mentionService();
  });

  /** First tick reads the inbox head (start from now). */
  async function primeInbox(): Promise<void> {
    await svc.tick();
    expect(registry.mentionProgress.cursor).toBe(0);
  }

  it('pushes the roster every tick (the roster service sends only changes)', async () => {
    await svc.tick();
    await svc.tick();
    expect(roster.pushIfChanged).toHaveBeenCalledTimes(2);
  });

  it('starts the inbox from its head, never replaying old mentions', async () => {
    cloud.mention({ appId: ID, appName: 'Groceries', session: ATLAS, name: 'Atlas', op: 'add', commentId: 'c1', thread: thread([atlasHere]) });
    await svc.tick();
    expect(registry.mentionProgress.cursor).toBe(1);
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('wakes (and may start) a mentioned agent outside the publisher\'s team, with the anchor; the publisher hears who was mentioned', async () => {
    registry.add(ID);
    await primeInbox();
    const t = thread([atlasHere]);
    cloud.push(ID, { kind: 'comment', comment: { id: 'c1', op: 'add', mentions: [atlasHere], thread: t }, actor: { kind: 'owner', id: 'u1' }, at: '2026-10-05T09:00:00.000Z' } as unknown as Omit<AppChange, 'seq'>);
    cloud.mention({ appId: ID, appName: 'Groceries', session: ATLAS, name: 'Atlas', op: 'add', commentId: 'c1', thread: t, at: '2026-10-05T09:00:00.000Z' });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);

    expect(deliver).toHaveBeenCalledTimes(2);
    const byWho = new Map(deliver.mock.calls.map(([session, text, opts]) => [session, { text, opts }]));
    const atlas = byWho.get(ATLAS)!;
    // Same robust path as the publisher's wake: owner-authored (queue priority) with a batch ref.
    expect(atlas.opts).toEqual({ activate: true, owner: true, ref: `app:${ID}:m1-1:1` });
    expect(atlas.text).toContain('[APP CHANGES] The owner mentioned you in a comment on the app "Groceries" (28au74d9cj)');
    expect(atlas.text).toContain('UNTRUSTED');
    expect(atlas.text).toContain('Owner commented on Button “Buy milk” (#4, comment id c1; data-crewly-id "buy-button", selector button#buy, text "Buy milk", app version 2) (mentioned: @Atlas):');
    expect(atlas.text).toContain('    | @Atlas 这个可以研究一下吗');
    expect(atlas.text).toContain('--reply <comment id>');
    expect(atlas.text).toContain('--get <comment id>');
    expect(atlas.text).not.toContain('--list');
    expect(atlas.text).toContain('even if this app is not your team');

    const ella = byWho.get('dev-ella')!;
    expect(ella.text).toContain('The owner commented on your app');
    expect(ella.text).toContain('(mentioned: @Atlas)');
    expect(ella.text).toContain('they got them too');
    expect(ella.text).toContain('--list');

    expect(registry.mentionProgress).toEqual({ cursor: 1, delivered: [] });
    expect(registry.apps.get(ID)?.cursor).toBe(1);
  });

  it('a mentioned publisher gets one message, not two', async () => {
    registry.add(ID);
    await primeInbox();
    const ella = { session: 'dev-ella', name: 'Ella', instanceId: 'inst-1' };
    const t = thread([ella]);
    cloud.push(ID, { kind: 'comment', comment: { id: 'c1', op: 'add', mentions: [ella], thread: t }, actor: { kind: 'owner', id: 'u1' } } as unknown as Omit<AppChange, 'seq'>);
    cloud.mention({ appId: ID, appName: 'Groceries', session: 'dev-ella', name: 'Ella', op: 'add', commentId: 'c1', thread: t });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [session, text] = deliver.mock.calls[0];
    expect(session).toBe('dev-ella');
    expect(text).toContain('The owner commented on your app');
    expect(text).toContain('Comments from the owner (1)');
    expect(text).toContain('--list');
  });

  it('the same session on another machine is someone else: the publisher is still woken from the feed', async () => {
    registry.add(ID);
    await primeInbox();
    const ellaElsewhere = { session: 'dev-ella', name: 'Ella', instanceId: 'inst-2' };
    cloud.push(ID, { kind: 'comment', comment: { id: 'c1', op: 'add', mentions: [ellaElsewhere], thread: thread([ellaElsewhere]) }, actor: { kind: 'owner', id: 'u1' } } as unknown as Omit<AppChange, 'seq'>);
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe('dev-ella');
  });

  it('a mention for an app this machine did not publish (cross-machine) is delivered from the inbox alone', async () => {
    await primeInbox();
    const reply = { id: 'r1', body: '@Atlas can you look?', author: { kind: 'owner', name: 'Owner' }, mentions: [atlasHere] };
    cloud.mention({ appId: ID2, appName: 'Trip planner', session: ATLAS, name: 'Atlas', op: 'reply', commentId: 'c1', replyId: 'r1', thread: thread([], [reply]) });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [session, text, opts] = deliver.mock.calls[0];
    expect(session).toBe(ATLAS);
    expect(opts).toEqual({ activate: true, owner: true, ref: `app:${ID2}:m1-1:1` });
    expect(text).toContain('[APP CHANGES] The owner mentioned you in a comment on the app "Trip planner" (xyzabcdefg)');
    // A reply: the element is named too, since the mentioned agent may not have seen the thread.
    expect(text).toContain('Owner replied on #4 (Button “Buy milk”; comment id c1; data-crewly-id "buy-button"');
    expect(text).toContain('(mentioned: @Atlas):');
    expect(text).toContain('    | @Atlas can you look?');
    expect(registry.mentionProgress).toEqual({ cursor: 1, delivered: [] });
  });

  it('"@Orc" goes to the orchestrator; a mention of an agent gone from this machine too, saying so', async () => {
    await primeInbox();
    cloud.mention({ appId: ID2, appName: 'Trip planner', session: 'crewly-orc', name: 'Orc', op: 'add', commentId: 'c1', thread: thread([{ session: 'crewly-orc', name: 'Orc', instanceId: 'inst-1' }]) });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBeNull();
    expect(deliver.mock.calls[0][1]).toContain('The owner mentioned you in a comment');

    await jest.advanceTimersByTimeAsync(10 * MIN);
    cloud.mention({ appId: ID, appName: 'Groceries', session: 'crewly-old-zed-00000000', name: 'Zed', op: 'add', commentId: 'c2', thread: thread([]) });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    const [session, text, opts] = deliver.mock.calls[1];
    expect(session).toBeNull();
    expect(opts).toEqual({ activate: false, owner: true, ref: `app:${ID}:m2-2:1` });
    expect(text).toContain('mentioned an agent that is no longer on this machine');
    expect(text).toContain('@Zed is not an agent on this machine any more');
  });

  it('skips mentions whose comment or app is gone', async () => {
    await primeInbox();
    cloud.mention({ appId: ID, appName: null, session: ATLAS, name: 'Atlas', op: 'add', commentId: 'c1', thread: null });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).not.toHaveBeenCalled();
    expect(registry.mentionProgress.cursor).toBe(1);
  });

  it('keeps the inbox cursor before a pending mention and does not redeliver after a restart', async () => {
    await primeInbox();
    cloud.mention({ appId: ID2, appName: 'Trip planner', session: ATLAS, name: 'Atlas', op: 'add', commentId: 'c1', thread: thread([atlasHere]) });
    await svc.tick();
    expect(registry.mentionProgress.cursor).toBe(0); // pending: a restart re-reads it

    // Restart before the batch went out: delivered once, by the new instance.
    svc.stop();
    svc = mentionService();
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(registry.mentionProgress.cursor).toBe(1);

    svc.stop();
    svc = mentionService();
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('retries a failed delivery to a mentioned agent', async () => {
    await primeInbox();
    deliver.mockResolvedValueOnce(false);
    cloud.mention({ appId: ID2, appName: 'Trip planner', session: ATLAS, name: 'Atlas', op: 'add', commentId: 'c1', thread: thread([atlasHere]) });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(registry.mentionProgress.cursor).toBe(0);
    await jest.advanceTimersByTimeAsync(MIN);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(registry.mentionProgress.cursor).toBe(1);
  });

  it('a mention delivery that never settles times out, is retried, and the inbox cursor then moves on', async () => {
    await primeInbox();
    deliver.mockImplementationOnce(() => new Promise(() => undefined));
    cloud.mention({ appId: ID2, appName: 'Trip planner', session: ATLAS, name: 'Atlas', op: 'add', commentId: 'c1', thread: thread([atlasHere]) });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(registry.mentionProgress.cursor).toBe(0);
    await jest.advanceTimersByTimeAsync(5 * MIN + MIN + 1000); // delivery timeout, then the first retry
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(svc.pendingKeys()).toEqual([]);
    expect(registry.mentionProgress.cursor).toBe(1);
  });

  it('an inbox read that never settles does not hold the pass; the next read delivers', async () => {
    registry.add(ID);
    await primeInbox();
    const realRequest = cloud.request.bind(cloud);
    let hang = true;
    cloud.request = (<T,>(m: string, p: string, o?: { query?: Query; timeoutMs?: number }) =>
      p === '/mentions' && hang ? ((hang = false), new Promise<T>(() => undefined)) : realRequest<T>(m, p, o)) as typeof cloud.request;
    cloud.mention({ appId: ID2, appName: 'Trip planner', session: ATLAS, name: 'Atlas', op: 'add', commentId: 'c1', thread: thread([atlasHere]) });
    svc.start();
    await jest.advanceTimersByTimeAsync(30_000 + 2 * MIN + 1000); // first pass: the inbox read hits its deadline
    expect(svc.mentionsBackoff()).toMatchObject({ failures: 1 });
    cloud.push(ID, ownerData());
    await jest.advanceTimersByTimeAsync(5 * MIN);
    const atlas = deliver.mock.calls.filter(([s]) => s === ATLAS);
    expect(atlas).toHaveLength(1);
    expect(deliver.mock.calls.filter(([s]) => s === 'dev-ella')).toHaveLength(1);
  });

  it('a stuck mention batch is reported by the watchdog like any owner change', async () => {
    await primeInbox();
    deliver.mockImplementation(async (s: string | null) => s === null);
    cloud.mention({ appId: ID2, appName: 'Trip planner', session: ATLAS, name: 'Atlas', op: 'add', commentId: 'c1', thread: thread([atlasHere]) });
    svc.start();
    await jest.advanceTimersByTimeAsync(20 * MIN);
    const stuck = deliver.mock.calls.filter(([s, t]) => s === null && String(t).includes('have waited'));
    expect(stuck).toHaveLength(1);
    expect(stuck[0][1]).toContain(ATLAS);
  });

  it('an older Cloud without the inbox (404): backs off quietly, apps keep polling', async () => {
    registry.add(ID);
    cloud.inboxFail = new AppsCloudError(404, 'not_found', 'Not found');
    await svc.tick();
    expect(svc.mentionsBackoff()).toMatchObject({ failures: 1 });
    cloud.push(ID, ownerData());
    await svc.tick();
    expect(cloud.inboxCalls).toHaveLength(1); // still backing off
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('AppWakeService — app owners (crewly-services apps/SPEC.md §15)', () => {
  const KAI = 'crewly-dev-kai-11111111';
  const ATLAS = 'crewly-research-atlas-0a1b2c3d';
  const ROOM = { kind: 'channel' as const, id: 'huddle-brief', name: 'daily-brief' };
  const thread = (mentions: Array<{ session: string; name: string; instanceId: string }> = []): AppCommentThread => ({
    id: 'c1',
    number: 1,
    anchor: { tag: 'div', text: 'Today' },
    body: 'Shorter please',
    mentions,
    replies: [],
    status: 'open',
  });
  let deliverRoom: jest.Mock;
  let roomMembers: jest.Mock;
  let roomFallback: jest.Mock;
  let local: Set<string>;

  function ownerService(): AppWakeService {
    return new AppWakeService({
      client: cloud,
      registry: registry as unknown as AppsRegistryService,
      deliver,
      resolveAgent,
      isRunning: (s) => running.has(s),
      isLocalAgent: async (s) => local.has(s),
      instanceId: async () => 'inst-1',
      roomMembers,
      deliverRoom,
      roomFallback,
      skillsPath: '/skills/agent',
    });
  }

  beforeEach(async () => {
    deliverRoom = jest.fn().mockResolvedValue(true);
    roomMembers = jest.fn().mockResolvedValue(['dev-ella', KAI]);
    roomFallback = jest.fn().mockResolvedValue(null);
    local = new Set(['dev-ella', KAI, ATLAS]);
    svc.stop();
    svc = ownerService();
    registry.add(ID);
    await svc.tick(); // inbox head + app head
  });

  it('a comment Cloud routed to the explicit owner is skipped in the publisher\'s feed', async () => {
    cloud.push(ID, { kind: 'comment', comment: { id: 'c1', op: 'add', thread: thread() }, ownerRouted: true, actor: { kind: 'owner', id: 'u1' } } as unknown as Omit<AppChange, 'seq'>);
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliver).not.toHaveBeenCalled();
    expect(registry.apps.get(ID)?.cursor).toBe(1);
  });

  it('a channel owner\'s entry is posted into the room after a short window (no agent wake); a resend is not doubled', async () => {
    cloud.mention({ appId: ID, appName: 'Daily brief', session: '', name: 'daily-brief', reason: 'owner', room: ROOM, op: 'add', commentId: 'c1', thread: thread() });
    await svc.tick();
    expect(deliverRoom).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(CREWLY_APPS_CONSTANTS.COMMENTS.ROOM_BATCH_WINDOW_MS);
    expect(deliverRoom).toHaveBeenCalledTimes(1);
    expect(deliverRoom.mock.calls[0][0]).toMatchObject({ appId: ID, appName: 'Groceries', room: ROOM, comments: [{ kind: 'comment', comment: { id: 'c1', op: 'add' } }] });
    expect(deliver).not.toHaveBeenCalled();
    expect(registry.mentionProgress.cursor).toBe(1);
    await svc.tick();
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(deliverRoom).toHaveBeenCalledTimes(1);
  });

  it('a reply the owner wrote in Slack reaches the room marked via slack (the room service skips it there)', async () => {
    cloud.mention({ appId: ID, session: '', name: 'daily-brief', reason: 'owner', room: ROOM, op: 'reply', replyId: 'r1', via: 'slack', commentId: 'c1', thread: thread() });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(CREWLY_APPS_CONSTANTS.COMMENTS.ROOM_BATCH_WINDOW_MS);
    expect(deliverRoom.mock.calls[0][0].comments[0].actor).toEqual({ kind: 'owner', via: 'slack' });
  });

  it('a failed room post is retried; the inbox cursor stays before it until it lands', async () => {
    deliverRoom.mockResolvedValueOnce(false);
    cloud.mention({ appId: ID, session: '', name: 'daily-brief', reason: 'owner', room: ROOM, op: 'add', commentId: 'c1', thread: thread() });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(CREWLY_APPS_CONSTANTS.COMMENTS.ROOM_BATCH_WINDOW_MS);
    expect(deliverRoom).toHaveBeenCalledTimes(1);
    expect(registry.mentionProgress.cursor).toBe(0);
    await jest.advanceTimersByTimeAsync(CREWLY_APPS_CONSTANTS.WAKE_RETRY_BASE_MS);
    expect(deliverRoom).toHaveBeenCalledTimes(2);
    await svc.tick();
    expect(registry.mentionProgress.cursor).toBe(1);
  });

  it('an @mentioned agent of this machine outside the room is woken too; members are left to the room', async () => {
    const atlas = { session: ATLAS, name: 'Atlas', instanceId: 'inst-1' };
    const kai = { session: KAI, name: 'Kai', instanceId: 'inst-1' };
    cloud.mention({ appId: ID, session: '', name: 'daily-brief', reason: 'owner', room: ROOM, op: 'add', commentId: 'c1', thread: thread([kai, atlas]) });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliverRoom).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe(ATLAS);
    expect(deliver.mock.calls[0][1]).toContain('mentioned you');
  });

  it('a team without a room here falls back to its lead; a missing channel to the orchestrator', async () => {
    roomMembers.mockResolvedValue(null);
    roomFallback.mockImplementation(async (r: { kind: string }) => (r.kind === 'team' ? KAI : null));
    cloud.mention({ appId: ID, session: '', name: 'Dev', reason: 'owner', room: { kind: 'team', id: 't-dev', name: 'Dev' }, op: 'add', commentId: 'c1', thread: thread() });
    cloud.mention({ appId: ID2, appName: 'Other', session: '', name: 'gone', reason: 'owner', room: { kind: 'channel', id: 'h-x', name: 'gone' }, op: 'add', commentId: 'c2', thread: { ...thread(), id: 'c2' } });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    const who = deliver.mock.calls.map(([s]) => s).sort();
    expect(who).toEqual([KAI, null].sort());
    expect(deliverRoom).not.toHaveBeenCalled();
  });

  it('an agent owner is woken as the owner, not as a mention', async () => {
    cloud.mention({ appId: ID, session: KAI, name: 'Kai', reason: 'owner', op: 'add', commentId: 'c1', thread: thread() });
    await svc.tick();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [session, text, opts] = deliver.mock.calls[0];
    expect(session).toBe(KAI);
    expect(opts).toMatchObject({ activate: true, owner: true });
    expect(text).toContain('you own its comments');
    expect(text).not.toContain('mentioned you');
    expect(text).toContain('--list');
  });
});
