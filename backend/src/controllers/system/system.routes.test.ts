import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Router } from 'express';
import type { ApiContext } from '../types.js';

jest.mock('./system.controller.js', () => ({
  getSystemHealth: jest.fn((_req: any, res: any) => res.json({ ok: true })),
  getSystemMetrics: jest.fn((_req: any, res: any) => res.json({ ok: true })),
  getSystemConfiguration: jest.fn((_req: any, res: any) => res.json({ ok: true })),
}));

jest.mock('./restart-readiness.controller.js', () => ({
  getRestartReadiness: jest.fn((_req: any, res: any) => res.json({ safe: true })),
}));

const { createSystemRouter } = require('./system.routes.js');

describe('System Routes', () => {
  let mockContext: ApiContext;
  let router: Router;

  beforeEach(() => {
    mockContext = {
      storageService: {},
      tmuxService: {},
      schedulerService: {},
      activeProjectsService: {},
      promptTemplateService: {},
      taskAssignmentMonitor: {},
      taskTrackingService: {}
    } as any;

    router = createSystemRouter(mockContext);
  });

  it('should create router with system routes', () => {
    expect(router).toBeDefined();
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });

  it('should have GET route for health check', () => {
    const healthRoute = router.stack.find(layer =>
      layer.route && layer.route.path === '/health' && (layer.route as any).methods.get
    );
    expect(healthRoute).toBeDefined();
  });

  it('should have GET route for metrics', () => {
    const metricsRoute = router.stack.find(layer =>
      layer.route && layer.route.path === '/metrics' && (layer.route as any).methods.get
    );
    expect(metricsRoute).toBeDefined();
  });

  it('should have GET route for configuration', () => {
    const configRoute = router.stack.find(layer =>
      layer.route && layer.route.path === '/configuration' && (layer.route as any).methods.get
    );
    expect(configRoute).toBeDefined();
  });

  it('should have GET route for restart readiness', () => {
    const readinessRoute = router.stack.find(layer =>
      layer.route && layer.route.path === '/restart-readiness' && (layer.route as any).methods.get
    );
    expect(readinessRoute).toBeDefined();
  });
});
