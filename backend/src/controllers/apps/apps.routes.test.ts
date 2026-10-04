import { createAppsRouter } from './apps.routes.js';

interface Layer { route?: { path: string; methods: Record<string, boolean> } }

describe('Crewly Apps routes', () => {
  const router = createAppsRouter();
  const has = (method: string, path: string) => (router.stack as Layer[]).some((l) => l.route?.path === path && l.route.methods[method]);

  it('registers publish, list, rollback, versions, the data routes and the P3 link / visibility routes', () => {
    for (const [m, p] of [
      ['post', '/publish'],
      ['get', '/'],
      ['post', '/:appId/rollback'],
      ['get', '/:appId/versions'],
      ['get', '/:appId/data/:collection'],
      ['post', '/:appId/data/:collection'],
      ['get', '/:appId/data/:collection/:docId'],
      ['put', '/:appId/data/:collection/:docId'],
      ['patch', '/:appId/data/:collection/:docId'],
      ['delete', '/:appId/data/:collection/:docId'],
      ['post', '/:appId/share'],
      ['get', '/:appId/links'],
      ['delete', '/:appId/links/:linkId'],
      ['delete', '/:appId/links'],
      ['post', '/:appId/visibility-request'],
      ['delete', '/:appId/visibility-request'],
      ['post', '/:appId/make-private'],
    ] as const) {
      expect(has(m, p)).toBe(true);
    }
    expect((router.stack as Layer[]).filter((l) => l.route)).toHaveLength(17);
  });
});
