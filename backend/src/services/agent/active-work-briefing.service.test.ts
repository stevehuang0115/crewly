/**
 * Unit tests for ActiveWorkBriefingService
 *
 * Covers the 9 unit scenarios defined in design Q8 / GitHub issue #395:
 *   1. 0 open work → empty briefing, "(No active work — fresh start)"
 *   2. N=3 active WIs → all 3 shown, sorted by priority then age
 *   3. N=20 exceeds cap (15) → truncated + marker, `truncated: true`
 *   4. WI claimed by ANOTHER agent → excluded for the original target
 *   5. Recently-resolved 25min ago → included
 *   6. Recently-resolved 35min ago → excluded
 *   7. Memory says done, state says open → annotation in formatted output
 *   8. TaskPoolService throws → service rejects, caller catches
 *   9. Orchestrator role → caps × 3, system-wide query (no target filter)
 *
 * @module services/agent/active-work-briefing.service.test
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
import type { MemoryHints } from './active-work-briefing.service.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Minimal Request factory — fills in defaults so individual tests only need
 * to override the fields under test.
 */
function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'req-default',
    sourceConversationItemId: 'conv-1',
    title: 'A request',
    description: 'desc',
    status: 'open',
    priority: 'normal',
    requiresConfirmation: false,
    workItemIds: [],
    intentLevel: 'L1',
    intentCategory: 'other',
    tags: [],
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h old
    updatedAt: new Date().toISOString(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    ...overrides,
  };
}

/**
 * Minimal WorkItem factory — fills in defaults so individual tests only need
 * to override the fields under test.
 */
function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-default',
    type: 'delegate',
    owner: 'orchestrator',
    title: 'A work item',
    status: 'queued' as WorkItemStatus,
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
 * Build a service instance backed by inline arrays. Tests construct fresh
 * services to avoid singleton bleed between cases.
 *
 * @param requests - Requests returned by the fake `listAll`
 * @param items - WorkItems returned by the fake `getAllItems`
 * @param overrides - Per-fake error injection
 * @returns A configured ActiveWorkBriefingService
 */
