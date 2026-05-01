/**
 * Tests for the Active Work controller.
 *
 * Covers:
 *   1. Happy path — returns the briefing as JSON
 *   2. Markdown format — returns text/markdown rendering
 *   3. 400 — missing sessionName param
 *   4. 500 — service rejects (TaskPool/Request hiccup)
 *   5. Router factory — exposes the expected route
 *   6. Forwards optional `recentlyResolvedWindowMs` to the service
 *
 * @module controllers/active-work/active-work.controller.test
 */

jest.mock('../../services/core/logger.service.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return {
    LoggerService: {
      getInstance: () => ({ createComponentLogger: () => mockLogger }),
    },
  };
});

import type { Request as ExpressRequest, Response } from 'express';
import {
  getActiveWorkBriefing,
  createActiveWorkRouter,
} from './active-work.controller.js';
import { ActiveWorkBriefingService } from '../../services/agent/active-work-briefing.service.js';

/**
 * Stand up an ActiveWorkBriefingService configured for tests by swapping its
 * factories and stamping the singleton slot. Returns the spy hooks for the
 * fakes so tests can assert call signatures.
 *
 * @param requests - Fake Request list
 * @param items - Fake WorkItem list
 * @param overrides - Per-fake error injection
 */
function installFakeService(
  requests: unknown[] = [],
  items: unknown[] = [],
  overrides: { taskPoolThrows?: Error; requestThrows?: Error } = {},
): {
  generateSpy: jest.SpyInstance;
  formatSpy: jest.SpyInstance;
} {
  const requestServiceFactory = () => ({
    listAll: jest.fn().mockImplementation(async () => {
      if (overrides.requestThrows) throw overrides.requestThrows;
      return requests;
    }),
  });
  const taskPoolFactory = () => ({
    getAllItems: jest.fn().mockImplementation(async () => {
      if (overrides.taskPoolThrows) throw overrides.taskPoolThrows;
      return items;
    }),
  });
  ActiveWorkBriefingService.resetInstance();
  // Reach in and replace the singleton with the test-configured instance so
  // the controller's `getInstance()` returns the fake.
  const inst = ActiveWorkBriefingService.createForTest(
    requestServiceFactory as never,
    taskPoolFactory as never,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ActiveWorkBriefingService as any).instance = inst;
  const generateSpy = jest.spyOn(inst, 'generateActiveWorkBriefing');
  const formatSpy = jest.spyOn(inst, 'formatBriefingAsMarkdown');
  return { generateSpy, formatSpy };
}

/**
 * Build a mock Express request and response pair.
 */
function buildReqRes(params: Record<string, string>, query: Record<string, string> = {}) {
  const req = { params, query } as unknown as ExpressRequest;
  const calls: { code: number | null; body: unknown; type: string | null; sent: string | null } = {
    code: null,
    body: null,
    type: null,
    sent: null,
  };
  const res = {
    status: jest.fn().mockImplementation((code: number) => {
      calls.code = code;
      return res;
    }),
    json: jest.fn().mockImplementation((body: unknown) => {
      calls.body = body;
      return res;
    }),
    type: jest.fn().mockImplementation((t: string) => {
      calls.type = t;
      return res;
    }),
    send: jest.fn().mockImplementation((s: string) => {
      calls.sent = s;
      return res;
    }),
  } as unknown as Response;
  return { req, res, calls };
}

describe('Active Work Controller', () => {
  beforeEach(() => {
    ActiveWorkBriefingService.resetInstance();
  });

  it('returns 400 when sessionName param is missing', async () => {
    const { req, res, calls } = buildReqRes({});
    await getActiveWorkBriefing(req, res);
    expect(calls.code).toBe(400);
    expect(calls.body).toEqual({
      success: false,
      error: 'sessionName param is required',
    });
  });

  it('returns the briefing as JSON when format is unspecified', async () => {
    installFakeService([], []);
    const { req, res, calls } = buildReqRes({ sessionName: 'dev-1' });
    await getActiveWorkBriefing(req, res);
    expect(calls.code).toBeNull(); // 200
    expect(calls.body).toMatchObject({
      success: true,
      data: expect.objectContaining({
        openRequests: [],
        activeWorkItems: [],
        truncated: false,
        totalCounts: { requests: 0, workItems: 0 },
      }),
    });
  });

  it('returns markdown when format=markdown', async () => {
    installFakeService([], []);
    const { req, res, calls } = buildReqRes(
      { sessionName: 'dev-1' },
      { format: 'markdown' },
    );
    await getActiveWorkBriefing(req, res);
    expect(calls.type).toBe('text/markdown');
    expect(typeof calls.sent).toBe('string');
    expect(calls.sent).toContain('## Your Active Work');
    expect(calls.sent).toContain('(No active work — fresh start)');
  });

  it('returns 500 when the service rejects (TaskPool error)', async () => {
    installFakeService([], [], { taskPoolThrows: new Error('pool down') });
    const { req, res, calls } = buildReqRes({ sessionName: 'dev-1' });
    await getActiveWorkBriefing(req, res);
    expect(calls.code).toBe(500);
    expect(calls.body).toEqual({ success: false, error: 'pool down' });
  });

  it('forwards a positive recentlyResolvedWindowMs to the service', async () => {
    const { generateSpy } = installFakeService([], []);
    const { req, res } = buildReqRes(
      { sessionName: 'dev-1' },
      { recentlyResolvedWindowMs: '120000' },
    );
    await getActiveWorkBriefing(req, res);
    expect(generateSpy).toHaveBeenCalledWith('dev-1', 'developer', {
      recentlyResolvedWindowMs: 120000,
    });
  });

  it('ignores a non-numeric recentlyResolvedWindowMs', async () => {
    const { generateSpy } = installFakeService([], []);
    const { req, res } = buildReqRes(
      { sessionName: 'dev-1' },
      { recentlyResolvedWindowMs: 'not-a-number' },
    );
    await getActiveWorkBriefing(req, res);
    expect(generateSpy).toHaveBeenCalledWith('dev-1', 'developer', {
      recentlyResolvedWindowMs: undefined,
    });
  });

  it('honors the role query parameter (orchestrator path)', async () => {
    const { generateSpy } = installFakeService([], []);
    const { req, res } = buildReqRes({ sessionName: 'crewly-orc' }, { role: 'orchestrator' });
    await getActiveWorkBriefing(req, res);
    expect(generateSpy).toHaveBeenCalledWith('crewly-orc', 'orchestrator', expect.any(Object));
  });
});

describe('createActiveWorkRouter', () => {
  it('exposes GET /:sessionName/active-work', () => {
    const router = createActiveWorkRouter();
    const stack = (router as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    const routes = stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route!.path,
        methods: Object.keys(layer.route!.methods),
      }));
    expect(routes).toContainEqual(
      expect.objectContaining({
        path: '/:sessionName/active-work',
        methods: expect.arrayContaining(['get']),
      }),
    );
  });
});
