/**
 * Tests for the weekly owner-pulls rollup (#1387): kinds, outcomes, the FYI
 * rule, week over week, per team, and the rendered line.
 */

import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import type { OwnerDecision } from '../../../types/decision.types.js';
import type { RequestOpenItem } from '../../../types/v2/open-item.types.js';
import {
  classifyAgentPost,
  countOwnerActiveMinutes,
  countOwnerTouches,
  decisionPullKind,
  decisionPullOutcome,
  endsWithQuestion,
  pullsFromAgentPosts,
  pullsFromDecisions,
  pullsFromOpenItems,
  renderPullsWeekly,
  rollupPulls,
  type AgentPostFacts,
  type PullRecord,
} from './owner-pulls-weekly.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

function card(over: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: 'D-1',
    question: 'Which one?',
    options: [{ key: 'a', label: 'A' }],
    defaultKey: 'a',
    deadline: ago(0),
    requestedBy: 'atlas',
    asker: 'atlas',
    status: 'resolved',
    createdAt: ago(1),
    updatedAt: ago(1),
    ...over,
  } as OwnerDecision;
}

function rec(over: Partial<PullRecord> = {}): PullRecord {
  return { at: ago(1), kind: 'decision', team: 'CE', outcome: 'answered', ...over };
}

describe('classifyAgentPost (the FYI rule)', () => {
  const base: AgentPostFacts = { endsWithQuestion: false, openedDecisionCard: false, workItemBlockedOnOwner: false, reportsFailure: false };

  it('is an FYI only when it asked nothing, opened no card and blocked nothing', () => {
    expect(classifyAgentPost(base)).toBe('fyi');
  });

  it.each([
    ['ends with a question', { endsWithQuestion: true }],
    ['opened a decision card', { openedDecisionCard: true }],
    ['a WorkItem stayed blocked on the owner', { workItemBlockedOnOwner: true }],
  ])('needs an answer when it %s', (_n, over) => {
    expect(classifyAgentPost({ ...base, ...over })).toBe('decision');
  });

  it('a failure report is stuck, even without a question', () => {
    expect(classifyAgentPost({ ...base, reportsFailure: true })).toBe('stuck');
  });
});

describe('decision cards', () => {
  it('kinds: approvals are review, a spend cap is stuck, the rest decisions', () => {
    expect(decisionPullKind(card())).toBe('decision');
    expect(decisionPullKind(card({ kind: 'gmail_send' }))).toBe('review');
    expect(decisionPullKind(card({ merge: true }))).toBe('review');
    expect(decisionPullKind(card({ sensitive: 'deploy' }))).toBe('review');
    expect(decisionPullKind(card({ kind: 'spend_cap' }))).toBe('stuck');
    expect(decisionPullKind(card({ kind: 'reply_question' }))).toBe('decision');
  });

  it('outcomes: answered, aged out (deadline default, expired, parked), ignored (skipped), open; withdrawn is not a pull', () => {
    expect(decisionPullOutcome(card({ status: 'resolved', answeredVia: 'button' }))).toBe('answered');
    expect(decisionPullOutcome(card({ status: 'resolved', answeredVia: 'deadline' }))).toBe('aged_out');
    expect(decisionPullOutcome(card({ status: 'defaulted' }))).toBe('aged_out');
    expect(decisionPullOutcome(card({ status: 'expired' }))).toBe('aged_out');
    expect(decisionPullOutcome(card({ status: 'parked' }))).toBe('aged_out');
    expect(decisionPullOutcome(card({ status: 'skipped' }))).toBe('ignored');
    expect(decisionPullOutcome(card({ status: 'open' }))).toBe('open');
    expect(decisionPullOutcome(card({ status: 'cancelled' }))).toBeNull();
  });

  it('leaves out harness-asked cards except a spend cap, and withdrawn cards; names the team', () => {
    const rows = pullsFromDecisions(
      [
        card({ id: 'D-1' }),
        card({ id: 'D-2', system: { key: 'x' }, kind: 'runtime_terms' }),
        card({ id: 'D-3', system: { key: 'y' }, kind: 'spend_cap', status: 'open' }),
        card({ id: 'D-4', status: 'cancelled' }),
      ],
      (d) => (d.id === 'D-1' ? 'CE' : null),
    );
    expect(rows.map((r) => [r.kind, r.team, r.outcome])).toEqual([
      ['decision', 'CE', 'answered'],
      ['stuck', 'Unassigned', 'open'],
    ]);
  });

  it('uses askedAt (when the agent asked) over createdAt', () => {
    const [r] = pullsFromDecisions([card({ askedAt: ago(9), createdAt: ago(1) })], () => 'CE');
    expect(r.at).toBe(ago(9));
  });
});

