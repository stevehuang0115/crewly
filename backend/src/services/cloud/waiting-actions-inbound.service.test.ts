/**
 * Tests for WaitingActionsInboundService — the machine side of accept /
 * send-back from the Crewly Cloud portal: verify-by-fetch, run through the
 * ticket review, report, idempotency on re-push, refusals.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { ComponentLogger } from '../core/logger.service.js';
import type { ReviewActionResult } from '../v3/ticket-review.service.js';
import type { Request } from '../../types/v2/request.types.js';
import type { IncomingMessage } from './cloud-sync.types.js';
import {
  WaitingActionsInboundService,
  refusalText,
  waitingActionCapabilities,
  type WaitingActionsFetch,
  type WaitingActionsReview,
} from './waiting-actions-inbound.service.js';

const INSTANCE = 'dev-mac-mini';
const CLOUD = 'https://api.crewly.test';

function logger(): ComponentLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as ComponentLogger;
}

function push(over: Record<string, unknown> = {}, type = 'waiting_action'): IncomingMessage {
  return {
    id: `relay-${Math.random()}`,
    from: 'crewly-cloud-slack-acct',
    fromDeviceName: 'crewly-cloud-slack',
    type: type as IncomingMessage['type'],
    payload: { v: 1, actionId: 'act-1', itemId: 'item-1', instanceId: INSTANCE, ticketId: 'req-1', ...over },
    encrypted: false,
    sentAt: new Date().toISOString(),
  };
}

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const stored = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { actionId: 'act-1', itemId: 'item-1', instanceId: INSTANCE, ticketId: 'req-1', kind: 'accept', state: 'sent', ...over },
});

const okTicket = { ok: true, ticket: { id: 'req-1' } as Request } as ReviewActionResult;

describe('WaitingActionsInboundService', () => {
  let source: EventEmitter;
  let fetchMock: jest.Mock<WaitingActionsFetch>;
  let review: { verify: jest.Mock<WaitingActionsReview['verify']>; reject: jest.Mock<WaitingActionsReview['reject']> };
  let reviewReady: boolean;
  let resync: jest.Mock<() => void>;
  let refresh: jest.Mock<() => Promise<boolean>>;
  let service: WaitingActionsInboundService;

  /** Route fetches: GET action → `action`, POST result → 200. */
  function cloudReturns(action: Response): void {
    fetchMock.mockImplementation(async (url, init) => {
      if ((init as RequestInit).method === 'POST') return json(200, { success: true, data: { state: 'removed' } });
      return action;
    });
  }

  const reports = () =>
    fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit).method === 'POST')
      .map(([url, init]) => ({ url, body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

  beforeEach(() => {
    source = new EventEmitter();
    fetchMock = jest.fn<WaitingActionsFetch>();
    cloudReturns(json(200, stored()));
    review = {
      verify: jest.fn<WaitingActionsReview['verify']>().mockResolvedValue(okTicket),
      reject: jest.fn<WaitingActionsReview['reject']>().mockResolvedValue(okTicket),
    };
    reviewReady = true;
    resync = jest.fn<() => void>();
    refresh = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
    service = new WaitingActionsInboundService({
      source,
      cloud: { getToken: () => 'machine-token', getCloudUrl: () => `${CLOUD}/`, tryRefreshToken: refresh },
      review: () => (reviewReady ? review : null),
      identity: async () => ({ instanceId: INSTANCE, deviceName: 'Mac mini' }),
      requestResync: resync,
      fetchImpl: fetchMock,
      sleep: async () => undefined,
      logger: logger(),
    });
  });

  afterEach(() => service.stop());

  it('accept: fetches the action with the machine token, verifies the ticket, reports ok and asks for a resync', async () => {
    expect(await service.handle(push())).toBe('done');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CLOUD}/api/cloud/conversations/waiting/actions/act-1?instanceId=${INSTANCE}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer machine-token');
    expect(review.verify).toHaveBeenCalledWith('req-1');
    expect(reports()).toEqual([{ url: `${CLOUD}/api/cloud/conversations/waiting/actions/act-1/result`, body: { instanceId: INSTANCE, ok: true } }]);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('send-back: rejects with the reason from Cloud, like the board', async () => {
    cloudReturns(json(200, stored({ kind: 'send_back', reason: 'The button is still blue' })));
    expect(await service.handle(push())).toBe('done');
    expect(review.reject).toHaveBeenCalledWith('req-1', 'The button is still blue', 'board');
    expect(review.verify).not.toHaveBeenCalled();
  });

  it('reports a refusal in words the owner can read', async () => {
    review.verify.mockResolvedValue({ ok: false, reason: 'open_work' });
    expect(await service.handle(push())).toBe('refused');
    expect(reports()[0].body).toEqual({ instanceId: INSTANCE, ok: false, code: 'open_work', error: refusalText('open_work', 'Mac mini') });
  });

  it('a re-push of an action already carried out only re-reports', async () => {
    await service.handle(push());
    expect(await service.handle(push())).toBe('duplicate');
    expect(review.verify).toHaveBeenCalledTimes(1);
    expect(reports()).toHaveLength(2);
  });

  it('never runs what Cloud does not confirm for this machine', async () => {
    expect(await service.handle(push({ instanceId: 'other-box' }))).toBe('not_for_this_machine');
    cloudReturns(json(404, {}));
    expect(await service.handle(push())).toBe('unverified');
    cloudReturns(json(200, stored({ ticketId: 'req-OTHER' })));
    expect(await service.handle(push())).toBe('unverified');
    cloudReturns(json(410, {}));
    expect(await service.handle(push())).toBe('expired');
    expect(review.verify).not.toHaveBeenCalled();
    expect(reports()).toEqual([]);
  });

  it('retries fetch errors, refreshes the token once on 401, and waits for ticket review to be ready', async () => {
    cloudReturns(json(500, {}));
    expect(await service.handle(push())).toBe('fetch_failed');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockReset();
    refresh.mockResolvedValue(true);
    cloudReturns(json(200, stored()));
    fetchMock.mockResolvedValueOnce(json(401, {}));
    expect(await service.handle(push({ actionId: 'act-1' }))).toBe('done');
    expect(refresh).toHaveBeenCalledTimes(1);

    reviewReady = false;
    cloudReturns(json(200, stored({ actionId: 'act-2' })));
    expect(await service.handle(push({ actionId: 'act-2' }))).toBe('fetch_failed');
  });

  it('ignores other relay types and malformed pushes; advertises the capability only while running', async () => {
    expect(await service.handle(push({}, 'talk_message'))).toBe('ignored');
    expect(await service.handle({ ...push(), payload: { actionId: 'x' } })).toBe('ignored');
    expect(waitingActionCapabilities()).toEqual([]);
    service.start();
    expect(waitingActionCapabilities()).toEqual(['waiting_actions']);
    source.emit('message', push());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(review.verify).toHaveBeenCalled();
    service.stop();
    expect(waitingActionCapabilities()).toEqual([]);
  });
});
