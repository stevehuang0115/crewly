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

  it('should register exactly 13 routes', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    expect(routes).toHaveLength(13);
  });

  it('should only use GET or POST methods', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    for (const route of routes) {
      expect(route.route.methods.delete).toBeUndefined();
      expect(route.route.methods.put).toBeUndefined();
      expect(route.route.methods.patch).toBeUndefined();
    }
  });

  it('should have 7 GET routes and 6 POST routes', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    const getRoutes = routes.filter((r: any) => r.route.methods.get);
    const postRoutes = routes.filter((r: any) => r.route.methods.post);
    expect(getRoutes).toHaveLength(7);
    expect(postRoutes).toHaveLength(6);
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
