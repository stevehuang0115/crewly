/**
 * Sub-agents Routes Tests
 *
 * @module controllers/subagents/subagents.routes.test
 */

import { createSubagentsRouter } from './subagents.routes.js';

jest.mock('./subagents.controller.js', () => ({
  runSubagent: jest.fn(),
}));

describe('createSubagentsRouter', () => {
  it('registers POST / and nothing else', () => {
    const router = createSubagentsRouter();
    const layers = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
    const routes = layers.flatMap((l) => (l.route ? [{ path: l.route.path, methods: Object.keys(l.route.methods) }] : []));
    expect(routes).toEqual([{ path: '/', methods: ['post'] }]);
  });
});
