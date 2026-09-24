import { createMicrosoftTodoRouter } from './microsoft-todo.routes.js';

interface Layer { route?: { path: string; methods: Record<string, boolean> } }

describe('Microsoft To Do routes', () => {
  const router = createMicrosoftTodoRouter();
  const has = (method: string, path: string) => (router.stack as Layer[]).some((l) => l.route?.path === path && l.route.methods[method]);

  it('registers the grant, list and task routes', () => {
    for (const [m, p] of [
      ['get', '/status'],
      ['get', '/connect-url'],
      ['delete', '/disconnect'],
      ['get', '/lists'],
      ['post', '/lists'],
      ['get', '/tasks'],
      ['post', '/tasks'],
      ['patch', '/tasks/:taskId'],
      ['delete', '/tasks/:taskId'],
    ] as const) {
      expect(has(m, p)).toBe(true);
    }
    expect((router.stack as Layer[]).filter((l) => l.route)).toHaveLength(9);
  });
});
