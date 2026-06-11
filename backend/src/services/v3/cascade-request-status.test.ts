/**
 * Unit tests for the standalone cascadeRequestStatus helper.
 *
 * Mirrors the semantics of the original V3DataService.cascadeRequestStatus
 * implementation (so behaviour-preserving extraction is verifiable) and
 * adds the new `ready → running → done` hop for Requests whose first
 * lifecycle event is a successful verify.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { cascadeRequestStatus, type CascadeDeps } from './cascade-request-status.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const SILENT_LOGGER = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'req-1',
    title: 'test',
    sourceConversationItemId: 'slack-CTEST-1707000000.000001',
    intentLevel: 'L2',
    intentCategory: 'planning',
    actionable: true,
    status: 'running',
    workItemIds: [],
    createdAt: '2026-05-09T01:00:00.000Z',
    updatedAt: '2026-05-09T01:00:00.000Z',
    ...overrides,
  } as Request;
}

function makeWI(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'wi-1',
    title: 'test wi',
    description: '',
    status: 'queued',
    requestId: 'req-1',
    target: '',
    type: 'delegate',
    createdAt: '2026-05-09T01:00:00.000Z',
    updatedAt: '2026-05-09T01:00:00.000Z',
    ...overrides,
  } as WorkItem;
}

function makeDeps(opts: {
  request?: Request;
  pool?: WorkItem[];
  updateThrows?: Error;
} = {}): { deps: CascadeDeps; requestStore: Map<string, Request>; updates: Array<[string, Partial<Request>]>; notified: Array<{ event: string; payload: unknown }> } {
  const requestStore = new Map<string, Request>();
  if (opts.request) requestStore.set(opts.request.id, opts.request);
  const updates: Array<[string, Partial<Request>]> = [];
  const notified: Array<{ event: string; payload: unknown }> = [];

  const deps: CascadeDeps = {
    requestService: {
      getById: async (id: string) => requestStore.get(id) ?? null,
      update: async (id: string, patch: Partial<Request>) => {
        if (opts.updateThrows) throw opts.updateThrows;
        updates.push([id, patch]);
        const existing = requestStore.get(id);
        if (existing) requestStore.set(id, { ...existing, ...patch } as Request);
        return null;
      },
    },
    taskPool: {
      getAllItems: async () => opts.pool ?? [],
    },
    logger: SILENT_LOGGER as unknown as CascadeDeps['logger'],
    notifier: {
      emit: (event, payload) => notified.push({ event, payload }),
    },
  };

  return { deps, requestStore, updates, notified };
}

describe('cascadeRequestStatus', () => {
  it('no-ops on undefined requestId (event is for an unlinked WI)', async () => {
    const { deps, updates } = makeDeps({});
    await cascadeRequestStatus(undefined, deps);
    expect(updates).toEqual([]);
  });

  it('no-ops when the Request is already terminal (done)', async () => {
    const r = makeRequest({ status: 'done' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [makeWI({ status: 'cancelled' })],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([]);
  });

  it('no-ops when the Request has no child WIs', async () => {
    const r = makeRequest({ status: 'running' });
    const { deps, updates } = makeDeps({ request: r, pool: [] });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([]);
  });

  it('cascades to done when every child landed on a verified terminal', async () => {
    const r = makeRequest({ status: 'running' });
    const { deps, updates, notified } = makeDeps({
      request: r,
      pool: [
        makeWI({ id: 'a', status: 'done' }),
        makeWI({ id: 'b', status: 'verified' }),
        makeWI({ id: 'c', status: 'verified' }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([['req-1', { status: 'done' }]]);
    expect(notified).toEqual([
      { event: 'v3:request_updated', payload: { requestId: 'req-1', status: 'done', previousStatus: 'running' } },
    ]);
  });

  it('P2 acceptance gate: a done_by_worker (unverified) child keeps the Request running, not done', async () => {
    // The deliverable must NOT be marked done while a child still awaits a TL
    // verdict — that would be the Request-level silent-pass. It stays running;
    // P1's verify-enforcement escalates the unverified child for a verdict,
    // after which a later cascade completes the Request.
    const r = makeRequest({ status: 'running' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [
        makeWI({ id: 'a', status: 'verified' }),
        makeWI({ id: 'b', status: 'done_by_worker' }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    // running → running is a no-op write OR a running update; either way NOT done.
    expect(updates.some(([, u]) => u.status === 'done')).toBe(false);
  });

  it('cascades to cancelled when every child is cancelled or failed', async () => {
    const r = makeRequest({ status: 'ready' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [
        makeWI({ id: 'a', status: 'cancelled' }),
        makeWI({ id: 'b', status: 'cancelled' }),
        makeWI({ id: 'c', status: 'failed' }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([['req-1', { status: 'cancelled' }]]);
  });

  it('does NOT cascade-cancel when the only cancelled child was SLA-resolved by orc_reply (Steve 2026-05-15)', async () => {
    // Reproduces the dogfood race: a Slack Request with one
    // respond_to_user SLA tracker. Orc replies in-window → markResolved
    // transitions the tracker queued→cancelled with
    // metadata.slaResolvedReason='orc_reply'. Cascade fires on
    // task:cancelled; without this guard it overwrites Request.status
    // to 'cancelled' just before RequestSlaSubscriber.maybeCloseRequest
    // moves it to 'done'.
    const r = makeRequest({ status: 'ready' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [
        makeWI({
          id: 'request:req-1:respond_to_user',
          status: 'cancelled',
          metadata: { slaResolvedReason: 'orc_reply' },
        }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([]);
  });

  it('honors verified-reply tags for chatv2_reply and workitem_decompose too', async () => {
    const r = makeRequest({ status: 'ready' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [
        makeWI({
          id: 'a',
          status: 'cancelled',
          metadata: { slaResolvedReason: 'chatv2_reply' },
        }),
        makeWI({
          id: 'b',
          status: 'cancelled',
          metadata: { slaResolvedReason: 'workitem_decompose' },
        }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([]);
  });

  it('still cascades to cancelled when SLA-resolved children sit alongside other genuine cancellations', async () => {
    // Mixed: 1 SLA-resolved (orc_reply) + 1 real cancellation. The SLA
    // tracker is filtered out, leaving ['cancelled'] → cascade fires.
    const r = makeRequest({ status: 'ready' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [
        makeWI({
          id: 'sla',
          status: 'cancelled',
          metadata: { slaResolvedReason: 'orc_reply' },
        }),
        makeWI({ id: 'real-cancel', status: 'cancelled' }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([['req-1', { status: 'cancelled' }]]);
  });

  it('still cascades to running when SLA-resolved cancellation coexists with a running sibling', async () => {
    const r = makeRequest({ status: 'ready' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [
        makeWI({
          id: 'sla',
          status: 'cancelled',
          metadata: { slaResolvedReason: 'orc_reply' },
        }),
        makeWI({ id: 'live', status: 'running' }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([['req-1', { status: 'running' }]]);
  });

  it('cascades to running when any child is running, regardless of other state', async () => {
    const r = makeRequest({ status: 'ready' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [
        makeWI({ id: 'a', status: 'running' }),
        makeWI({ id: 'b', status: 'queued' }),
        makeWI({ id: 'c', status: 'cancelled' }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([['req-1', { status: 'running' }]]);
  });

  it('does NOT cascade when all WIs are still queued (work delegated, not started)', async () => {
    const r = makeRequest({ status: 'ready' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [makeWI({ status: 'queued' }), makeWI({ status: 'queued' })],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([]);
  });

  it('cascades to blocked when every non-queued child is blocked and none are running', async () => {
    const r = makeRequest({ status: 'running' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [
        makeWI({ id: 'a', status: 'blocked' }),
        makeWI({ id: 'b', status: 'blocked' }),
      ],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([['req-1', { status: 'blocked' }]]);
  });

  it('hops `ready → running → done` when the direct edge is illegal', async () => {
    // REQUEST_TRANSITIONS forbids `ready → done`. The cascade must
    // detect this and step via running so a fast verify (Plan WI
    // skipped the running stage entirely) still closes cleanly.
    const r = makeRequest({ status: 'ready' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [makeWI({ status: 'verified' })],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([
      ['req-1', { status: 'running' }],
      ['req-1', { status: 'done' }],
    ]);
  });

  it('does not throw when the target status is not reachable from current state', async () => {
    // Pathological case: pretend the Request has an exotic in-flight
    // status that neither matches a direct nor hop edge for the
    // computed target. Cascade should log + return, NOT throw.
    const r = makeRequest({ status: 'waiting_confirmation' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [makeWI({ status: 'blocked' })],
    });
    // waiting_confirmation → blocked is NOT in REQUEST_TRANSITIONS.
    await expect(cascadeRequestStatus(r.id, deps)).resolves.toBeUndefined();
    expect(updates).toEqual([]);
  });

  it('swallows `requestService.update` failures (best-effort contract)', async () => {
    const r = makeRequest({ status: 'running' });
    const { deps, updates } = makeDeps({
      request: r,
      pool: [makeWI({ status: 'done' })],
      updateThrows: new Error('disk full'),
    });
    await expect(cascadeRequestStatus(r.id, deps)).resolves.toBeUndefined();
    expect(updates).toEqual([]); // updates array tracks only succeeded writes
  });

  it('does not re-emit when newStatus matches current status', async () => {
    const r = makeRequest({ status: 'running' });
    const { deps, updates, notified } = makeDeps({
      request: r,
      pool: [makeWI({ status: 'running' })],
    });
    await cascadeRequestStatus(r.id, deps);
    expect(updates).toEqual([]);
    expect(notified).toEqual([]);
  });
});
