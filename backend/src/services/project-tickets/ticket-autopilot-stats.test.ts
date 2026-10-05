/**
 * Tests for the ticket autopilot stats on synthetic traces
 * (specs/2026-10-03-autopilot-experiments.md §2).
 */

import { addDays, computeAutopilotStats, cycleStat, dayEndMs, dayStartMs, daysBetween, processSummary, rangeDays, type StatsTrace } from './ticket-autopilot-stats.js';
import { usageOfEvent, type OwnerTouchEvent, type TraceMetrics, type TraceStall } from '../trace/trace-metrics.js';
import type { TraceEvent, TraceIndexEntry } from '../trace/trace.types.js';

const H = 3_600_000;
/** Local time on 2026-10-0d at hour h, as ISO. */
const at = (d: number, h: number, m = 0): string => new Date(2026, 9, d, h, m, 0).toISOString();

let seq = 0;
function ev(type: TraceEvent['type'], ts: string, extra: Partial<TraceEvent> = {}): TraceEvent {
  seq += 1;
  return { ts, traceId: 'tr-x', type, actor: { kind: 'system' }, refs: {}, summary: `${type} ${seq}`, outcome: 'info', ...extra };
}

function entry(traceId: string, kind: 'autopilot' | 'ticket' | 'request', day: string, labels: string[] = [], ticketId?: string): TraceIndexEntry {
  return {
    traceId,
    root: { traceId, kind: kind as never, summary: ticketId ? `${ticketId}: x` : 'run', createdAt: at(Number(day.slice(8)), 0, 1), actor: { kind: 'system' }, refs: ticketId ? { ticketId } : {} },
    updatedAt: at(5, 23),
    eventCount: 0,
    bytes: 0,
    truncated: false,
    tags: { autopilot: { projectId: 'p', day }, ...(labels.length ? { labels } : {}) },
  };
}

/** Detail metrics: each owner touch with its time, every stall. */
function metrics(over: { touches?: Array<[OwnerTouchEvent['kind'], string]>; stalls?: TraceStall[] } = {}): TraceMetrics {
  const stalls = over.stalls ?? [];
  const byCause = { runtime_quota: 0, delivery_failure: 0, waiting_on_owner: 0, waiting_on_agent: 0, nobody_pushing: 0 };
  for (const s of stalls) byCause[s.cause] += 1;
  return {
    ownerTouches: { answered: 0, approved: 0, sentBack: 0, corrected: 0, manual: 0, total: (over.touches ?? []).length },
    ownerTouchEvents: (over.touches ?? []).map(([kind, at]) => ({ kind, at })),
    stalls: { thresholdMinutes: 30, count: stalls.length, totalMs: stalls.reduce((a, s) => a + s.ms, 0), byCause, items: stalls },
  } as unknown as TraceMetrics;
}

const status = (ticketId: string, from: string, to: string, ts: string, actor: TraceEvent['actor'] = { kind: 'system' }): TraceEvent =>
  ev('ticket.status', ts, { actor, refs: { ticketId }, data: { from, to } });
const wi = (workItemId: string, from: string, to: string, ts: string): TraceEvent => ev('workitem.status', ts, { refs: { workItemId }, data: { from, to } });
const usage = (ts: string, input: number, output: number): TraceEvent =>
  ev('usage', ts, { actor: { kind: 'agent', session: 'dev' }, refs: { session: 'dev' }, data: { input, output, model: 'claude-sonnet-4-5' } });