describe('open items (questions left in replies)', () => {
  const item = (id: string, status: RequestOpenItem['status'], type: RequestOpenItem['type'] = 'question'): { requestId: string; item: RequestOpenItem } => ({
    requestId: 'r1',
    item: { id, type, text: 't', agent: 'atlas', sourceMessageId: 'm', createdAt: ago(2), status },
  });

  it('counts questions once, skips carded, superseded and commitments', () => {
    const rows = pullsFromOpenItems(
      [item('q1', 'resolved'), item('q2', 'expired'), item('q3', 'skipped'), item('q4', 'open'), item('q5', 'superseded'), item('q6', 'resolved'), item('c1', 'open', 'commitment')],
      new Set(['r1:q6']),
      () => 'Think Tank',
    );
    expect(rows.map((r) => r.outcome)).toEqual(['answered', 'aged_out', 'ignored', 'open']);
    expect(rows.every((r) => r.kind === 'decision' && r.team === 'Think Tank')).toBe(true);
  });
});

describe('rollupPulls', () => {
  it('counts this week and last week apart, with the change', () => {
    const w = rollupPulls([rec(), rec({ kind: 'review', outcome: 'aged_out' }), rec({ at: ago(10) }), rec({ at: ago(20) }), rec({ at: ago(0) }), rec({ at: ago(3) })], NOW);
    // ago(0) is exactly "now": the window is [now-7d, now), so it is out.
    expect(w.thisWeek.total).toBe(3);
    expect(w.lastWeek.total).toBe(1);
    expect(w.change).toBe(2);
    expect(w.thisWeek.byKind).toEqual({ decision: 2, review: 1, fyi: 0, stuck: 0 });
    expect(w.thisWeek.byOutcome).toEqual({ answered: 2, aged_out: 1, ignored: 0, open: 0 });
  });

  it('groups by team, most pulls first', () => {
    const w = rollupPulls([rec({ team: 'B' }), rec({ team: 'A' }), rec({ team: 'A' }), rec({ team: 'C' })], NOW);
    expect(w.thisWeek.byTeam).toEqual([
      { team: 'A', count: 2 },
      { team: 'B', count: 1 },
      { team: 'C', count: 1 },
    ]);
  });

  it('ignores records with a bad time', () => {
    expect(rollupPulls([rec({ at: 'nope' })], NOW).thisWeek.total).toBe(0);
  });
});

describe('countOwnerTouches', () => {
  it('sums trace owner touches into this week and last week', () => {
    expect(
      countOwnerTouches(
        [
          { createdAt: ago(1), ownerTouches: 2 },
          { createdAt: ago(3), ownerTouches: 1 },
          { createdAt: ago(9), ownerTouches: 4 },
          { createdAt: ago(30), ownerTouches: 9 },
        ],
        NOW,
      ),
    ).toEqual({ thisWeek: 3, lastWeek: 4 });
  });
});

