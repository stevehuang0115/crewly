/**
 * Browser session client tests.
 *
 * @module services/browser-session.service.test
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchBrowserSessions, frameUrl, stopBrowserSession, sendBrowserInput, fetchBrowserFrame, frameToBlob } from './browser-session.service';

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

describe('sendBrowserInput', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts the input to the session and reports the fresh frame', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { frame: { capturedAt: 77 } } }) });

    await expect(sendBrowserInput('pia', { kind: 'key', key: 'Enter' })).resolves.toEqual({ ok: true, frameAt: 77 });
    expect(mockFetch).toHaveBeenCalledWith('/api/browser/sessions/pia/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'key', key: 'Enter' }),
    });
  });

  it('hands back the frame the reply carries, so it can be shown at once', async () => {
    const frame = { base64: 'QUJD', mimeType: 'image/jpeg', capturedAt: 88 };
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { frame } }) });
    await expect(sendBrowserInput('pia', { kind: 'back' })).resolves.toEqual({ ok: true, frameAt: 88, frame });
  });

  it('passes the backend reason through on a refusal', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Take control of this browser first.' }) });
    await expect(sendBrowserInput('pia', { kind: 'back' })).resolves.toEqual({
      ok: false,
      error: 'Take control of this browser first.',
    });
  });

  it('never throws when offline', async () => {
    mockFetch.mockImplementation(async () => {
      throw new Error('offline');
    });
    const result = await sendBrowserInput('pia', { kind: 'back' });
    expect(result).toEqual({ ok: false, error: 'offline' });
  });
});

describe('fetchBrowserFrame', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A fetch Response for an image, with an optional capture-time header. */
  function imageResponse(type: string, body: string, capturedAt?: string) {
    return {
      ok: true,
      headers: { get: (h: string) => (h === 'X-Frame-Captured-At' ? capturedAt ?? null : null) },
      blob: async () => new Blob([body], { type }),
    };
  }

  it('returns the image with its capture time', async () => {
    mockFetch.mockResolvedValue(imageResponse('image/jpeg', 'jpeg', '1234'));
    const got = await fetchBrowserFrame('pia', 1, 3);
    expect(got?.capturedAt).toBe(1234);
    expect(got?.blob.type).toBe('image/jpeg');
    expect(mockFetch).toHaveBeenCalledWith('/api/browser/sessions/pia/frame?t=1&p=3', { cache: 'no-store' });
  });

  it('is null for anything that is not a picture, so the last good frame stays', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchBrowserFrame('pia', 1, 1)).resolves.toBeNull();
    mockFetch.mockResolvedValue(imageResponse('image/jpeg', ''));
    await expect(fetchBrowserFrame('pia', 1, 1)).resolves.toBeNull();
    mockFetch.mockResolvedValue(imageResponse('application/json', '{}'));
    await expect(fetchBrowserFrame('pia', 1, 1)).resolves.toBeNull();
  });
});

describe('frameToBlob', () => {
  it('decodes the base64 into an image of the given type', async () => {
    const blob = frameToBlob({ base64: btoa('hello'), mimeType: 'image/png', capturedAt: 1 });
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(5);
  });
});
