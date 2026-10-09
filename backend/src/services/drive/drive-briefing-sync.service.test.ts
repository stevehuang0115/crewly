/**
 * Drive mode status push: events gather and rebuild, an unchanged snapshot
 * is not re-sent, the full resync, the PUT shape (machine token, instance
 * path), signed out / switched off, Cloud not ready → paused, failures back
 * off, 401 refreshes once.
 */

import { DriveBriefingSyncService, isBriefingSyncDisabled, snapshotKey, type DriveBriefingSyncDeps } from './drive-briefing-sync.service.js';
import type { BriefingSnapshot } from './drive-briefing.contract.js';

function snap(teams: string[] = ['CE'], at = '2026-10-09T10:00:00.000Z'): BriefingSnapshot {
  return { v: 1, generatedAt: at, teams: teams.map((name) => ({ name, agents: [], open: 0, inProgress: 0, review: 0, blocked: 0, doneToday: 0 })), agents: [], items: [], waiting: [] };
}

function harness(over: Partial<DriveBriefingSyncDeps> = {}, status: number[] = []) {
  let clock = 1_000_000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 1;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let current = snap();
  const listeners: Array<() => void> = [];
  const deps: DriveBriefingSyncDeps = {
    build: jest.fn(async () => current),
    cloud: { getToken: () => 'tok', getCloudUrl: () => 'https://api.crewlyai.com/' },
    identity: async () => ({ instanceId: 'mac-1' }),
    sources: [(l) => {
      listeners.push(l);
      return () => undefined;
    }],
    env: {},
    fetchImpl: jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const code = status.shift() ?? 200;
      return new Response(JSON.stringify(code === 200 ? { success: true } : { success: false, code: 'x' }), { status: code });
    }),
    now: () => clock,
    setTimeout: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ fn, at: clock + ms, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as DriveBriefingSyncDeps['setTimeout'],
    clearTimeout: ((h: unknown) => {
      const i = timers.findIndex((t) => t.id === (h as number));
      if (i >= 0) timers.splice(i, 1);
    }) as DriveBriefingSyncDeps['clearTimeout'],
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
    ...over,
  };
  const service = new DriveBriefingSyncService(deps);
  /** Advance the clock and run due timers (and the passes they start). */
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers.find((t) => t.at <= clock);
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
  };
  return { service, deps, calls, advance, emit: () => listeners.forEach((l) => l()), set: (s: BriefingSnapshot) => (current = s), tick: (ms: number) => (clock += ms) };
}

describe('DriveBriefingSyncService', () => {
  it('PUTs the snapshot to the machine\'s instance path with its own token', async () => {
    const h = harness();
    expect(await h.service.syncNow()).toBe('uploaded');
    expect(h.calls[0].url).toBe('https://api.crewlyai.com/api/cloud/instances/mac-1/briefing');
    expect(h.calls[0].init).toMatchObject({ method: 'PUT', headers: { Authorization: 'Bearer tok' } });
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ snapshot: snap() });
  });

  it('an unchanged snapshot is not sent again (build time ignored) until the full resync', async () => {
    const h = harness();
    await h.service.syncNow();
    h.set(snap(['CE'], '2026-10-09T10:01:00.000Z'));
    expect(await h.service.syncNow()).toBe('unchanged');
    h.tick(5 * 60_000);
    expect(await h.service.syncNow()).toBe('uploaded');
    expect(snapshotKey(snap(['CE'], 'a'))).toBe(snapshotKey(snap(['CE'], 'b')));
  });

  it('events gather (debounce) and rebuild once; a change is uploaded', async () => {
    const h = harness();
    h.service.start();
    await h.advance(0); // first check
    expect(h.calls).toHaveLength(1);
    h.set(snap(['CE', 'Marketing']));
    h.emit();
    h.emit();
    h.emit();
    await h.advance(2_000);
    expect(h.calls).toHaveLength(1);
    await h.advance(3_500);
    expect(h.calls).toHaveLength(2);
    expect(JSON.parse(String(h.calls[1].init.body)).snapshot.teams).toHaveLength(2);
    h.service.stop();
  });

  it('the periodic check uploads only on a change', async () => {
    const h = harness();
    h.service.start();
    await h.advance(0);
    await h.advance(60_000);
    expect(h.calls).toHaveLength(1);
    h.set(snap(['Ops']));
    await h.advance(60_000);
    expect(h.calls).toHaveLength(2);
    h.service.stop();
  });

  it('signed out or switched off: nothing is built or sent', async () => {
    const off = harness({ env: { CREWLY_DRIVE_BRIEFING: '0' } });
    expect(await off.service.syncNow()).toBe('skipped');
    const out = harness({ cloud: { getToken: () => null, getCloudUrl: () => 'https://x' } });
    expect(await out.service.syncNow()).toBe('skipped');
    expect(off.calls).toEqual([]);
    expect(out.deps.build).not.toHaveBeenCalled();
    expect(isBriefingSyncDisabled({ CREWLY_DRIVE_BRIEFING: 'off' })).toBe(true);
    expect(isBriefingSyncDisabled({})).toBe(false);
  });

  it('a Cloud without the route pauses for an hour; a failure backs off; 401 refreshes once', async () => {
    const h = harness({}, [404]);
    expect(await h.service.syncNow()).toBe('paused');
    expect(await h.service.syncNow()).toBe('paused');
    h.tick(60 * 60_000);
    expect(await h.service.syncNow()).toBe('uploaded');

    const f = harness({}, [500]);
    expect(await f.service.syncNow()).toBe('failed');
    expect(await f.service.syncNow()).toBe('paused');
    f.tick(15_000);
    expect(await f.service.syncNow()).toBe('uploaded');

    const tryRefreshToken = jest.fn(async () => true);
    const r = harness({ cloud: { getToken: () => 'tok2', getCloudUrl: () => 'https://x', tryRefreshToken } }, [401, 200]);
    expect(await r.service.syncNow()).toBe('uploaded');
    expect(tryRefreshToken).toHaveBeenCalledTimes(1);
  });
});
