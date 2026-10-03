/**
 * Owner Session Service Tests (#999)
 *
 * @module services/owner-session.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import {
  ensureOwnerSession,
  getCsrfToken,
  installOwnerSessionAxios,
  installOwnerSessionFetch,
  isOwnApiRequest,
  isOwnerAuthChallenge,
  isWriteMethod,
  resetOwnerSessionForTesting,
} from './owner-session.service';

/** A JSON response. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fake fetch that serves the session endpoint and records API calls. */
function fakeServer() {
  let issued = 0;
  const calls: Array<{ url: string; method: string; csrf: string | null }> = [];
  const replies: Response[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === '/api/auth/session') {
      issued += 1;
      return json(200, { success: true, data: { csrfToken: `csrf-${issued}` } });
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), csrf: headers.get('X-Crewly-CSRF') });
    return replies.shift() ?? json(200, { success: true });
  });
  return { fetchImpl, calls, replies, issued: () => issued };
}

describe('owner-session.service', () => {
  beforeEach(() => {
    resetOwnerSessionForTesting();
  });

  describe('classifiers', () => {
    it('recognises same-origin API calls, writes and the owner challenge', () => {
      expect(isOwnApiRequest('/api/decisions/D1/choose')).toBe(true);
      expect(isOwnApiRequest(`${window.location.origin}/api/tickets`)).toBe(true);
      expect(isOwnApiRequest('/api/auth/session')).toBe(false);
      expect(isOwnApiRequest('https://api.crewlyai.com/api/x')).toBe(false);
      expect(isOwnApiRequest('/assets/x.js')).toBe(false);
      expect(isWriteMethod('post')).toBe(true);
      expect(isWriteMethod(undefined)).toBe(false);
      expect(isOwnerAuthChallenge(401, { error: 'owner_auth_required' })).toBe(true);
      expect(isOwnerAuthChallenge(401, { error: 'Reload this page — Crewly was updated.', code: 'owner_auth_required', reload: true })).toBe(true);
      expect(isOwnerAuthChallenge(401, { error: 'unauthorized' })).toBe(false);
      expect(isOwnerAuthChallenge(403, { error: 'owner_auth_required' })).toBe(false);
    });
  });

  describe('fetch wrapper', () => {
    it('sends the CSRF token on writes, not on reads, and bootstraps once', async () => {
      const server = fakeServer();
      const win = { fetch: server.fetchImpl as unknown as typeof fetch };
      installOwnerSessionFetch(win);
      await Promise.all([
        win.fetch('/api/decisions/D1/choose', { method: 'POST', body: '{}' }),
        win.fetch('/api/system/usage/caps', { method: 'PUT', body: '{}' }),
      ]);
      await win.fetch('/api/tickets');
      expect(server.issued()).toBe(1);
      expect(server.calls.map((c) => [c.method, c.csrf])).toEqual([
        ['POST', 'csrf-1'],
        ['PUT', 'csrf-1'],
        ['GET', null],
      ]);
    });

    it('never sends the token to another origin', async () => {
      const server = fakeServer();
      const win = { fetch: server.fetchImpl as unknown as typeof fetch };
      installOwnerSessionFetch(win);
      await win.fetch('https://api.crewlyai.com/api/x', { method: 'POST' });
      expect(server.issued()).toBe(0);
      expect(server.calls[0].csrf).toBeNull();
    });

    it('refreshes the session and retries once on owner_auth_required (tab outlived a restart)', async () => {
      const server = fakeServer();
      const win = { fetch: server.fetchImpl as unknown as typeof fetch };
      installOwnerSessionFetch(win);
      server.replies.push(json(401, { success: false, error: 'owner_auth_required' }));
      const res = await win.fetch('/api/tickets/T1/verify', { method: 'POST', body: '{}' });
      expect(res.status).toBe(200);
      expect(server.calls.map((c) => c.csrf)).toEqual(['csrf-1', 'csrf-2']);
      expect(getCsrfToken()).toBe('csrf-2');
    });

    it('does not retry a different 401 or a second owner_auth_required', async () => {
      const server = fakeServer();
      const win = { fetch: server.fetchImpl as unknown as typeof fetch };
      installOwnerSessionFetch(win);
      server.replies.push(json(401, { error: 'unauthorized' }));
      expect((await win.fetch('/api/x', { method: 'POST' })).status).toBe(401);
      server.replies.push(json(401, { error: 'owner_auth_required' }), json(401, { error: 'owner_auth_required' }));
      expect((await win.fetch('/api/y', { method: 'POST' })).status).toBe(401);
      expect(server.calls).toHaveLength(3);
    });
  });

  describe('axios interceptors', () => {
    it('adds the CSRF header to writes and retries once on owner_auth_required', async () => {
      const server = fakeServer();
      const win = { fetch: server.fetchImpl as unknown as typeof fetch };
      installOwnerSessionFetch(win); // the session bootstrap goes through this fetch
      const instance = axios.create();
      const seen: Array<string | undefined> = [];
      let first = true;
      instance.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
        const csrf = AxiosHeaders.from(config.headers).get('X-Crewly-CSRF');
        seen.push(typeof csrf === 'string' ? csrf : undefined);
        if (first) {
          first = false;
          return { data: { success: false, error: 'owner_auth_required' }, status: 401, statusText: 'Unauthorized', headers: {}, config };
        }
        return { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config };
      };
      installOwnerSessionAxios(instance);
      const res = await instance.post('/api/system/usage/caps', {}, { validateStatus: () => true });
      expect(res.status).toBe(200);
      expect(seen).toEqual(['csrf-1', 'csrf-2']);
    });

    it('leaves reads without the CSRF header', async () => {
      const server = fakeServer();
      installOwnerSessionFetch({ fetch: server.fetchImpl as unknown as typeof fetch });
      const instance = axios.create();
      let csrf: unknown = 'unset';
      instance.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
        csrf = AxiosHeaders.from(config.headers).get('X-Crewly-CSRF');
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      };
      installOwnerSessionAxios(instance);
      await instance.get('/api/decisions');
      expect(csrf).toBeUndefined();
      expect(server.issued()).toBe(0);
    });
  });

  it('ensureOwnerSession returns null when the backend refuses', async () => {
    installOwnerSessionFetch({ fetch: (async () => json(403, { success: false })) as unknown as typeof fetch });
    expect(await ensureOwnerSession()).toBeNull();
  });
});
