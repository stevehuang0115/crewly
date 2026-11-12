/**
 * Tests for the support client (crewly#1558): the Cloud lookups with this
 * machine's login, and one agent read over a fake relay: how the answer is
 * matched, what happens when none comes, and how failures are named.
 */

import { SUPPORT_VIEW_CONSTANTS } from '../../constants.js';
import { SupportClientService, type ISupportClientCloudSync, type SupportClientIncomingMessage } from './support-client.service.js';
import { SupportViewError } from './support-client.types.js';

const F = SUPPORT_VIEW_CONSTANTS.FAILURES;
const TOKEN = 'secret-cloud-token';
const MACHINE = { relayQueueId: 'q-theirs' };

interface Sent {
  peer: string;
  data: { id: string; method: string; path: string };
  agent: string;
}

function make(opts: { queueId?: string | null; send?: (sent: Sent) => Promise<void> | void; login?: { baseUrl: string; token: string } | null; fetchImpl?: jest.Mock; timeoutMs?: number } = {}) {
  const handlers: Array<(m: SupportClientIncomingMessage) => void> = [];
  const sent: Sent[] = [];
  const cloudSync: ISupportClientCloudSync = {
    on: (_e, h) => void handlers.push(h),
    off: (_e, h) => void handlers.splice(handlers.indexOf(h), 1),
    getQueueId: () => (opts.queueId === undefined ? 'q-mine' : opts.queueId),
    sendSupportAgentRequest: async (peer, data, agent) => {
      const s = { peer, data, agent };
      sent.push(s);
      await opts.send?.(s);
    },
  };
  const warn = jest.fn();
  let n = 0;
  const fetchImpl = opts.fetchImpl ?? jest.fn();
  const client = new SupportClientService({
    cloudSync,
    cloud: async () => (opts.login === undefined ? { baseUrl: 'https://cloud.test/', token: TOKEN } : opts.login),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    responseTimeoutMs: opts.timeoutMs ?? 20_000,
    newId: () => `id-${++n}`,
    logger: { info: jest.fn(), warn },
  });
  const deliver = (msg: SupportClientIncomingMessage): void => handlers.slice().forEach((h) => h(msg));
  const answer = (id: string, status: number, body: unknown): void => deliver({ type: 'api_response', payload: { id, status, body } });
  return { client, handlers, sent, deliver, answer, warn, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

async function failure(promise: Promise<unknown>): Promise<SupportViewError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SupportViewError);
    return error as SupportViewError;
  }
  throw new Error('expected the call to fail');
}

describe('SupportClientService listener', () => {
  it('attaches once and detaches on stop', () => {
    const { client, handlers } = make();
    client.start();
    client.start();
    expect(handlers).toHaveLength(1);
    client.stop();
    expect(handlers).toHaveLength(0);
    client.stop();
  });

  it('refuses a read before it is started', async () => {
    const { client, sent } = make();
    expect((await failure(client.read(MACHINE, { area: 'agents' }, 'Nova'))).code).toBe(F.NOT_CONNECTED);
    expect(sent).toHaveLength(0);
  });
});

