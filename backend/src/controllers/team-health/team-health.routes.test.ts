/**
 * Tests for THW route registration.
 *
 * @module controllers/team-health/team-health.routes.test
 */

import { createTeamHealthRouter } from './team-health.routes.js';

describe('createTeamHealthRouter', () => {
  it('registers GET /scan, POST /run, and POST /silence', () => {
    const router = createTeamHealthRouter();
    type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };
    const stack = (router as unknown as { stack: RouteLayer[] }).stack;
    const routes = stack
      .map((l) => (l.route ? { path: l.route.path, methods: l.route.methods } : null))
      .filter((r): r is { path: string; methods: Record<string, boolean> } => r !== null);
    expect(routes.find((r) => r.path === '/scan')?.methods.get).toBe(true);
    expect(routes.find((r) => r.path === '/run')?.methods.post).toBe(true);
    expect(routes.find((r) => r.path === '/silence')?.methods.post).toBe(true);
  });
});
