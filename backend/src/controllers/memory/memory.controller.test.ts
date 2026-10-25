/**
 * Tests for Memory Controller
 *
 * Validates the REST handlers for remember, recall, and recordLearning
 * endpoints including input validation and error handling.
 *
 * @module controllers/memory/memory.controller.test
 */

import { remember, recall, recordLearning, getMyContext, supersedeMemory, recordCorrection, decideCorrection, listCorrections } from './memory.controller.js';

// Mock LoggerService before any imports that use it
jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// Mock CorrectionLadderService (#810)
const mockLadderRecord = jest.fn();
const mockLadderDecide = jest.fn();
const mockLadderList = jest.fn();
jest.mock('../../services/memory/correction-ladder.service.js', () => ({
  CorrectionLadderService: {
    getInstance: () => ({
      record: mockLadderRecord,
      decide: mockLadderDecide,
      list: mockLadderList,
    }),
  },
}));

// Mock MemoryService
const mockRemember = jest.fn();
const mockRecall = jest.fn();
const mockRecordLearning = jest.fn();

const mockGetTimingBlock = jest.fn<string | null, [string]>(() => null);
jest.mock('../../services/ai/self-improvement/task-timing.service.js', () => ({
  getTaskTimingService: () => ({ getTimingBlock: (agent: string) => mockGetTimingBlock(agent) }),
}));

jest.mock('../../services/memory/memory.service.js', () => ({
  MemoryService: {
    getInstance: () => ({
      remember: mockRemember,
      recall: mockRecall,
      recordLearning: mockRecordLearning,
    }),
  },
}));

// Mock GoalTrackingService
jest.mock('../../services/memory/goal-tracking.service.js', () => ({
  GoalTrackingService: {
    getInstance: () => ({
      getGoals: jest.fn().mockResolvedValue([]),
      getCurrentFocus: jest.fn().mockResolvedValue(null),
    }),
  },
}));

// Mock DailyLogService
jest.mock('../../services/memory/daily-log.service.js', () => ({
  DailyLogService: {
    getInstance: () => ({
      getTodaysLog: jest.fn().mockResolvedValue(''),
    }),
  },
}));

// Mock LearningAccumulationService
jest.mock('../../services/memory/learning-accumulation.service.js', () => ({
  LearningAccumulationService: {
    getInstance: () => ({
      getSuccesses: jest.fn().mockResolvedValue(''),
      getFailures: jest.fn().mockResolvedValue(''),
    }),
  },
}));

// Mock MemorySupersessionService (M4)
const mockSupersede = jest.fn();
jest.mock('../../services/memory/memory-supersession.service.js', () => ({
  MemorySupersessionService: {
    getInstance: () => ({
      supersede: mockSupersede,
    }),
  },
}));

