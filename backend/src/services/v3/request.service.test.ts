/**
 * Tests for RequestService — CRUD operations for V3 Request entities.
 *
 * @module services/v3/request.service.test
 */

import { RequestService, setRequestServiceEventBus, type RequestPlan } from './request.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';

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

    // -----------------------------------------------------------------------
    // INBOUND-1: request:created event publication
    // -----------------------------------------------------------------------

    describe('request:created event (INBOUND-1)', () => {
      /**
       * Build a fake EventBusService that captures publish() calls. The fake
       * implements only the surface RequestService touches — no inheritance
       * required.
       */
      function buildFakeBus(opts?: { throwOnPublish?: boolean }): {
        bus: EventBusService;
        published: AgentEvent[];
      } {
        const published: AgentEvent[] = [];
        const bus = {
          publish: jest.fn((event: AgentEvent) => {
            if (opts?.throwOnPublish) throw new Error('bus failure');
            published.push(event);
          }),
        } as unknown as EventBusService;
        return { bus, published };
      }

      afterEach(() => {
        // Clear any wired bus so suite-level isolation holds.
        setRequestServiceEventBus(null);
      });

      it('publishes request:created with the correct shape after save', async () => {
        const { bus, published } = buildFakeBus();
        setRequestServiceEventBus(bus);

        const service = RequestService.getInstance('/tmp/test-project');
        const request = await service.create({
          sourceConversationItemId: 'slack-C123-1',
          title: 'Help with Slack',
          description: 'A user message',
          tags: ['slack'],
        });

        expect(published).toHaveLength(1);
        const event = published[0];
        expect(event.type).toBe('request:created');
        expect(event.id).toBe(`request:created:${request.id}`);
        expect(event.requestId).toBe(request.id);
        expect(event.newValue).toBe('open');
        expect(event.previousValue).toBe('');
        expect(event.timestamp).toBe(request.createdAt);
        // changedField uses the existing 'taskStatus' enum member; spelled out
        // in publishCreatedEvent's inline comment to discourage churn.
        expect(event.changedField).toBe('taskStatus');
      });

      it('silently skips publish when no bus is wired', async () => {
        // No setRequestServiceEventBus call — wired bus stays null.
        const service = RequestService.getInstance('/tmp/test-project');
        const request = await service.create({
          sourceConversationItemId: 'conv-no-bus',
          title: 'No bus available',
          description: 'Should still persist',
        });

        // Persistence still succeeded.
        expect(request.id).toBeDefined();
        expect(request.status).toBe('open');
      });

      it('does not roll back the create when bus.publish throws', async () => {
        const { bus } = buildFakeBus({ throwOnPublish: true });
        setRequestServiceEventBus(bus);

        const service = RequestService.getInstance('/tmp/test-project');
        const request = await service.create({
          sourceConversationItemId: 'conv-publish-err',
          title: 'Publish will throw',
          description: 'But the Request must persist',
        });

        // The Request is persisted regardless of the publish failure.
        expect(request.id).toBeDefined();
        expect(request.status).toBe('open');
        const stored = await service.getById(request.id);
        expect(stored).not.toBeNull();
      });

      it('forwards missionId on the event when present on the Request', async () => {
        const { bus, published } = buildFakeBus();
        setRequestServiceEventBus(bus);

        const service = RequestService.getInstance('/tmp/test-project');
        await service.create({
          sourceConversationItemId: 'conv-mission',
          title: 'Mission-tied',
          description: 'Linked to a mission',
          missionId: 'mission-42',
        });

        expect(published[0].missionId).toBe('mission-42');
      });

      it('clears the wired bus when setRequestServiceEventBus(null) is called', async () => {
        const { bus, published } = buildFakeBus();
        setRequestServiceEventBus(bus);

        const service = RequestService.getInstance('/tmp/test-project');
        await service.create({
          sourceConversationItemId: 'conv-1',
          title: 'First',
          description: 'wired',
        });
        expect(published).toHaveLength(1);

        setRequestServiceEventBus(null);
        await service.create({
          sourceConversationItemId: 'conv-2',
          title: 'Second',
          description: 'unwired',
        });
        // No new publish — count stays at 1.
        expect(published).toHaveLength(1);
      });
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
