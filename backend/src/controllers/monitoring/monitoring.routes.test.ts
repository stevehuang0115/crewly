/**
 * Tests for Monitoring Routes
 *
 * @module controllers/monitoring/monitoring.routes.test
 */

import { Router } from 'express';
import { createMonitoringRouter } from './monitoring.routes.js';
import type { ApiContext } from '../types.js';

describe('Monitoring Routes', () => {
  it('should create router without context', () => {
    const router = createMonitoringRouter();
    expect(router).toBeDefined();
    expect(router.stack).toBeDefined();
  });

  it('should create router with context for backward compatibility', () => {
    const mockContext = {
      storageService: {},
      tmuxService: {},
      schedulerService: {},
      activeProjectsService: {},
      promptTemplateService: {},
      taskAssignmentMonitor: {},
      taskTrackingService: {},
    } as ApiContext;

    const router = createMonitoringRouter(mockContext);
    expect(router).toBeDefined();
    expect(router.stack).toBeDefined();
  });

  it('should register token-usage GET and POST routes', () => {
    const router = createMonitoringRouter();
    const routes = router.stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    expect(routes).toContainEqual(
      expect.objectContaining({ path: '/token-usage', methods: expect.arrayContaining(['get']) })
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ path: '/token-usage/reset', methods: expect.arrayContaining(['post']) })
    );
  });

  it('should register extension-logs POST route', () => {
    const router = createMonitoringRouter();
    const routes = router.stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    expect(routes).toContainEqual(
      expect.objectContaining({ path: '/extension-logs', methods: expect.arrayContaining(['post']) })
    );
  });
});
