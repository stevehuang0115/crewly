/**
 * Tests for the tickets API client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildTicketListQuery,
  dismissTicket,
  fetchTicket,
  fetchTickets,
  patchTicket,
  rejectTicket,
  setTicketAcceptance,
  verifyTicket,
} from './tickets.service';
import { TicketApiError } from '../types/ticket.types';

const fetchMock = vi.fn();

/**
 * Queue one fetch response.
 *
 * @param body - JSON body
 * @param status - HTTP status
 */
function respond(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildTicketListQuery', () => {
  it('omits empty filters', () => {
    expect(buildTicketListQuery()).toBe('');
    expect(buildTicketListQuery({ q: '   ' })).toBe('');
  });

  it('encodes every filter', () => {
    expect(buildTicketListQuery({ column: 'to_review', kind: 'issue', q: ' 登录 ', includeLegacy: true }))
      .toBe('?column=to_review&kind=issue&q=%E7%99%BB%E5%BD%95&includeLegacy=true');
  });
});

describe('fetchTickets', () => {
  it('GETs the board and unwraps data', async () => {
    respond({ success: true, data: { tickets: [{ id: 'a' }], columns: { todo: 1 } } });
    const res = await fetchTickets({ kind: 'feature' });
    expect(fetchMock).toHaveBeenCalledWith('/api/tickets?kind=feature', undefined);
    expect(res).toEqual({ tickets: [{ id: 'a' }], columns: { todo: 1 } });
  });

  it('defaults missing fields', async () => {
    respond({ success: true, data: {} });
    expect(await fetchTickets()).toEqual({ tickets: [], columns: {} });
  });

  it('throws TicketApiError on failure', async () => {
    respond({ success: false, error: 'Unknown kind: x' }, 400);
    await expect(fetchTickets()).rejects.toMatchObject({ status: 400, message: 'Unknown kind: x' });
  });

  it('survives a non-JSON error body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error('bad'); } });
    await expect(fetchTickets()).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });
});

describe('fetchTicket', () => {
  it('GETs one ticket by encoded id', async () => {
    respond({ success: true, data: { ticket: { id: 'a' }, board: { id: 'a' } } });
    await fetchTicket('TKT-001');
    expect(fetchMock).toHaveBeenCalledWith('/api/tickets/TKT-001', undefined);
  });
});

describe('review actions', () => {
  it('verify POSTs /verify', async () => {
    respond({ success: true, data: {} });
    await verifyTicket('id1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tickets/id1/verify');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('reject POSTs the trimmed reason', async () => {
    respond({ success: true, data: {} });
    await rejectTicket('id1', '  按钮还是灰的 ');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tickets/id1/reject');
    expect(JSON.parse(init.body)).toEqual({ reason: '按钮还是灰的' });
  });

  it('reject refuses a blank reason without calling the server', async () => {
    await expect(rejectTicket('id1', '   ')).rejects.toBeInstanceOf(TicketApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries the refusal code', async () => {
    respond({ success: false, error: 'Ticket is not waiting for review', code: 'not_in_review' }, 409);
    await expect(rejectTicket('id1', 'x')).rejects.toMatchObject({ status: 409, code: 'not_in_review' });
  });

  it('dismiss POSTs /dismiss', async () => {
    respond({ success: true, data: {} });
    await dismissTicket('id1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tickets/id1/dismiss');
  });

  it('acceptance PUTs the items', async () => {
    respond({ success: true, data: {} });
    await setTicketAcceptance('id1', [{ text: 'a', check: 'auto' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tickets/id1/acceptance');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ items: [{ text: 'a', check: 'auto' }] });
  });

  it('patch PATCHes the fields', async () => {
    respond({ success: true, data: {} });
    await patchTicket('id1', { priority: 'urgent' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tickets/id1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ priority: 'urgent' });
  });
});