describe('MemoryController', () => {
  let mockRes: { json: jest.Mock; status: jest.Mock };
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockRes = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();

    mockRemember.mockReset();
    mockRecall.mockReset();
    mockRecordLearning.mockReset();
    mockSupersede.mockReset();
    mockLadderRecord.mockReset();
    mockLadderDecide.mockReset();
    mockLadderList.mockReset();
  });

  // ========================= remember =========================

  describe('remember', () => {
    it('should store memory and return entryId', async () => {
      mockRemember.mockResolvedValue('entry-123');

      await remember(
        {
          body: {
            agentId: 'dev-001',
            content: 'Always validate inputs',
            category: 'pattern',
            scope: 'agent',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRemember).toHaveBeenCalledWith({
        agentId: 'dev-001',
        content: 'Always validate inputs',
        category: 'pattern',
        scope: 'agent',
        projectPath: undefined,
        metadata: undefined,
      });
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        entryId: 'entry-123',
      });
    });

    it('should default scope to agent when not provided', async () => {
      mockRemember.mockResolvedValue('entry-456');

      await remember(
        {
          body: {
            agentId: 'dev-001',
            content: 'Some fact',
            category: 'fact',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRemember).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'agent' })
      );
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        entryId: 'entry-456',
      });
    });

    it('should pass metadata through to MemoryService', async () => {
      mockRemember.mockResolvedValue('entry-789');

      const metadata = {
        title: 'API Error Pattern',
        patternCategory: 'api',
        example: 'handleApiError(handler)',
      };

      await remember(
        {
          body: {
            agentId: 'dev-001',
            content: 'Use error wrapper',
            category: 'pattern',
            scope: 'project',
            projectPath: '/path/to/project',
            metadata,
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRemember).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata,
          projectPath: '/path/to/project',
          scope: 'project',
        })
      );
    });

    it('should return 400 when agentId is missing', async () => {
      await remember(
        { body: { content: 'test', category: 'fact' } } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('agentId'),
        })
      );
      expect(mockRemember).not.toHaveBeenCalled();
    });

    it('should return 400 when content is missing', async () => {
      await remember(
        { body: { agentId: 'dev-001', category: 'fact' } } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRemember).not.toHaveBeenCalled();
    });

    it('should return 400 when category is missing', async () => {
      await remember(
        { body: { agentId: 'dev-001', content: 'test' } } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRemember).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid category', async () => {
      await remember(
        {
          body: {
            agentId: 'dev-001',
            content: 'test',
            category: 'invalid-category',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('invalid-category'),
        })
      );
      expect(mockRemember).not.toHaveBeenCalled();
    });

    // F4 fix (2026-05-06): controller surfaces alias hints for common
    // mistakes. Sam (TL) hit `category=workflow` earlier in the audit cycle.
    // Arch nit (PR #468): 'best-practice' is produced by BOTH 'fact'
    // (agent-only) and 'decision' (project-only) in the service-layer
    // mapper, so the hint must be scope-aware to avoid sending project
    // callers down a dead-end (fact rejects on project scope).
    it.each([
      // [badCategory, scope, expectedHint]
      ['workflow', 'agent', 'pattern'],
      ['workflow', 'project', 'pattern'],
      ['best-practice', 'agent', 'fact'],
      ['best-practice', 'project', 'decision'], // <-- Arch nit fix
      ['anti-pattern', 'agent', 'gotcha'],
      ['anti-pattern', 'project', 'gotcha'],
    ])('should hint public-API alias when caller uses internal name %s with scope=%s', async (badCategory, scope, expectedHint) => {
      await remember(
        {
          body: {
            agentId: 'dev-001',
            content: 'test',
            category: badCategory,
            scope,
            ...(scope === 'project' ? { projectPath: '/tmp/test' } : {}),
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining(`did you mean '${expectedHint}'`),
        })
      );
      expect(mockRemember).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid scope', async () => {
      await remember(
        {
          body: {
            agentId: 'dev-001',
            content: 'test',
            category: 'fact',
            scope: 'invalid-scope',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('invalid-scope'),
        })
      );
    });

    it('should return 400 when scope is project but projectPath is missing', async () => {
      await remember(
        {
          body: {
            agentId: 'dev-001',
            content: 'test',
            category: 'pattern',
            scope: 'project',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('projectPath'),
        })
      );
    });

    it('should call next on service error', async () => {
      const serviceError = new Error('Storage failure');
      mockRemember.mockRejectedValue(serviceError);

      await remember(
        {
          body: {
            agentId: 'dev-001',
            content: 'test',
            category: 'fact',
            scope: 'agent',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockNext).toHaveBeenCalledWith(serviceError);
    });

    it('should accept all valid categories', async () => {
      const categories = ['fact', 'pattern', 'decision', 'gotcha', 'preference', 'relationship'];

      for (const category of categories) {
        mockRemember.mockResolvedValue(`entry-${category}`);

        await remember(
          {
            body: {
              agentId: 'dev-001',
              content: `test ${category}`,
              category,
              scope: 'agent',
            },
          } as any,
          mockRes as any,
          mockNext
        );

        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: true })
        );
      }
    });
  });

  // ========================= recall =========================

  describe('recall', () => {
    const mockRecallResult = {
      agentMemories: ['[best-practice] Validate inputs'],
      projectMemories: ['[pattern] Error handling: Use wrapper'],
      combined: '### From Your Experience\n- [best-practice] Validate inputs',
    };

    it('should return recall results', async () => {
      mockRecall.mockResolvedValue(mockRecallResult);

      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'error handling in API endpoints',
            scope: 'both',
            projectPath: '/path/to/project',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRecall).toHaveBeenCalledWith({
        agentId: 'dev-001',
        context: 'error handling in API endpoints',
        scope: 'both',
        limit: undefined,
        projectPath: '/path/to/project',
      });
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: mockRecallResult,
      });
    });

    it('should default scope to both when not provided', async () => {
      mockRecall.mockResolvedValue(mockRecallResult);

      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'test query',
            projectPath: '/path',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRecall).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'both' })
      );
    });

    it('should pass limit parameter as number', async () => {
      mockRecall.mockResolvedValue(mockRecallResult);

      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'test',
            scope: 'agent',
            limit: 5,
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRecall).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5 })
      );
    });

    it('should convert string limit to number', async () => {
      mockRecall.mockResolvedValue(mockRecallResult);

      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'test',
            scope: 'agent',
            limit: '15',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRecall).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 15 })
      );
    });

    it('should return 400 when agentId is missing', async () => {
      await recall(
        { body: { context: 'test' } } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('agentId'),
        })
      );
      expect(mockRecall).not.toHaveBeenCalled();
    });

    it('should return 400 when context is missing', async () => {
      await recall(
        { body: { agentId: 'dev-001' } } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRecall).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid scope', async () => {
      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'test',
            scope: 'invalid',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('invalid'),
        })
      );
    });

    it('should return 400 when scope includes project but projectPath is missing', async () => {
      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'test',
            scope: 'project',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('projectPath'),
        })
      );
    });

    it('should return 400 when scope is both but projectPath is missing', async () => {
      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'test',
            scope: 'both',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should allow agent scope without projectPath', async () => {
      mockRecall.mockResolvedValue({
        agentMemories: [],
        projectMemories: [],
        combined: '',
      });

      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'test',
            scope: 'agent',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });

    it('should call next on service error', async () => {
      const serviceError = new Error('Recall failed');
      mockRecall.mockRejectedValue(serviceError);

      await recall(
        {
          body: {
            agentId: 'dev-001',
            context: 'test',
            scope: 'agent',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockNext).toHaveBeenCalledWith(serviceError);
    });
  });

  // ========================= recordLearning =========================

  describe('recordLearning', () => {
    it('should record a learning successfully', async () => {
      mockRecordLearning.mockResolvedValue(undefined);

      await recordLearning(
        {
          body: {
            agentId: 'dev-001',
            agentRole: 'developer',
            projectPath: '/path/to/project',
            learning: 'Always use async/await for DB operations',
            relatedTask: 'TICKET-456',
            relatedFiles: ['src/db/queries.ts'],
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRecordLearning).toHaveBeenCalledWith({
        agentId: 'dev-001',
        agentRole: 'developer',
        projectPath: '/path/to/project',
        learning: 'Always use async/await for DB operations',
        relatedTask: 'TICKET-456',
        relatedFiles: ['src/db/queries.ts'],
      });
      expect(mockRes.json).toHaveBeenCalledWith({ success: true });
    });

    it('should record a learning without optional fields', async () => {
      mockRecordLearning.mockResolvedValue(undefined);

      await recordLearning(
        {
          body: {
            agentId: 'dev-001',
            agentRole: 'developer',
            projectPath: '/path/to/project',
            learning: 'Simple learning',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRecordLearning).toHaveBeenCalledWith({
        agentId: 'dev-001',
        agentRole: 'developer',
        projectPath: '/path/to/project',
        learning: 'Simple learning',
        relatedTask: undefined,
        relatedFiles: undefined,
      });
      expect(mockRes.json).toHaveBeenCalledWith({ success: true });
    });

    it('should return 400 when agentId is missing', async () => {
      await recordLearning(
        {
          body: {
            agentRole: 'developer',
            projectPath: '/path',
            learning: 'test',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('agentId'),
        })
      );
      expect(mockRecordLearning).not.toHaveBeenCalled();
    });

    it('should return 400 when agentRole is missing', async () => {
      await recordLearning(
        {
          body: {
            agentId: 'dev-001',
            projectPath: '/path',
            learning: 'test',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRecordLearning).not.toHaveBeenCalled();
    });

    it('should return 400 when projectPath is missing', async () => {
      await recordLearning(
        {
          body: {
            agentId: 'dev-001',
            agentRole: 'developer',
            learning: 'test',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRecordLearning).not.toHaveBeenCalled();
    });

    it('should return 400 when learning is missing', async () => {
      await recordLearning(
        {
          body: {
            agentId: 'dev-001',
            agentRole: 'developer',
            projectPath: '/path',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRecordLearning).not.toHaveBeenCalled();
    });

    it('should call next on service error', async () => {
      const serviceError = new Error('Write failed');
      mockRecordLearning.mockRejectedValue(serviceError);

      await recordLearning(
        {
          body: {
            agentId: 'dev-001',
            agentRole: 'developer',
            projectPath: '/path',
            learning: 'test',
          },
        } as any,
        mockRes as any,
        mockNext
      );

      expect(mockNext).toHaveBeenCalledWith(serviceError);
    });
  });

  // ========================= getMyContext =========================

  describe('recordLearning with correctionClass (#810)', () => {
    const body = {
      agentId: 'dev-001',
      agentRole: 'developer',
      projectPath: '/path/to/project',
      learning: 'Never git add -A',
      relatedTask: 'TICKET-9',
      correctionClass: 'git-add-all',
    };

    it('counts the class on the ladder and reports the tally', async () => {
      mockRecordLearning.mockResolvedValue(undefined);
      mockLadderRecord.mockResolvedValue({ record: { class: 'git-add-all', count: 2 }, raised: true, workItemId: 'wi-1' });

      await recordLearning({ body } as any, mockRes as any, mockNext);

      expect(mockRecordLearning).toHaveBeenCalledWith(expect.objectContaining({ learning: 'Never git add -A' }));
      expect(mockLadderRecord).toHaveBeenCalledWith({
        projectPath: '/path/to/project',
        correctionClass: 'git-add-all',
        agentId: 'dev-001',
        text: 'Never git add -A',
        source: 'learning',
        relatedTask: 'TICKET-9',
      });
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        correction: { class: 'git-add-all', count: 2, raised: true, workItemId: 'wi-1' },
      });
    });

    it('keeps the learning when the ladder fails', async () => {
      mockRecordLearning.mockResolvedValue(undefined);
      mockLadderRecord.mockRejectedValue(new Error('disk full'));

      await recordLearning({ body } as any, mockRes as any, mockNext);

      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, correction: { error: 'disk full' } });
    });

    it('does not touch the ladder without a class', async () => {
      mockRecordLearning.mockResolvedValue(undefined);
      await recordLearning({ body: { ...body, correctionClass: undefined } } as any, mockRes as any, mockNext);
      expect(mockLadderRecord).not.toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('recordCorrection', () => {
    it('rejects missing fields', async () => {
      await recordCorrection({ body: { projectPath: '/p', correctionClass: 'c' } } as any, mockRes as any, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockLadderRecord).not.toHaveBeenCalled();
    });

    it('returns 400 when the ladder refuses the class', async () => {
      mockLadderRecord.mockRejectedValue(new Error('Correction class "??" has no letters or digits'));
      await recordCorrection({ body: { projectPath: '/p', correctionClass: '??', agentId: 'a', text: 't' } } as any, mockRes as any, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ success: false, error: 'Correction class "??" has no letters or digits' });
    });

    it('records with a known source and defaults unknown sources to manual', async () => {
      mockLadderRecord.mockResolvedValue({ record: { class: 'c', count: 1 }, raised: false, skipped: 'below_threshold' });
      await recordCorrection({ body: { projectPath: '/p', correctionClass: 'c', agentId: 'a', text: 't', source: 'failure' } } as any, mockRes as any, mockNext);
      expect(mockLadderRecord).toHaveBeenCalledWith(expect.objectContaining({ source: 'failure' }));
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: { class: 'c', count: 1, raised: false, workItemId: undefined, skipped: 'below_threshold' },
      });

      await recordCorrection({ body: { projectPath: '/p', correctionClass: 'c', agentId: 'a', text: 't', source: 'bogus' } } as any, mockRes as any, mockNext);
      expect(mockLadderRecord).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'manual' }));
    });
  });

  describe('decideCorrection', () => {
    const req = (body: Record<string, unknown>, cls = 'git-add-all') => ({ params: { class: cls }, body }) as any;

    it('rejects missing fields', async () => {
      await decideCorrection(req({ projectPath: '/p', rung: 'check' }), mockRes as any, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockLadderDecide).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown class and 400 for a bad rung', async () => {
      mockLadderDecide.mockRejectedValueOnce(new Error('No correction class "nope" in /p'));
      await decideCorrection(req({ projectPath: '/p', rung: 'check', reason: 'r', decidedBy: 'tl' }, 'nope'), mockRes as any, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(404);

      mockLadderDecide.mockRejectedValueOnce(new Error('Unknown rung "vibes"'));
      await decideCorrection(req({ projectPath: '/p', rung: 'vibes', reason: 'r', decidedBy: 'tl' }), mockRes as any, mockNext);
      expect(mockRes.status).toHaveBeenLastCalledWith(400);
    });

    it('records the decision', async () => {
      const record = { class: 'git-add-all', count: 2, decision: { rung: 'check', reason: 'r', decidedBy: 'tl' } };
      mockLadderDecide.mockResolvedValue(record);
      await decideCorrection(req({ projectPath: '/p', rung: 'check', reason: 'r', link: 'PR #1', decidedBy: 'tl' }), mockRes as any, mockNext);
      expect(mockLadderDecide).toHaveBeenCalledWith({ projectPath: '/p', correctionClass: 'git-add-all', rung: 'check', reason: 'r', link: 'PR #1', decidedBy: 'tl' });
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: record });
    });
  });

  describe('listCorrections', () => {
    it('needs projectPath', async () => {
      await listCorrections({ query: {} } as any, mockRes as any, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('lists the project classes', async () => {
      mockLadderList.mockResolvedValue([{ class: 'c', count: 3 }]);
      await listCorrections({ query: { projectPath: '/p' } } as any, mockRes as any, mockNext);
      expect(mockLadderList).toHaveBeenCalledWith('/p');
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: [{ class: 'c', count: 3 }] });
    });
  });

  describe('getMyContext', () => {
    beforeEach(() => {
      mockRecall.mockResolvedValue({
        agentMemories: [],
        projectMemories: [],
        combined: '',
      });
    });

    it('returns context (memories/goals/learnings) without a knowledge-base section', async () => {
      // The standalone knowledge base was retired — agent recall is now BM25
      // over the LLM-wiki, so the context response no longer carries knowledgeDocs.
      await getMyContext(
        {
          body: {
            agentId: 'dev-001',
            agentRole: 'developer',
            projectPath: '/path/to/project',
          },
        } as any,
        mockRes as any,
        mockNext,
      );

      const payload = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(payload.success).toBe(true);
      expect(payload.data).toHaveProperty('memories');
      expect(payload.data).not.toHaveProperty('knowledgeDocs');
    });

    it('recalls with the caller\'s context when given, else the generic one (#857)', async () => {
      await getMyContext(
        { body: { agentId: 'dev-001', agentRole: 'developer', projectPath: '/p', context: ' developer session startup, unfinished work ' } } as any,
        mockRes as any,
        mockNext,
      );
      expect(mockRecall).toHaveBeenCalledWith(expect.objectContaining({ context: 'developer session startup, unfinished work', scope: 'both' }));

      mockRecall.mockClear();
      await getMyContext({ body: { agentId: 'dev-001', agentRole: 'developer', projectPath: '/p', context: '   ' } } as any, mockRes as any, mockNext);
      expect(mockRecall).toHaveBeenCalledWith(expect.objectContaining({ context: 'developer agent context for current work' }));

      mockRecall.mockClear();
      await getMyContext({ body: { agentId: 'dev-001', agentRole: 'developer', projectPath: '/p', context: 'x'.repeat(900) } } as any, mockRes as any, mockNext);
      expect(mockRecall.mock.calls[0][0].context).toHaveLength(500);
    });

    it("includes the agent's task-timing summary only when it has history", async () => {
      const req = { body: { agentId: 'dev-001', agentRole: 'developer', projectPath: '/p' } } as any;
      await getMyContext(req, mockRes as any, mockNext);
      expect((mockRes.json as jest.Mock).mock.calls[0][0].data).not.toHaveProperty('taskTimings');

      mockGetTimingBlock.mockReturnValueOnce('Your own task times: revision median 23 min.');
      await getMyContext(req, mockRes as any, mockNext);
      expect(mockGetTimingBlock).toHaveBeenCalledWith('dev-001');
      expect((mockRes.json as jest.Mock).mock.calls[1][0].data.taskTimings).toContain('revision median 23 min');
    });

    it('should return 400 when agentId is missing', async () => {
      await getMyContext(
        {
          body: {
            agentRole: 'developer',
            projectPath: '/path',
          },
        } as any,
        mockRes as any,
        mockNext,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('agentId'),
        }),
      );
    });

    it('should return 400 when agentRole is missing', async () => {
      await getMyContext(
        {
          body: {
            agentId: 'dev-001',
            projectPath: '/path',
          },
        } as any,
        mockRes as any,
        mockNext,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when projectPath is missing', async () => {
      await getMyContext(
        {
          body: {
            agentId: 'dev-001',
            agentRole: 'developer',
          },
        } as any,
        mockRes as any,
        mockNext,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  // ========================= supersedeMemory (M4) =========================

  describe('supersedeMemory', () => {
    it('persists supersession and returns 200 with the result', async () => {
      const supersededAt = '2026-05-03T18:00:00.000Z';
      mockSupersede.mockResolvedValue({
        oldId: 'rk-old',
        newId: 'rk-new',
        supersededAt,
        reason: 'updated',
      });

      await supersedeMemory(
        {
          body: {
            agentId: 'crewly-product-max-c69ce8e6',
            oldId: 'rk-old',
            newId: 'rk-new',
            reason: 'updated',
          },
        } as any,
        mockRes as any,
        mockNext,
      );

      expect(mockSupersede).toHaveBeenCalledWith({
        agentId: 'crewly-product-max-c69ce8e6',
        oldId: 'rk-old',
        newId: 'rk-new',
        reason: 'updated',
      });
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: { oldId: 'rk-old', newId: 'rk-new', supersededAt, reason: 'updated' },
      });
      expect(mockRes.status).not.toHaveBeenCalledWith(400);
    });

    it('passes through with reason omitted', async () => {
      mockSupersede.mockResolvedValue({
        oldId: 'a',
        newId: 'b',
        supersededAt: '2026-05-03T18:00:00.000Z',
      });

      await supersedeMemory(
        { body: { agentId: 'agent-1', oldId: 'a', newId: 'b' } } as any,
        mockRes as any,
        mockNext,
      );

      expect(mockSupersede).toHaveBeenCalledWith({
        agentId: 'agent-1',
        oldId: 'a',
        newId: 'b',
        reason: undefined,
      });
    });

    it('returns 400 when agentId is missing', async () => {
      await supersedeMemory(
        { body: { oldId: 'a', newId: 'b' } } as any,
        mockRes as any,
        mockNext,
      );
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockSupersede).not.toHaveBeenCalled();
    });

    it('returns 400 when oldId is missing', async () => {
      await supersedeMemory(
        { body: { agentId: 'agent-1', newId: 'b' } } as any,
        mockRes as any,
        mockNext,
      );
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when newId is missing', async () => {
      await supersedeMemory(
        { body: { agentId: 'agent-1', oldId: 'a' } } as any,
        mockRes as any,
        mockNext,
      );
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 with the service error message when validation throws', async () => {
      mockSupersede.mockRejectedValue(new Error('Old memory entry "rk-missing" not found for agent "agent-1"'));

      await supersedeMemory(
        { body: { agentId: 'agent-1', oldId: 'rk-missing', newId: 'rk-new' } } as any,
        mockRes as any,
        mockNext,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Old memory entry "rk-missing" not found for agent "agent-1"',
      });
    });
  });
});
