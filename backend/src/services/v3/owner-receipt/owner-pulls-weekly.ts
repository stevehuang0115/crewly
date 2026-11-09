/**
 * Owner pulls, weekly (#1387) — how often agents put something in
 * front of the owner, by kind and by team, and what became of it.
 *
 * Measures only; it never changes when agents ping the owner. Pure functions:
 * the caller reads decisions / Request open items / traces and passes them in.
 * Spec: specs/owner-pulls-weekly.md.
 *
 * ## The rule for "FYI that did not need an answer"
 *
 * An agent post to the owner (a plain chat message, not a card) is an FYI when
 * ALL of these hold ({@link classifyAgentPost}):
 *  1. it did not end with a question,
 *  2. it did not open a decision card, and
 *  3. no WorkItem stayed blocked on the owner afterwards.
 * Any one of them failing makes it a "needed an answer" pull (a decision),
 * unless it reports a failure / stuck work (then it is `stuck`). This is the
 * issue's first guess; it is a rule on facts the harness already has, so the
 * owner is never asked per post. Decision cards always ask, so they are never
 * FYIs.
 *
 * @module services/v3/owner-receipt/owner-pulls-weekly
 */

import { OWNER_RECEIPT_CONSTANTS, PULLS_WEEKLY_KIND_LABELS } from '../../../constants.js';
import type { OwnerDecision } from '../../../types/decision.types.js';
import type { RequestOpenItem } from '../../../types/v2/open-item.types.js';

/** What the agent wanted from the owner. */
export type PullKind = 'decision' | 'review' | 'fyi' | 'stuck';

/** Every kind, in the order the line names them. */
export const PULL_KINDS: readonly PullKind[] = ['decision', 'review', 'fyi', 'stuck'];

/**
 * What became of a pull.
 * - `answered`: the owner chose / replied
 * - `aged_out`: the deadline passed and the default was applied, or it expired / parked unanswered
 * - `ignored`: the owner skipped it ("no need")
 * - `open`: still waiting
 */
export type PullOutcome = 'answered' | 'aged_out' | 'ignored' | 'open';

/** Every outcome, in the order the line names them. */
export const PULL_OUTCOMES: readonly PullOutcome[] = ['answered', 'aged_out', 'ignored', 'open'];

/** One agent pull on the owner. */
export interface PullRecord {
  /** When the agent pulled (ISO) */
  at: string;
  kind: PullKind;
  /** Team name, or the unknown-team label */
  team: string;
  /** What became of it; absent when nothing tracks it (a plain agent post) */
  outcome?: PullOutcome;
  /** Who caused it (display name or session); absent when unknown */
  agent?: string;
}

/** Facts about one agent post to the owner that is not a card. */
export interface AgentPostFacts {
  /** The post's last sentence is a question */
  endsWithQuestion: boolean;
  /** The agent opened a decision card for it */
  openedDecisionCard: boolean;
  /** A WorkItem stayed blocked on the owner after the post */
  workItemBlockedOnOwner: boolean;
  /** It reports an error, a failure or work that is stuck */
  reportsFailure: boolean;
}

/**
 * Classify a plain agent post by the FYI rule (see the module doc).
 *
 * @param facts - What the harness knows about the post
 * @returns `stuck` for a failure report, `decision` when it needed an answer, else `fyi`
 */
export function classifyAgentPost(facts: AgentPostFacts): PullKind {
  if (facts.reportsFailure) return 'stuck';
  if (facts.endsWithQuestion || facts.openedDecisionCard || facts.workItemBlockedOnOwner) return 'decision';
  return 'fyi';
}

/** Decision kinds that ask the owner to approve something an agent holds. */
const REVIEW_DECISION_KINDS: ReadonlySet<NonNullable<OwnerDecision['kind']>> = new Set([
  'browser_action',
  'gmail_send',
  'private_share',
  'app_collaborator',
  'app_template',
  'model_tier_change',
]);

/**
 * Kind of a decision card: a held action / merge / sensitive ask is a review
 * or approval, a spend cap is the agent being stopped, the rest are decisions.
 *
 * @param d - The card
 * @returns Its pull kind
 */
export function decisionPullKind(d: OwnerDecision): PullKind {
  if (d.kind === 'spend_cap') return 'stuck';
  if ((d.kind && REVIEW_DECISION_KINDS.has(d.kind)) || d.merge === true || d.sensitive !== undefined) return 'review';
  return 'decision';
}

/**
 * Outcome of a decision card, or null when the card does not count as a pull
 * (withdrawn by the agent before the owner dealt with it).
 *
 * @param d - The card
 * @returns Outcome or null
 */
