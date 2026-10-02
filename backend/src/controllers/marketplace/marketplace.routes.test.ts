// Auto-update + priority fix
/**
 * Tests for Marketplace Routes
 *
 * Validates the router configuration: correct paths, HTTP methods,
 * and handler registration for all marketplace endpoints.
 *
 * @module controllers/marketplace/marketplace.routes.test
 */

import { Router } from 'express';
import { createMarketplaceRouter } from './marketplace.routes.js';

// Mock the controller to avoid pulling in service dependencies
jest.mock('./marketplace.controller.js', () => ({
  handleListItems: jest.fn(),
  handleListInstalled: jest.fn(),
  handleListUpdates: jest.fn(),
  handleGetItem: jest.fn(),
  handleRefresh: jest.fn(),
  handleInstall: jest.fn(),
  handleUninstall: jest.fn(),
  handleUpdate: jest.fn(),
  handleSubmit: jest.fn(),
  handleListSubmissions: jest.fn(),
  handleGetSubmission: jest.fn(),
  handleReviewSubmission: jest.fn(),
  handleGetItemReadme: jest.fn(),
}));

// Mock the auto-update service lazily imported by POST /auto-update
const mockCheckAndApplyUpdates = jest.fn();
jest.mock('../../services/marketplace/marketplace-auto-update.service.js', () => ({
  checkAndApplyUpdates: (...args: unknown[]) => mockCheckAndApplyUpdates(...args),
}));

describe('Marketplace Routes', () => {
  let router: Router;

  beforeEach(() => {
    router = createMarketplaceRouter();
  });

  it('should create a router instance', () => {
    expect(router).toBeDefined();
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------
  // Static GET routes
  // ---------------------------------------------------------------

  it('should have GET route for /', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  it('should have GET route for /installed', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/installed' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  it('should have GET route for /updates', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/updates' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Static POST routes
  // ---------------------------------------------------------------

  it('should have POST route for /refresh', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/refresh' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Parameterized routes
  // ---------------------------------------------------------------

  it('should have GET route for /:id', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/:id' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /:id/install', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/:id/install' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /:id/uninstall', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/:id/uninstall' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /:id/update', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/:id/update' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Submission routes
  // ---------------------------------------------------------------

  it('should have POST route for /submit', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/submit' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have GET route for /submissions', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/submissions' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  it('should have GET route for /submissions/:id', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/submissions/:id' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /submissions/:id/review', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/submissions/:id/review' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Route count and method restrictions
  // ---------------------------------------------------------------

  it('should have GET route for /:id/readme', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/:id/readme' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  it('should register exactly 14 routes', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    expect(routes).toHaveLength(14);
  });

  it('should only use GET or POST methods', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    for (const route of routes) {
      expect(route.route.methods.delete).toBeUndefined();
      expect(route.route.methods.put).toBeUndefined();
      expect(route.route.methods.patch).toBeUndefined();
    }
  });

  it('should have 7 GET routes and 7 POST routes', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    const getRoutes = routes.filter((r: any) => r.route.methods.get);
    const postRoutes = routes.filter((r: any) => r.route.methods.post);
    expect(getRoutes).toHaveLength(7);
    expect(postRoutes).toHaveLength(7);
  });

  // ---------------------------------------------------------------
  // Auto-update route
  // ---------------------------------------------------------------

  describe('POST /auto-update', () => {
    const getHandler = (): ((req: unknown, res: unknown, next: unknown) => Promise<void>) => {
      const layer = (router.stack as any[]).find(
        (l: any) => l.route?.path === '/auto-update' && l.route?.methods?.post
      );
      expect(layer).toBeDefined();
      return layer.route.stack[0].handle;
    };

    beforeEach(() => {
      mockCheckAndApplyUpdates.mockReset();
    });

    it('should respond with the auto-update result on success', async () => {
      const result = { checked: 2, updated: ['skill-a'], failed: [] };
      mockCheckAndApplyUpdates.mockResolvedValue(result);
      const res = { json: jest.fn() };
      const next = jest.fn();

      await getHandler()({}, res, next);

      expect(mockCheckAndApplyUpdates).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: result });
      expect(next).not.toHaveBeenCalled();
    });

    it('should forward errors to next()', async () => {
      const error = new Error('registry unreachable');
      mockCheckAndApplyUpdates.mockRejectedValue(error);
      const res = { json: jest.fn() };
      const next = jest.fn();

      await getHandler()({}, res, next);

      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(error);
    });

    it('should be registered before the parameterized /:id routes', () => {
      const paths = (router.stack as any[]).filter((l: any) => l.route).map((l: any) => l.route.path);
      expect(paths.indexOf('/auto-update')).toBeLessThan(paths.indexOf('/:id'));
    });
  });

  // ---------------------------------------------------------------
  // Route ordering (static before parameterized)
  // ---------------------------------------------------------------

  it('should register static routes before parameterized /:id route', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    const paths = routes.map((r: any) => r.route.path);

    const installedIndex = paths.indexOf('/installed');
    const updatesIndex = paths.indexOf('/updates');
    const submitIndex = paths.indexOf('/submit');
    const submissionsIndex = paths.indexOf('/submissions');
    const idIndex = paths.indexOf('/:id');

    expect(installedIndex).toBeLessThan(idIndex);
    expect(updatesIndex).toBeLessThan(idIndex);
    expect(submitIndex).toBeLessThan(idIndex);
    expect(submissionsIndex).toBeLessThan(idIndex);
  });
});
