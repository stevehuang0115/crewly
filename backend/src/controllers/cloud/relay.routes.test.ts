/**
 * Tests for Relay Routes
 *
 * Validates that all relay client endpoints are registered on the router
 * with cloud connection and tier middleware.
 *
 * @module controllers/cloud/relay.routes.test
 */

import { Router } from 'express';
import { createRelayRouter } from './relay.routes.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('./relay.controller.js', () => ({
  connectToRelay: jest.fn((_req: unknown, res: { status: (s: number) => { json: (d: unknown) => void } }) => res.status(200).json({ success: true })),
  disconnectFromRelay: jest.fn((_req: unknown, res: { status: (s: number) => { json: (d: unknown) => void } }) => res.status(200).json({ success: true })),
  getRelayDevices: jest.fn((_req: unknown, res: { status: (s: number) => { json: (d: unknown) => void } }) => res.status(200).json({ success: true })),
  getCloudDevices: jest.fn((_req: unknown, res: { status: (s: number) => { json: (d: unknown) => void } }) => res.status(200).json({ success: true })),
  sendRelayMessage: jest.fn((_req: unknown, res: { status: (s: number) => { json: (d: unknown) => void } }) => res.status(200).json({ success: true })),
}));

const mockTierMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());

jest.mock('../../services/cloud/cloud-auth.middleware.js', () => ({
  requireCloudConnection: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireTier: jest.fn(() => mockTierMiddleware),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RouteEntry {
  method: string;
  path: string;
  middlewareCount: number;
}

/** Extract registered routes from an Express Router for assertions. */
function getRegisteredRoutes(router: Router): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: unknown[] } }> }).stack;

  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods);
      for (const method of methods) {
        routes.push({
          method: method.toUpperCase(),
          path: layer.route.path,
          middlewareCount: layer.route.stack.length,
        });
      }
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Relay Routes', () => {
  let router: Router;
  let routes: RouteEntry[];

  beforeAll(() => {
    router = createRelayRouter();
    routes = getRegisteredRoutes(router);
  });

  it('should register POST /connect with auth middleware', () => {
    const route = routes.find(r => r.method === 'POST' && r.path === '/connect');
    expect(route).toBeDefined();
    expect(route!.middlewareCount).toBe(3); // requireCloudConnection + requireTier + handler
  });

  it('should register POST /disconnect with auth middleware', () => {
    const route = routes.find(r => r.method === 'POST' && r.path === '/disconnect');
    expect(route).toBeDefined();
    expect(route!.middlewareCount).toBe(3);
  });

  it('should register GET /devices with auth middleware', () => {
    const route = routes.find(r => r.method === 'GET' && r.path === '/devices');
    expect(route).toBeDefined();
    expect(route!.middlewareCount).toBe(3);
  });

  it('should register POST /send with auth middleware', () => {
    const route = routes.find(r => r.method === 'POST' && r.path === '/send');
    expect(route).toBeDefined();
    expect(route!.middlewareCount).toBe(3);
  });

  it('should register GET /cloud-devices with cloud connection middleware', () => {
    const route = routes.find(r => r.method === 'GET' && r.path === '/cloud-devices');
    expect(route).toBeDefined();
    expect(route!.middlewareCount).toBe(2); // requireCloudConnection + handler (no tier check)
  });

  it('should register exactly 5 routes', () => {
    expect(routes).toHaveLength(5);
  });

  it('should call requireTier with "pro" for client-side routes', () => {
    const { requireTier } = jest.requireMock('../../services/cloud/cloud-auth.middleware.js');
    expect(requireTier).toHaveBeenCalledWith('pro');
  });
});
