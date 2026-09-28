/**
 * Tests for WaitingItemsSyncService — computes 待验收 from the real ticket
 * intake (derived column) and uploads full snapshots only when they change,
 * plus the periodic full resync, account switch, pauses and backoff.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ComponentLogger } from '../core/logger.service.js';
import { TicketIntakeService, type TicketRequestStore } from '../v3/ticket-intake.service.js';
import type { Request } from '../../types/v2/request.types.js';
import { WAITING_SYNC_CONSTANTS } from '../../constants.js';
import { WaitingItemsSyncService, type WaitingSyncFetch } from './waiting-items-sync.service.js';
import type { WaitingIngestRequest } from './waiting-items.contract.js';

const CLOUD = 'https://api.crewly.test';
const T0 = Date.parse('2026-09-28T12:00:00.000Z');

function logger(): ComponentLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as ComponentLogger;
}

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** A JWT-shaped token for an account (only the payload is read). */
function tokenFor(sub: string): string {
  return `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
}

function ticket(id: string, n: number, over: Partial<Request> = {}): Request {
  return {
    id,
    ticketNumber: n,
    title: `Ticket ${n}`,
    description: `Do thing ${n}`,
    kind: 'feature',
    status: 'waiting_confirmation',
    requiresConfirmation: true,
    priority: 'medium',
    workItemIds: [],
    tags: [],
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    submittedAt: '2026-09-28T10:00:00.000Z',
    reply: { at: '2026-09-28T10:00:00.000Z', by: 'dev-ella', messageId: `m${n}`, excerpt: `Done ${n}` },
    rejectCount: 0,
    ...over,
  } as unknown as Request;
}

describe('WaitingItemsSyncService', () => {
  let requests: Map<string, Request>;
  let intake: TicketIntakeService;
  let fetchMock: jest.Mock<WaitingSyncFetch>;
  let token: string | null;
  let clock: number;
  let caps: string[];
  let changeListener: (() => void) | null;
  let refresh: jest.Mock<() => Promise<boolean>>;
  let service: WaitingItemsSyncService;
  let env: NodeJS.ProcessEnv;

  const bodies = (): WaitingIngestRequest[] =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as WaitingIngestRequest);

  beforeEach(() => {
    requests = new Map();
    const store: TicketRequestStore = {
      create: async () => {
        throw new Error('unused');
      },
      getById: async (id) => requests.get(id) ?? null,
      listAll: async () => [...requests.values()],
      update: async () => {
        throw new Error('unused');
      },
      getRequestsDir: () => '/tmp/none',
    };
    intake = new TicketIntakeService({ requests: store, findWorkItem: async () => ({ status: 'done' }) });
    fetchMock = jest.fn<WaitingSyncFetch>().mockResolvedValue(json(200, { success: true, upserted: 1 }));
    token = tokenFor('acct-1');
    clock = T0;
    caps = ['talk_message', 'waiting_actions'];
    changeListener = null;
    refresh = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
    env = {};
    service = new WaitingItemsSyncService({
      listWaiting: async () => (await intake.list({ column: 'to_review' })).tickets,
      cloud: { getToken: () => token, getCloudUrl: () => `${CLOUD}/`, tryRefreshToken: refresh },
      identity: async () => ({ instanceId: 'dev-mac-mini', deviceName: 'Mac mini' }),
      crewlyVersion: async () => '1.20.152',
      agentNames: async () => new Map([['dev-ella', 'Ella']]),
      capabilities: () => caps,
      onTicketChange: (fn) => {
        changeListener = fn;
        return () => {
          changeListener = null;
        };
      },
      env,
      fetchImpl: fetchMock,
      now: () => clock,
      setTimeout: (() => 0) as unknown as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
      logger: logger(),
    });
  });

  it('uploads the 待验收 set as a full snapshot with the machine name and capabilities', async () => {
    requests.set('r1', ticket('r1', 1));
    requests.set('r2', ticket('r2', 2, { status: 'running' })); // in progress → not waiting
    requests.set('r3', ticket('r3', 3, { workItemIds: ['w1'], status: 'running' })); // all WorkItems done → to_review
    requests.set('r4', ticket('r4', 4, { requiresConfirmation: false })); // no review needed
    expect(await service.syncNow()).toBe('uploaded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CLOUD}/api/cloud/conversations/waiting/ingest`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    const body = bodies()[0];
    expect(body).toMatchObject({ instanceId: 'dev-mac-mini', deviceName: 'Mac mini', crewlyVersion: '1.20.152', full: true, capabilities: caps });
    expect(body.items.map((i) => i.ticketId)).toEqual(['r1', 'r3']);
    expect(body.items[0]).toMatchObject({ tkt: 'TKT-001', title: 'Ticket 1', excerpt: 'Done 1', agentSession: 'dev-ella', agentName: 'Ella' });
  });

  it('skips the upload while nothing changed, uploads on a change, and resyncs fully every 5 minutes', async () => {
    requests.set('r1', ticket('r1', 1));
    await service.syncNow();
    expect(await service.syncNow()).toBe('unchanged');

    requests.delete('r1'); // accepted on the machine
    expect(await service.syncNow()).toBe('uploaded');
    expect(bodies()[1].items).toEqual([]);

    expect(await service.syncNow()).toBe('unchanged');
    clock += WAITING_SYNC_CONSTANTS.FULL_SYNC_INTERVAL_MS;
    expect(await service.syncNow()).toBe('uploaded');
    // A capability change (the action handler started) is an upload too.
    caps = ['talk_message'];
    expect(await service.syncNow()).toBe('uploaded');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does nothing when signed out or switched off, and starts over for another account', async () => {
    requests.set('r1', ticket('r1', 1));
    token = null;
    expect(await service.syncNow()).toBe('skipped');
    token = tokenFor('acct-1');
    env.CREWLY_CONVERSATION_SYNC = '0';
    expect(await service.syncNow()).toBe('skipped');
    delete env.CREWLY_CONVERSATION_SYNC;
    expect(await service.syncNow()).toBe('uploaded');
    token = tokenFor('acct-2');
    expect(await service.syncNow()).toBe('uploaded');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pauses an hour when Cloud has no inbox yet, backs off on errors, refreshes the token on 401', async () => {
    requests.set('r1', ticket('r1', 1));
    fetchMock.mockResolvedValueOnce(json(404, { code: 'not_found' }));
    expect(await service.syncNow()).toBe('paused');
    expect(await service.syncNow()).toBe('paused');
    clock += WAITING_SYNC_CONSTANTS.UNAVAILABLE_RETRY_MS;

    fetchMock.mockResolvedValueOnce(json(401, {}));
    expect(await service.syncNow()).toBe('failed');
    expect(refresh).toHaveBeenCalled();
    expect(await service.syncNow()).toBe('paused');
    clock += WAITING_SYNC_CONSTANTS.BACKOFF_INITIAL_MS;

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await service.syncNow()).toBe('failed');
    clock += WAITING_SYNC_CONSTANTS.BACKOFF_INITIAL_MS * 2;
    expect(await service.syncNow()).toBe('uploaded');
  });

  it('subscribes to ticket changes on start and unsubscribes on stop', () => {
    service.start();
    expect(changeListener).not.toBeNull();
    service.stop();
    expect(changeListener).toBeNull();
  });
});
