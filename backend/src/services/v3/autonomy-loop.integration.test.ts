/**
 * Autonomy acceptance-loop integration test (P1 + P2 + P2b composed).
 *
 * Proves the end-to-end "verify → accept → judge" loop with the REAL rule +
 * cascade machinery over one shared in-memory pool — deterministically, no LLM:
 *
 *   1. A worker reports a WorkItem done (`done_by_worker`) and the TL never
 *      verifies it within the deadline → {@link detectUnverifiedWorkItems}
 *      flags it for escalation (P1: no silent auto-accept).
 *   2. While that child is unverified, the parent Request must NOT complete —
 *      {@link cascadeRequestStatus} keeps it `running` (P2: acceptance gate).
 *   3. Once the orc renders a verdict (child → `verified`), the cascade
 *      completes the Request AND fires the final-deliverable hook so the orc
 *      makes the holistic "is it usable" judgment (P2b).
 *
 * This is the reproducible core of the autonomous software loop. (A full
 * LLM-driven cold-start run — orc proposes a team, agents actually build and
 * verify — is non-deterministic and validated separately/manually.)
 *
 * @module services/v3/autonomy-loop.integration.test
 */

import { detectUnverifiedWorkItems } from '../reconciler/reconcile-rules.js';
import { cascadeRequestStatus, type CascadeDeps } from './cascade-request-status.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/index.js';

const SILENT = { info() {}, warn() {}, debug() {}, error() {} } as unknown as CascadeDeps['logger'];

function makeWI(over: Partial<WorkItem>): WorkItem {
  return { ...createWorkItem({ type: 'delegate', owner: 'agent', title: 'Test', target: 'agent-1' }), ...over };
}

function makeRequest(over: Partial<Request> = {}): Request {
  return {
    id: 'req-1',
    sourceConversationItemId: 'conv-1',
    title: 'Build a small CLI todo app',
    description: 'Build a small CLI todo app',
    status: 'running',
    priority: 'normal',
    requiresConfirmation: false,
    workItemIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as Request;
}

/** Build cascade deps over a shared, mutable pool + request store. */
function makeDeps(pool: WorkItem[], request: Request) {
  const updates: Array<[string, Partial<Request>]> = [];
  const completed: Array<{ requestId: string; childCount: number }> = [];
  const store = new Map<string, Request>([[request.id, request]]);
  const deps: CascadeDeps = {
    requestService: {
      getById: async (id) => store.get(id) ?? null,
      update: async (id, patch) => {
        updates.push([id, patch]);
        const ex = store.get(id);
        if (ex) store.set(id, { ...ex, ...patch } as Request);
        return null;
      },
    },
    taskPool: { getAllItems: async () => pool },
    logger: SILENT,
    onRequestCompleted: (req, children) => {
      completed.push({ requestId: req.id, childCount: children.length });
    },
  };
  return { deps, updates, completed };
}

describe('autonomy acceptance loop (P1 + P2 + P2b)', () => {
  const NOW = Date.now();
  const threeHoursAgo = new Date(NOW - 3 * 3_600_000).toISOString();

  it('catches unverified work, gates Request completion, then completes + judges on verdict', async () => {
    // One Request with two children: one verified, one reported done but NOT
    // yet verified (3h ago — past the 2h verify-escalate deadline).
    const verifiedChild = makeWI({ id: 'a', requestId: 'req-1', status: 'verified' });
    const unverifiedChild = makeWI({
      id: 'b',
      requestId: 'req-1',
      status: 'done_by_worker',
      completedAt: threeHoursAgo,
    });
    const pool: WorkItem[] = [verifiedChild, unverifiedChild];
    const request = makeRequest();
    const { deps, updates, completed } = makeDeps(pool, request);

    // --- P1: the unverified child is flagged for escalation to the orc. ---
    const unverified = detectUnverifiedWorkItems(pool, NOW);
    expect(unverified.unverifiedIds).toEqual(['b']);

    // --- P2: while 'b' is unverified, the Request must NOT complete. ---
    await cascadeRequestStatus('req-1', deps);
    expect(updates.some(([, u]) => u.status === 'done')).toBe(false);
    expect(completed).toEqual([]); // no final judgment yet

    // --- Orc renders the verdict (escalation answered): child → verified. ---
    unverifiedChild.status = 'verified';

    // --- P2 + P2b: now the Request completes AND the final-judgment hook fires. ---
    await cascadeRequestStatus('req-1', deps);
    expect(updates.some(([, u]) => u.status === 'done')).toBe(true);
    expect(completed).toEqual([{ requestId: 'req-1', childCount: 2 }]);
  });

  it('a freshly-done child is NOT escalated and does NOT complete the Request prematurely', async () => {
    const child = makeWI({
      id: 'b',
      requestId: 'req-1',
      status: 'done_by_worker',
      completedAt: new Date(NOW - 60_000).toISOString(), // 1 min ago
    });
    const pool = [makeWI({ id: 'a', requestId: 'req-1', status: 'verified' }), child];
    const { deps, updates, completed } = makeDeps(pool, makeRequest());

    expect(detectUnverifiedWorkItems(pool, NOW).unverifiedIds).toEqual([]); // within deadline
    await cascadeRequestStatus('req-1', deps);
    expect(updates.some(([, u]) => u.status === 'done')).toBe(false); // gated
    expect(completed).toEqual([]);
  });
});
