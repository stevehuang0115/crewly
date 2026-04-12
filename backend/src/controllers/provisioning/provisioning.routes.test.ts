/**
 * Tests for Provisioning Routes configuration.
 *
 * @module controllers/provisioning/provisioning.routes.test
 */

import { createProvisioningRouter } from './provisioning.routes.js';

describe('createProvisioningRouter', () => {
  it('should return an Express Router', () => {
    const router = createProvisioningRouter();
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  it('should have routes for deployments CRUD', () => {
    const router = createProvisioningRouter();
    const routes = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;

    // Verify routes exist
    const paths = routes
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route!.path,
        methods: Object.keys(layer.route!.methods),
      }));

    // POST /deployments
    expect(paths).toContainEqual(
      expect.objectContaining({ path: '/deployments', methods: expect.arrayContaining(['post']) }),
    );

    // GET /deployments
    expect(paths).toContainEqual(
      expect.objectContaining({ path: '/deployments', methods: expect.arrayContaining(['get']) }),
    );

    // GET /deployments/:id/status
    expect(paths).toContainEqual(
      expect.objectContaining({ path: '/deployments/:id/status', methods: expect.arrayContaining(['get']) }),
    );

    // DELETE /deployments/:id
    expect(paths).toContainEqual(
      expect.objectContaining({ path: '/deployments/:id', methods: expect.arrayContaining(['delete']) }),
    );
  });
});
