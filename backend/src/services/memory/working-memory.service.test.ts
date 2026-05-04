/**
 * Tests for `WorkingMemoryService` (Memory Phase 1 / Fix M2 — wake card).
 *
 * Two layers:
 *   1. Pure-helper tests — exercise the exported helpers
 *      (pickCurrentWorkItem, buildUpstreamChain, collectOpenLoops,
 *      summarizeWorkItem, renderWakeCard, enforceHardCap) directly,
 *      no IO.
 *   2. Service-level tests — drive `getWakeCardForAgent` end-to-end with
 *      the TaskPoolService.getInstance().getAllItems() result stubbed via
 *      jest.spyOn and the RequestService backed by a real `.crewly/`
 *      temp dir, so file-system reads exercise the production code path.
 *
 * @module services/memory/working-memory.service.test
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  WorkingMemoryService,
  WAKE_CARD_HARD_CAP_BYTES,
  pickCurrentWorkItem,
  buildUpstreamChain,
  collectOpenLoops,
  summarizeWorkItem,
  renderWakeCard,
  enforceHardCap,
} from './working-memory.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { RequestService } from '../v3/request.service.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { Request, RequestStatus } from '../../types/v2/request.types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid WorkItem for tests. Pass overrides for any field
 * a test cares about; the defaults satisfy the required-fields contract
 * of the `WorkItem` interface.
 */
function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: overrides.id ?? `wi-${Math.random().toString(36).slice(2, 10)}`,
    requestId: overrides.requestId,
    parentWorkItemId: overrides.parentWorkItemId,
    type: overrides.type ?? 'delegate',
    owner: overrides.owner ?? 'agent',
    target: overrides.target,
    title: overrides.title ?? 'Sample task',
    description: overrides.description,
    status: overrides.status ?? 'running',
    scheduledAt: overrides.scheduledAt,
    createdAt: overrides.createdAt ?? '2026-05-01T00:00:00Z',
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    result: overrides.result,
    error: overrides.error,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 3,
    triggerId: overrides.triggerId,
    projectTaskId: overrides.projectTaskId,
    missionId: overrides.missionId,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cost: overrides.cost ?? 0,
    metadata: overrides.metadata,
    dependsOn: overrides.dependsOn,
    ...overrides,
  };
}

/**
 * Build a minimal valid Request for tests. Mirrors `makeWorkItem` shape;
 * defaults satisfy the persistence contract used by `isRequest`.
 */
function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: overrides.id ?? `req-${Math.random().toString(36).slice(2, 10)}`,
    sourceConversationItemId: overrides.sourceConversationItemId ?? 'conv-1',
    title: overrides.title ?? 'Sample request',
    description: overrides.description ?? 'Long-form description',
    status: overrides.status ?? ('running' as RequestStatus),
    priority: overrides.priority ?? 'normal',
    requiresConfirmation: overrides.requiresConfirmation ?? false,
    confirmationReason: overrides.confirmationReason,
    workItemIds: overrides.workItemIds ?? [],
    missionId: overrides.missionId,
    projectTaskId: overrides.projectTaskId,
    intentLevel: overrides.intentLevel ?? 'L1',
    intentCategory: overrides.intentCategory ?? 'other',
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? '2026-05-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-05-01T00:00:00Z',
    completedAt: overrides.completedAt,
    result: overrides.result,
    totalInputTokens: overrides.totalInputTokens ?? 0,
    totalOutputTokens: overrides.totalOutputTokens ?? 0,
    totalCost: overrides.totalCost ?? 0,
    ownerAgent: overrides.ownerAgent,
    ...overrides,
  };
}

/** Create a temp project root with `.crewly/requests/` for a test. */
async function makeTempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-card-'));
  await fs.mkdir(path.join(root, '.crewly', 'requests'), { recursive: true });
  return root;
}

