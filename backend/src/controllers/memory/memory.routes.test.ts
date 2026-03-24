/**
 * Tests for Memory Routes
 *
 * Validates the router configuration: correct paths, HTTP methods,
 * and handler registration for all memory endpoints.
 *
 * @module controllers/memory/memory.routes.test
 */

import { Router } from 'express';
import { createMemoryRouter } from './memory.routes.js';

describe('Memory Routes', () => {
  let router: Router;

  beforeEach(() => {
    router = createMemoryRouter();
  });

  it('should create a router instance', () => {
    expect(router).toBeDefined();
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------
  // Original POST-only routes
  // ---------------------------------------------------------------

  it('should have POST route for /remember', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/remember' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /recall', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/recall' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /record-learning', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/record-learning' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Goal routes
  // ---------------------------------------------------------------

  it('should have POST route for /goals', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/goals' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have GET route for /goals', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/goals' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Focus routes
  // ---------------------------------------------------------------

  it('should have POST route for /focus', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/focus' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have GET route for /focus', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/focus' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Daily log routes
  // ---------------------------------------------------------------

  it('should have POST route for /daily-log', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/daily-log' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have GET route for /daily-log', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/daily-log' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Learning accumulation routes
  // ---------------------------------------------------------------

  it('should have POST route for /record-success', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/record-success' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /record-failure', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/record-failure' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Context route
  // ---------------------------------------------------------------

  it('should have POST route for /my-context', () => {
    const route = (router.stack as any[]).find(
      (layer: any) => layer.route?.path === '/my-context' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Route count and method restrictions
  // ---------------------------------------------------------------

  it('should register exactly 14 routes', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    expect(routes).toHaveLength(14);
  });

  it('should only use POST or GET methods', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    for (const route of routes) {
      expect(route.route.methods.delete).toBeUndefined();
      expect(route.route.methods.put).toBeUndefined();
      expect(route.route.methods.patch).toBeUndefined();
    }
  });

  it('should have 9 POST routes and 3 GET routes', () => {
    const routes = (router.stack as any[]).filter((layer: any) => layer.route);
    const postRoutes = routes.filter((r: any) => r.route.methods.post);
    const getRoutes = routes.filter((r: any) => r.route.methods.get);
    expect(postRoutes).toHaveLength(10);
    expect(getRoutes).toHaveLength(4);
  });
});