describe('SupportClientService.read', () => {
  it('sends one agent GET and returns the data of the matching answer', async () => {
    const { client, sent, answer } = make();
    client.start();
    const reading = client.read(MACHINE, { area: 'conversations', limit: 5 }, 'Nova');
    await Promise.resolve();
    expect(sent).toEqual([{ peer: 'q-theirs', data: { id: 'id-1', method: 'GET', path: '/support/conversations?limit=5' }, agent: 'Nova' }]);
    expect(client.pendingCount()).toBe(1);
    answer('id-1', 200, { success: true, data: { conversations: [{ id: 'c1' }] } });
    await expect(reading).resolves.toEqual({ conversations: [{ id: 'c1' }] });
    expect(client.pendingCount()).toBe(0);
  });

  it('takes an answer that arrives before the send call returns', async () => {
    const ctx = make({ send: (s) => ctx.answer(s.data.id, 200, { success: true, data: 'early' }) });
    ctx.client.start();
    await expect(ctx.client.read(MACHINE, { area: 'agents' }, 'Nova')).resolves.toBe('early');
    expect(ctx.client.pendingCount()).toBe(0);
  });

  it('matches by id only: other messages and unknown ids are left alone', async () => {
    const { client, deliver, answer } = make();
    client.start();
    const first = client.read(MACHINE, { area: 'agents' }, 'Nova');
    const second = client.read(MACHINE, { area: 'errors' }, 'Nova');
    await Promise.resolve();
    deliver({ type: 'api_request', payload: { id: 'id-1', status: 200, body: { success: true, data: 'not an answer' } } });
    deliver({ type: 'chat_response', payload: { id: 'id-1' } });
    answer('someone-elses-id', 200, { success: true, data: 'not ours' });
    deliver({ type: 'api_response', payload: null });
    deliver({ type: 'api_response', payload: { id: 7 } });
    expect(client.pendingCount()).toBe(2);
    answer('id-2', 200, { success: true, data: 'second' });
    answer('id-1', 200, { success: true, data: 'first' });
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    // A duplicate answer finds nothing waiting.
    answer('id-1', 200, { success: true, data: 'again' });
    expect(client.pendingCount()).toBe(0);
  });

  it('gives up after the timeout and forgets the request', async () => {
    jest.useFakeTimers();
    try {
      const { client, answer } = make({ timeoutMs: 20_000 });
      client.start();
      const reading = failure(client.read(MACHINE, { area: 'agents' }, 'Nova'));
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(19_999);
      expect(client.pendingCount()).toBe(1);
      jest.advanceTimersByTime(1);
      expect((await reading).code).toBe(F.OFFLINE);
      expect(client.pendingCount()).toBe(0);
      // A late answer is ignored.
      answer('id-1', 200, { success: true, data: 'late' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the timer when the answer comes', async () => {
    jest.useFakeTimers();
    try {
      const { client, answer } = make();
      client.start();
      const reading = client.read(MACHINE, { area: 'agents' }, 'Nova');
      await Promise.resolve();
      answer('id-1', 200, { success: true, data: 1 });
      await expect(reading).resolves.toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [404, null, F.ACCESS_ENDED],
    [403, 'support_agent_access_off', F.AGENT_ACCESS_OFF],
    [403, 'support_agent_read_only', F.READ_ONLY],
    [403, 'support_agent_path_refused', F.NOT_ALLOWED],
    [429, 'support_agent_rate_limited', F.RATE_LIMITED],
    [500, null, F.FAILED],
  ])('names a relay refusal %i %p as %s and forgets the request', async (status, code, expected) => {
    const { client } = make({
      send: () => {
        throw Object.assign(new Error('refused'), { status, code });
      },
    });
    client.start();
    expect((await failure(client.read(MACHINE, { area: 'agents' }, 'Nova'))).code).toBe(expected);
    expect(client.pendingCount()).toBe(0);
  });

  it('names a send that could not be made as not connected, without leaking the cause', async () => {
    const { client, warn } = make({
      send: () => {
        throw new Error('fetch failed');
      },
    });
    client.start();
    const error = await failure(client.read(MACHINE, { area: 'agents' }, 'Nova'));
    expect(error.code).toBe(F.NOT_CONNECTED);
    expect(error.message).not.toContain('fetch failed');
    expect(warn).toHaveBeenCalled();
    expect(client.pendingCount()).toBe(0);
  });

  it.each([
    [403, { success: false, code: 'support_disabled' }, F.DISABLED],
    [404, { success: false, code: 'support_not_found' }, F.NOT_FOUND],
    [403, { success: false, code: 'support_agent_read_only' }, F.READ_ONLY],
    [403, { success: false, code: 'support_agent_path_refused' }, F.NOT_ALLOWED],
    [500, { success: false, code: 'support_unavailable' }, F.FAILED],
    [200, { success: false }, F.FAILED],
    [200, 'not an object', F.FAILED],
    [200, null, F.FAILED],
  ])('names the answer %i %p as %s', async (status, body, expected) => {
    const ctx = make({ send: (s) => ctx.answer(s.data.id, status, body) });
    ctx.client.start();
    expect((await failure(ctx.client.read(MACHINE, { area: 'agents' }, 'Nova'))).code).toBe(expected);
  });

  it('drops an answer larger than the cap', async () => {
    const ctx = make({ send: (s) => ctx.answer(s.data.id, 200, { success: true, data: 'x'.repeat(SUPPORT_VIEW_CONSTANTS.MAX_RESPONSE_CHARS + 1) }) });
    ctx.client.start();
    expect((await failure(ctx.client.read(MACHINE, { area: 'errors' }, 'Nova'))).code).toBe(F.FAILED);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringMatching(/larger than the cap/), expect.any(Object));
    expect(ctx.client.pendingCount()).toBe(0);
  });

  it('reads an answer without a whole-number status as a failure', async () => {
    const ctx = make({ send: (s) => ctx.deliver({ type: 'api_response', payload: { id: s.data.id, status: '200', body: { success: true, data: 1 } } }) });
    ctx.client.start();
    expect((await failure(ctx.client.read(MACHINE, { area: 'agents' }, 'Nova'))).code).toBe(F.FAILED);
  });

  it('refuses locally: a machine with no relay queue, no queue of its own, a path that is not a read', async () => {
    const { client, sent } = make();
    client.start();
    expect((await failure(client.read({ relayQueueId: '' }, { area: 'agents' }, 'Nova'))).code).toBe(F.OFFLINE);
    expect((await failure(client.read(MACHINE, { area: 'messages', conversationId: '../settings' }, 'Nova'))).code).toBe(F.INVALID);
    expect((await failure(client.read(MACHINE, { area: 'settings' } as never, 'Nova'))).code).toBe(F.NOT_ALLOWED);
    const unregistered = make({ queueId: null });
    unregistered.client.start();
    expect((await failure(unregistered.client.read(MACHINE, { area: 'agents' }, 'Nova'))).code).toBe(F.NOT_CONNECTED);
    expect(sent).toHaveLength(0);
    expect(unregistered.sent).toHaveLength(0);
  });

  it('refuses more waiting requests than the cap', async () => {
    const { client, sent } = make();
    client.start();
    const waiting = Array.from({ length: SUPPORT_VIEW_CONSTANTS.MAX_PENDING }, () => client.read(MACHINE, { area: 'agents' }, 'Nova').catch((e) => e));
    await Promise.resolve();
    expect(client.pendingCount()).toBe(SUPPORT_VIEW_CONSTANTS.MAX_PENDING);
    expect((await failure(client.read(MACHINE, { area: 'agents' }, 'Nova'))).code).toBe(F.RATE_LIMITED);
    expect(sent).toHaveLength(SUPPORT_VIEW_CONSTANTS.MAX_PENDING);
    client.stop();
    const ended = await Promise.all(waiting);
    expect(ended.every((e) => e instanceof SupportViewError && e.code === F.OFFLINE)).toBe(true);
    expect(client.pendingCount()).toBe(0);
  });
});

describe('SupportClientService Cloud lookups', () => {
  it('lists the active grants this account received, with this machine\'s login', async () => {
    const fetchImpl = jest.fn(async () =>
      json(200, { success: true, data: { grants: [{ id: 'g1', grantorEmail: 'steve@example.com', role: 'viewer', includePrivate: false, agentAccess: true }] } }),
    );
    const { client } = make({ fetchImpl });
    await expect(client.listGrants()).resolves.toEqual([{ id: 'g1', grantorEmail: 'steve@example.com', role: 'viewer', includePrivate: false, agentAccess: true, instanceId: null }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloud.test/api/cloud/support-grants/received');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBeUndefined();
  });

  it('lists the machines of one grant', async () => {
    const fetchImpl = jest.fn(async () => json(200, { success: true, data: { instances: [{ instanceId: 'i1', deviceName: 'Studio Mac', relayQueueId: 'q-1', live: true }] } }));
    const { client } = make({ fetchImpl });
    await expect(client.listMachines('g 1/x')).resolves.toEqual([{ instanceId: 'i1', deviceName: 'Studio Mac', relayQueueId: 'q-1', live: true }]);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://cloud.test/api/cloud/support-grants/g%201%2Fx/instances');
  });

  it('reads a body without a data wrapper as the data', async () => {
    const { client } = make({ fetchImpl: jest.fn(async () => json(200, { grants: [{ id: 'g1', status: 'active' }] })) });
    expect(await client.listGrants()).toHaveLength(1);
  });

  it.each([
    [401, F.NOT_CONNECTED],
    [403, F.ACCESS_ENDED],
    [404, F.ACCESS_ENDED],
    [429, F.RATE_LIMITED],
    [500, F.FAILED],
  ])('names a Cloud %i as %s', async (status, expected) => {
    const { client } = make({ fetchImpl: jest.fn(async () => json(status, { success: false, error: 'no' })) });
    expect((await failure(client.listMachines('g1'))).code).toBe(expected);
  });

  it.each([
    [401, F.NOT_CONNECTED],
    [403, F.ACCESS_ENDED],
    [404, F.CLOUD_UNSUPPORTED],
    [429, F.RATE_LIMITED],
    [500, F.FAILED],
  ])('names a Cloud %i for the received-grants list as %s', async (status, expected) => {
    const { client } = make({ fetchImpl: jest.fn(async () => json(status, { success: false, error: 'no' })) });
    expect((await failure(client.listGrants())).code).toBe(expected);
  });

  it('says an older Cloud does not support agent access yet', async () => {
    const { client } = make({ fetchImpl: jest.fn(async () => json(404, { success: false, error: 'Not found' })) });
    const error = await failure(client.listGrants());
    expect(error.message).toBe('This Crewly Cloud does not support agent access yet.');
    expect(error.status).toBe(501);
  });

  it('is not connected when this machine is not signed in, and does not call Cloud', async () => {
    const { client, fetchImpl } = make({ login: null });
    expect((await failure(client.listGrants())).code).toBe(F.NOT_CONNECTED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the token in an error or a log line', async () => {
    const offline = make({
      fetchImpl: jest.fn(async () => {
        throw new Error(`connect failed with Bearer ${TOKEN}`);
      }),
    });
    const down = await failure(offline.client.listGrants());
    expect(down.code).toBe(F.NOT_CONNECTED);
    const unreadable = make({
      fetchImpl: jest.fn(async () => ({ status: 200, ok: true, json: async () => { throw new Error(TOKEN); } }) as unknown as Response),
    });
    const bad = await failure(unreadable.client.listGrants());
    expect(bad.code).toBe(F.FAILED);
    for (const text of [down.message, bad.message, JSON.stringify(offline.warn.mock.calls), JSON.stringify(unreadable.warn.mock.calls)]) {
      expect(text).not.toContain(TOKEN);
    }
  });
});
