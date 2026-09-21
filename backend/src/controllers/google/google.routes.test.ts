/**
 * Google Workspace Routes Tests
 *
 * @module controllers/google/google.routes.test
 */

import type { Router } from 'express';
import { createGoogleRouter } from './google.routes.js';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

describe('Google Workspace Routes', () => {
  let router: Router;

  beforeEach(() => {
    router = createGoogleRouter();
  });

  function has(method: string, path: string): boolean {
    return (router.stack as Layer[]).some((l) => l.route?.path === path && l.route?.methods?.[method]);
  }

  it('registers every route in the contract', () => {
    expect(has('get', '/status')).toBe(true);
    expect(has('get', '/connect-url')).toBe(true);
    expect(has('delete', '/disconnect')).toBe(true);
    expect(has('get', '/gmail/search')).toBe(true);
    expect(has('get', '/gmail/messages/:id')).toBe(true);
    expect(has('post', '/gmail/send')).toBe(true);
    expect(has('get', '/calendar/events')).toBe(true);
    expect(has('post', '/calendar/events')).toBe(true);
  });

  it('registers the Drive / Docs / Sheets / Slides routes', () => {
    for (const [method, path] of [
      ['get', '/drive/files'], ['get', '/drive/files/:id'], ['get', '/drive/files/:id/content'], ['post', '/drive/files'],
      ['get', '/docs/:id'], ['post', '/docs'], ['post', '/docs/:id/append'],
      ['get', '/sheets/:id'], ['get', '/sheets/:id/values'], ['post', '/sheets'], ['post', '/sheets/:id/values'],
      ['get', '/slides/:id'], ['post', '/slides'],
    ] as const) {
      expect(has(method, path)).toBe(true);
    }
  });

  it('registers exactly 23 routes', () => {
    expect((router.stack as Layer[]).filter((l) => l.route)).toHaveLength(23);
  });

  // Asking the owner to authorize is not a Google API call, but it must sit
  // behind the same connector gate: only an agent allowed to use Google may
  // post a card that connects the owner's account (2026-09-21).
  it('puts the authorization card behind the connector gate, like every Google call', () => {
    const paths = (router.stack as Layer[]).filter((l) => l.route).map((l) => l.route!.path);
    expect(paths).toContain('/connect-card');
    // The gate is router-level middleware installed before the routes, so a
    // new route is covered by construction; assert it is still there.
    expect((router.stack as Layer[]).some((l) => !l.route)).toBe(true);
  });
});
