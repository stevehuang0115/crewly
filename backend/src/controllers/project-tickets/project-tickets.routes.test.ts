/**
 * Tests for the project tickets router configuration.
 */
import { createProjectTicketsMigrationRouter, createProjectTicketsRouter } from './project-tickets.routes.js';

type Stack = { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };

function routesOf(router: unknown): string[] {
  return (router as Stack).stack.filter((l) => l.route).map((l) => `${Object.keys(l.route!.methods)[0]} ${l.route!.path}`);
}

describe('project tickets routers', () => {
  it('only uses GET and POST (the relay carries nothing else)', () => {
    for (const r of routesOf(createProjectTicketsRouter())) expect(r).toMatch(/^(get|post) /);
  });

  it('exposes the link endpoint', () => {
    expect(routesOf(createProjectTicketsRouter())).toContain('post /:project/:id/link');
  });

  it('keeps the migration on its own prefix', () => {
    expect(routesOf(createProjectTicketsMigrationRouter())).toEqual(['post /:project']);
  });
});
