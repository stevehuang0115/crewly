/**
 * Tests for the tickets router configuration.
 */

import { createTicketsRouter } from './tickets.routes.js';

describe('createTicketsRouter', () => {
  it('registers list, lookup and dismiss', () => {
    const stack = (createTicketsRouter() as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    const routes = stack.filter((l) => l.route).map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));
    expect(routes).toEqual([
      { path: '/', methods: ['get'] },
      { path: '/:tkt', methods: ['get'] },
      { path: '/:id/dismiss', methods: ['post'] },
    ]);
  });
});
