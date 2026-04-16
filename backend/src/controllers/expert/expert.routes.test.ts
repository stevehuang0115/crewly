/**
 * Expert Routes Tests
 *
 * Unit tests for expert route configuration.
 *
 * @module controllers/expert/expert.routes.test
 */

import { createExpertRouter } from './expert.routes.js';

describe('expert.routes', () => {
  describe('createExpertRouter', () => {
    it('returns an Express router', () => {
      const router = createExpertRouter();
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
    });

    it('has a GET / route registered', () => {
      const router = createExpertRouter();
      const routes = (router as unknown as { stack: Array<{ route: { path: string; methods: Record<string, boolean> } }> }).stack;
      const getRoot = routes.find(
        (layer) => layer.route?.path === '/' && layer.route?.methods?.get
      );
      expect(getRoot).toBeDefined();
    });
  });
});
