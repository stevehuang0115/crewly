import { describe, it, expect } from 'vitest';
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
});
