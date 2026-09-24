/**
 * Tests for AgentAutoClaimService — automatic work assignment for idle agents.
 *
 * @module services/v3/agent-auto-claim.service.test
 */

// AgentAutoClaimService tests — auto-claim, recovery, wake via team API, Slack escalation
import { AgentAutoClaimService } from './agent-auto-claim.service.js';

// Axios is dynamically imported inside `recoverPendingTasks` (for the
// `/api/teams` lookup + member-start POST). The recovery test below
// asserts on calls to those endpoints, so we stub the default import.
const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...args: unknown[]) => mockAxiosGet(...args),
    post: (...args: unknown[]) => mockAxiosPost(...args),
  },
}));

// Escalation router is dynamically imported; stub it so the recovery
// test can assert routing decisions without hitting filesystem state.
const mockRecordOrphanedWorkItem = jest.fn().mockResolvedValue(null);
jest.mock('./escalation-router.service.js', () => ({
  EscalationRouterService: {
    getInstance: () => ({
      recordOrphanedWorkItem: mockRecordOrphanedWorkItem,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetAvailableItems = jest.fn().mockResolvedValue([]);
const mockClaimSpecificItem = jest.fn().mockResolvedValue(null);
const mockGetAllItems = jest.fn().mockResolvedValue([]);
const mockRetargetQueuedItem = jest.fn(async (id: string, target: string) => ({ id, target }));
const mockGetTeams = jest.fn().mockResolvedValue([]);
const mockTriggerGet = jest.fn();
const mockRetargetWorkItemAction = jest.fn().mockResolvedValue(true);

jest.mock('../core/storage.service.js', () => ({
  StorageService: { getInstance: () => ({ getTeams: mockGetTeams }) },
}));
jest.mock('./trigger-engine.service.js', () => ({
  TriggerEngine: { getInstance: () => ({ get: mockTriggerGet, retargetWorkItemAction: mockRetargetWorkItemAction }) },
}));

jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      getAvailableItems: mockGetAvailableItems,
      claimSpecificItem: mockClaimSpecificItem,
      orderClaimCandidates: async (_agent: string, items: unknown[]) => items,
      getAllItems: mockGetAllItems,
      retargetQueuedItem: mockRetargetQueuedItem,
    }),
  },
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

jest.mock('../reconciler/reconcile-rules.js', () => ({
  computeAgentScore: jest.fn().mockReturnValue({
    skillMatch: 25,
    urgency: 10,
    contextFamiliarity: 5,
    loadPenalty: 0,
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentAutoClaimService', () => {
  beforeEach(() => {
    AgentAutoClaimService.resetInstance();
    jest.clearAllMocks();
  });

  describe('singleton', () => {
    it('should return same instance', () => {
      const a = AgentAutoClaimService.getInstance();
      const b = AgentAutoClaimService.getInstance();
      expect(a).toBe(b);
    });

    it('should reset instance', () => {
      const a = AgentAutoClaimService.getInstance();
      AgentAutoClaimService.resetInstance();
      const b = AgentAutoClaimService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('tryAutoClaimForAgent', () => {
    it('should return null when no available items', async () => {
      const service = AgentAutoClaimService.getInstance();
      mockGetAvailableItems.mockResolvedValueOnce([]);

      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result).toBeNull();
    });

    it('should claim best-scoring item for agent', async () => {
      const service = AgentAutoClaimService.getInstance();

      const items = [
        { id: 'wi-1', title: 'Task 1', type: 'delegate', status: 'queued', target: 'agent-1', createdAt: new Date().toISOString() },
        { id: 'wi-2', title: 'Task 2', type: 'delegate', status: 'queued', target: 'agent-1', createdAt: new Date().toISOString() },
      ];
      mockGetAvailableItems.mockResolvedValueOnce(items);
      mockClaimSpecificItem.mockResolvedValueOnce({
        workItem: items[0],
        claim: { id: 'claim-1', agentId: 'agent-1' },
      });

      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result).not.toBeNull();
      expect(result?.workItemId).toBe('wi-1');
      expect(mockClaimSpecificItem).toHaveBeenCalledWith('agent-1', 'wi-1');
    });

    it('should handle race condition gracefully', async () => {
      const service = AgentAutoClaimService.getInstance();

      mockGetAvailableItems.mockResolvedValueOnce([
        { id: 'wi-1', title: 'Task 1', type: 'delegate', status: 'queued', createdAt: new Date().toISOString() },
      ]);
      // Claim fails — someone else got it
      mockClaimSpecificItem.mockResolvedValueOnce(null);

      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result).toBeNull();
    });

    it('tries the next candidate when the first is lost to a race, and skips items targeted at others', async () => {
      const service = AgentAutoClaimService.getInstance();
      const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      mockGetAvailableItems.mockResolvedValueOnce([
        { id: 'wi-other', title: 'For someone else', type: 'delegate', status: 'queued', target: 'agent-2', createdAt: old },
        { id: 'wi-a', title: 'Task A', type: 'delegate', status: 'queued', target: 'agent-1', createdAt: old },
        { id: 'wi-b', title: 'Task B', type: 'delegate', status: 'queued', target: 'agent-1', createdAt: old },
        { id: 'wi-free', title: 'Unassigned — for a decider, not for whoever is idle', type: 'delegate', status: 'queued', createdAt: old },
      ]);
      mockClaimSpecificItem.mockReset();
      mockClaimSpecificItem
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ workItem: { id: 'wi-b', target: 'agent-1' }, claim: { id: 'c' } });
      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result?.workItemId).toBe('wi-b');
      expect(mockClaimSpecificItem.mock.calls.map((c) => c[1])).toEqual(['wi-a', 'wi-b']);
    });

    // 2026-05-12 dogfood regression: AutoClaim happily claimed
    // `request:<rid>:respond_to_user` tracker WIs for crewly-orc, then
    // `WorkItemDispatchSubscriber.dispatchTo` short-circuited on the
    // SLA tracker pattern — WI stuck `running`, SLA breach in 5/10 min,
    // claim revoked, infinite re-claim loop. User saw "Request never
    // progresses." Filter these out at the source of `availableItems`.
    it('skips SLA tracker WIs (request:*:respond_to_user) — they are not dispatchable', async () => {
      const service = AgentAutoClaimService.getInstance();

      const trackerWI = {
        id: 'request:3e6b984f-80e8-4473-b6c9-a19a4c1240ba:respond_to_user',
        title: 'Respond to user: [Fix] ...',
        type: 'review',
        status: 'queued',
        target: 'crewly-orc',
        createdAt: new Date().toISOString(),
      };
      mockGetAvailableItems.mockResolvedValueOnce([trackerWI]);

      const result = await service.tryAutoClaimForAgent('crewly-orc');

      expect(result).toBeNull();
      expect(mockClaimSpecificItem).not.toHaveBeenCalled();
    });

    it('still claims a real delegate WI when an SLA tracker is also present', async () => {
      // Mixed pool: one tracker (skip), one real work item (claim).
      // Asserts the filter is targeted, not over-broad.
      const service = AgentAutoClaimService.getInstance();

      const tracker = {
        id: 'request:abc:respond_to_user',
        title: 'tracker',
        type: 'review',
        status: 'queued',
        target: 'crewly-orc',
        createdAt: new Date().toISOString(),
      };
      const real = {
        id: 'wi-real-1',
        title: 'Real task',
        type: 'delegate',
        status: 'queued',
        target: 'crewly-orc',
        createdAt: new Date().toISOString(),
      };
      mockGetAvailableItems.mockResolvedValueOnce([tracker, real]);
      mockClaimSpecificItem.mockResolvedValueOnce({
        workItem: real,
        claim: { id: 'claim-real', agentId: 'crewly-orc' },
      });

      const result = await service.tryAutoClaimForAgent('crewly-orc');

      expect(result?.workItemId).toBe('wi-real-1');
      expect(mockClaimSpecificItem).toHaveBeenCalledWith('crewly-orc', 'wi-real-1');
    });

    it('should skip items below score threshold', async () => {
      const service = AgentAutoClaimService.getInstance();

      const { computeAgentScore } = require('../reconciler/reconcile-rules.js');
      computeAgentScore.mockReturnValue({
        skillMatch: 5,
        urgency: 2,
        contextFamiliarity: 0,
        loadPenalty: 0,
      }); // Total = 7, below threshold of 15

      mockGetAvailableItems.mockResolvedValueOnce([
        { id: 'wi-1', title: 'Poor match', type: 'delegate', status: 'queued', createdAt: new Date().toISOString() },
      ]);

      const result = await service.tryAutoClaimForAgent('agent-1');
      expect(result).toBeNull();
      expect(mockClaimSpecificItem).not.toHaveBeenCalled();
    });
  });

  describe('recoverPendingTasks — orchestrator self-loop guard (PR-1.3)', () => {
    // Reproduces the 2026-05-27 22:29:06 / 23:22:28 incident: a WI
    // targeted at `crewly-orc` could not be woken via the team-member
    // start endpoint (returns 400 because the orc is not a regular
    // team member); the wake-failure path then escalated "to
    // Orchestrator", but the orc IS the orchestrator → self-loop.
    function orcTargetedWi(id: string, target = 'crewly-orc') {
      return {
        id,
        title: `Wiki migrate ${id}`,
        type: 'delegate',
        owner: 'orchestrator',
        target,
        status: 'queued' as const,
        retryCount: 0,
        maxRetries: 1,
        createdAt: new Date().toISOString(),
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
    }

    function teamsResponseWithoutOrc() {
      return { data: { data: [{ id: 't1', members: [{ id: 'm1', sessionName: 'alice' }] }] } };
    }

    beforeEach(() => {
      mockAxiosGet.mockReset();
      mockAxiosPost.mockReset();
      mockRecordOrphanedWorkItem.mockReset().mockResolvedValue(null);
      // Default teams response excludes orc — that's how the original
      // bug manifests (orc isn't a "member" of any team in the v3
      // teams.json shape, so the member-id lookup fails).
      mockAxiosGet.mockResolvedValue(teamsResponseWithoutOrc());
    });

    it('does NOT attempt the team-member start endpoint for the orchestrator session', async () => {
      const service = AgentAutoClaimService.getInstance();
      // Wire a health provider that flags ORC as inactive (the
      // condition that pushed the WI into the wake path).
      service.initialize({ on: jest.fn() } as never, async () => {
        const map = new Map();
        map.set('crewly-orc', { sessionName: 'crewly-orc', status: 'inactive' });
        return map;
      });

      const orcWi = orcTargetedWi('wi-orc-1');
      mockGetAvailableItems.mockResolvedValueOnce([orcWi]);

      await (service as unknown as { recoverPendingTasks: () => Promise<void> }).recoverPendingTasks();

      // No member-start POST for the orc — the orc has its own
      // supervisor-respawn lifecycle.
      const startCalls = mockAxiosPost.mock.calls.filter((c) =>
        String(c[0] ?? '').includes('/members/') && String(c[0] ?? '').endsWith('/start'),
      );
      expect(startCalls).toHaveLength(0);
    });

    it('names the scheduled work item when waking, so the dormant-team gate can exempt it', async () => {
      const service = AgentAutoClaimService.getInstance();
      service.initialize({ on: jest.fn() } as never, async () => {
        const map = new Map();
        map.set('alice', { sessionName: 'alice', status: 'inactive' });
        return map;
      });
      const wi = { ...orcTargetedWi('wi-cron-1'), target: 'alice', triggerId: 'trg-daily' };
      mockGetAvailableItems.mockResolvedValue([wi]);
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      await (service as unknown as { recoverPendingTasks: () => Promise<void> }).recoverPendingTasks();

      const start = mockAxiosPost.mock.calls.find((c) => String(c[0]).endsWith('/members/m1/start'));
      expect(start?.[1]).toEqual({ workItemId: 'wi-cron-1' });
      mockGetAvailableItems.mockResolvedValue([]);
    });

    it('does NOT escalate orc-targeted items even if they fall through to the orphan list', async () => {
      // Defense-in-depth: even if a future code path adds an
      // orc-targeted WI directly to `orphanedItems`, the final
      // escalation filter must drop it.
      const service = AgentAutoClaimService.getInstance();
      // Health map does NOT contain `crewly-orc` → falls into "agent
      // doesn't exist in any team" orphan path (line 430 pre-fix).
      service.initialize({ on: jest.fn() } as never, async () => new Map());

      const orcWi = orcTargetedWi('wi-orc-2');
      mockGetAvailableItems.mockResolvedValueOnce([orcWi]);

      await (service as unknown as { recoverPendingTasks: () => Promise<void> }).recoverPendingTasks();

      expect(mockRecordOrphanedWorkItem).not.toHaveBeenCalled();
    });

    it('still escalates orphaned NON-orc items normally', async () => {
      // Regression guard — the new filter must only drop orc items,
      // not silence the entire escalation flow.
      const service = AgentAutoClaimService.getInstance();
      service.initialize({ on: jest.fn() } as never, async () => new Map());

      const wi = orcTargetedWi('wi-alice-1', 'alice-the-dev');
      mockGetAvailableItems.mockResolvedValueOnce([wi]);
      // teams API doesn't list alice either → orphan path.
      mockAxiosGet.mockResolvedValue({ data: { data: [] } });

      await (service as unknown as { recoverPendingTasks: () => Promise<void> }).recoverPendingTasks();

      expect(mockRecordOrphanedWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wi-alice-1', target: 'alice-the-dev' }),
      );
    });
  });

  describe('start/stop', () => {
    it('should warn if started without initialization', () => {
      const service = AgentAutoClaimService.getInstance();
      // Should not throw
      service.start();
      service.stop();
    });

    it('should start and stop cleanly', () => {
      const service = AgentAutoClaimService.getInstance();
      const mockEventBus = { on: jest.fn() };
      service.initialize(mockEventBus);
      service.start();

      expect(mockEventBus.on).toHaveBeenCalledWith('event_published', expect.any(Function));

      service.stop();
    });
  });
});

describe('AgentAutoClaimService.healOrphans (2026-09-24 metrics trigger)', () => {
  const teams = [
    {
      id: 'mkt',
      name: 'Crewly Marketing',
      members: [
        { id: '45506487-1b63', name: 'Dana', sessionName: 'crewly-marketing-dana-45506487' },
        { id: 'e6a6b8ea-9a3f', name: 'Ella', sessionName: 'crewly-marketing-ella-e6a6b8ea', canDelegate: true, hierarchyLevel: 1 },
      ],
    },
  ];

  beforeEach(() => {
    mockGetTeams.mockResolvedValue(teams);
    mockRetargetQueuedItem.mockClear();
    mockRetargetWorkItemAction.mockClear();
    mockTriggerGet.mockReset();
  });

  it('re-points a renamed member\'s task at its current session and fixes the trigger', async () => {
    const placed = await AgentAutoClaimService.getInstance().healOrphans([
      { id: 'wi-1', target: 'crewly-marketing-self-watch-scribe-45506487', triggerId: 'trg-1' } as never,
    ]);
    expect(placed.get('wi-1')).toBe('crewly-marketing-dana-45506487');
    expect(mockRetargetQueuedItem).toHaveBeenCalledWith('wi-1', 'crewly-marketing-dana-45506487', 'renamed_member');
    expect(mockRetargetWorkItemAction).toHaveBeenCalledWith('trg-1', 'crewly-marketing-dana-45506487');
  });

  it('falls back to the lead of the trigger\'s team (without rewriting the trigger)', async () => {
    mockTriggerGet.mockReturnValue({ id: 'trg-2', teamId: 'mkt' });
    const placed = await AgentAutoClaimService.getInstance().healOrphans([
      { id: 'wi-2', target: 'someone-gone-deadbeef', triggerId: 'trg-2' } as never,
    ]);
    expect(placed.get('wi-2')).toBe('crewly-marketing-ella-e6a6b8ea');
    expect(mockRetargetWorkItemAction).not.toHaveBeenCalled();
  });

  it('leaves what it cannot place for the owner', async () => {
    const placed = await AgentAutoClaimService.getInstance().healOrphans([{ id: 'wi-3', target: 'nobody-deadbeef' } as never]);
    expect(placed.size).toBe(0);
    expect(mockRetargetQueuedItem).not.toHaveBeenCalled();
  });
});
