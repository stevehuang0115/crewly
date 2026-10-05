import { createAppsRouter } from './apps.routes.js';

interface Layer { route?: { path: string; methods: Record<string, boolean> } }

describe('Crewly Apps routes', () => {
  const router = createAppsRouter();
  const has = (method: string, path: string) => (router.stack as Layer[]).some((l) => l.route?.path === path && l.route.methods[method]);

  it('registers publish, list, rollback, versions, the data routes and the P3 link / visibility routes and the comment routes', () => {
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
      ['post', '/thumbnails/refresh-all'],
      ['post', '/:appId/thumbnail/refresh'],
      ['post', '/:appId/share'],
      ['get', '/:appId/links'],
      ['delete', '/:appId/links/:linkId'],
      ['delete', '/:appId/links'],
      ['post', '/:appId/visibility-request'],
      ['delete', '/:appId/visibility-request'],
      ['post', '/:appId/make-private'],
      ['get', '/:appId/comments'],
      ['get', '/:appId/comments/:commentId'],
      ['post', '/:appId/comments/:commentId/replies'],
      ['post', '/:appId/comments/:commentId/resolve'],
      ['post', '/:appId/comments/:commentId/reopen'],
    ] as const) {
      expect(has(m, p)).toBe(true);
    }
    expect((router.stack as Layer[]).filter((l) => l.route)).toHaveLength(24);
  });
});