describe('renderPullsWeekly', () => {
  it('renders the line, kinds, outcomes, teams and owner touches', () => {
    const w = rollupPulls(
      [
        rec(),
        rec({ kind: 'review', outcome: 'aged_out', team: 'SteamFun' }),
        rec({ kind: 'stuck', outcome: 'ignored', team: 'SteamFun' }),
        rec({ at: ago(10) }),
      ],
      NOW,
      { thisWeek: 5, lastWeek: 2 },
    );
    expect(renderPullsWeekly(w)).toBe(
      [
        '*Pulled you in 3 times this week* (up 2 from last week)',
        '• By kind: 1 decision needed, 1 review or approval, 1 agent stuck or error',
        '• Answered 1, aged out 1, ignored 1',
        '• By team: SteamFun 2, CE 1',
        '• You replied or approved 5 times in runs (last week 2)',
      ].join('\n'),
    );
  });

  it('says "up" and caps the team list', () => {
    const recs = [rec({ at: ago(10) }), rec({ at: ago(11) }), ...['A', 'B', 'C', 'D', 'E'].map((team) => rec({ team }))];
    const text = renderPullsWeekly(rollupPulls(recs, NOW));
    expect(text).toContain('up 3 from last week');
    expect(text).toContain('By team: A 1, B 1, C 1, +2 more');
  });

  it('is empty when there were no pulls in either week, and singular for one', () => {
    expect(renderPullsWeekly(rollupPulls([], NOW))).toBe('');
    expect(renderPullsWeekly(rollupPulls([rec()], NOW)).split('\n')[0]).toBe('*Pulled you in 1 time this week* (up 1 from last week)');
  });

  it('shows the drop when this week had none', () => {
    expect(renderPullsWeekly(rollupPulls([rec({ at: ago(9) })], NOW))).toBe('*Pulled you in 0 times this week* (down 1 from last week)');
  });
});

describe('agent-started DM posts (FYI count)', () => {
  it('tells a question from a statement at the end of a post', () => {
    expect(endsWithQuestion('Draft is ready. Send it today?')).toBe(true);
    expect(endsWithQuestion('今天发吗？ 🙂')).toBe(true);
    expect(endsWithQuestion('Is this ok?" ')).toBe(true);
    expect(endsWithQuestion('Why? Because the deadline moved. Done.')).toBe(false);
  });

  it('counts a post that asked nothing as an FYI, a question as a decision, without an outcome', () => {
    const recs = pullsFromAgentPosts(
      [
        { at: ago(1), agent: 'ella', endsWithQuestion: false },
        { at: ago(2), agent: 'ella', endsWithQuestion: true },
      ],
      [],
      (s) => (s === 'ella' ? 'CE' : null),
    );
    expect(recs).toEqual([
      { at: ago(1), kind: 'fyi', team: 'CE', agent: 'ella' },
      { at: ago(2), kind: 'decision', team: 'CE', agent: 'ella' },
    ]);
  });

  it('leaves out a post made right around a card the same agent opened', () => {
    const at = ago(1);
    const near = new Date(Date.parse(at) + 60_000).toISOString();
    const recs = pullsFromAgentPosts(
      [
        { at: near, agent: 'atlas', endsWithQuestion: false },
        { at: near, agent: 'vera', endsWithQuestion: false },
      ],
      [card({ askedAt: at, asker: 'atlas', requestedBy: 'atlas' })],
      () => null,
    );
    expect(recs.map((r) => r.team)).toEqual(['Unassigned']);
    expect(recs).toHaveLength(1);
  });

  it('keeps a post next to a card that is not a pull (withdrawn or Crewly\'s own)', () => {
    const at = ago(1);
    const recs = pullsFromAgentPosts(
      [{ at, agent: 'atlas', endsWithQuestion: false }],
      [card({ askedAt: at, status: 'cancelled' }), card({ askedAt: at, system: { key: 'x' }, kind: 'runtime_terms' })],
      () => null,
    );
    expect(recs).toHaveLength(1);
  });

  it('shows FYIs in the kinds, and no outcome line when nothing has one', () => {
    const text = renderPullsWeekly(rollupPulls([rec({ kind: 'fyi', outcome: undefined }), rec({ kind: 'fyi', outcome: undefined })], NOW));
    expect(text).toContain('2 FYI that did not need an answer');
    expect(text).not.toMatch(/Answered|Open \d/);
  });
});

