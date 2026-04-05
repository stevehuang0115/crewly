/**
 * Tests for Data API Routes — V2 Data Architecture
 *
 * Validates route registration and handler wiring for all
 * /api/v2/data/* endpoints.
 */

import { createDataRouter } from './data.routes.js';

describe('createDataRouter', () => {
  it('returns an Express router', () => {
    const router = createDataRouter();
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  it('registers all expected routes', () => {
    const router = createDataRouter();
    const routes = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route!.path,
        methods: Object.keys(layer.route!.methods),
      }));

    // DataObject CRUD
    expect(routes).toContainEqual({ path: '/objects', methods: ['get'] });
    expect(routes).toContainEqual({ path: '/objects', methods: ['post'] });
    expect(routes).toContainEqual({ path: '/objects/:id', methods: ['get'] });
    expect(routes).toContainEqual({ path: '/objects/:id', methods: ['patch'] });
    expect(routes).toContainEqual({ path: '/objects/:id', methods: ['delete'] });

    // Schemas
    expect(routes).toContainEqual({ path: '/schemas', methods: ['get'] });

    // Sinks
    expect(routes).toContainEqual({ path: '/sinks', methods: ['get'] });
    expect(routes).toContainEqual({ path: '/sinks/:sinkId', methods: ['post'] });

    // Sync
    expect(routes).toContainEqual({ path: '/sync/status', methods: ['get'] });
  });

  it('has exactly 9 route handlers', () => {
    const router = createDataRouter();
    const routes = (router as unknown as { stack: Array<{ route?: unknown }> }).stack
      .filter((layer) => layer.route);
    expect(routes).toHaveLength(9);
  });
});
