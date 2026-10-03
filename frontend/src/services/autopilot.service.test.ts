/**
 * Tests for the autopilot stats / runs client.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AutopilotApiError, getAutopilotRuns, getAutopilotStats } from './autopilot.service';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('autopilot.service', () => {
  it('reads stats with the range and label', async () => {
    const fn = stubFetch(200, { success: true, data: { days: [], total: {} } });
    await getAutopilotStats('p 1', 14, 'feed');
    expect(fn).toHaveBeenCalledWith('/api/project-ticket-autopilot/p%201/stats?days=14&label=feed');
  });

  it('reads runs and unwraps the days', async () => {
    stubFetch(200, { success: true, data: { days: [{ day: '2026-10-03', runTraceId: 'tr-1', traces: [] }] } });
    expect(await getAutopilotRuns('p1', 7)).toEqual([{ day: '2026-10-03', runTraceId: 'tr-1', traces: [] }]);
  });

  it('throws with the status', async () => {
    stubFetch(403, { success: false, error: 'Only the owner' });
    await expect(getAutopilotStats('p1', 7)).rejects.toMatchObject({ status: 403, message: 'Only the owner' });
    await expect(getAutopilotStats('p1', 7)).rejects.toBeInstanceOf(AutopilotApiError);
  });
});
