import { createMissionPolicyRouter } from './mission-policy.routes.js';

describe('createMissionPolicyRouter', () => {
  it('should create a router with expected routes', () => {
    const router = createMissionPolicyRouter();
    expect(router).toBeDefined();
    const routes = (router as any).stack?.map((r: any) => r.route?.path).filter(Boolean) || [];
    expect(routes).toContain('/');
    expect(routes).toContain('/:id');
    expect(routes).toContain('/:id/policy');
  });

  it('registers PUT /:id for partial mission updates', () => {
    const router = createMissionPolicyRouter();
    const entries: Array<{ path: string; methods: Record<string, boolean> }> =
      (router as any).stack
        ?.map((r: any) => r.route)
        .filter(Boolean)
        .map((r: any) => ({ path: r.path, methods: r.methods })) ?? [];

    const putIdRoute = entries.find((e) => e.path === '/:id' && e.methods.put);
    expect(putIdRoute).toBeDefined();
  });
});