export function decisionPullOutcome(d: OwnerDecision): PullOutcome | null {
  switch (d.status) {
    case 'resolved':
      // A default applied at the deadline is resolved with `answeredVia: 'deadline'`.
      return d.answeredVia === 'deadline' ? 'aged_out' : 'answered';
    case 'defaulted':
    case 'expired':
    case 'parked':
      return 'aged_out';
    case 'skipped':
      return 'ignored';
    case 'open':
      return 'open';
    case 'cancelled':
      return null;
    default:
      return null;
  }
}

/**
 * Turn decision cards into pull records. Cards the harness asks itself (runtime
 * terms, receipt format) are not agent pulls and are left out; a spend cap is
 * kept (an agent was stopped).
 *
 * @param decisions - Every card
 * @param teamOf - Team name for a card, or null
 * @returns Records
 */
export function pullsFromDecisions(decisions: readonly OwnerDecision[], teamOf: (d: OwnerDecision) => string | null): PullRecord[] {
  const out: PullRecord[] = [];
  for (const d of decisions) {
    if (d.system && d.kind !== 'spend_cap') continue;
    const outcome = decisionPullOutcome(d);
    if (!outcome) continue;
    out.push({
      at: d.askedAt ?? d.createdAt,
      kind: decisionPullKind(d),
      team: teamOf(d) ?? OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM,
      outcome,
      ...((d.asker || d.requestedBy) ? { agent: d.asker || d.requestedBy } : {}),
    });
  }
  return out;
}

/**
 * Turn the questions agents left in their replies (Request open items) into
 * pull records. A question already carded (a `reply_question` decision tracks
 * it) is counted once, by its card; superseded / cancelled items are not pulls.
 *
 * @param items - Open items with their Request id
 * @param cardedKeys - `requestId:itemId` of items that have a decision card
 * @param teamOfAgent - Team name for an agent session, or null
 * @returns Records
 */
export function pullsFromOpenItems(
  items: ReadonlyArray<{ requestId: string; item: RequestOpenItem }>,
  cardedKeys: ReadonlySet<string>,
  teamOfAgent: (session: string) => string | null,
): PullRecord[] {
  const out: PullRecord[] = [];
  for (const { requestId, item } of items) {
    if (item.type !== 'question' || cardedKeys.has(`${requestId}:${item.id}`)) continue;
    let outcome: PullOutcome;
    switch (item.status) {
      case 'resolved':
        outcome = 'answered';
        break;
      case 'skipped':
        outcome = 'ignored';
        break;
      case 'expired':
        outcome = 'aged_out';
        break;
      case 'open':
      case 'waiting_owner':
      case 'overdue':
      case 'ready':
        outcome = 'open';
        break;
      default:
        continue; // superseded / cancelled / delivered
    }
    out.push({
      at: item.createdAt,
      // A question left in a reply ends with a question by construction.
      kind: classifyAgentPost({ endsWithQuestion: true, openedDecisionCard: false, workItemBlockedOnOwner: false, reportsFailure: false }),
      team: teamOfAgent(item.agent) ?? OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM,
      outcome,
      ...(item.agent ? { agent: item.agent } : {}),
    });
  }
  return out;
}

/** An agent-started post in the owner's DM, as the post log keeps it. */
export interface AgentPostRecord {
  /** When it was posted (ISO) */
  at: string;
  /** Agent session that posted */
  agent: string;
  /** Its last sentence is a question */
  endsWithQuestion: boolean;
  /**
   * `stuck`: not a post but a notice that work stalled and was put in front of
   * the owner (the stall watcher's owner step); who and when only.
   */
  kind?: 'stuck';
}

/**
 * Whether a post's last sentence is a question (`?` or `？` at its end, past
 * trailing emoji, quotes and closing brackets).
 *
 * @param text - Post text
 * @returns True when it ends with a question
 */
