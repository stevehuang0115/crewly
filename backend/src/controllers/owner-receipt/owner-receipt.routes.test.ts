/**
 * Tests for the owner receipt router (#828).
 */

import { createOwnerReceiptRouter } from './owner-receipt.routes.js';

describe('createOwnerReceiptRouter', () => {
  it('registers the receipt, settings and send routes', () => {
    const stack = (createOwnerReceiptRouter() as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    const routes = stack.filter((l) => l.route).map((l) => ({ path: l.route?.path, methods: Object.keys(l.route?.methods ?? {}) }));
    expect(routes).toEqual([
      { path: '/', methods: ['get'] },
      { path: '/settings', methods: ['get'] },
      { path: '/settings', methods: ['put'] },
      { path: '/settings', methods: ['post'] },
      { path: '/send', methods: ['post'] },
    ]);
  });
});
