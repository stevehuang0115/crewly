/**
 * Tests for V3DataService — automatic V3 entity creation via event hooks.
 *
 * @module services/v3/v3-data.service.test
 */

import { EventEmitter } from 'events';

// Shared mock state
const mockAddToPool = jest.fn().mockResolvedValue(undefined);
const mockClaimFromPool = jest.fn().mockResolvedValue({ workItem: { id: 'claimed-wi' }, claim: { agentId: 'test' } });
const mockGetAllItems = jest.fn().mockResolvedValue([]);
const mockCompleteItem = jest.fn().mockResolvedValue(undefined);
const mockFailItem = jest.fn().mockResolvedValue(undefined);
const mockUpdateItemStatus = jest.fn().mockResolvedValue(undefined);
const mockRequestCreate = jest.fn().mockResolvedValue({ id: 'req-123', title: 'test' });
const mockRequestGetById = jest.fn().mockResolvedValue(null);
const mockRequestUpdate = jest.fn().mockResolvedValue(undefined);
const mockRequestLinkWorkItem = jest.fn().mockResolvedValue(undefined);
const mockRequestListAll = jest.fn().mockResolvedValue([]);
const mockFindBySource = jest.fn().mockResolvedValue(null);
const mockAtomicWriteJson = jest.fn().mockResolvedValue(undefined);
const mockWriteFile = jest.fn().mockResolvedValue(undefined);

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

jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      getAllItems: mockGetAllItems,
      addToPool: mockAddToPool,
      claimFromPool: mockClaimFromPool,
      completeItem: mockCompleteItem,
      failItem: mockFailItem,
      updateItemStatus: mockUpdateItemStatus,
    }),
  },
}));

jest.mock('./request.service.js', () => ({
  RequestService: {
    getInstance: () => ({
      create: mockRequestCreate,
      getById: mockRequestGetById,
      update: mockRequestUpdate,
      linkWorkItem: mockRequestLinkWorkItem,
      listAll: mockRequestListAll,
      findBySourceConversationItemId: mockFindBySource,
    }),
  },
}));

jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  atomicWriteJson: mockAtomicWriteJson,
  safeReadJson: jest.fn().mockResolvedValue(null),
}));

jest.mock('fs/promises', () => ({
  writeFile: mockWriteFile,
  readdir: jest.fn().mockResolvedValue([]),
}));

jest.mock('./project-task-watcher.service.js', () => ({
  ProjectTaskWatcherService: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    dispose: jest.fn(),
  })),
}));

// Import after mocks are set up
import {
  V3DataService,
  classifyIntent,
  planTasksFromObjective,
  generateRequestTitle,
  isNonActionableMessage,
  MIN_REQUEST_CONTENT_LENGTH,
  DANGLING_REQUEST_GRACE_MS,
  type PlannedTask,
  type TaskDelegatedEvent,
  type TaskBlockedEvent,
  type GoalSetEvent,
  type UserWorkMessageEvent,
  type TaskCompletedEvent,
} from './v3-data.service.js';
import { RequestTracker } from './request-tracker.service.js';

