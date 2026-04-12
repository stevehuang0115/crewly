/**
 * Tests for RequestService — CRUD operations for V3 Request entities.
 *
 * @module services/v3/request.service.test
 */

import { RequestService, type RequestPlan } from './request.service.js';

// Mock file I/O
const mockFiles = new Map<string, string>();

jest.mock('fs/promises', () => ({
  readdir: jest.fn().mockImplementation(async () => {
    const entries: string[] = [];
    for (const key of mockFiles.keys()) {
      const filename = key.split('/').pop() || '';
      if (filename.endsWith('.json')) entries.push(filename);
    }
    return entries;
  }),
}));

jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  atomicWriteJson: jest.fn().mockImplementation(async (filePath: string, data: unknown) => {
    mockFiles.set(filePath, JSON.stringify(data));
  }),
  safeReadJson: jest.fn().mockImplementation(async (filePath: string, fallback: unknown) => {
    const content = mockFiles.get(filePath);
    if (!content) return fallback;
    return JSON.parse(content);
  }),
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

describe('RequestService', () => {
  beforeEach(() => {
    RequestService.resetInstance();
    mockFiles.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a Request with valid input', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const request = await service.create({
        sourceConversationItemId: 'conv-123',
        title: 'Deploy to staging',
        description: 'Deploy the current build to the staging environment',
      });

      expect(request.id).toBeDefined();
      expect(request.title).toBe('Deploy to staging');
      expect(request.status).toBe('open');
      expect(request.priority).toBe('normal');
      expect(request.intentLevel).toBe('L1');
      expect(request.workItemIds).toEqual([]);
    });

    it('should throw on invalid input', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      await expect(
        service.create({
          sourceConversationItemId: '',
          title: '',
          description: 'test',
        }),
      ).rejects.toThrow('Invalid CreateRequestInput');
    });
  });

  describe('getById', () => {
    it('should return null for non-existent request', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const result = await service.getById('nonexistent-id');
      expect(result).toBeNull();
    });

    it('should return a previously created request', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-456',
        title: 'Test request',
        description: 'A test request',
      });

      const found = await service.getById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.title).toBe('Test request');
    });
  });

  describe('update', () => {
    it('should update request status with valid transition', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-789',
        title: 'Update test',
        description: 'Testing updates',
      });

      const updated = await service.update(created.id, { status: 'ready' });
      expect(updated.status).toBe('ready');
    });

    it('should throw on invalid status transition', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: 'conv-invalid',
        title: 'Invalid transition test',
        description: 'Testing invalid transition',
      });

      // Transition to done first (terminal state)
      await service.update(created.id, { status: 'done' });

      // done -> running is invalid
      await expect(
        service.update(created.id, { status: 'running' }),
      ).rejects.toThrow('Invalid status transition');
    });

    it('should set completedAt when transitioning to done', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-done',
        title: 'Done test',
        description: 'Testing done transition',
      });

      // Transition: open -> ready -> running -> done
      await service.update(created.id, { status: 'ready' });
      await service.update(created.id, { status: 'running' });
      const done = await service.update(created.id, { status: 'done' });

      expect(done.status).toBe('done');
      expect(done.completedAt).toBeDefined();
    });

    it('should throw when request not found', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      await expect(
        service.update('nonexistent-id', { title: 'nope' }),
      ).rejects.toThrow('Request not found');
    });
  });

  describe('linkWorkItem', () => {
    it('should add workItemId to request', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-link',
        title: 'Link test',
        description: 'Testing work item link',
      });

      const updated = await service.linkWorkItem(created.id, 'wi-123');
      expect(updated).not.toBeNull();
      expect(updated?.workItemIds).toContain('wi-123');
    });

    it('should not duplicate workItemId', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-dedup',
        title: 'Dedup test',
        description: 'Testing dedup',
      });

      await service.linkWorkItem(created.id, 'wi-456');
      const updated = await service.linkWorkItem(created.id, 'wi-456');
      expect(updated?.workItemIds.filter((id) => id === 'wi-456')).toHaveLength(1);
    });

    it('should return null for non-existent request', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const result = await service.linkWorkItem('nonexistent', 'wi-789');
      expect(result).toBeNull();
    });
  });

  describe('plan', () => {
    it('should return empty tasks for short messages', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('.');
      expect(plan.tasks).toHaveLength(0);
      expect(plan.strategy).toBe('none');
      expect(plan.reasoning).toContain('too short');
    });

    it('should return tasks for 2-character messages (e.g. OK)', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('OK');
      expect(plan.tasks.length).toBeGreaterThan(0);
      expect(plan.strategy).not.toBe('none');
    });

    it('should return empty tasks for empty string', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('');
      expect(plan.tasks).toHaveLength(0);
      expect(plan.strategy).toBe('none');
    });

    it('should decompose build-type messages into 3 tasks', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      // Needs to be complex: multiple action verbs or conjunctions
      const plan = await service.plan('Build a new authentication system with OAuth2 and then integrate it with the existing user database and session management');

      expect(plan.tasks).toHaveLength(3);
      expect(plan.strategy).toBe('build');
      expect(plan.tasks[0].title).toContain('Design');
      expect(plan.tasks[1].title).toContain('Implement');
      expect(plan.tasks[2].title).toContain('Test');
      expect(plan.reasoning).toContain('build');
    });

    it('should decompose fix-type messages into 3 tasks', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      // Needs to be complex: "and then" + multiple verbs
      const plan = await service.plan('Fix the memory leak in the queue processor and then verify all dependent services are stable and review performance metrics');

      expect(plan.tasks).toHaveLength(3);
      expect(plan.strategy).toBe('fix');
      expect(plan.tasks[0].title).toContain('Investigate');
      expect(plan.tasks[1].title).toContain('Fix');
      expect(plan.tasks[2].title).toContain('Verify');
    });

    it('should decompose generic messages into plan/execute/review', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      // Needs to be complex and not match build/fix keywords
      const plan = await service.plan('Improve system performance by 30% and then optimize the reporting pipeline with weekly updates and alerting on regressions');

      expect(plan.tasks).toHaveLength(3);
      expect(plan.strategy).toBe('generic');
      expect(plan.tasks[0].title).toContain('Plan');
      expect(plan.tasks[1].title).toContain('Execute');
      expect(plan.tasks[2].title).toContain('Review');
    });

    it('should preserve the original message in the plan', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const msg = 'Create a dashboard with real-time metrics';
      const plan = await service.plan(msg);

      expect(plan.message).toBe(msg);
    });

    it('should include acceptance criteria on all tasks', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('Implement a search feature with autocomplete');

      for (const task of plan.tasks) {
        expect(task.acceptanceCriteria.length).toBeGreaterThan(0);
        expect(task.priority).toBeDefined();
      }
    });

    it('should trim whitespace from messages', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('   Build a new API   ');

      expect(plan.message).toBe('Build a new API');
      expect(plan.tasks.length).toBeGreaterThan(0);
    });
  });
});