export function endsWithQuestion(text: string): boolean {
  return /[?？][\s\p{Extended_Pictographic}\p{Pe}\p{Pf}"'*_~`]*$/u.test(text.trim());
}

/**
 * Turn agent-started posts in the owner's DM into pull records, by the FYI
 * rule. A post the same agent made right around a card it opened is that
 * card's post: the card already counts it. Whether a WorkItem then stayed
 * blocked on the owner is not known for a post, so rule 3 is not applied.
 *
 * @param posts - Logged posts
 * @param decisions - Every card (for rule 2)
 * @param teamOfAgent - Team name for an agent session, or null
 * @returns Records (no outcome: nothing tracks an answer to a plain post)
 */
export function pullsFromAgentPosts(
  posts: readonly AgentPostRecord[],
  decisions: readonly OwnerDecision[],
  teamOfAgent: (session: string) => string | null,
): PullRecord[] {
  const window = OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY.CARD_POST_WINDOW_MS;
  const cardTimes = new Map<string, number[]>();
  for (const d of decisions) {
    // Only a card that counts as a pull may stand in for the post.
    if ((d.system && d.kind !== 'spend_cap') || !decisionPullOutcome(d)) continue;
    const at = Date.parse(d.askedAt ?? d.createdAt);
    if (!Number.isFinite(at)) continue;
    for (const who of new Set([d.asker, d.requestedBy])) {
      if (who) cardTimes.set(who, [...(cardTimes.get(who) ?? []), at]);
    }
  }
  const out: PullRecord[] = [];
  for (const post of posts) {
    const at = Date.parse(post.at);
    if (!Number.isFinite(at)) continue;
    const stuck = post.kind === 'stuck';
    // A stuck notice is not a post a card could stand in for.
    const openedDecisionCard = !stuck && (cardTimes.get(post.agent) ?? []).some((t) => Math.abs(t - at) <= window);
    if (openedDecisionCard) continue;
    out.push({
      at: post.at,
      kind: classifyAgentPost({ endsWithQuestion: post.endsWithQuestion, openedDecisionCard, workItemBlockedOnOwner: false, reportsFailure: stuck }),
      team: teamOfAgent(post.agent) ?? OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM,
      agent: post.agent,
    });
  }
  return out;
}

/** Counts for one week. */
export interface PullsWeek {
  total: number;
  byKind: Record<PullKind, number>;
  /** Only pulls whose outcome is tracked (not plain agent posts) */
  byOutcome: Record<PullOutcome, number>;
  /** Most pulls first, then by name */
  byTeam: Array<{ team: string; count: number }>;
  /** The agents (with their team) that caused the most pulls, most first */
  bySource: Array<{ agent: string; team: string; count: number }>;
}

/** The weekly rollup. */
export interface PullsWeekly {
  /** Window of the counted week (ISO) */
  window: { from: string; to: string };
  thisWeek: PullsWeek;
  lastWeek: PullsWeek;
  /** `thisWeek.total - lastWeek.total` */
  change: number;
  /**
   * The owner's own touches in runs (trace owner-touch metrics: replies,
   * approvals, send-backs, corrections), when the caller supplied them.
   */
  ownerTouches?: { thisWeek: number; lastWeek: number };
  /**
   * Estimated minutes the owner was active (distinct 5-minute buckets with an
   * owner message, times the bucket), when the caller supplied message times.
   */
  ownerActiveMinutes?: { thisWeek: number; lastWeek: number };
}

function emptyWeek(): PullsWeek {
  return {
    total: 0,
    byKind: { decision: 0, review: 0, fyi: 0, stuck: 0 },
    byOutcome: { answered: 0, aged_out: 0, ignored: 0, open: 0 },
    byTeam: [],
    bySource: [],
  };
}

function countWeek(records: readonly PullRecord[], fromMs: number, toMs: number): PullsWeek {
  const week = emptyWeek();
  const teams = new Map<string, number>();
  const sources = new Map<string, { agent: string; team: string; count: number }>();
  for (const r of records) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t < fromMs || t >= toMs) continue;
    week.total += 1;
    week.byKind[r.kind] += 1;
    if (r.outcome) week.byOutcome[r.outcome] += 1;
    teams.set(r.team, (teams.get(r.team) ?? 0) + 1);
    if (r.agent) {
      const key = `${r.team}\u0000${r.agent}`;
      const src = sources.get(key) ?? { agent: r.agent, team: r.team, count: 0 };
      src.count += 1;
      sources.set(key, src);
    }
  }
  week.bySource = [...sources.values()].sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent) || a.team.localeCompare(b.team));
  week.byTeam = [...teams.entries()].map(([team, count]) => ({ team, count })).sort((a, b) => b.count - a.count || a.team.localeCompare(b.team));
  return week;
}

/**
 * Roll pulls up into this week and last week.
 *
 * @param records - All pull records (any age)
 * @param now - End of the counted week
 * @param ownerTouches - Optional owner-touch counts from traces
 * @param ownerActiveMinutes - Optional owner active minutes ({@link countOwnerActiveMinutes})
 * @returns The rollup
 */
export function rollupPulls(
  records: readonly PullRecord[],
  now: Date,
  ownerTouches?: { thisWeek: number; lastWeek: number },
  ownerActiveMinutes?: { thisWeek: number; lastWeek: number },
): PullsWeekly {
  const span = OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY.WINDOW_MS;
  const to = now.getTime();
  const from = to - span;
  const thisWeek = countWeek(records, from, to);
  const lastWeek = countWeek(records, from - span, from);
  return {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    thisWeek,
    lastWeek,
    change: thisWeek.total - lastWeek.total,
    ...(ownerTouches ? { ownerTouches } : {}),
    ...(ownerActiveMinutes ? { ownerActiveMinutes } : {}),
  };
}

