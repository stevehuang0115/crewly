/**
 * Browser session client tests.
 *
 * @module services/browser-session.service.test
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchBrowserSessions, frameUrl, stopBrowserSession } from './browser-session.service';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('fetchBrowserSessions', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('returns the sessions the backend reports', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { sessions: [{ id: 'pia' }] } }),
    });

    await expect(fetchBrowserSessions()).resolves.toEqual([{ id: 'pia' }]);
    expect(mockFetch).toHaveBeenCalledWith('/api/browser/sessions');
  });

  it('asks for active sessions only when told to', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { sessions: [] } }) });

    await fetchBrowserSessions(true);

    expect(mockFetch).toHaveBeenCalledWith('/api/browser/sessions?active=1');
  });

  it('returns nothing rather than throwing when the backend errors', async () => {
    // This list polls every couple of seconds; a transient failure must not
    // take the page down or spam an error state.
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchBrowserSessions()).resolves.toEqual([]);

    mockFetch.mockRejectedValue(new Error('offline'));
    await expect(fetchBrowserSessions()).resolves.toEqual([]);
  });

  it('copes with a well-formed response that carries no sessions key', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: {} }) });
    await expect(fetchBrowserSessions()).resolves.toEqual([]);
  });
});

describe('frameUrl', () => {
  it('addresses the session and busts the cache on the capture time', () => {
    expect(frameUrl('pia', 42)).toBe('/api/browser/sessions/pia/frame?t=42');
  });

  it('escapes a session name that needs it', () => {
    expect(frameUrl('team/agent name')).toContain('team%2Fagent%20name');
  });

  it('is stable when no frame has been captured', () => {
    expect(frameUrl('pia')).toBe('/api/browser/sessions/pia/frame?t=0');
  });
});

describe('stopBrowserSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts to the stop endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await expect(stopBrowserSession('pia')).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('/api/browser/sessions/pia/stop', { method: 'POST' });
  });

  it('reports failure rather than throwing', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    await expect(stopBrowserSession('pia')).resolves.toBe(false);

    mockFetch.mockRejectedValue(new Error('offline'));
    await expect(stopBrowserSession('pia')).resolves.toBe(false);
  });
});
