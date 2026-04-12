/**
 * Tests for Request Routes — router configuration verification.
 *
 * @module controllers/request/request.routes.test
 */

import { describe, it, expect } from 'vitest';
import { createRequestRouter } from './request.routes.js';

describe('createRequestRouter', () => {
  it('should return a router with expected routes', () => {
    const router = createRequestRouter();

    // Express router stores routes in router.stack
    const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
    const routes = stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route!.path,
        methods: Object.keys(layer.route!.methods),
      }));

    // Verify expected routes exist
    expect(routes).toContainEqual(expect.objectContaining({ path: '/', methods: expect.arrayContaining(['get']) }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/', methods: expect.arrayContaining(['post']) }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/:id', methods: expect.arrayContaining(['get']) }));
    expect(routes).toContainEqual(expect.objectContaining({ path: '/:id', methods: expect.arrayContaining(['put']) }));
  });
});