/**
 * Sum the owner touches of traces whose root falls in each week.
 *
 * @param traces - Trace rows: root time and the owner-touch total from metrics
 * @param now - End of the counted week
 * @returns Counts for this and last week
 */
export function countOwnerTouches(
  traces: ReadonlyArray<{ createdAt: string; ownerTouches: number }>,
  now: Date,
): { thisWeek: number; lastWeek: number } {
  const span = OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY.WINDOW_MS;
  const to = now.getTime();
  const out = { thisWeek: 0, lastWeek: 0 };
  for (const t of traces) {
    const at = Date.parse(t.createdAt);
    if (!Number.isFinite(at) || at >= to) continue;
    if (at >= to - span) out.thisWeek += t.ownerTouches;
    else if (at >= to - 2 * span) out.lastWeek += t.ownerTouches;
  }
  return out;
}

/**
 * Estimate the owner's active minutes in each week from the times of their
 * messages: distinct buckets ({@link OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY.ACTIVE_BUCKET_MS})
 * holding at least one message, times the bucket length. Only times are read,
 * never text.
 *
 * @param messageTimes - Epoch ms of owner messages (any age)
 * @param now - End of the counted week
 * @returns Active minutes for this and last week
 */
export function countOwnerActiveMinutes(messageTimes: readonly number[], now: Date): { thisWeek: number; lastWeek: number } {
  const { WINDOW_MS: span, ACTIVE_BUCKET_MS: bucket } = OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY;
  const to = now.getTime();
  const thisBuckets = new Set<number>();
  const lastBuckets = new Set<number>();
  for (const t of messageTimes) {
    if (!Number.isFinite(t) || t >= to) continue;
    if (t >= to - span) thisBuckets.add(Math.floor(t / bucket));
    else if (t >= to - 2 * span) lastBuckets.add(Math.floor(t / bucket));
  }
  const minutes = bucket / 60_000;
  return { thisWeek: thisBuckets.size * minutes, lastWeek: lastBuckets.size * minutes };
}

/** `+3`, `-2`, `no change`. */
function changeWords(change: number): string {
  if (change === 0) return 'same as last week';
  return `${change > 0 ? 'up' : 'down'} ${Math.abs(change)} from last week`;
}

/**
 * Render the weekly line for the owner (Slack mrkdwn, at most seven lines, no
 * ticket or card numbers). Empty string when there were no pulls this week
 * and last week: nothing to say.
 *
 * @param w - The rollup
 * @returns Text or ''
 */
export function renderPullsWeekly(w: PullsWeekly): string {
  if (w.thisWeek.total === 0 && w.lastWeek.total === 0) return '';
  const { thisWeek } = w;
  const noun = thisWeek.total === 1 ? 'time' : 'times';
  const lines = [`*Pulled you in ${thisWeek.total} ${noun} this week* (${changeWords(w.change)})`];
  if (thisWeek.total > 0) {
    const kinds = PULL_KINDS.filter((k) => thisWeek.byKind[k] > 0).map((k) => `${thisWeek.byKind[k]} ${PULLS_WEEKLY_KIND_LABELS[k]}`);
    lines.push(`• By kind: ${kinds.join(', ')}`);
    const outcomes = PULL_OUTCOMES.filter((o) => thisWeek.byOutcome[o] > 0).map((o) => `${o.replace('_', ' ')} ${thisWeek.byOutcome[o]}`);
    if (outcomes.length > 0) lines.push(`• ${outcomes.join(', ').replace(/^./, (c) => c.toUpperCase())}`);
    const max = OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY.MAX_TEAMS;
    const shown = thisWeek.byTeam.slice(0, max).map((t) => `${t.team} ${t.count}`);
    const rest = thisWeek.byTeam.length - shown.length;
    lines.push(`• By team: ${shown.join(', ')}${rest > 0 ? `, +${rest} more` : ''}`);
    const sources = thisWeek.bySource.slice(0, OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY.MAX_SOURCES).map((s) => `${s.agent} (${s.team}) ${s.count}`);
    if (sources.length > 0) lines.push(`• Top sources: ${sources.join(', ')}`);
  }
  if (w.ownerActiveMinutes && w.ownerActiveMinutes.thisWeek + w.ownerActiveMinutes.lastWeek > 0) {
    lines.push(`• You were active about ${w.ownerActiveMinutes.thisWeek} min (last week ${w.ownerActiveMinutes.lastWeek})`);
  }
  if (w.ownerTouches && w.ownerTouches.thisWeek + w.ownerTouches.lastWeek > 0) {
    lines.push(`• You replied or approved ${w.ownerTouches.thisWeek} times in runs (last week ${w.ownerTouches.lastWeek})`);
  }
  return lines.join('\n');
}
