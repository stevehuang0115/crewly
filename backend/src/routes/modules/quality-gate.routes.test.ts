/**
 * Tests for Quality Gate Routes
 *
 * Validates that the quality gate router is properly configured
 * with the expected endpoints.
 *
 * @module routes/modules/quality-gate.routes.test
 */

import { createQualityGateRouter } from './quality-gate.routes.js';

// Mock the controller to avoid service initialization
jest.mock('../../controllers/quality-gate/quality-gate.controller.js', () => ({
  checkQualityGates: jest.fn(),
  preCommitGate: jest.fn(),
}));

// Mock LoggerService (required by controller)
jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

describe('Quality Gate Routes', () => {
  it('should create a router with POST /check route', () => {
    const router = createQualityGateRouter();

    // Router.stack contains the registered routes
    const routes = (router as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    expect(routes).toContainEqual({
      path: '/check',
      methods: ['post'],
    });
    expect(routes).toContainEqual({
      path: '/pre-commit',
      methods: ['post'],
    });
  });

  it('should return a valid Express router', () => {
    const router = createQualityGateRouter();

    // Verify it has the standard router interface
    expect(typeof router.use).toBe('function');
    expect(typeof router.get).toBe('function');
    expect(typeof router.post).toBe('function');
  });
});
