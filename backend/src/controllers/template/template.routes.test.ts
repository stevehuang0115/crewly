/**
 * Tests for Template Routes
 *
 * Verifies that createTemplateRouter registers the correct Express
 * routes with the correct HTTP methods and paths.
 *
 * @module controllers/template/template.routes.test
 */

import { Router } from 'express';
import { createTemplateRouter } from './template.routes.js';

// ---------------------------------------------------------------------------
// Mocks — stub out controller handlers before importing routes
// ---------------------------------------------------------------------------

jest.mock('./template.controller.js', () => ({
  handleListTemplates: jest.fn((_req, res) => res.status(200).json({ success: true })),
  handleGetTemplate: jest.fn((_req, res) => res.status(200).json({ success: true })),
  handleCreateTeamFromTemplate: jest.fn((_req, res) => res.status(200).json({ success: true })),
  handleDeployTemplate: jest.fn((_req, res) => res.status(200).json({ success: true })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RouteEntry {
  method: string;
  path: string;
}

/** Extract registered routes from an Express Router for assertions. */
function getRegisteredRoutes(router: Router): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;

  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods);
      for (const method of methods) {
        routes.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Template Routes', () => {
  let router: Router;
  let routes: RouteEntry[];

  beforeAll(() => {
    router = createTemplateRouter();
    routes = getRegisteredRoutes(router);
  });

  it('should register GET / route for listing templates', () => {
    expect(routes).toContainEqual({ method: 'GET', path: '/' });
  });

  it('should register GET /:id route for fetching a template', () => {
    expect(routes).toContainEqual({ method: 'GET', path: '/:id' });
  });

  it('should register POST /:id/create-team route', () => {
    expect(routes).toContainEqual({ method: 'POST', path: '/:id/create-team' });
  });

  it('should register POST /:id/deploy route for deploying a template', () => {
    expect(routes).toContainEqual({ method: 'POST', path: '/:id/deploy' });
  });

  it('should register exactly 4 routes', () => {
    expect(routes).toHaveLength(4);
  });

  it('should place static routes before parameterized routes', () => {
    const getRoutes = routes.filter(r => r.method === 'GET');
    const staticIndex = getRoutes.findIndex(r => r.path === '/');
    const paramIndex = getRoutes.findIndex(r => r.path === '/:id');
    expect(staticIndex).toBeLessThan(paramIndex);
  });
});