function makeService(
  requests: Request[] = [],
  items: WorkItem[] = [],
  overrides: { taskPoolThrows?: Error; requestThrows?: Error } = {},
): ActiveWorkBriefingService {
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
  return ActiveWorkBriefingService.createForTest(requestServiceFactory, taskPoolFactory);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActiveWorkBriefingService', () => {
  beforeEach(() => {
    ActiveWorkBriefingService.resetInstance();
  });

  describe('getInstance / resetInstance', () => {
    it('returns the same instance on repeated calls', () => {
      const a = ActiveWorkBriefingService.getInstance();
      const b = ActiveWorkBriefingService.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance clears the singleton', () => {
      const a = ActiveWorkBriefingService.getInstance();
      ActiveWorkBriefingService.resetInstance();
      const b = ActiveWorkBriefingService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // ===== Scenario 1: zero work =====
  describe('scenario 1 — empty briefing', () => {
    it('returns zero rows when nothing is active', async () => {
      const service = makeService([], []);
      const briefing = await service.generateActiveWorkBriefing('dev-1', 'developer');
      expect(briefing.openRequests).toHaveLength(0);
      expect(briefing.activeWorkItems).toHaveLength(0);
      expect(briefing.pendingReviews).toHaveLength(0);
      expect(briefing.outboundDelegations).toHaveLength(0);
      expect(briefing.recentlyAutoResolved).toHaveLength(0);
      expect(briefing.truncated).toBe(false);
    });

    it('format produces fresh-start message when briefing is empty', async () => {
      const service = makeService([], []);
      const briefing = await service.generateActiveWorkBriefing('dev-1', 'developer');
      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('## Your Active Work');
      expect(md).toContain('(No active work — fresh start)');
    });
  });

  // ===== Scenario 2: N=3 active WIs sorted =====
  describe('scenario 2 — N=3 active WorkItems sorted by priority then age', () => {
    it('lists all three rows, high priority first', async () => {
      const sessionName = 'dev-1';
      const now = Date.now();
      const items = [
        makeWorkItem({
          id: 'wi-low-old',
          target: sessionName,
          createdAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
          metadata: { priority: 'low' },
          status: 'running',
        }),
        makeWorkItem({
          id: 'wi-high-new',
          target: sessionName,
          createdAt: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
          metadata: { priority: 'high' },
          status: 'running',
        }),
        makeWorkItem({
          id: 'wi-normal-mid',
          target: sessionName,
          createdAt: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
          metadata: { priority: 'normal' },
          status: 'running',
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer', {
        nowMs: now,
      });
      expect(briefing.activeWorkItems.map((wi) => wi.id)).toEqual([
        'wi-high-new',
        'wi-normal-mid',
        'wi-low-old',
      ]);
      expect(briefing.activeWorkItems.every((wi) => wi.title === 'A work item')).toBe(true);
      expect(briefing.truncated).toBe(false);
    });
  });

  // ===== Scenario 3: N=20 exceeds cap =====
  describe('scenario 3 — N=20 exceeds cap (15) → truncated', () => {
    it('keeps top 15 with truncation marker', async () => {
      const sessionName = 'dev-1';
      const now = Date.now();
      const items: WorkItem[] = [];
      for (let i = 0; i < 20; i += 1) {
        items.push(
          makeWorkItem({
            id: `wi-${i}`,
            target: sessionName,
            createdAt: new Date(now - (20 - i) * 60 * 60 * 1000).toISOString(),
            metadata: { priority: 'normal' },
            status: 'running',
          }),
        );
      }
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer', {
        nowMs: now,
      });
      expect(briefing.activeWorkItems).toHaveLength(15);
      expect(briefing.truncation.activeWorkItems.totalCandidates).toBe(20);
      expect(briefing.truncation.activeWorkItems.cap).toBe(15);
      expect(briefing.truncation.activeWorkItems.truncated).toBe(true);
      expect(briefing.truncated).toBe(true);

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('… and 5 more');
      expect(md).toContain('get-my-active-work');
    });
  });

  // ===== Scenario 4: target=me, claimedBy=other → excluded =====
  describe('scenario 4 — WorkItem targeted at me but claimed by another agent → excluded', () => {
    it('does not surface a WI claimed by a different agent', async () => {
      const sessionName = 'dev-1';
      const items = [
        makeWorkItem({
          id: 'wi-stolen',
          target: sessionName,
          metadata: { claimedBy: 'dev-other', priority: 'normal' },
          status: 'running',
        }),
        makeWorkItem({
          id: 'wi-mine',
          target: sessionName,
          metadata: { priority: 'normal' },
          status: 'running',
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer');
      expect(briefing.activeWorkItems.map((wi) => wi.id)).toEqual(['wi-mine']);
    });

    it('still surfaces a WI explicitly claimed by me even if target is unset', async () => {
      const sessionName = 'dev-1';
      const items = [
        makeWorkItem({
          id: 'wi-claimed-by-me',
          target: undefined,
          metadata: { claimedBy: sessionName, priority: 'normal' },
          status: 'running',
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer');
      expect(briefing.activeWorkItems.map((wi) => wi.id)).toEqual(['wi-claimed-by-me']);
    });
  });

  // ===== Scenarios 5 & 6: recently-resolved window in/out =====
  describe('scenarios 5 & 6 — recently-resolved window 30min', () => {
    it('includes a WI resolved 25 minutes ago', async () => {
      const sessionName = 'dev-1';
      const now = Date.now();
      const items = [
        makeWorkItem({
          id: 'wi-recent',
          target: sessionName,
          status: 'verified',
          metadata: {
            slaResolvedAt: new Date(now - 25 * 60 * 1000).toISOString(),
            slaResolvedReason: 'sla_close_run',
          },
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer', {
        nowMs: now,
      });
      expect(briefing.recentlyAutoResolved.map((r) => r.id)).toEqual(['wi-recent']);
    });

    it('excludes a WI resolved 35 minutes ago', async () => {
      const sessionName = 'dev-1';
      const now = Date.now();
      const items = [
        makeWorkItem({
          id: 'wi-stale',
          target: sessionName,
          status: 'verified',
          metadata: {
            slaResolvedAt: new Date(now - 35 * 60 * 1000).toISOString(),
            slaResolvedReason: 'escalation_timeout',
          },
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer', {
        nowMs: now,
      });
      expect(briefing.recentlyAutoResolved).toHaveLength(0);
    });

    it('honors a custom recentlyResolvedWindowMs override', async () => {
      const sessionName = 'dev-1';
      const now = Date.now();
      const items = [
        makeWorkItem({
          id: 'wi-edge',
          target: sessionName,
          status: 'verified',
          metadata: {
            slaResolvedAt: new Date(now - 35 * 60 * 1000).toISOString(),
            slaResolvedReason: 'sla_close_run',
          },
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer', {
        nowMs: now,
        recentlyResolvedWindowMs: 60 * 60 * 1000, // 1h
      });
      expect(briefing.recentlyAutoResolved).toHaveLength(1);
    });
  });

  // ===== Scenario 7: memory contradiction surfaced inline =====
  describe('scenario 7 — memory contradicts state → annotation appears', () => {
    it('appends "(memory: marked done — verify)" to a row', async () => {
      const sessionName = 'dev-1';
      const items = [
        makeWorkItem({
          id: 'wi-disputed',
          target: sessionName,
          status: 'running',
          metadata: { priority: 'normal' },
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer');

      const hints: MemoryHints = new Map([['wi:wi-disputed', 'marked done — verify']]);
      const md = service.formatBriefingAsMarkdown(briefing, hints);
      expect(md).toContain('wi-disputed');
      expect(md).toContain('*(memory: marked done — verify)*');
    });

    it('omits the annotation if no hint is provided', async () => {
      const sessionName = 'dev-1';
      const items = [
        makeWorkItem({
          id: 'wi-clean',
          target: sessionName,
          status: 'running',
          metadata: { priority: 'normal' },
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer');
      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).not.toContain('*(memory:');
    });
  });

  // ===== Scenario 8: TaskPool throws → service rejects =====
  describe('scenario 8 — TaskPoolService throws → service rejects', () => {
    it('rethrows the underlying error so the call site can soft-fail', async () => {
      const service = makeService([], [], { taskPoolThrows: new Error('pool storage hiccup') });
      await expect(
        service.generateActiveWorkBriefing('dev-1', 'developer'),
      ).rejects.toThrow('pool storage hiccup');
    });

    it('rethrows when RequestService.listAll throws', async () => {
      const service = makeService([], [], { requestThrows: new Error('disk read failed') });
      await expect(
        service.generateActiveWorkBriefing('dev-1', 'developer'),
      ).rejects.toThrow('disk read failed');
    });
  });

  // ===== Scenario 9: orchestrator caps × 3, system-wide =====
  describe('scenario 9 — orchestrator role', () => {
    it('triples the active-WorkItem cap (15 → 45)', async () => {
      const items: WorkItem[] = [];
      const now = Date.now();
      // Build 50 WIs targeting OTHER agents — orchestrator should still see them.
      for (let i = 0; i < 50; i += 1) {
        items.push(
          makeWorkItem({
            id: `wi-${i}`,
            target: `dev-${i}`,
            createdAt: new Date(now - (50 - i) * 60 * 1000).toISOString(),
            metadata: { priority: 'normal' },
            status: 'running',
          }),
        );
      }
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing('crewly-orc', 'orchestrator', {
        nowMs: now,
      });
      expect(briefing.activeWorkItems).toHaveLength(45);
      expect(briefing.truncation.activeWorkItems.cap).toBe(45);
    });

    it('queries system-wide (no target=me filter)', async () => {
      const items = [
        makeWorkItem({ id: 'wi-a', target: 'dev-1', status: 'running' }),
        makeWorkItem({ id: 'wi-b', target: 'dev-2', status: 'running' }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing('crewly-orc', 'orchestrator');
      expect(briefing.activeWorkItems.map((wi) => wi.id).sort()).toEqual(['wi-a', 'wi-b']);
    });

    it('triples the open-Request cap (10 → 30) and surfaces every status-active Request', async () => {
      const requests: Request[] = [];
      for (let i = 0; i < 35; i += 1) {
        requests.push(
          makeRequest({
            id: `req-${i}`,
            // Even orchestrator filters out terminal statuses.
            status: 'open',
            ownerAgent: `dev-${i}`,
            priority: 'normal',
          }),
        );
      }
      const service = makeService(requests, []);
      const briefing = await service.generateActiveWorkBriefing(
        'crewly-orc',
        'orchestrator',
      );
      expect(briefing.openRequests).toHaveLength(30);
      expect(briefing.truncation.openRequests.cap).toBe(30);
    });
  });

  // ===== Bonus: open-request filter for non-orchestrator =====
  describe('open-request filter for non-orchestrator agents', () => {
    it('only surfaces Requests where ownerAgent === sessionName', async () => {
      const requests = [
        makeRequest({ id: 'req-mine', ownerAgent: 'dev-1', status: 'running' }),
        makeRequest({ id: 'req-theirs', ownerAgent: 'dev-2', status: 'running' }),
      ];
      const service = makeService(requests, []);
      const briefing = await service.generateActiveWorkBriefing('dev-1', 'developer');
      expect(briefing.openRequests.map((r) => r.id)).toEqual(['req-mine']);
    });

    it('skips terminal Requests (done, cancelled)', async () => {
      const requests = [
        makeRequest({ id: 'req-done', ownerAgent: 'dev-1', status: 'done' }),
        makeRequest({ id: 'req-cancelled', ownerAgent: 'dev-1', status: 'cancelled' }),
        makeRequest({ id: 'req-running', ownerAgent: 'dev-1', status: 'running' }),
      ];
      const service = makeService(requests, []);
      const briefing = await service.generateActiveWorkBriefing('dev-1', 'developer');
      expect(briefing.openRequests.map((r) => r.id)).toEqual(['req-running']);
    });
  });

  // ===== Bonus: pending reviews, outbound delegations =====
  describe('pending reviews — verifier-routed', () => {
    it('surfaces done_by_worker WIs where metadata.verifier === me', async () => {
      const items = [
        makeWorkItem({
          id: 'wi-review-mine',
          status: 'done_by_worker',
          metadata: { verifier: 'tl-1', claimedBy: 'dev-x' },
        }),
        makeWorkItem({
          id: 'wi-review-theirs',
          status: 'done_by_worker',
          metadata: { verifier: 'tl-other' },
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing('tl-1', 'team_lead');
      expect(briefing.pendingReviews.map((r) => r.id)).toEqual(['wi-review-mine']);
      expect(briefing.pendingReviews[0].claimedBy).toBe('dev-x');
    });
  });

  describe('outbound delegations — delegatedBy filter', () => {
    it('surfaces in-flight WIs delegated by me', async () => {
      const items = [
        makeWorkItem({
          id: 'wi-mine',
          target: 'dev-target',
          status: 'running',
          metadata: { delegatedBy: 'tl-1' },
        }),
        makeWorkItem({
          id: 'wi-theirs',
          target: 'dev-target',
          status: 'running',
          metadata: { delegatedBy: 'tl-other' },
        }),
        // Terminal status — even with my delegatedBy, should be excluded.
        makeWorkItem({
          id: 'wi-done',
          target: 'dev-target',
          status: 'done',
          metadata: { delegatedBy: 'tl-1' },
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing('tl-1', 'team_lead');
      expect(briefing.outboundDelegations.map((r) => r.id)).toEqual(['wi-mine']);
    });

    it('returns empty when metadata.delegatedBy is unpopulated (forward-compat)', async () => {
      const items = [
        makeWorkItem({
          id: 'wi-no-meta',
          target: 'dev-target',
          status: 'running',
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing('tl-1', 'team_lead');
      expect(briefing.outboundDelegations).toHaveLength(0);
    });
  });

  // ===== formatBriefingAsMarkdown — structural =====
  describe('formatBriefingAsMarkdown structural assertions', () => {
    it('emits the expected section headings only when the section has rows', async () => {
      const sessionName = 'dev-1';
      const items = [
        makeWorkItem({ id: 'wi-1', target: sessionName, status: 'running' }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer');
      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('### Active WorkItems');
      expect(md).not.toContain('### Open Requests');
      expect(md).not.toContain('### Pending Reviews');
      expect(md).not.toContain('### Outbound Delegations');
      expect(md).not.toContain('### Recently Auto-Resolved');
    });

    it('emits a description bullet under a WI when description exists', async () => {
      const sessionName = 'dev-1';
      const items = [
        makeWorkItem({
          id: 'wi-1',
          target: sessionName,
          status: 'running',
          description: 'Do the thing',
        }),
      ];
      const service = makeService([], items);
      const briefing = await service.generateActiveWorkBriefing(sessionName, 'developer');
      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('  - Do the thing');
    });
  });

  // ---------------------------------------------------------------------------
  // ESM require bridge — local regression guard (F-NEW-1, auditor cycle 1)
  // ---------------------------------------------------------------------------
  //
  // The lazy load inside `getInstance()` was originally written as bare
  // `require('../v3/request.service.js')`, which crashes under ESM (production)
  // with `require is not defined`. The skill `get-my-active-work` and
  // `AgentRegistrationService.activeWorkBriefing` both flow through that
  // factory at session startup, so EVERY session was hitting the error
  // (auditor cycle 1 reported 25 occurrences in a single day).
  //
  // The fix replaces bare `require(` with `nodeRequire(` (a CJS↔ESM bridge
  // anchored to `pathToFileURL(process.argv[1])`). This guard scans the
  // service source directly so a future contributor cannot silently revert
  // the bridge or add a fresh bare `require(` in the same file.
  //
  // Static-only because under ts-jest's CJS transpile `typeof require ===
  // 'function'` is true, so the runtime path picks the global `require`
  // and never hits the createRequire branch — the runtime bug is invisible
  // here. Source-scanning is the correct shape.
  describe('ESM require bridge regression (F-NEW-1)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');

    const SERVICE_PATH = path.resolve(__dirname, 'active-work-briefing.service.ts');

    /**
     * Strip line and block comments so historical references inside JSDoc
     * (e.g. "originally `require()`'d" wording in the file's own docblock)
     * do not false-positive against the regex below.
     */
    const stripComments = (s: string): string =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');

    it('source contains no bare `require(` calls outside of comments', () => {
      const code = stripComments(fs.readFileSync(SERVICE_PATH, 'utf8'));
      // Match `require(` or `require ` followed by `(` — but NOT `nodeRequire(`,
      // `createRequire(`, or property-style `.require(`. Word-boundary lookbehind
      // anchors the bare global form.
      const BARE_REQUIRE = /(?<![A-Za-z0-9_$.])require\s*\(/g;
      const matches = code.match(BARE_REQUIRE) ?? [];
      expect(matches).toEqual([]);
    });

    it('source uses the canonical `nodeRequire` bridge', () => {
      const code = stripComments(fs.readFileSync(SERVICE_PATH, 'utf8'));
      // The lazy loads inside getInstance() must go through `nodeRequire`.
      expect(code).toMatch(/nodeRequire\s*\(\s*['"]\.\.\/v3\/request\.service\.js['"]\s*\)/);
      expect(code).toMatch(
        /nodeRequire\s*\(\s*['"]\.\.\/task-pool\/task-pool\.service\.js['"]\s*\)/,
      );
      // And the bridge itself must be defined the canonical way (anchored
      // to process.argv[1] via pathToFileURL — see commit 070cd3e5).
      expect(code).toMatch(
        /createRequire\s*\(\s*pathToFileURL\s*\(\s*process\.argv\[1\]/,
      );
    });
  });
});