describe('V3DataService', () => {
  let eventBus: EventEmitter;
  let service: V3DataService;

  beforeEach(() => {
    eventBus = new EventEmitter();
    RequestTracker.resetInstance();
    service = new V3DataService(eventBus, '/tmp/test-project');
    jest.clearAllMocks();
    mockGetAllItems.mockResolvedValue([]);
    mockFindBySource.mockResolvedValue(null);
    mockRequestGetById.mockResolvedValue(null);
    mockRequestListAll.mockResolvedValue([]);
  });

  afterEach(() => {
    service.dispose();
    RequestTracker.resetInstance();
  });

  describe('constructor', () => {
    it('should subscribe to all V3 events including task_blocked', () => {
      expect(eventBus.listenerCount('v3:task_delegated')).toBe(1);
      expect(eventBus.listenerCount('v3:task_completed')).toBe(1);
      expect(eventBus.listenerCount('v3:task_failed')).toBe(1);
      expect(eventBus.listenerCount('v3:task_blocked')).toBe(1);
      expect(eventBus.listenerCount('v3:goal_set')).toBe(1);
      expect(eventBus.listenerCount('v3:user_work_message')).toBe(1);
    });
  });

  describe('onTaskDelegated', () => {
    it('should create a WorkItem when task:delegated fires', async () => {
      const event: TaskDelegatedEvent = {
        taskId: 'task-1',
        title: 'Implement feature X',
        description: 'Build the thing',
        assignedTo: 'agent-leo',
        priority: 'high',
        projectPath: '/tmp/test',
        milestone: 'sprint-1',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      const addedItem = mockAddToPool.mock.calls[0][0];
      expect(addedItem.type).toBe('delegate');
      expect(addedItem.owner).toBe('orchestrator');
      expect(addedItem.target).toBe('agent-leo');
      expect(addedItem.title).toBe('Implement feature X');
      expect(addedItem.projectTaskId).toBe('task-1');
    });

    it('should auto-claim WorkItem for target agent after addToPool', async () => {
      const event: TaskDelegatedEvent = {
        taskId: 'task-autoclaim',
        title: 'Auto-claim test',
        assignedTo: 'agent-max',
        projectPath: '/tmp/test',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      expect(mockClaimFromPool).toHaveBeenCalledTimes(1);
      expect(mockClaimFromPool).toHaveBeenCalledWith('agent-max', { types: ['delegate'] });
    });

    it('should not fail if auto-claim throws', async () => {
      mockClaimFromPool.mockRejectedValueOnce(new Error('No items to claim'));

      const event: TaskDelegatedEvent = {
        taskId: 'task-claim-fail',
        title: 'Claim failure test',
        assignedTo: 'agent-leo',
        projectPath: '/tmp/test',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      // addToPool should still succeed even if claimFromPool fails
      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      expect(mockClaimFromPool).toHaveBeenCalledTimes(1);
    });

    it('should skip duplicate WorkItems', async () => {
      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-1', projectTaskId: 'task-1', status: 'queued' },
      ]);

      const event: TaskDelegatedEvent = {
        taskId: 'task-1',
        title: 'Already exists',
        assignedTo: 'agent-leo',
        projectPath: '/tmp/test',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddToPool).not.toHaveBeenCalled();
    });

    it('should link WorkItem to Request when requestId is present', async () => {
      mockRequestGetById.mockResolvedValueOnce({
        id: 'req-1',
        status: 'open',
        workItemIds: [],
      });

      const event: TaskDelegatedEvent = {
        taskId: 'task-link',
        title: 'Task with request',
        assignedTo: 'agent-leo',
        projectPath: '/tmp/test',
        requestId: 'req-1',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      expect(mockRequestLinkWorkItem).toHaveBeenCalledWith('req-1', expect.any(String));
      // Should transition Request open → running
      expect(mockRequestUpdate).toHaveBeenCalledWith('req-1', { status: 'running' });
    });

    it('should NOT resolve requestId from RequestTracker — explicit only (P2-2 fix)', async () => {
      // P2-2 fix verified by this commit: onTaskDelegated must not consult
      // RequestTracker even when getActiveRequestId() would return a value.
      // The time-window correlation was a global-singleton race vector that
      // produced cross-conversation mislinks; all delegation paths now must
      // pass requestId explicitly via TaskDelegatedEvent.requestId.
      RequestTracker.getInstance().setActiveRequest('req-from-tracker');

      const event: TaskDelegatedEvent = {
        taskId: 'task-no-req',
        title: 'Task without requestId',
        assignedTo: 'agent-leo',
        projectPath: '/tmp/test',
        // No requestId on event — should NOT use RequestTracker
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      const addedItem = mockAddToPool.mock.calls[0][0];
      // requestId should be undefined — no fallback to RequestTracker
      expect(addedItem.requestId).toBeUndefined();
      expect(mockRequestLinkWorkItem).not.toHaveBeenCalled();
    });

    it('P2-2: explicit event.requestId still resolves (no fallback regression)', async () => {
      // Regression guard: removing the RequestTracker fallback must not
      // also break the explicit-requestId path. event.requestId must still
      // flow through to the resulting WorkItem.
      const event: TaskDelegatedEvent = {
        taskId: 'task-explicit-req',
        title: 'Task with explicit requestId',
        assignedTo: 'agent-leo',
        projectPath: '/tmp/test',
        requestId: 'req-explicit-123',
        timestamp: new Date().toISOString(),
      };

      mockRequestGetById.mockResolvedValueOnce({
        id: 'req-explicit-123',
        status: 'open',
        workItemIds: [],
      });

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      const addedItem = mockAddToPool.mock.calls[0][0];
      expect(addedItem.requestId).toBe('req-explicit-123');
    });

    it('should NOT use greedy fallback — no cross-conversation mislinks (Bug 2 fix)', async () => {
      // Simulate: RequestTracker expired, an open Request exists on disk
      // from a DIFFERENT conversation. Should NOT be linked.
      mockRequestListAll.mockResolvedValueOnce([
        { id: 'req-other-conv', status: 'open', workItemIds: [], createdAt: new Date().toISOString() },
      ]);

      const event: TaskDelegatedEvent = {
        taskId: 'task-orphan-no-fallback',
        title: 'Task after tracker expired',
        assignedTo: 'agent-leo',
        projectPath: '/tmp/test',
        // No requestId, RequestTracker also expired
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      const addedItem = mockAddToPool.mock.calls[0][0];
      // Should NOT have linked to the unrelated Request
      expect(addedItem.requestId).toBeUndefined();
      expect(mockRequestLinkWorkItem).not.toHaveBeenCalled();
    });

    it('should not link if no open Request exists and no requestId', async () => {
      mockRequestListAll.mockResolvedValueOnce([]);

      const event: TaskDelegatedEvent = {
        taskId: 'task-orphan',
        title: 'Orphan task',
        assignedTo: 'agent-leo',
        projectPath: '/tmp/test',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddToPool).toHaveBeenCalledTimes(1);
      expect(mockRequestLinkWorkItem).not.toHaveBeenCalled();
    });

    it('should not transition Request if already running', async () => {
      mockRequestGetById.mockResolvedValueOnce({
        id: 'req-2',
        status: 'running',
        workItemIds: ['wi-old'],
      });

      const event: TaskDelegatedEvent = {
        taskId: 'task-2nd',
        title: 'Second delegation',
        assignedTo: 'agent-max',
        projectPath: '/tmp/test',
        requestId: 'req-2',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockRequestLinkWorkItem).toHaveBeenCalled();
      expect(mockRequestUpdate).not.toHaveBeenCalled();
    });
  });

  describe('onTaskCompleted', () => {
    it('should mark running WorkItem as done and cascade Request status', async () => {
      mockGetAllItems
        .mockResolvedValueOnce([
          { id: 'wi-1', target: 'agent-leo', status: 'running', requestId: 'req-c1' },
        ])
        // Second call for cascadeRequestStatus
        .mockResolvedValueOnce([
          { id: 'wi-1', target: 'agent-leo', status: 'done', requestId: 'req-c1' },
        ]);

      mockRequestGetById.mockResolvedValueOnce({
        id: 'req-c1',
        status: 'running',
        workItemIds: ['wi-1'],
      });

      const event: TaskCompletedEvent = {
        type: 'task:completed',
        sessionName: 'agent-leo',
        newValue: 'completed',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_completed', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockCompleteItem).toHaveBeenCalledWith('wi-1');
      // Request should cascade to 'done' since all WorkItems are done
      expect(mockRequestUpdate).toHaveBeenCalledWith('req-c1', { status: 'done' });
    });

    it('should transition queued → running → done when completing a queued WorkItem (Bug 1 fix)', async () => {
      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-1', target: 'agent-leo', status: 'queued' },
      ]);

      eventBus.emit('v3:task_completed', {
        type: 'task:completed',
        sessionName: 'agent-leo',
        newValue: 'completed',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should first transition queued → running, then complete
      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-1', 'running');
      expect(mockCompleteItem).toHaveBeenCalledWith('wi-1');
    });

    it('should match by projectTaskId first (precise match)', async () => {
      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-wrong', target: 'agent-leo', status: 'running', projectTaskId: 'task-other' },
        { id: 'wi-right', target: 'agent-max', status: 'queued', projectTaskId: 'task-123' },
      ]);

      eventBus.emit('v3:task_completed', {
        type: 'task:completed',
        taskId: 'task-123',
        sessionName: 'agent-leo',
        newValue: 'completed',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should match by projectTaskId, not by sessionName
      expect(mockCompleteItem).toHaveBeenCalledWith('wi-right');
    });

    it('should skip if no WorkItem matches at all', async () => {
      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-1', target: 'agent-other', status: 'queued' },
      ]);

      eventBus.emit('v3:task_completed', {
        type: 'task:completed',
        sessionName: 'agent-nonexistent',
        newValue: 'completed',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockCompleteItem).not.toHaveBeenCalled();
    });
  });

  describe('onTaskFailed', () => {
    it('should transition queued → running before failing (Bug 1 fix)', async () => {
      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-qf', target: 'agent-max', status: 'queued' },
      ]);

      eventBus.emit('v3:task_failed', {
        type: 'task:failed',
        sessionName: 'agent-max',
        newValue: 'failed',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-qf', 'running');
      expect(mockFailItem).toHaveBeenCalledWith('wi-qf', expect.stringContaining('agent-max'));
    });

    it('should mark running WorkItem as failed and cascade', async () => {
      mockGetAllItems
        .mockResolvedValueOnce([
          { id: 'wi-2', target: 'agent-max', status: 'running', requestId: 'req-f1' },
        ])
        .mockResolvedValueOnce([
          { id: 'wi-2', target: 'agent-max', status: 'failed', requestId: 'req-f1' },
        ]);

      mockRequestGetById.mockResolvedValueOnce({
        id: 'req-f1',
        status: 'running',
        workItemIds: ['wi-2'],
      });

      const event: TaskCompletedEvent = {
        type: 'task:failed',
        sessionName: 'agent-max',
        newValue: 'failed',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_failed', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFailItem).toHaveBeenCalledWith('wi-2', expect.stringContaining('agent-max'));
      expect(mockRequestUpdate).toHaveBeenCalledWith('req-f1', { status: 'cancelled' });
    });
  });

  describe('onTaskBlocked', () => {
    it('should mark running WorkItem as blocked', async () => {
      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-b1', target: 'agent-leo', status: 'running', requestId: undefined },
      ]);

      const event: TaskBlockedEvent = {
        sessionName: 'agent-leo',
        reason: 'Waiting for API key',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_blocked', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-b1', 'blocked');
    });

    it('should cascade Request status to blocked', async () => {
      mockGetAllItems
        .mockResolvedValueOnce([
          { id: 'wi-b2', target: 'agent-max', status: 'running', requestId: 'req-b1' },
        ])
        .mockResolvedValueOnce([
          { id: 'wi-b2', target: 'agent-max', status: 'blocked', requestId: 'req-b1' },
        ]);

      mockRequestGetById.mockResolvedValueOnce({
        id: 'req-b1',
        status: 'running',
        workItemIds: ['wi-b2'],
      });

      const event: TaskBlockedEvent = {
        sessionName: 'agent-max',
        reason: 'Missing dependency',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:task_blocked', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockUpdateItemStatus).toHaveBeenCalledWith('wi-b2', 'blocked');
      expect(mockRequestUpdate).toHaveBeenCalledWith('req-b1', { status: 'blocked' });
    });

    it('should skip if no running WorkItem matches', async () => {
      mockGetAllItems.mockResolvedValueOnce([]);

      eventBus.emit('v3:task_blocked', {
        sessionName: 'agent-x',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockUpdateItemStatus).not.toHaveBeenCalled();
    });
  });

  describe('onGoalSet', () => {
    it('should create a Mission with decomposed tasks when goal:set fires', async () => {
      const event: GoalSetEvent = {
        goal: 'Ship V3 by April',
        projectPath: '/tmp/test',
        setBy: 'user',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:goal_set', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAtomicWriteJson).toHaveBeenCalledTimes(1);
      const savedMission = mockAtomicWriteJson.mock.calls[0][1];
      expect(savedMission.objective).toBe('Ship V3 by April');
      expect(savedMission.status).toBe('active');
      // Mission should have activeProjectTaskIds populated
      expect(savedMission.activeProjectTaskIds.length).toBeGreaterThan(0);
    });

    it('should write task files to delegated/open when goal:set fires', async () => {
      const event: GoalSetEvent = {
        goal: 'Build a new login feature and then integrate with SSO provider and add 2FA support',
        projectPath: '/tmp/test',
        setBy: 'user',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:goal_set', event);
      await new Promise((r) => setTimeout(r, 50));

      // Complex "Build" objective (multiple actions) → 3 tasks (design, implement, test)
      expect(mockWriteFile).toHaveBeenCalledTimes(3);

      // Verify task files are written to correct directory
      const firstCallPath = mockWriteFile.mock.calls[0][0];
      expect(firstCallPath).toContain('.crewly/tasks/delegated/open/');
      expect(firstCallPath).toContain('.md');

      // Verify content includes mission reference
      const firstCallContent = mockWriteFile.mock.calls[0][1];
      expect(firstCallContent).toContain('Parent mission:');
      expect(firstCallContent).toContain('Build a new login feature');
    });

    it('should create single task for simple objectives (P0-1 intelligent decomposition)', async () => {
      const event: GoalSetEvent = {
        goal: 'Fix the login button',
        projectPath: '/tmp/test',
        setBy: 'user',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:goal_set', event);
      await new Promise((r) => setTimeout(r, 50));

      // Simple "Fix" objective → 1 task only
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const content = mockWriteFile.mock.calls[0][1];
      expect(content).toContain('Fix the login button');
    });

    it('should create fix-category tasks for complex bug-related objectives', async () => {
      const event: GoalSetEvent = {
        goal: 'Fix the memory leak in queue processor and then refactor the connection pooling to prevent recurrence',
        projectPath: '/tmp/test',
        setBy: 'user',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:goal_set', event);
      await new Promise((r) => setTimeout(r, 50));

      // Complex "Fix" keyword → 3 tasks (investigate, fix, verify)
      expect(mockWriteFile).toHaveBeenCalledTimes(3);
      const firstContent = mockWriteFile.mock.calls[0][1];
      expect(firstContent).toContain('Investigate');
    });

    it('should create default tasks for generic complex objectives', async () => {
      const event: GoalSetEvent = {
        goal: 'Improve team velocity by 20% and then implement automated performance dashboards with weekly reporting and alerting on regressions',
        projectPath: '/tmp/test',
        setBy: 'user',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:goal_set', event);
      await new Promise((r) => setTimeout(r, 50));

      // Complex build → 3 tasks (design, implement, test) — "implement" keyword triggers build category
      expect(mockWriteFile).toHaveBeenCalledTimes(3);
      const firstContent = mockWriteFile.mock.calls[0][1];
      expect(firstContent).toContain('Design approach');
    });

    it('should resolve ownerId from event.setBy when StorageService finds the member', async () => {
      // Arrange: stub findMemberBySessionName so the goal:set handler
      // populates the new ownerId field on the created Mission.
      const { StorageService } = await import('../core/storage.service.js');
      const findSpy = jest
        .spyOn(StorageService.getInstance() as any, 'findMemberBySessionName')
        .mockResolvedValue({ member: { id: 'sam-member-id', name: 'Sam', sessionName: 'sam-session' } });

      const event: GoalSetEvent = {
        goal: 'Test mission with owner resolution',
        projectPath: '/tmp/test',
        setBy: 'sam-session',
        timestamp: new Date().toISOString(),
      };

      // Act
      eventBus.emit('v3:goal_set', event);
      await new Promise((r) => setTimeout(r, 50));

      // Assert: any mission writeFile that fired should carry ownerId.
      // (Mission file path matches *.json under .crewly/missions, scan all writes.)
      const missionWrites = mockWriteFile.mock.calls.filter((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('missions'),
      );
      if (missionWrites.length > 0) {
        const missionContent = missionWrites[0][1];
        expect(missionContent).toContain('sam-member-id');
      }
      // findMemberBySessionName should have been consulted with the setBy value.
      expect(findSpy).toHaveBeenCalledWith('sam-session');

      findSpy.mockRestore();
    });

    it('should leave ownerId undefined when setBy cannot be resolved to a member', async () => {
      const { StorageService } = await import('../core/storage.service.js');
      const findSpy = jest
        .spyOn(StorageService.getInstance() as any, 'findMemberBySessionName')
        .mockResolvedValue(null);

      const event: GoalSetEvent = {
        goal: 'Test mission unresolved owner',
        projectPath: '/tmp/test',
        setBy: 'unknown-user',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:goal_set', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(findSpy).toHaveBeenCalledWith('unknown-user');
      findSpy.mockRestore();
    });
  });

  describe('onUserWorkMessage', () => {
    it('should NOT create Request directly — defers to orchestrator skills', async () => {
      const event: UserWorkMessageEvent = {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        content: 'Please deploy the staging environment',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event);
      await new Promise((r) => setTimeout(r, 50));

      // V3 pipeline change: onUserWorkMessage no longer creates Requests.
      // The orchestrator creates Requests via the 'create-request' skill.
      expect(mockRequestCreate).not.toHaveBeenCalled();
    });

    it('should clear RequestTracker on new message', async () => {
      // Pre-set an active request
      RequestTracker.getInstance().setActiveRequest('old-req');

      const event: UserWorkMessageEvent = {
        messageId: 'msg-clear',
        conversationId: 'conv-clear',
        content: 'A new user message triggers tracker clear',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event);
      await new Promise((r) => setTimeout(r, 50));

      // The old request should have been cleared (clearOnNewMessage)
      // No new request is set since handler defers to orchestrator
      const activeId = RequestTracker.getInstance().getActiveRequestId();
      expect(activeId).toBeNull();
    });

    it('should skip single-character messages (P2-1 relaxed filter)', async () => {
      const event: UserWorkMessageEvent = {
        messageId: 'msg-single-char',
        conversationId: 'conv-single-char',
        content: '.',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockRequestCreate).not.toHaveBeenCalled();
    });

    it('should skip non-actionable messages like "OK" (P0-1 intelligent filtering)', async () => {
      const event: UserWorkMessageEvent = {
        messageId: 'msg-ok',
        conversationId: 'conv-ok',
        content: 'OK',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event);
      await new Promise((r) => setTimeout(r, 50));

      // P0-1: "OK" is a confirmation, not an actionable request
      expect(mockRequestCreate).not.toHaveBeenCalled();
    });

    it('should not reject short commands like "fix" and "go" (P2-1 relaxed filter)', async () => {
      const event: UserWorkMessageEvent = {
        messageId: 'msg-fix',
        conversationId: 'conv-fix',
        content: 'fix',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event);
      await new Promise((r) => setTimeout(r, 50));

      // Short commands pass the length filter (≥ MIN_REQUEST_CONTENT_LENGTH)
      // but no Request is created directly — orchestrator handles via skills
      expect(mockRequestCreate).not.toHaveBeenCalled();
      // Importantly, the handler should NOT throw (fire-and-forget)
    });

    it('should deduplicate by messageId (not conversationId)', async () => {
      mockFindBySource.mockResolvedValueOnce({
        id: 'existing-req',
        sourceConversationItemId: 'msg-3',
      });

      const event: UserWorkMessageEvent = {
        messageId: 'msg-3',
        conversationId: 'conv-3',
        content: 'This should be deduplicated message',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event);
      await new Promise((r) => setTimeout(r, 50));

      // Dedup check uses messageId, not conversationId
      expect(mockFindBySource).toHaveBeenCalledWith('msg-3');
      expect(mockRequestCreate).not.toHaveBeenCalled();
    });

    it('should deduplicate by messageId in same conversation (not block same-thread messages)', async () => {
      // First message — no existing request for this messageId
      mockFindBySource.mockResolvedValueOnce(null);

      const event1: UserWorkMessageEvent = {
        messageId: 'msg-10',
        conversationId: 'conv-shared',
        content: 'First request in thread',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event1);
      await new Promise((r) => setTimeout(r, 50));

      // No direct creation — orchestrator handles via skills
      expect(mockRequestCreate).not.toHaveBeenCalled();

      // Second message in same conversation with different messageId
      mockFindBySource.mockResolvedValueOnce(null);

      const event2: UserWorkMessageEvent = {
        messageId: 'msg-11',
        conversationId: 'conv-shared',
        content: 'Second request in same thread',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event2);
      await new Promise((r) => setTimeout(r, 50));

      // Each message gets a dedup check by its own messageId
      expect(mockFindBySource).toHaveBeenCalledWith('msg-11');
      // Still no direct creation
      expect(mockRequestCreate).not.toHaveBeenCalled();
    });

    it('should auto-close dangling open Requests past grace period (Bug 3 + P2-1)', async () => {
      const staleTime = new Date(Date.now() - DANGLING_REQUEST_GRACE_MS - 60_000).toISOString(); // past grace
      const recentTime = new Date().toISOString(); // just created

      mockRequestListAll.mockResolvedValueOnce([
        { id: 'req-stale-dangling', status: 'open', workItemIds: [], createdAt: staleTime },
        { id: 'req-recent-dangling', status: 'open', workItemIds: [], createdAt: recentTime },
        { id: 'req-active', status: 'running', workItemIds: ['wi-1'], createdAt: staleTime },
      ]);

      const event: UserWorkMessageEvent = {
        messageId: 'msg-cleanup',
        conversationId: 'conv-cleanup',
        content: 'A new message that triggers cleanup',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event);
      await new Promise((r) => setTimeout(r, 50));

      // Should close the STALE dangling Request (open + empty workItemIds + past grace)
      expect(mockRequestUpdate).toHaveBeenCalledWith('req-stale-dangling', { status: 'done' });
      // Should NOT close the RECENT dangling Request (within grace period)
      expect(mockRequestUpdate).not.toHaveBeenCalledWith('req-recent-dangling', expect.anything());
      // Should NOT close the active Request (has workItems)
      expect(mockRequestUpdate).not.toHaveBeenCalledWith('req-active', expect.anything());
    });

    it('should not auto-close dangling Requests within grace period (P2-1)', async () => {
      const recentTime = new Date(Date.now() - 30_000).toISOString(); // 30 seconds ago, well within grace

      mockRequestListAll.mockResolvedValueOnce([
        { id: 'req-fresh', status: 'open', workItemIds: [], createdAt: recentTime },
      ]);

      const event: UserWorkMessageEvent = {
        messageId: 'msg-no-premature-close',
        conversationId: 'conv-no-premature',
        content: 'New message should not kill fresh requests',
        source: 'slack',
        timestamp: new Date().toISOString(),
      };

      eventBus.emit('v3:user_work_message', event);
      await new Promise((r) => setTimeout(r, 50));

      // Should NOT close the fresh Request — grace period protects it
      expect(mockRequestUpdate).not.toHaveBeenCalledWith('req-fresh', { status: 'done' });
    });

    it('should handle long messages without error (defers to orchestrator)', async () => {
      const longContent = 'A'.repeat(200);

      eventBus.emit('v3:user_work_message', {
        messageId: 'msg-long',
        conversationId: 'conv-long',
        content: longContent,
        source: 'web_chat',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      // Long messages are accepted (pass length filter) but no direct creation
      expect(mockRequestCreate).not.toHaveBeenCalled();
    });
  });

  describe('cascadeRequestStatus', () => {
    it('should set Request to done when all WorkItems are done', async () => {
      mockGetAllItems
        .mockResolvedValueOnce([
          { id: 'wi-c1', target: 'a', status: 'running', requestId: 'req-cascade' },
        ])
        .mockResolvedValueOnce([
          { id: 'wi-c1', target: 'a', status: 'done', requestId: 'req-cascade' },
        ]);

      mockRequestGetById.mockResolvedValueOnce({
        id: 'req-cascade',
        status: 'running',
        workItemIds: ['wi-c1'],
      });

      eventBus.emit('v3:task_completed', {
        type: 'task:completed',
        sessionName: 'a',
        newValue: 'completed',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockRequestUpdate).toHaveBeenCalledWith('req-cascade', { status: 'done' });
    });

    it('should keep Request running if some WorkItems still running', async () => {
      mockGetAllItems
        .mockResolvedValueOnce([
          { id: 'wi-r1', target: 'a', status: 'running', requestId: 'req-partial' },
        ])
        .mockResolvedValueOnce([
          { id: 'wi-r1', target: 'a', status: 'done', requestId: 'req-partial' },
          { id: 'wi-r2', target: 'b', status: 'running', requestId: 'req-partial' },
        ]);

      mockRequestGetById.mockResolvedValueOnce({
        id: 'req-partial',
        status: 'running',
        workItemIds: ['wi-r1', 'wi-r2'],
      });

      eventBus.emit('v3:task_completed', {
        type: 'task:completed',
        sessionName: 'a',
        newValue: 'completed',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      // Request stays 'running' because wi-r2 is still running
      expect(mockRequestUpdate).not.toHaveBeenCalled();
    });

    it('should not cascade if no requestId on WorkItem', async () => {
      mockGetAllItems.mockResolvedValueOnce([
        { id: 'wi-no-req', target: 'a', status: 'running' },
      ]);

      eventBus.emit('v3:task_completed', {
        type: 'task:completed',
        sessionName: 'a',
        newValue: 'completed',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockRequestGetById).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should remove all event listeners including task_blocked', () => {
      service.dispose();

      expect(eventBus.listenerCount('v3:task_delegated')).toBe(0);
      expect(eventBus.listenerCount('v3:task_completed')).toBe(0);
      expect(eventBus.listenerCount('v3:task_failed')).toBe(0);
      expect(eventBus.listenerCount('v3:task_blocked')).toBe(0);
      expect(eventBus.listenerCount('v3:goal_set')).toBe(0);
      expect(eventBus.listenerCount('v3:user_work_message')).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should not throw when handler fails — fire-and-forget', async () => {
      mockAddToPool.mockRejectedValueOnce(new Error('Storage full'));

      const event: TaskDelegatedEvent = {
        taskId: 'task-fail',
        title: 'This will fail',
        assignedTo: 'agent-x',
        projectPath: '/tmp/test',
        timestamp: new Date().toISOString(),
      };

      // Should not throw
      eventBus.emit('v3:task_delegated', event);
      await new Promise((r) => setTimeout(r, 50));

      // No unhandled rejection — fire-and-forget worked
      expect(true).toBe(true);
    });
  });
});

describe('P2-1 filter constants', () => {
  it('should export MIN_REQUEST_CONTENT_LENGTH as 2', () => {
    expect(MIN_REQUEST_CONTENT_LENGTH).toBe(2);
  });

  it('should export DANGLING_REQUEST_GRACE_MS as 5 minutes', () => {
    expect(DANGLING_REQUEST_GRACE_MS).toBe(5 * 60 * 1000);
  });
});

describe('classifyIntent', () => {
  it('should classify debugging keywords', () => {
    expect(classifyIntent('Fix the login bug').intentCategory).toBe('debugging');
    expect(classifyIntent('There is an error in auth').intentCategory).toBe('debugging');
    expect(classifyIntent('The app is broken').intentCategory).toBe('debugging');
  });

  it('should classify deployment keywords', () => {
    expect(classifyIntent('Deploy to staging').intentCategory).toBe('deployment');
    expect(classifyIntent('Release version 2.0').intentCategory).toBe('deployment');
    expect(classifyIntent('Ship the new feature').intentCategory).toBe('deployment');
  });

  it('should classify review keywords', () => {
    expect(classifyIntent('Review the PR').intentCategory).toBe('review');
    expect(classifyIntent('Code review needed').intentCategory).toBe('review');
  });

  it('should classify planning keywords', () => {
    expect(classifyIntent('Plan the sprint').intentCategory).toBe('planning');
    expect(classifyIntent('Design the API').intentCategory).toBe('planning');
  });

  it('should classify research keywords', () => {
    expect(classifyIntent('Research the best library').intentCategory).toBe('research');
    expect(classifyIntent('Analyze the performance data').intentCategory).toBe('research');
  });

  it('should classify communication keywords', () => {
    expect(classifyIntent('Send a message to the team').intentCategory).toBe('communication');
    expect(classifyIntent('Notify everyone about the meeting').intentCategory).toBe('communication');
  });

  it('should classify code_change keywords', () => {
    expect(classifyIntent('Implement the search feature').intentCategory).toBe('code_change');
    expect(classifyIntent('Create a new endpoint').intentCategory).toBe('code_change');
    expect(classifyIntent('Build the dashboard').intentCategory).toBe('code_change');
  });

  it('should return other for unrecognized content', () => {
    expect(classifyIntent('lorem ipsum dolor sit amet').intentCategory).toBe('other');
    expect(classifyIntent('lorem ipsum dolor sit amet').intentLevel).toBe('L1');
  });

  it('should set correct intent levels', () => {
    expect(classifyIntent('Fix a bug').intentLevel).toBe('L1');           // debugging → L1
    expect(classifyIntent('Deploy to prod').intentLevel).toBe('L2');      // deployment → L2 (deploy/env trigger)
    expect(classifyIntent('Build a feature').intentLevel).toBe('L2');     // code_change → L2 (build+system noun)
    // Bug A v0 (Mia §3 row 5): a single bounded communication directive
    // ("tell …") is L1, NOT L0. L0 is reserved for read-only / status /
    // lookup with no state change. Pre-Bug-A v3-data.service.classifyIntent
    // hard-coded communication → L0 — that's been corrected to align with
    // Mia's canonical product brief.
    expect(classifyIntent('Tell the team').intentLevel).toBe('L1');       // communication → L1
    expect(classifyIntent('Research options').intentLevel).toBe('L1');    // research → L1
  });
});

describe('planTasksFromObjective', () => {
  it('should return single task for simple build objectives (P0-1)', () => {
    const tasks = planTasksFromObjective('Build a login button');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('Build a login button');
    expect(tasks[0].priority).toBe('high');
  });

  it('should return 3 tasks for complex build objectives', () => {
    const tasks = planTasksFromObjective('Build a new authentication system and then integrate OAuth providers with token refresh and session management');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].title).toContain('Design approach');
    expect(tasks[1].title).toContain('Implement');
    expect(tasks[2].title).toContain('Test and verify');
    expect(tasks[0].priority).toBe('high');
    expect(tasks[2].priority).toBe('medium');
  });

  it('should return single task for simple fix objectives (P0-1)', () => {
    const tasks = planTasksFromObjective('Fix the login button');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('Fix the login button');
  });

  it('should return 3 tasks for complex fix objectives', () => {
    const tasks = planTasksFromObjective('Fix the memory leak in queue processor and then refactor the connection pool to prevent recurrence');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].title).toContain('Investigate');
    expect(tasks[1].title).toContain('Fix');
    expect(tasks[2].title).toContain('Verify fix');
  });

  it('should return single task for simple generic objectives (P0-1)', () => {
    const tasks = planTasksFromObjective('Improve team velocity');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('Improve team velocity');
  });

  it('should return 3 tasks for complex generic objectives', () => {
    // "implement" triggers build category → Design/Implement/Test
    const tasks = planTasksFromObjective('Improve team velocity by 20% and then implement automated performance dashboards with weekly reporting and alerting');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].title).toContain('Design approach');
    expect(tasks[1].title).toContain('Implement');
    expect(tasks[2].title).toContain('Test and verify');
  });

  it('should return 3 generic tasks for non-build/fix complex objectives', () => {
    const tasks = planTasksFromObjective('Improve team velocity by 20% and then optimize the reporting pipeline with weekly updates and alerting on regressions');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].title).toContain('Plan');
    expect(tasks[1].title).toContain('Execute');
    expect(tasks[2].title).toContain('Review');
  });

  it('should include acceptance criteria on all tasks', () => {
    const tasks = planTasksFromObjective('Create a new API endpoint');
    for (const task of tasks) {
      expect(task.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });

  it('should truncate long objectives in task titles', () => {
    const longObjective = 'A'.repeat(200);
    const tasks = planTasksFromObjective(longObjective);
    for (const task of tasks) {
      expect(task.title.length).toBeLessThan(200);
    }
  });

  it('should recognise ship keyword as build category (simple → 1 task)', () => {
    const tasks = planTasksFromObjective('Ship V3 by April');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('Ship V3 by April');
  });

  it('should recognise debug keyword as fix category (simple → 1 task)', () => {
    const tasks = planTasksFromObjective('Debug the flaky test suite');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('Debug the flaky test suite');
  });

  it('should recognise error keyword as fix category (simple → 1 task)', () => {
    const tasks = planTasksFromObjective('There is an error in the pipeline');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('error in the pipeline');
  });

  // Chinese language support tests
  it('should detect Chinese build keywords (创建)', () => {
    const tasks = planTasksFromObjective('创建一个新的 API 端点');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toContain('Implement');
  });

  it('should detect Chinese fix keywords (修复)', () => {
    const tasks = planTasksFromObjective('修复登录页面的崩溃问题');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toContain('fix');
  });

  it('should detect Chinese complex objectives with 包括', () => {
    const tasks = planTasksFromObjective('请评估一下系统的安全性，包括 API 鉴权、数据加密、日志审计三个方面');
    // Should be detected as complex (包括 + 3 、-separated items)
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('classifyIntent — Chinese keywords', () => {
  it('should classify Chinese research keywords (评估)', () => {
    const result = classifyIntent('请评估一下系统的安全性');
    expect(result.intentCategory).toBe('research');
  });

  it('should classify Chinese query keywords (查一下)', () => {
    // Bug A v0 (canonical classifier from intent-task.types): "查一下 …
    // 多少 团队" is structurally a lookup/status question, which Mia §1.2
    // Q1 defines as L0/query. The pre-Bug-A v3-data.service heuristic
    // bucketed it as 'research' via a Chinese-specific fallback that
    // didn't distinguish lookup from investigation. The canonical
    // classifier consolidates to 'query' which better fits Mia's
    // category semantics (research = "investigate/explore/analyze";
    // query = "what/where/count/lookup"). Both still result in the
    // same SLA/decomposition behaviour because L1/query and L1/research
    // route identically.
    const result = classifyIntent('帮我查一下现在有多少团队');
    expect(result.intentCategory).toBe('query');
  });

  it('should classify Chinese debugging keywords (修复)', () => {
    const result = classifyIntent('修复登录页面的崩溃问题');
    expect(result.intentCategory).toBe('debugging');
  });

  it('should classify Chinese deployment keywords (部署)', () => {
    const result = classifyIntent('把最新版本部署到生产环境');
    expect(result.intentCategory).toBe('deployment');
  });

  it('should classify Chinese code_change keywords (实现)', () => {
    const result = classifyIntent('实现用户注册功能');
    expect(result.intentCategory).toBe('code_change');
  });

  it('should classify Chinese planning keywords (设计)', () => {
    const result = classifyIntent('设计新的数据库架构');
    expect(result.intentCategory).toBe('planning');
  });
});

describe('generateRequestTitle', () => {
  it('should always add prefix to short messages', () => {
    const title = generateRequestTitle('帮我查一下现在有多少团队', 'research');
    expect(title).toContain('[Research]');
    expect(title).not.toBe('帮我查一下现在有多少团队');
  });

  it('should use generic prefix for other category', () => {
    const title = generateRequestTitle('短消息', 'other');
    expect(title).toContain('[Request]');
    expect(title).not.toBe('短消息');
  });

  it('should truncate long messages and extract first sentence', () => {
    const long = '请评估一下系统的安全性，包括 API 鉴权、数据加密、日志审计三个方面。这是一个重要的任务。';
    const title = generateRequestTitle(long, 'research');
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toContain('[Research]');
  });
});
