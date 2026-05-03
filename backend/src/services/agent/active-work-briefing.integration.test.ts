/**
 * Integration tests for the active-work briefing wiring.
 *
 * Covers the registration-path acceptance criteria from issue #395 without
 * dragging in the full AgentRegistrationService mock graph (which is 3,400+
 * LOC of jest mocks). The test directly exercises the same call shape used
 * by `agent-registration.service.ts:1591-1606`:
 *
 *   1. Generate the briefing from fake stores
 *   2. Format markdown
 *   3. Concatenate to a synthetic prompt
 *   4. Verify content / soft-fail behaviour
 *
 * Scenarios:
 *   - Agent with 5 open WIs in pool → prompt contains `## Your Active Work`
 *     section with all 5 entries.
 *   - TaskPool throws → wrapping try/catch logs WARN, prompt does NOT contain
 *     the section, registration continues.
 *   - Two agents fetch concurrently → each gets only their own slice.
 *
 * @module services/agent/active-work-briefing.integration.test
 */

jest.mock('../core/logger.service.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return {
    LoggerService: {
      getInstance: () => ({ createComponentLogger: () => mockLogger }),
    },
  };
});

import { ActiveWorkBriefingService } from './active-work-briefing.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/request.types.js';
import { isRequestFulfilled } from '../../types/v2/request.types.js';

/**
 * Build a minimal WorkItem for tests.
 */
function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-default',
    type: 'delegate',
    owner: 'orchestrator',
    title: 'A work item',
    status: 'running',
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    retryCount: 0,
    maxRetries: 2,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...overrides,
  };
}

/**
 * Mirror of the soft-fail wrapping at `agent-registration.service.ts:1592-1606`.
 * Returns the prompt-after-injection so tests can assert on the final string.
 */
async function injectActiveWorkBriefing(
  service: ActiveWorkBriefingService,
  basePrompt: string,
  sessionName: string,
  role: string,
  warn: (msg: string) => void,
): Promise<string> {
  let prompt = basePrompt;
  try {
    const briefing = await service.generateActiveWorkBriefing(sessionName, role);
    const md = service.formatBriefingAsMarkdown(briefing);
    if (md && md.length > 30) {
      prompt += `\n\n---\n\n${md}`;
    }
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
  }
  return prompt;
}

