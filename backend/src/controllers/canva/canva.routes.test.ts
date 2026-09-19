import { createCanvaRouter } from './canva.routes.js';

interface Layer { route?: { path: string; methods: Record<string, boolean> } }

describe('Canva routes', () => {
  const router = createCanvaRouter();
  const has = (method: string, path: string) => (router.stack as Layer[]).some((l) => l.route?.path === path && l.route.methods[method]);

  it('registers the grant, design, export and asset routes', () => {
    for (const [m, p] of [['get', '/status'], ['get', '/connect-url'], ['delete', '/disconnect'], ['get', '/designs'], ['get', '/designs/:id'], ['post', '/designs'], ['post', '/designs/:id/export'], ['post', '/assets']] as const) {
      expect(has(m, p)).toBe(true);
    }
    expect((router.stack as Layer[]).filter((l) => l.route)).toHaveLength(8);
  });
});
