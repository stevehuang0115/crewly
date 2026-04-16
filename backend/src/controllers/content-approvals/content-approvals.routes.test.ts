/**
 * Content Approvals Routes Tests
 *
 * Verifies that the router is created with the correct endpoints.
 *
 * @module controllers/content-approvals/content-approvals.routes.test
 */

import { createContentApprovalsRouter } from './content-approvals.routes.js';

describe('createContentApprovalsRouter', () => {
  it('returns an Express router', () => {
    const router = createContentApprovalsRouter();
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  it('has expected routes registered', () => {
    const router = createContentApprovalsRouter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = (router as any).stack || [];
    const paths = stack
      .map((layer: { route?: { path: string } }) => layer.route?.path)
      .filter(Boolean);

    expect(paths).toContain('/');
    expect(paths).toContain('/pending');
    expect(paths).toContain('/stats');
    expect(paths).toContain('/:id');
    expect(paths).toContain('/:id/approve');
    expect(paths).toContain('/:id/reject');
  });
});
