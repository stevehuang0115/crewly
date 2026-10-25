/**
 * Tests for the activity log API client (#881).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityApiError, activityQueryString, listActivity } from './activity.service';

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

describe('activity service', () => {
  it('builds the query from set fields only, trimmed', () => {
    expect(activityQueryString({})).toBe('');
    expect(activityQueryString({ actorType: '', action: ' team. ', since: '2026-10-25', limit: 50 })).toBe(
      '?action=team.&since=2026-10-25&limit=50',
    );
  });

  it('reads a page and defaults a missing body', async () => {
    const entry = { id: 'e1', ts: '2026-10-25T10:00:00.000Z', actor: { type: 'owner' }, action: 'team.updated', target: { type: 'team', id: 't1' } };
    respond({ success: true, data: { count: 1, limit: 100, entries: [entry] } });
    expect(await listActivity({ actorType: 'owner' })).toEqual({ count: 1, limit: 100, entries: [entry] });
    expect(fetchMock).toHaveBeenCalledWith('/api/activity?actorType=owner');

    respond({ success: true });
    expect(await listActivity({ limit: 20 })).toEqual({ count: 0, limit: 20, entries: [] });
  });

  it('throws the API message on a refusal', async () => {
    respond({ success: false, error: 'owner_only', message: 'Only the owner can read the activity log.' }, 403);
    await expect(listActivity()).rejects.toMatchObject<Partial<ActivityApiError>>({
      status: 403,
      message: 'Only the owner can read the activity log.',
    });
  });
});