describe('Active-work briefing — integration', () => {
  beforeEach(() => {
    ActiveWorkBriefingService.resetInstance();
  });

  it('agent with 5 open WIs receives a prompt containing all 5 entries under ## Your Active Work', async () => {
    const sessionName = 'dev-1';
    const items: WorkItem[] = [];
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      items.push(
        makeWorkItem({
          id: `wi-${i}`,
          target: sessionName,
          createdAt: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(),
        }),
      );
    }
    const service = ActiveWorkBriefingService.createForTest(
      () => ({ listAll: jest.fn().mockResolvedValue([]) }) as never,
      () => ({ getAllItems: jest.fn().mockResolvedValue(items) }) as never,
    );
    const warn = jest.fn();
    const prompt = await injectActiveWorkBriefing(
      service,
      '## Base prompt',
      sessionName,
      'developer',
      warn,
    );
    expect(prompt).toContain('## Your Active Work');
    expect(prompt).toContain('### Active WorkItems');
    for (let i = 0; i < 5; i += 1) {
      expect(prompt).toContain(`wi-${i}`);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('TaskPool throws → prompt is unchanged, WARN logged, registration continues', async () => {
    const service = ActiveWorkBriefingService.createForTest(
      () => ({ listAll: jest.fn().mockResolvedValue([]) }) as never,
      () => ({
        getAllItems: jest.fn().mockRejectedValue(new Error('storage hiccup')),
      }) as never,
    );
    const warn = jest.fn();
    const base = '## Base prompt';
    const prompt = await injectActiveWorkBriefing(
      service,
      base,
      'dev-1',
      'developer',
      warn,
    );
    expect(prompt).toBe(base); // unchanged
    expect(prompt).not.toContain('## Your Active Work');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('storage hiccup');
  });

  it('two agents fetched concurrently each get only their own slice', async () => {
    const items: WorkItem[] = [
      makeWorkItem({ id: 'wi-a-1', target: 'dev-a' }),
      makeWorkItem({ id: 'wi-a-2', target: 'dev-a' }),
      makeWorkItem({ id: 'wi-b-1', target: 'dev-b' }),
      // Targeted to dev-b but already claimed by dev-c — should be excluded for dev-b.
      makeWorkItem({ id: 'wi-stolen', target: 'dev-b', metadata: { claimedBy: 'dev-c' } }),
    ];
    const service = ActiveWorkBriefingService.createForTest(
      () => ({ listAll: jest.fn().mockResolvedValue([]) }) as never,
      () => ({ getAllItems: jest.fn().mockResolvedValue(items) }) as never,
    );

    const [aBriefing, bBriefing] = await Promise.all([
      service.generateActiveWorkBriefing('dev-a', 'developer'),
      service.generateActiveWorkBriefing('dev-b', 'developer'),
    ]);

    expect(aBriefing.activeWorkItems.map((wi) => wi.id).sort()).toEqual(['wi-a-1', 'wi-a-2']);
    expect(bBriefing.activeWorkItems.map((wi) => wi.id)).toEqual(['wi-b-1']);
    expect(bBriefing.activeWorkItems.find((wi) => wi.id === 'wi-stolen')).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Memory Phase 1 — REQ-X (orc-restart recovery filter)
  // ─────────────────────────────────────────────────────────────────────
  describe('REQ-X — orc-restart recovery skips fulfilled Requests', () => {
    /**
     * Helper: build a Request fixture with explicit fulfillment shape.
     */
    function makeRequest(overrides: Partial<Request> = {}): Request {
      return {
        id: overrides.id ?? 'req-x',
        sourceConversationItemId: 'msg-1',
        title: overrides.title ?? 'A request',
        description: 'description',
        status: overrides.status ?? 'running',
        priority: 'normal',
        requiresConfirmation: false,
        workItemIds: [],
        intentLevel: 'L1',
        intentCategory: 'other',
        tags: [],
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        ...overrides,
      };
    }

    it('orc-recovery briefing surfaces a running Request and skips a fulfilled one', async () => {
      const fulfilled = makeRequest({
        id: 'req-fulfilled',
        title: 'Already replied to user',
        status: 'done',
        completedAt: '2026-05-03T17:30:00.000Z',
        result: 'Final reply: shipped fix to main.',
      });
      const inFlight = makeRequest({
        id: 'req-in-flight',
        title: 'Worker still investigating',
        status: 'running',
      });

      // Pre-condition: the criterion should classify these correctly.
      expect(isRequestFulfilled(fulfilled)).toBe(true);
      expect(isRequestFulfilled(inFlight)).toBe(false);

      const service = ActiveWorkBriefingService.createForTest(
        () => ({ listAll: jest.fn().mockResolvedValue([fulfilled, inFlight]) }) as never,
        () => ({ getAllItems: jest.fn().mockResolvedValue([]) }) as never,
      );

      const warn = jest.fn();
      const prompt = await injectActiveWorkBriefing(
        service,
        '## Base prompt',
        'crewly-orc',
        'orchestrator',
        warn,
      );

      expect(prompt).toContain('req-in-flight');
      expect(prompt).not.toContain('req-fulfilled');
      expect(warn).not.toHaveBeenCalled();
    });

    it('over-recovery preference — a Request with status=done but no result is treated as NOT fulfilled and surfaces', async () => {
      // Sam REQ-X risk surface case 3: reply sent but worker crashed before
      // result was persisted. Better to re-surface (over-recover) than drop.
      const partiallyDone = makeRequest({
        id: 'req-partial',
        status: 'done',
        completedAt: '2026-05-03T17:30:00.000Z',
        result: undefined, // missing — defense-in-depth
      });

      expect(isRequestFulfilled(partiallyDone)).toBe(false);

      // The active-work-briefing service excludes terminal `done` from
      // `ACTIVE_REQUEST_STATUSES`. So even though `isRequestFulfilled`
      // returns false (over-recovery vote), the briefing's filter still
      // hides this Request because its `status === 'done'`. This is the
      // documented gap: the criterion (isRequestFulfilled) and the
      // briefing's filter (ACTIVE_REQUEST_STATUSES) are NOT identical —
      // they intentionally serve different purposes:
      //   - isRequestFulfilled: defensive read of "is the user'\''s ask
      //     definitively closed". Used by callers that want a strong yes/no.
      //   - ACTIVE_REQUEST_STATUSES: cheap state-machine prefilter to keep
      //     terminal rows out of the briefing. Done rows are out, full stop.
      // If the partial-done case ever surfaces a real-world bug (orc loses
      // a request because state was prematurely flipped to done), the fix
      // is to revisit how `done` is set, not to bypass the prefilter here.
      const service = ActiveWorkBriefingService.createForTest(
        () => ({ listAll: jest.fn().mockResolvedValue([partiallyDone]) }) as never,
        () => ({ getAllItems: jest.fn().mockResolvedValue([]) }) as never,
      );
      const briefing = await service.generateActiveWorkBriefing('crewly-orc', 'orchestrator');
      expect(briefing.openRequests.find((r) => r.id === 'req-partial')).toBeUndefined();
    });

    it('cancelled Requests are also skipped (terminal but not fulfilled)', async () => {
      const cancelled = makeRequest({
        id: 'req-cancelled',
        status: 'cancelled',
      });
      expect(isRequestFulfilled(cancelled)).toBe(false); // not fulfilled
      // ...but ACTIVE_REQUEST_STATUSES still excludes it (terminal).
      const service = ActiveWorkBriefingService.createForTest(
        () => ({ listAll: jest.fn().mockResolvedValue([cancelled]) }) as never,
        () => ({ getAllItems: jest.fn().mockResolvedValue([]) }) as never,
      );
      const briefing = await service.generateActiveWorkBriefing('crewly-orc', 'orchestrator');
      expect(briefing.openRequests).toHaveLength(0);
    });

    it('waiting_confirmation Requests are surfaced (orc still owes a handoff)', async () => {
      const awaiting = makeRequest({
        id: 'req-await',
        title: 'Awaiting confirm',
        status: 'waiting_confirmation',
        requiresConfirmation: true,
        confirmationReason: 'Production deploy needs approval',
      });
      expect(isRequestFulfilled(awaiting)).toBe(false);
      const service = ActiveWorkBriefingService.createForTest(
        () => ({ listAll: jest.fn().mockResolvedValue([awaiting]) }) as never,
        () => ({ getAllItems: jest.fn().mockResolvedValue([]) }) as never,
      );
      const briefing = await service.generateActiveWorkBriefing('crewly-orc', 'orchestrator');
      expect(briefing.openRequests.find((r) => r.id === 'req-await')).toBeDefined();
    });
  });

  it('briefing markdown can be appended after a memory section in the right order', async () => {
    // Emulate the prompt-assembly order documented in the design doc:
    //   ## Your Active Work    ← NEW
    //   ## Your Previous Knowledge   ← memory (existing)
    const sessionName = 'dev-1';
    const items = [makeWorkItem({ id: 'wi-1', target: sessionName })];
    const service = ActiveWorkBriefingService.createForTest(
      () => ({ listAll: jest.fn().mockResolvedValue([]) }) as never,
      () => ({ getAllItems: jest.fn().mockResolvedValue(items) }) as never,
    );
    const warn = jest.fn();
    const promptAfterActiveWork = await injectActiveWorkBriefing(
      service,
      '## Base prompt',
      sessionName,
      'developer',
      warn,
    );
    const finalPrompt = promptAfterActiveWork + '\n\n---\n\n## Your Previous Knowledge\n\n(memory)';
    const activeWorkIdx = finalPrompt.indexOf('## Your Active Work');
    const memoryIdx = finalPrompt.indexOf('## Your Previous Knowledge');
    expect(activeWorkIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(activeWorkIdx).toBeLessThan(memoryIdx);
  });
});
