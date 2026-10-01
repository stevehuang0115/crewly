/**
 * Tests for the owner decisions API client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chooseDecision, listOpenDecisions, remindDecisionTomorrow } from './decisions.service';
import { DecisionApiError } from '../types/decision.types';

const fetchMock = vi.fn();

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

describe('decisions service', () => {
  it('lists open decisions and defaults a missing array', async () => {
    respond({ success: true, data: [{ id: 'D-1' }] });
    expect(await listOpenDecisions()).toEqual([{ id: 'D-1' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/decisions?status=open', undefined);
    respond({ success: true });
    expect(await listOpenDecisions()).toEqual([]);
  });

  it('posts choose and remind to the decision sub-resources', async () => {
    respond({ success: true, data: { id: 'D-1', status: 'resolved' } });
    await chooseDecision('D-1', 'b');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/decisions/D-1/choose');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ option: 'b' });

    respond({ success: true, data: { id: 'D-1' } });
    await remindDecisionTomorrow('D-1');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/decisions/D-1/remind');
  });

  it('throws DecisionApiError with the server message', async () => {
    respond({ success: false, error: 'Decision D-9 is resolved' }, 409);
    await expect(chooseDecision('D-9', 'a')).rejects.toMatchObject({ name: 'DecisionApiError', status: 409, message: 'Decision D-9 is resolved' });
    respond({}, 500);
    await expect(listOpenDecisions()).rejects.toBeInstanceOf(DecisionApiError);
  });
});
