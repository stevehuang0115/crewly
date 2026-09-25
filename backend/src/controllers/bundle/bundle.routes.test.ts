/**
 * Tests for the bundle router configuration.
 */

import { createBundleRouter } from './bundle.routes.js';
import type { BundleApplyService } from '../../services/bundle/bundle-apply.service.js';
import type { BundleCatalog } from '../../services/bundle/bundle-catalog.js';

jest.mock('../../services/bundle/bundle-apply.factory.js', () => ({
  getBundleApplyService: jest.fn(),
  getBundleCatalog: jest.fn(),
}));

describe('createBundleRouter', () => {
  it('registers GET/POST-only routes (the relay carries only these), job route before the detail route', () => {
    const router = createBundleRouter(
      () => ({}) as BundleApplyService,
      () => ({}) as BundleCatalog,
    ) as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));
    expect(routes).toEqual([
      { path: '/', methods: ['get'] },
      { path: '/apply/:jobId', methods: ['get'] },
      { path: '/apply', methods: ['post'] },
      { path: '/:templateId', methods: ['get'] },
    ]);
  });
});
