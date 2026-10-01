/**
 * Replay (2026-09-28): the night the owner found the receipt overwhelming —
 * 14 asks and 17 「等你拍板」 with ticket numbers and his own words cut off.
 *
 * The fixture is shaped on that night's tickets (see its `_about`). The test
 * applies the new rules (plain answers close, 24h silence accepts, 3 idle
 * days close as stale — specs/ticket-calm.md) and checks the receipt that
 * comes out: at most ten lines, Chinese, no ticket numbers, none of his raw
 * words, nothing for unknowns, the right team for each line, misrouted
 * answers left off.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isValidRequestTransition, type Request, type UpdateRequestInput } from '../../../types/v2/request.types.js';
import { TICKET_CONSTANTS } from '../../../constants.js';
import { answerNeedsOwner, planTicketCleanup, runTicketCleanup, type TicketCleanupStore } from '../ticket-hygiene.js';
import { buildReceiptData } from './owner-receipt-data.js';
import { renderReceiptSlack } from './owner-receipt.renderer.js';
import type { ReceiptWindow } from './owner-receipt.types.js';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'owner-receipt.replay-2026-09-28.fixture.json'), 'utf8')) as {
  window: ReceiptWindow;
  teams: Record<string, string>;
  agentNames: Record<string, string>;
  requests: Request[];
};

/** In-memory store that honours the status transitions (no WorkItems in this fixture). */
class MemoryStore implements TicketCleanupStore {
  readonly items: Map<string, Request>;
  constructor(requests: readonly Request[]) {
    this.items = new Map(requests.map((r) => [r.id, structuredClone(r)]));
  }
  async listAll(): Promise<Request[]> {
    return [...this.items.values()].map((r) => structuredClone(r));
  }
  async update(id: string, updates: UpdateRequestInput): Promise<Request> {
    const r = this.items.get(id);
    if (!r) throw new Error(`not found: ${id}`);
    if (updates.status && updates.status !== r.status && !isValidRequestTransition(r.status, updates.status)) throw new Error('bad transition');
    const { accepted: _a, ignoreDeadChildren: _i, reopenStale: _r, ...rest } = updates;
    const next = { ...r, ...rest } as Request;
    if (updates.status === 'done' || updates.status === 'cancelled') next.completedAt = new Date(NOW).toISOString();
    this.items.set(id, next);
    return structuredClone(next);
  }
}

const NOW = Date.parse(FIXTURE.window.to);
const OWNER_WORDS = FIXTURE.requests.map((r) => r.description);

describe('replay — 2026-09-28, the overwhelming receipt, under the new rules', () => {
  it('the one-time cleanup (dry run) finds the old pile: 待验收 from 9/26–27 and idle tickets', () => {
    const plan = planTicketCleanup(FIXTURE.requests, { now: NOW });
    const waiting = FIXTURE.requests.filter((r) => r.status === 'waiting_confirmation').length;
    // eslint-disable-next-line no-console
    console.log(`[replay 2026-09-28] 待验收 before: ${waiting}; cleanup would close ${plan.answered} as answered, accept ${plan.accept}, close ${plan.stale} as stale`);
    expect(waiting).toBe(14);
    // Plain answers (nothing to look at, nothing asked) close whatever their age…
    expect(plan.actions.filter((a) => a.action === 'answered').map((a) => a.tkt)).toEqual(['TKT-004', 'TKT-031', 'TKT-071', 'TKT-088']);
    // …the rest answered more than 24h before the receipt is accepted.
    expect(plan.actions.filter((a) => a.action === 'accept').map((a) => a.tkt)).toEqual(['TKT-017', 'TKT-029', 'TKT-051']);
    expect(plan.actions.filter((a) => a.action === 'stale').map((a) => a.tkt ?? a.id)).toEqual(['TKT-053', 'legacy-200', 'legacy-201']);
  });

  it('renders at most ten short lines, no ticket numbers, none of his words, right teams, misrouted left off', async () => {
    const store = new MemoryStore(FIXTURE.requests);
    // New rule at answer time: a plain answer (no deliverable, no question to him) closes.
    for (const r of await store.listAll()) {
      if (r.status === 'waiting_confirmation' && !answerNeedsOwner(r)) {
        await store.update(r.id, { status: 'done', accepted: true, tags: [...r.tags, TICKET_CONSTANTS.REVIEW.ANSWERED_TAG] });
        store.items.get(r.id)!.completedAt = r.submittedAt;
      }
    }
    // Then the sweep / one-time cleanup: 24h of silence accepts, 3 idle days close.
    const applied = await runTicketCleanup(store, { now: NOW, apply: true });
    expect(applied.failed).toEqual([]);

    const data = buildReceiptData({
      requests: await store.listAll(),
      workItems: [],
      window: FIXTURE.window,
      teamOf: (s) => FIXTURE.teams[s] ?? null,
      agentNameOf: (s) => FIXTURE.agentNames[s] ?? null,
      now: new Date(NOW),
    });
    const text = renderReceiptSlack(data);
    // eslint-disable-next-line no-console
    console.log(`[replay 2026-09-28] receipt:\n${text}`);

    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toBe('*Crewly receipt · Mon 9/28*');
    expect(text).not.toMatch(/TKT-\d/);
    for (const banned of ['不详', '没记', '等你拍板', '你提了', '你发了']) expect(text).not.toContain(banned);
    for (const words of OWNER_WORDS) expect(text).not.toContain(words.slice(0, 12));

    // Done today: three outcomes, in the agents' words, each credited to who did it.
    expect(data.highlights).toHaveLength(3);
    // TKT-094 had no assignee; Owen answered it → CE, not Unassigned.
    expect(data.highlights.find((h) => h.ticketId === 'tkt-094')?.team).toBe('CE');
    expect(text).not.toContain('Unassigned');

    // Needs your decision: three questions, then how many more are on the board.
    expect(data.decisions).toHaveLength(3);
    expect(lines.at(-1)).toBe(`${data.decisionsTotal - 3} more on the board`);
    // Addressed to another machine's agent, answered by Atlas: asked by Atlas.
    const all = buildReceiptData({
      requests: await store.listAll(),
      workItems: [],
      window: FIXTURE.window,
      teamOf: (s) => FIXTURE.teams[s] ?? null,
      now: new Date(NOW),
    });
    expect(all.waiting.find((w) => w.id === 'tkt-095')?.team).toBe('Think Tank');
    const only095 = buildReceiptData({
      requests: (await store.listAll()).filter((r) => r.id === 'tkt-095'),
      workItems: [],
      window: FIXTURE.window,
      teamOf: (s) => FIXTURE.teams[s] ?? null,
      agentNameOf: (s) => FIXTURE.agentNames[s] ?? null,
      now: new Date(NOW),
    });
    expect(only095.decisions).toEqual([expect.objectContaining({ from: 'Atlas', question: '发 10/2 周五那一期可以吗？' })]);
    // Answers recorded from another team (TKT-017, TKT-051) are never put in front of him.
    expect(data.decisions.map((d) => d.id)).not.toEqual(expect.arrayContaining(['tkt-017']));
    expect(data.decisions.map((d) => d.id)).not.toEqual(expect.arrayContaining(['tkt-051']));
    for (const d of data.decisions) expect(d.question).toMatch(/[？?]$/);
  });
});
