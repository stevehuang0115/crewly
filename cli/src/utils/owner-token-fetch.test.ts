/**
 * Tests for the CLI's owner token on local backend calls (#999).
 */

import axios from 'axios';
import { installOwnerTokenForLocalBackend, isLocalBackendUrl } from './owner-token-fetch.js';

describe('isLocalBackendUrl', () => {
  it.each(['http://localhost:8787/api/x', 'http://127.0.0.1:8788/api', 'http://[::1]:8787/api'])('%s is local', (u) => {
    expect(isLocalBackendUrl(u)).toBe(true);
  });
  it.each(['https://api.crewlyai.com/x', 'http://192.168.1.5:8787/api', 'not a url', undefined])('%s is not', (u) => {
    expect(isLocalBackendUrl(u)).toBe(false);
  });
});

describe('installOwnerTokenForLocalBackend', () => {
  function setup(token: string | null) {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const target = {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response('{}');
      }) as typeof fetch,
    };
    const instance = axios.create();
    installOwnerTokenForLocalBackend({ readToken: () => token, target, axiosInstance: instance });
    return { seen, target, instance };
  }

  it('adds the token to local fetches only', async () => {
    const { seen, target } = setup('tok');
    await target.fetch('http://127.0.0.1:8787/api/bundles/apply', { method: 'POST' });
    await target.fetch('https://api.crewlyai.com/api/x');
    expect(seen[0].headers.get('X-Crewly-Token')).toBe('tok');
    expect(seen[1].headers.get('X-Crewly-Token')).toBeNull();
  });

  it('keeps an explicit token and sends nothing when there is no token', async () => {
    const a = setup('tok');
    await a.target.fetch('http://localhost:8787/api/x', { headers: { 'X-Crewly-Token': 'mine' } });
    expect(a.seen[0].headers.get('X-Crewly-Token')).toBe('mine');
    const b = setup(null);
    await b.target.fetch('http://localhost:8787/api/x');
    expect(b.seen[0].headers.get('X-Crewly-Token')).toBeNull();
  });

  it('adds the token to local axios requests', async () => {
    const { instance } = setup('tok');
    let sent: unknown;
    instance.defaults.adapter = async (config) => {
      sent = config.headers?.['X-Crewly-Token'];
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    await instance.get('http://127.0.0.1:8787/api/harness');
    expect(sent).toBe('tok');
    await instance.get('https://api.crewlyai.com/x');
    expect(sent).toBeUndefined();
  });
});
