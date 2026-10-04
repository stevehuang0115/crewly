import { createAppsRouter } from './apps.routes.js';

interface Layer { route?: { path: string; methods: Record<string, boolean> } }

describe('Crewly Apps routes', () => {
  const router = createAppsRouter();
  const has = (method: string, path: string) => (router.stack as Layer[]).some((l) => l.route?.path === path && l.route.methods[method]);

  it('registers publish, list, rollback, versions and the data routes', () => {
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
    ] as const) {
      expect(has(m, p)).toBe(true);
    }
    expect((router.stack as Layer[]).filter((l) => l.route)).toHaveLength(10);
  });
});
