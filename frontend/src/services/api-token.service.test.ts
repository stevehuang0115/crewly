/**
 * API Token Service Tests
 *
 * @module services/api-token.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import {
  getApiToken,
  setApiToken,
  clearApiToken,
  consumeTokenFromUrl,
  isTokenChallenge,
  isSameOriginRequest,
  withTokenQuery,
  getSocketTokenQuery,
  installAxiosTokenInterceptors,
  installFetchTokenGuard,
} from './api-token.service';
import { API_TOKEN_REQUIRED_EVENT } from '../constants/api-token.constants';

describe('api-token.service', () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = 'crewly_token=; Path=/; Max-Age=0';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('storage + cookie', () => {
    it('stores, reads and clears the token, mirroring it into the cookie', () => {
      expect(getApiToken()).toBeNull();
      setApiToken('  tok-1  ');
      expect(getApiToken()).toBe('tok-1');
      expect(localStorage.getItem('crewly_api_token')).toBe('tok-1');
      expect(document.cookie).toContain('crewly_token=tok-1');

      clearApiToken();
      expect(getApiToken()).toBeNull();
      expect(document.cookie).not.toContain('crewly_token=tok-1');
    });
  });

  describe('consumeTokenFromUrl', () => {
    it('stores ?token= once and strips it from the URL', () => {
      const replaceState = vi.fn();
      const consumed = consumeTokenFromUrl(
        { pathname: '/teams', search: '?token=abc&x=1', hash: '#h' },
        { replaceState },
      );
      expect(consumed).toBe(true);
      expect(getApiToken()).toBe('abc');
      expect(replaceState).toHaveBeenCalledWith(null, '', '/teams?x=1#h');
    });

    it('ignores the Cloud OAuth callback route (its ?token= is a Cloud JWT)', () => {
      const replaceState = vi.fn();
      const consumed = consumeTokenFromUrl(
        { pathname: '/auth/callback', search: '?token=jwt', hash: '' },
        { replaceState },
      );
      expect(consumed).toBe(false);
      expect(getApiToken()).toBeNull();
      expect(replaceState).not.toHaveBeenCalled();
    });

    it('does nothing without a token param', () => {
      expect(consumeTokenFromUrl({ pathname: '/', search: '', hash: '' }, { replaceState: vi.fn() })).toBe(false);
    });
  });

  describe('isTokenChallenge', () => {
    it('recognises the WWW-Authenticate scheme or the unauthorized error body', () => {
      expect(isTokenChallenge(401, 'Crewly-Token')).toBe(true);
      expect(isTokenChallenge(401, null, { success: false, error: 'unauthorized' })).toBe(true);
      expect(isTokenChallenge(401, null, { error: 'Invalid or expired token' })).toBe(false);
      expect(isTokenChallenge(403, 'Crewly-Token')).toBe(false);
      expect(isTokenChallenge(200)).toBe(false);
    });
  });

  describe('isSameOriginRequest', () => {
    it('allows relative and same-origin URLs only', () => {
      expect(isSameOriginRequest('/api/teams')).toBe(true);
      expect(isSameOriginRequest(undefined)).toBe(true);
      expect(isSameOriginRequest(`${window.location.origin}/api/x`)).toBe(true);
      expect(isSameOriginRequest('https://api.crewlyai.com/api/devices')).toBe(false);
      expect(isSameOriginRequest('//evil.example/api')).toBe(false);
    });
  });

  describe('WebSocket helpers', () => {
    it('appends the token query only when a token is stored', () => {
      expect(withTokenQuery('ws://h/ws')).toBe('ws://h/ws');
      expect(getSocketTokenQuery()).toEqual({});
      setApiToken('a b');
      expect(withTokenQuery('ws://h/ws')).toBe('ws://h/ws?token=a%20b');
      expect(withTokenQuery('ws://h/ws?c=1')).toBe('ws://h/ws?c=1&token=a%20b');
      expect(getSocketTokenQuery()).toEqual({ token: 'a b' });
    });
  });

  describe('axios interceptors', () => {
    it('adds X-Crewly-Token to same-origin requests only', async () => {
      const instance = axios.create();
      installAxiosTokenInterceptors(instance);
      setApiToken('tok');
      const adapter = vi.fn(async (config) => ({ data: {}, status: 200, statusText: 'OK', headers: {}, config }));
      instance.defaults.adapter = adapter;

      await instance.get('/api/teams');
      expect(adapter.mock.calls[0][0].headers.get('X-Crewly-Token')).toBe('tok');

      await instance.get('https://api.crewlyai.com/api/devices');
      expect(adapter.mock.calls[1][0].headers.get('X-Crewly-Token')).toBeFalsy();
    });

    it('raises the token-required event on a challenge (rejected and resolved 401s)', async () => {
      const instance = axios.create();
      installAxiosTokenInterceptors(instance);
      const listener = vi.fn();
      window.addEventListener(API_TOKEN_REQUIRED_EVENT, listener);
      const challenge = (config: InternalAxiosRequestConfig) => ({
        data: { success: false, error: 'unauthorized' },
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'www-authenticate': 'Crewly-Token' },
        config,
      });

      // Error path: the adapter rejects like the real XHR adapter does on 401.
      instance.defaults.adapter = async (config) => {
        throw new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, challenge(config));
      };
      await expect(instance.get('/api/teams')).rejects.toBeTruthy();
      expect(listener).toHaveBeenCalledTimes(1);

      // Success path: `validateStatus: () => true` style callers resolve the 401.
      instance.defaults.adapter = async (config) => challenge(config);
      const res = await instance.get('/api/teams');
      expect(res.status).toBe(401);
      expect(listener).toHaveBeenCalledTimes(2);

      // A non-challenge 401 (e.g. chat-v2 JWT failure) does not prompt.
      instance.defaults.adapter = async (config) => ({
        data: { success: false, error: 'Invalid or expired token' },
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config,
      });
      await instance.get('/api/chat');
      expect(listener).toHaveBeenCalledTimes(2);
      window.removeEventListener(API_TOKEN_REQUIRED_EVENT, listener);
    });
  });

  describe('fetch guard', () => {
    it('adds the header for same-origin calls and raises the event on a 401 challenge', async () => {
      const original = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return {
          status: headers.get('X-Crewly-Token') === 'tok' ? 200 : 401,
          headers: new Headers({ 'www-authenticate': 'Crewly-Token' }),
        } as unknown as Response;
      });
      const win = { fetch: original } as unknown as Pick<Window, 'fetch'>;
      installFetchTokenGuard(win);
      const listener = vi.fn();
      window.addEventListener(API_TOKEN_REQUIRED_EVENT, listener);

      // No token stored → 401 challenge → event.
      const denied = await win.fetch('/api/teams');
      expect(denied.status).toBe(401);
      expect(listener).toHaveBeenCalledTimes(1);

      // Token stored → header attached → 200, no new event.
      setApiToken('tok');
      const ok = await win.fetch('/api/teams', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      expect(ok.status).toBe(200);
      const sentHeaders = new Headers(original.mock.calls[1][1]?.headers);
      expect(sentHeaders.get('Content-Type')).toBe('application/json');
      expect(sentHeaders.get('X-Crewly-Token')).toBe('tok');
      expect(listener).toHaveBeenCalledTimes(1);

      // Third-party origin never receives the token.
      await win.fetch('https://api.crewlyai.com/api/devices');
      expect(original.mock.calls[2][1]).toBeUndefined();
      window.removeEventListener(API_TOKEN_REQUIRED_EVENT, listener);
    });
  });
});
