/**
 * PR Review Routes Tests
 *
 * Unit tests for route configuration and registration.
 *
 * @module controllers/pr-review/pr-review.routes.test
 */

import { describe, it, expect, jest } from '@jest/globals';

// Mock the controller functions
jest.mock('./pr-review.controller.js', () => ({
  handleWebhook: jest.fn(),
  triggerManualReview: jest.fn(),
  getPrReviewStatus: jest.fn(),
}));

import { createPrReviewRouter } from './pr-review.routes';

describe('PR Review Routes', () => {
  it('should create a router', () => {
    const router = createPrReviewRouter();
    expect(router).toBeDefined();
  });

  it('should register POST /webhook route', () => {
    const router = createPrReviewRouter();
    const routes = (router as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/webhook', methods: ['post'] }),
      ]),
    );
  });

  it('should register POST /review route', () => {
    const router = createPrReviewRouter();
    const routes = (router as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/review', methods: ['post'] }),
      ]),
    );
  });

  it('should register GET /status route', () => {
    const router = createPrReviewRouter();
    const routes = (router as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/status', methods: ['get'] }),
      ]),
    );
  });

  it('should register exactly 3 routes', () => {
    const router = createPrReviewRouter();
    const routeCount = (router as any).stack.filter((layer: any) => layer.route).length;
    expect(routeCount).toBe(3);
  });
});