describe('ticket-autopilot-stats', () => {
  const days = ['2026-10-03', '2026-10-04', '2026-10-05'];

  function fixture(): StatsTrace[] {
    const run3: StatsTrace = {
      entry: entry('tr-run3', 'autopilot', '2026-10-03'),
      metrics: null,
      events: [
        ev('autopilot.action', at(3, 9), { refs: { ticketId: 'CE-1' }, data: { action: 'triage_ticket', labels: 'feed' } }),
        ev('autopilot.action', at(3, 9), { refs: { ticketId: 'CE-2' }, data: { action: 'triage_ticket', labels: 'feed,web' } }),
        ev('autopilot.action', at(3, 9), { refs: { ticketId: 'CE-3' }, data: { action: 'triage_ticket', labels: '' } }),
        usage(at(3, 9, 5), 1000, 200),
        ev('autopilot.action', at(3, 20), { data: { action: 'budget_paused' } }),
      ],
    };
    const run4: StatsTrace = {
      entry: entry('tr-run4', 'autopilot', '2026-10-04'),
      metrics: null,
      events: [
        ev('autopilot.action', at(4, 0, 5), { data: { action: 'budget_resumed', reason: 'new_day' } }),
        ev('autopilot.action', at(4, 10), { data: { action: 'budget_paused' } }),
        ev('autopilot.action', at(4, 12), { data: { action: 'budget_resumed', reason: 'boost' } }),
      ],
    };
    // CE-1 (feed): started day 3, worker done day 3 after 4h, lead rejected once, verified day 4.
    const t1: StatsTrace = {
      entry: entry('tr-t1', 'ticket', '2026-10-03', ['feed'], 'CE-1'),
      metrics: metrics({
        // The 09:00 touch is before the autopilot started work (a reused trace's earlier conversation): not counted.
        touches: [['corrected', at(3, 9)], ['answered', at(3, 12)], ['corrected', at(4, 8)]],
        stalls: [
          { start: at(3, 8), end: at(3, 9), ms: H, cause: 'nobody_pushing', detail: 'before the work' },
          { start: at(4, 1), end: at(4, 3), ms: 2 * H, cause: 'waiting_on_owner', detail: 'x' },
        ],
      }),
      events: [
        ev('autopilot.action', at(3, 10), { refs: { ticketId: 'CE-1', workItemId: 'w1' }, data: { action: 'claim' } }),
        status('CE-1', 'ready', 'in_progress', at(3, 10)),
        wi('w1', 'running', 'done_by_worker', at(3, 14)),
        wi('w1', 'done_by_worker', 'rejected', at(3, 15)),
        wi('w2', 'running', 'done_by_worker', at(4, 9)),
        status('CE-1', 'in_progress', 'done', at(4, 10)),
        usage(at(3, 11), 5000, 1000),
        ev('harness.nudge', at(3, 12)),
        ev('harness.redelivery', at(4, 2)),
        ev('message.outbound', at(4, 2), { outcome: 'failed' }),
      ],
    };
    // CE-2 (feed, web): started day 4, owner review sent back day 5, stall on day 5 (one item past the cap).
    const t2: StatsTrace = {
      entry: entry('tr-t2', 'ticket', '2026-10-04', ['feed', 'web'], 'CE-2'),
      metrics: metrics({
        touches: [['sentBack', at(5, 9)]],
        stalls: [{ start: at(5, 8), end: at(5, 9), ms: H, cause: 'nobody_pushing', detail: 'x' }],
      }),
      events: [
        status('CE-2', 'ready', 'in_progress', at(4, 11)),
        status('CE-2', 'in_progress', 'review', at(4, 15)),
        status('CE-2', 'review', 'ready', at(5, 9), { kind: 'owner' }),
        ev('guard.block', at(5, 10)),
      ],
    };
    // CE-3 (no label): started before the range; its touches land on the first day.
    const t3: StatsTrace = {
      entry: entry('tr-t3', 'ticket', '2026-10-01', [], 'CE-3'),
      metrics: metrics({ touches: [['answered', at(2, 10)], ['approved', at(5, 10)]] }),
      events: [status('CE-3', 'ready', 'in_progress', at(1, 10)), status('CE-3', 'in_progress', 'done', at(5, 10)), usage(at(5, 9), 100, 100)],
    };
    return [run3, run4, t1, t2, t3];
  }

  const base = { projectId: 'p', days, dailyBudgetTokens: 1_000_000, stallMinutes: 30, now: new Date(2026, 9, 5, 18) };

  it('counts tickets, cycle times, touches, stalls, interventions, tokens and paused time per day', () => {
    const s = computeAutopilotStats({ ...base, traces: fixture(), ledger: { '2026-10-03': { tokens: 500_000, costUsd: 2 }, '2026-10-04': { tokens: 1_200_000, costUsd: 5 } } });
    const [d3, d4, d5] = s.days;
    expect(s.range).toEqual({ start: '2026-10-03', end: '2026-10-05' });
    expect([d3.triaged, d3.started, d3.done, d3.verified, d3.sentBack]).toEqual([3, 1, 1, 0, 1]);
    expect([d4.started, d4.done, d4.verified]).toEqual([1, 1, 1]); // CE-2 → review = done; CE-1 verified
    expect([d5.verified, d5.sentBack]).toEqual([1, 1]); // CE-3 verified (started before the range); owner sent CE-2 back
    expect(d3.cycleTime.toDone).toEqual({ count: 1, medianMs: 4 * H, meanMs: 4 * H });
    expect(d4.cycleTime.toVerified).toEqual({ count: 1, medianMs: 24 * H, meanMs: 24 * H });
    expect(d5.cycleTime.toVerified.medianMs).toBe((4 * 24 + 0) * H); // CE-3: day 1 10:00 → day 5 10:00

    // Each touch on the day it happened; none outside the range or before the work started.
    expect(d3.ownerTouches).toEqual({ answered: 1, approved: 0, sentBack: 0, corrected: 0, total: 1 });
    expect(d4.ownerTouches).toEqual({ answered: 0, approved: 0, sentBack: 0, corrected: 1, total: 1 });
    expect(d5.ownerTouches).toEqual({ answered: 0, approved: 1, sentBack: 1, corrected: 0, total: 2 });
    expect(s.total.ownerTouches.total).toBe(4);

    expect(d3.stalls.count).toBe(0); // the 08:00 stall was before the autopilot's work
    expect(d4.stalls).toMatchObject({ count: 1, totalMs: 2 * H });
    expect(d4.stalls.byCause.waiting_on_owner).toEqual({ count: 1, ms: 2 * H });
    expect(d4.stalled).toBe(1);
    expect(d5.stalls.byCause.nobody_pushing).toEqual({ count: 1, ms: H });
    expect(s.total.stalls.count).toBe(2);

    expect(d3.interventions).toMatchObject({ nudges: 1, total: 1 });
    expect(d4.interventions).toMatchObject({ redeliveries: 1, misroutes: 1, total: 2 });
    expect(d5.interventions).toMatchObject({ guardBlocks: 1, total: 1 });

    const tok = (e: TraceEvent) => usageOfEvent(e)!.total;
    expect(d3.tokens).toBe(tok(usage('', 1000, 200)) + tok(usage('', 5000, 1000)));
    expect(d5.tokens).toBe(tok(usage('', 100, 100)));

    expect(d3.pausedMs).toBe(4 * H); // 20:00 → midnight
    expect(d4.pausedMs).toBe(2 * H); // 10:00 → 12:00 (the 00:05 resume closed nothing new)
    expect(d4.budget).toEqual({ dailyBudgetTokens: 1_000_000, ledgerTokens: 1_200_000, ledgerRawTokens: 1_200_000, ledgerCostUsd: 5, pct: 1.2 });
    expect(s.total.budget.ledgerTokens).toBe(1_700_000);
    expect(s.total.budget.dailyBudgetTokens).toBe(3_000_000);

    expect([s.total.triaged, s.total.started, s.total.done, s.total.verified, s.total.sentBack]).toEqual([3, 2, 3, 2, 2]);
    expect(d3.runTraceId).toBe('tr-run3');
    expect(d4.ticketTraceIds).toEqual(['tr-t2']);
    expect(s.labels).toEqual(['feed', 'web']);
  });

  it('limits ticket numbers to a label; budget and pauses stay project-wide', () => {
    const s = computeAutopilotStats({ ...base, label: 'WEB', traces: fixture() });
    expect(s.label).toBe('WEB');
    expect(s.total.triaged).toBe(1);
    expect(s.total.started).toBe(1);
    expect(s.total.verified).toBe(0);
    expect(s.total.tokens).toBe(0); // CE-2 had no usage; triage usage is not label work
    expect(s.total.pausedMs).toBe(6 * H);
    expect(s.scope).toEqual({ budget: 'project', pausedMs: 'project' });
  });

  it('a window does not double count: touches and stalls split exactly between adjacent ranges', () => {
    const traces = fixture();
    const a = computeAutopilotStats({ ...base, days: ['2026-10-03'], traces });
    const b = computeAutopilotStats({ ...base, days: ['2026-10-04', '2026-10-05'], traces });
    const all = computeAutopilotStats({ ...base, traces });
    expect(a.total.ownerTouches.total + b.total.ownerTouches.total).toBe(all.total.ownerTouches.total);
    expect(a.total.stalls.count + b.total.stalls.count).toBe(all.total.stalls.count);
    expect(all.traceCount).toBe(5);
    expect(computeAutopilotStats({ ...base, traces, unreadable: 1 }).incomplete).toBe(true);
  });

  it('computes detail metrics from the events when none are given', () => {
    const t: StatsTrace = {
      entry: entry('tr-t9', 'ticket', '2026-10-03', [], 'CE-9'),
      events: [status('CE-9', 'ready', 'in_progress', at(3, 9)), ev('decision.status', at(3, 11), { actor: { kind: 'owner' }, refs: { decisionId: 'D-1' }, data: { to: 'resolved' } }), status('CE-9', 'in_progress', 'done', at(3, 12))],
    };
    const s = computeAutopilotStats({ ...base, traces: [t] });
    expect(s.days[0].ownerTouches.answered).toBe(1);
  });

  it('counts goal replans per day from the run trace, once each, never as owner touches (specs/2026-10-04-autopilot-goal-replan.md)', () => {
    const replanEv = (d: number, h: number) => ev('autopilot.action', at(d, h), { refs: { workItemId: `wr-${d}-${h}` }, data: { action: 'replan', trigger: 'member_idle' } });
    const run: StatsTrace = { entry: entry('tr-r3', 'autopilot', '2026-10-03'), metrics: null, events: [replanEv(3, 20)] };
    const run5: StatsTrace = { entry: entry('tr-r5', 'autopilot', '2026-10-05'), metrics: null, events: [replanEv(5, 9), replanEv(5, 15)] };
    // The replan turn's own trace (kind triage) also holds the event: not counted twice.
    const turn: StatsTrace = { entry: { ...entry('tr-turn', 'autopilot', '2026-10-03'), root: { ...entry('tr-turn', 'autopilot', '2026-10-03').root, kind: 'triage' as never } }, metrics: null, events: [replanEv(3, 20)] };
    const s = computeAutopilotStats({ ...base, traces: [...fixture(), run, run5, turn] });
    expect(s.days.map((d) => d.replans)).toEqual([1, 0, 2]);
    expect(s.total.replans).toBe(3);
    expect(s.total.ownerTouches.total).toBe(4); // unchanged by the replans
    // A label filter does not hide them (project-wide, no ticket yet).
    expect(computeAutopilotStats({ ...base, label: 'feed', traces: [run5] }).total.replans).toBe(2);
    expect(computeAutopilotStats({ ...base, traces: fixture() }).total.replans).toBe(0);
  });

  it('closes a pause that is still open at now', () => {
    const run: StatsTrace = { entry: entry('r', 'autopilot', '2026-10-05'), metrics: null, events: [ev('autopilot.action', at(5, 16), { data: { action: 'budget_paused' } })] };
    expect(computeAutopilotStats({ ...base, traces: [run] }).days[2].pausedMs).toBe(2 * H);
  });

  it('summarises the process for an experiment', () => {
    const s = computeAutopilotStats({ ...base, traces: fixture() });
    const p = processSummary(s);
    expect(p).toMatchObject({ ticketsStarted: 2, ticketsDone: 3, ticketsShipped: 2, ownerTouches: 4, ownerTouchesPerTicket: 2, stalls: 2, stallMs: 3 * H });
    expect(p.noData).toBeUndefined();
    expect(p.costPerShippedTicket).toBeCloseTo(p.costUsd / 2, 2);
    const empty = processSummary(computeAutopilotStats({ ...base, traces: [] }));
    expect(empty.ownerTouchesPerTicket).toBeNull();
    expect(empty.costPerShippedTicket).toBeNull();
    expect(empty.noData).toBe(true); // no traces: no data, not zeros
  });

  it('day helpers', () => {
    expect(rangeDays(new Date(2026, 9, 2, 1), 3)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(cycleStat([3, 1, 2, 10])).toEqual({ count: 4, medianMs: 3, meanMs: 4 });
    expect(cycleStat([])).toEqual({ count: 0, medianMs: null, meanMs: null });
    // Day ends are the next local midnight (23 / 25 h across a DST change).
    for (const d of ['2026-03-08', '2026-11-01', '2026-10-03']) expect(dayEndMs(d)).toBe(dayStartMs(addDays(d, 1)));
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});