/** Persist a Request as `<id>.json` under `.crewly/requests/`. */
async function writeRequest(projectPath: string, req: Request): Promise<void> {
  await fs.writeFile(
    path.join(projectPath, '.crewly', 'requests', `${req.id}.json`),
    JSON.stringify(req, null, 2),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// pickCurrentWorkItem
// ---------------------------------------------------------------------------

describe('pickCurrentWorkItem', () => {
  it('returns null when sessionName is empty', () => {
    expect(pickCurrentWorkItem([makeWorkItem({ target: 'leo' })], '')).toBeNull();
  });

  it('returns null when no items match the target', () => {
    const items = [makeWorkItem({ target: 'sam', status: 'running' })];
    expect(pickCurrentWorkItem(items, 'leo')).toBeNull();
  });

  it('skips items in terminal statuses', () => {
    const terminal: WorkItemStatus[] = ['done', 'verified', 'cancelled', 'failed', 'rejected'];
    const items = terminal.map((status) =>
      makeWorkItem({ target: 'leo', status, title: status }),
    );
    expect(pickCurrentWorkItem(items, 'leo')).toBeNull();
  });

  it('skips queued / scheduled items (not yet started for this agent)', () => {
    const items: WorkItem[] = [
      makeWorkItem({ target: 'leo', status: 'queued' }),
      makeWorkItem({ target: 'leo', status: 'scheduled' }),
    ];
    expect(pickCurrentWorkItem(items, 'leo')).toBeNull();
  });

  it.each(['proposed', 'accepted', 'running', 'blocked', 'escalated'] as WorkItemStatus[])(
    'picks an item in active status `%s`',
    (status) => {
      const items = [makeWorkItem({ id: 'x', target: 'leo', status })];
      expect(pickCurrentWorkItem(items, 'leo')?.id).toBe('x');
    },
  );

  it('prefers the item with the greatest startedAt', () => {
    const items: WorkItem[] = [
      makeWorkItem({
        id: 'older',
        target: 'leo',
        status: 'running',
        startedAt: '2026-04-01T00:00:00Z',
      }),
      makeWorkItem({
        id: 'newer',
        target: 'leo',
        status: 'running',
        startedAt: '2026-05-01T00:00:00Z',
      }),
    ];
    expect(pickCurrentWorkItem(items, 'leo')?.id).toBe('newer');
  });

  it('falls back to createdAt when startedAt is missing', () => {
    const items: WorkItem[] = [
      makeWorkItem({
        id: 'older',
        target: 'leo',
        status: 'proposed',
        createdAt: '2026-04-01T00:00:00Z',
      }),
      makeWorkItem({
        id: 'newer',
        target: 'leo',
        status: 'proposed',
        createdAt: '2026-05-01T00:00:00Z',
      }),
    ];
    expect(pickCurrentWorkItem(items, 'leo')?.id).toBe('newer');
  });

  it('does not return another agent`s active item', () => {
    const items: WorkItem[] = [
      makeWorkItem({ id: 'sam-task', target: 'sam', status: 'running' }),
      makeWorkItem({ id: 'leo-task', target: 'leo', status: 'running' }),
    ];
    expect(pickCurrentWorkItem(items, 'leo')?.id).toBe('leo-task');
  });
});

// ---------------------------------------------------------------------------
// buildUpstreamChain
// ---------------------------------------------------------------------------

describe('buildUpstreamChain', () => {
  it('returns empty array when current has no parent', () => {
    const current = makeWorkItem({ id: 'c' });
    expect(buildUpstreamChain([current], current, 5)).toEqual([]);
  });

  it('walks parent chain in chronological order (oldest first)', () => {
    const grandparent = makeWorkItem({ id: 'gp' });
    const parent = makeWorkItem({ id: 'p', parentWorkItemId: 'gp' });
    const current = makeWorkItem({ id: 'c', parentWorkItemId: 'p' });
    const chain = buildUpstreamChain([grandparent, parent, current], current, 5);
    expect(chain.map((wi) => wi.id)).toEqual(['gp', 'p']);
  });

  it('respects the maxItems cap (drops oldest)', () => {
    // Build a chain of 6 ancestors a→b→c→d→e→f and current → a's parent.
    // We start with current and walk up; cap=3 should keep the THREE most-
    // recent ancestors (since cap is enforced before reversal). After
    // reversal: oldest-of-kept → newest-of-kept.
    const items: WorkItem[] = [];
    for (let i = 0; i < 6; i++) {
      items.push(
        makeWorkItem({
          id: `a${i}`,
          parentWorkItemId: i === 0 ? undefined : `a${i - 1}`,
        }),
      );
    }
    const current = makeWorkItem({ id: 'c', parentWorkItemId: 'a5' });
    const chain = buildUpstreamChain([...items, current], current, 3);
    expect(chain.map((wi) => wi.id)).toEqual(['a3', 'a4', 'a5']);
  });

  it('breaks on cycles without infinite-looping', () => {
    // p → q → p (cycle); cycle guard must terminate the walk.
    const p = makeWorkItem({ id: 'p', parentWorkItemId: 'q' });
    const q = makeWorkItem({ id: 'q', parentWorkItemId: 'p' });
    const current = makeWorkItem({ id: 'c', parentWorkItemId: 'p' });
    const chain = buildUpstreamChain([p, q, current], current, 10);
    // Walk: c.parent=p → push p, cursor=q → push q, cursor=p → already
    // visited (current.id seeded p via walk), loop ends. Reversed: [q, p].
    expect(chain.map((wi) => wi.id)).toEqual(['q', 'p']);
  });

  it('breaks gracefully when a parent id is missing from the pool', () => {
    const current = makeWorkItem({ id: 'c', parentWorkItemId: 'ghost' });
    expect(buildUpstreamChain([current], current, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectOpenLoops
// ---------------------------------------------------------------------------

describe('collectOpenLoops', () => {
  it('returns empty array when request is null', () => {
    expect(collectOpenLoops(null)).toEqual([]);
  });

  it('returns empty when requiresConfirmation is false', () => {
    expect(
      collectOpenLoops(makeRequest({ requiresConfirmation: false })),
    ).toEqual([]);
  });

  it('returns empty when requiresConfirmation is true but reason is missing', () => {
    expect(
      collectOpenLoops(makeRequest({ requiresConfirmation: true })),
    ).toEqual([]);
  });

  it('emits a confirmation reason as an open loop when present', () => {
    const out = collectOpenLoops(
      makeRequest({
        requiresConfirmation: true,
        confirmationReason: 'Verify staging is healthy',
      }),
    );
    expect(out).toEqual(['Awaiting user confirmation: Verify staging is healthy']);
  });
});

// ---------------------------------------------------------------------------
// summarizeWorkItem
// ---------------------------------------------------------------------------

describe('summarizeWorkItem', () => {
  it('renders status · title', () => {
    const wi = makeWorkItem({ status: 'running', title: 'Refactor router' });
    expect(summarizeWorkItem(wi)).toBe('running · Refactor router');
  });

  it('falls back to (untitled) when title is empty', () => {
    const wi = makeWorkItem({ status: 'blocked', title: '' });
    expect(summarizeWorkItem(wi)).toBe('blocked · (untitled)');
  });

  it('collapses internal whitespace', () => {
    const wi = makeWorkItem({ status: 'running', title: 'A   B\n\tC' });
    expect(summarizeWorkItem(wi)).toBe('running · A B C');
  });

  it('truncates long titles with an ellipsis', () => {
    const long = 'X'.repeat(200);
    const out = summarizeWorkItem(makeWorkItem({ status: 'running', title: long }));
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderWakeCard
// ---------------------------------------------------------------------------

describe('renderWakeCard', () => {
  it('returns empty string when current WorkItem is null', () => {
    expect(
      renderWakeCard({
        current: null,
        parentRequest: null,
        upstreamChain: [],
        openLoops: [],
      }),
    ).toBe('');
  });

  it('emits header + WorkItem + next-action when only current is present', () => {
    const card = renderWakeCard({
      current: makeWorkItem({
        title: 'Implement M2',
        description: 'Add the wake card to the prompt builder. Detail follows.',
      }),
      parentRequest: null,
      upstreamChain: [],
      openLoops: [],
    });
    expect(card).toContain('## Why You Are Awake');
    expect(card).toContain('WorkItem: Implement M2');
    expect(card).toContain('Required next action: Add the wake card to the prompt builder.');
    expect(card).not.toContain('Parent Request');
    expect(card).not.toContain('Upstream chain');
    expect(card).not.toContain('Known constraints');
  });

  it('renders all sections in the spec template ordering', () => {
    const card = renderWakeCard({
      current: makeWorkItem({
        title: 'Wire injection point',
        description: 'Hook M2 into PromptGenerator.',
      }),
      parentRequest: makeRequest({
        title: 'Memory Phase 1',
        description: 'Ship M1+M2 wake/mission cards. Multiple sub-tasks.',
      }),
      upstreamChain: [
        makeWorkItem({ id: 'u1', status: 'verified', title: 'Read spec' }),
        makeWorkItem({ id: 'u2', status: 'running', title: 'Build skeleton' }),
      ],
      openLoops: ['Awaiting user confirmation: spec sign-off'],
    });
    const idxHeader = card.indexOf('## Why You Are Awake');
    const idxWi = card.indexOf('WorkItem: Wire injection point');
    const idxParent = card.indexOf('Parent Request: Memory Phase 1');
    const idxChain = card.indexOf('Upstream chain:');
    const idxAction = card.indexOf('Required next action:');
    const idxLoops = card.indexOf('Known constraints / open loops on this Request:');
    expect(idxHeader).toBeGreaterThanOrEqual(0);
    expect(idxWi).toBeGreaterThan(idxHeader);
    expect(idxParent).toBeGreaterThan(idxWi);
    expect(idxChain).toBeGreaterThan(idxParent);
    expect(idxAction).toBeGreaterThan(idxChain);
    expect(idxLoops).toBeGreaterThan(idxAction);
    expect(card).toContain('- verified · Read spec');
    expect(card).toContain('- running · Build skeleton');
  });

  it('falls back to the title when description is missing', () => {
    const card = renderWakeCard({
      current: makeWorkItem({ title: 'Just a title', description: undefined }),
      parentRequest: null,
      upstreamChain: [],
      openLoops: [],
    });
    expect(card).toContain('Required next action: Just a title');
  });
});

// ---------------------------------------------------------------------------
// enforceHardCap
// ---------------------------------------------------------------------------

describe('enforceHardCap', () => {
  it('passes through cards already under the cap', () => {
    const small = '## hi\nbody';
    expect(enforceHardCap(small, 1024)).toBe(small);
  });

  it('truncates oversized cards at a line boundary', () => {
    const big = ['## hdr', ...Array.from({ length: 200 }).map((_, i) => `line-${i}`)].join('\n');
    const out = enforceHardCap(big, 256);
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(256);
    // The output should end on a complete line (no mid-line cut).
    expect(out.endsWith('-')).toBe(false);
    expect(
      out.split('\n').every((l) => l.length === 0 || /^(##\s.*|line-\d+)$/.test(l)),
    ).toBe(true);
  });

  it('falls back to byte-truncating the first line when even one line exceeds the cap', () => {
    const long = 'A'.repeat(2048);
    const out = enforceHardCap(long, 64);
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(64);
  });
});

// ---------------------------------------------------------------------------
// Service-level: getWakeCardForAgent
// ---------------------------------------------------------------------------

describe('WorkingMemoryService.getWakeCardForAgent', () => {
  let projectPath: string;
  let svc: WorkingMemoryService;
  let getAllItemsSpy: jest.SpyInstance;

  beforeEach(async () => {
    TaskPoolService.resetInstance();
    RequestService.resetInstance();
    WorkingMemoryService.clearInstance();
    projectPath = await makeTempProject();
    svc = WorkingMemoryService.getInstance();
    // Default: pool is empty. Individual tests override via mockResolvedValue.
    getAllItemsSpy = jest
      .spyOn(TaskPoolService.prototype, 'getAllItems')
      .mockResolvedValue([]);
  });

  afterEach(async () => {
    getAllItemsSpy.mockRestore();
    await fs.rm(projectPath, { recursive: true, force: true });
    TaskPoolService.resetInstance();
    RequestService.resetInstance();
    WorkingMemoryService.clearInstance();
  });

  it('returns empty string when no active WorkItem matches this agent', async () => {
    getAllItemsSpy.mockResolvedValue([
      makeWorkItem({ target: 'someone-else', status: 'running' }),
    ]);
    const out = await svc.getWakeCardForAgent({
      agentId: 'leo-id',
      sessionName: 'leo-session',
      projectPath,
    });
    expect(out).toBe('');
  });

  it('returns rendered card when an active WorkItem exists, even without a parent Request', async () => {
    getAllItemsSpy.mockResolvedValue([
      makeWorkItem({
        id: 'wi-1',
        target: 'leo-session',
        status: 'running',
        title: 'Build wake card',
        description: 'Implement M2 service',
      }),
    ]);
    const out = await svc.getWakeCardForAgent({
      agentId: 'leo-id',
      sessionName: 'leo-session',
      projectPath,
    });
    expect(out).toContain('## Why You Are Awake');
    expect(out).toContain('WorkItem: Build wake card');
    expect(out).toContain('Required next action: Implement M2 service');
    expect(out).not.toContain('Parent Request');
  });

  it('loads the parent Request from disk and surfaces it in the card', async () => {
    const parent = makeRequest({
      id: 'req-1',
      title: 'Memory Phase 1',
      description: 'Ship M1 + M2.',
    });
    await writeRequest(projectPath, parent);
    getAllItemsSpy.mockResolvedValue([
      makeWorkItem({
        id: 'wi-1',
        target: 'leo-session',
        status: 'running',
        title: 'Build wake card',
        requestId: 'req-1',
      }),
    ]);
    const out = await svc.getWakeCardForAgent({
      agentId: 'leo-id',
      sessionName: 'leo-session',
      projectPath,
    });
    expect(out).toContain('Parent Request: Memory Phase 1 — Ship M1 + M2.');
  });

  it('builds an upstream chain when parent WorkItems are present in the pool', async () => {
    getAllItemsSpy.mockResolvedValue([
      makeWorkItem({ id: 'gp', title: 'Plan memory work', status: 'verified' }),
      makeWorkItem({
        id: 'p',
        title: 'Read spec',
        status: 'verified',
        parentWorkItemId: 'gp',
      }),
      makeWorkItem({
        id: 'cur',
        target: 'leo-session',
        status: 'running',
        title: 'Build wake card',
        parentWorkItemId: 'p',
      }),
    ]);
    const out = await svc.getWakeCardForAgent({
      agentId: 'leo-id',
      sessionName: 'leo-session',
      projectPath,
    });
    expect(out).toContain('Upstream chain:');
    expect(out).toContain('- verified · Plan memory work');
    expect(out).toContain('- verified · Read spec');
  });

  it('is fail-soft when the task pool throws', async () => {
    getAllItemsSpy.mockRejectedValue(new Error('disk error'));
    const out = await svc.getWakeCardForAgent({
      agentId: 'leo-id',
      sessionName: 'leo-session',
      projectPath,
    });
    expect(out).toBe('');
  });

  it('downgrades a missing/malformed parent Request to a card without the parent section', async () => {
    // requestId points to a Request file we never wrote.
    getAllItemsSpy.mockResolvedValue([
      makeWorkItem({
        target: 'leo-session',
        status: 'running',
        title: 'Build wake card',
        requestId: 'req-ghost',
      }),
    ]);
    const out = await svc.getWakeCardForAgent({
      agentId: 'leo-id',
      sessionName: 'leo-session',
      projectPath,
    });
    expect(out).toContain('## Why You Are Awake');
    expect(out).toContain('WorkItem: Build wake card');
    expect(out).not.toContain('Parent Request');
  });

  it('enforces the hard byte cap', async () => {
    // Construct a current WorkItem with a huge description to force the
    // "Required next action" line near the cap, then expect the output
    // to never exceed WAKE_CARD_HARD_CAP_BYTES.
    const huge = 'A'.repeat(5000);
    getAllItemsSpy.mockResolvedValue([
      makeWorkItem({
        target: 'leo-session',
        status: 'running',
        title: huge,
        description: huge,
      }),
    ]);
    const out = await svc.getWakeCardForAgent({
      agentId: 'leo-id',
      sessionName: 'leo-session',
      projectPath,
    });
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(WAKE_CARD_HARD_CAP_BYTES);
  });
});
