import { createTaskPoolRouter, createTaskScoreRouter } from './task-pool.routes.js';

describe('createTaskPoolRouter', () => {
  it('should create a router with expected routes including /all alias', () => {
    const router = createTaskPoolRouter();
    expect(router).toBeDefined();
    const routes = (router as any).stack?.map((r: any) => r.route?.path).filter(Boolean) || [];
    expect(routes).toContain('/');
    expect(routes).toContain('/all');
  });
});

describe('createTaskScoreRouter', () => {
  it('exposes POST /score (mounted at /api/tasks by api.routes)', () => {
    const router = createTaskScoreRouter();
    const routes = (router as any).stack
      ?.filter((r: any) => r.route)
      .map((r: any) => ({ path: r.route.path, methods: Object.keys(r.route.methods) })) || [];
    expect(routes).toContainEqual({ path: '/score', methods: ['post'] });
  });
});
