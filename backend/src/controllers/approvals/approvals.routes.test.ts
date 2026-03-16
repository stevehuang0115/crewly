/**
 * Tests for Approvals Routes
 *
 * @module controllers/approvals/approvals.routes.test
 */

import { createApprovalsRouter } from './approvals.routes.js';

describe('Approvals Routes', () => {
  it('should create a router with correct routes', () => {
    const router = createApprovalsRouter();
    expect(router).toBeDefined();

    // Extract registered routes from the router stack
    const routes = router.stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    expect(routes).toEqual(
      expect.arrayContaining([
        { path: '/pending', methods: ['get'] },
        { path: '/:id/approve', methods: ['post'] },
        { path: '/:id/reject', methods: ['post'] },
      ]),
    );
  });

  it('should have exactly 3 routes', () => {
    const router = createApprovalsRouter();
    const routeCount = router.stack.filter((layer: any) => layer.route).length;
    expect(routeCount).toBe(3);
  });
});