describe('stuck notices', () => {
  it('counts a stalled-work notice as stuck, with no outcome, and no card stands in for it', () => {
    const at = ago(1);
    const recs = pullsFromAgentPosts([{ at, agent: 'atlas', endsWithQuestion: false, kind: 'stuck' }], [card({ askedAt: at })], () => 'CE');
    expect(recs).toEqual([{ at, kind: 'stuck', team: 'CE', agent: 'atlas' }]);
  });
});

describe('top sources', () => {
  it('ranks the agents that caused the most pulls, with their team, and renders the top three', () => {
    const recs = [
      rec({ agent: 'Sam', team: 'CE' }),
      rec({ agent: 'Sam', team: 'CE' }),
      rec({ agent: 'Sam', team: 'CE' }),
      rec({ agent: 'Lee', team: 'SteamFun' }),
      rec({ agent: 'Lee', team: 'SteamFun' }),
      rec({ agent: 'Pia', team: 'CE' }),
      rec({ agent: 'Zed', team: 'CE' }),
      rec({ team: 'CE' }),
    ];
    const w = rollupPulls(recs, NOW);
    expect(w.thisWeek.bySource.map((s) => `${s.agent}/${s.team}/${s.count}`)).toEqual(['Sam/CE/3', 'Lee/SteamFun/2', 'Pia/CE/1', 'Zed/CE/1']);
    expect(renderPullsWeekly(w)).toContain('• Top sources: Sam (CE) 3, Lee (SteamFun) 2, Pia (CE) 1');
  });

  it('adds a decision card asker and an open-item agent as the source', () => {
    expect(pullsFromDecisions([card()], () => 'CE')[0].agent).toBe('atlas');
    const item = { id: 'q', type: 'question', text: 't', agent: 'vera', sourceMessageId: 'm', createdAt: ago(1), status: 'open' } as unknown as RequestOpenItem;
    expect(pullsFromOpenItems([{ requestId: 'r', item }], new Set(), () => 'CE')[0].agent).toBe('vera');
  });

  it('leaves the line out when no pull names an agent', () => {
    expect(renderPullsWeekly(rollupPulls([rec()], NOW))).not.toContain('Top sources');
  });
});

describe('owner active minutes', () => {
  const bucket = OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY.ACTIVE_BUCKET_MS;
  const t = (days: number, ms = 0): number => Math.floor((NOW.getTime() - days * DAY) / bucket) * bucket + ms;

  it('counts distinct buckets with an owner message, times the bucket, this week and last', () => {
    const times = [t(1), t(1, 1000), t(1, bucket - 1), t(1, bucket), t(3), t(9), t(9, 2 * bucket), NOW.getTime() + 1000, t(20), Number.NaN];
    // This week: day-1 bucket (3 messages) + next bucket + day-3 bucket = 3 buckets. Last week: 2.
    expect(countOwnerActiveMinutes(times, NOW)).toEqual({ thisWeek: (3 * bucket) / 60_000, lastWeek: (2 * bucket) / 60_000 });
  });

  it('is zero with no messages and shown next to the pull count only when there is activity', () => {
    expect(countOwnerActiveMinutes([], NOW)).toEqual({ thisWeek: 0, lastWeek: 0 });
    const withActive = rollupPulls([rec()], NOW, undefined, { thisWeek: 40, lastWeek: 55 });
    expect(renderPullsWeekly(withActive)).toContain('• You were active about 40 min (last week 55)');
    expect(renderPullsWeekly(rollupPulls([rec()], NOW, undefined, { thisWeek: 0, lastWeek: 0 }))).not.toContain('active');
  });
});
