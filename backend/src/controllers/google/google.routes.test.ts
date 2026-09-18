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

  it('registers exactly 8 routes', () => {
    expect((router.stack as Layer[]).filter((l) => l.route)).toHaveLength(8);
  });
});
