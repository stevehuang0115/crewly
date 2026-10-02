/**
 * Approval activity — what agents asked the owner to allow, what was held
 * for the owner, and how each one ended, over the last N days
 * (`GET /api/security/approvals?days=7`, Settings › Security).
 *
 * Read-only. It aggregates the stores that already keep history:
 * - owner decision cards (`owner-decisions.json`, settled ones kept 30 days):
 *   every ask-owner question, sensitive asks (publish / email / deploy /
 *   spend), held browser actions, runtime-terms consents, spend-cap cards;
 * - held browser actions (`browser-pending-actions.json`, settled ones kept
 *   7 days): approved / refused / timed out;
 * - WhatsApp drafts that wait for the owner's 「发 W<n>」 (SQLite, when the
 *   inbox is set up);
 * - Gmail sends held for the owner (in memory: only the ones waiting now).
 *
 * Blocks that leave no record — the control-plane command guard (a hook
 * script exiting 2), mission policy, quality gate, team budget and cold
 * launch refusals — are reported as not tracked, never estimated.
 *
 * @module services/security/approval-activity.service
 */

import type { OwnerDecision } from '../../types/decision.types.js';
import type { HeldBrowserAction } from '../browser/held-action-store.js';
import type { WhatsAppDraft } from '../../types/whatsapp.types.js';
import type { HeldSend } from '../google/gmail-send-gate.js';

/** Days the endpoint accepts. */
export const APPROVAL_ACTIVITY_DAYS = [7, 30] as const;

/** How long settled browser holds are kept (BROWSER_APPROVAL_CONSTANTS.KEEP_SETTLED_MS). */
export const BROWSER_HISTORY_DAYS = 7;

/** Most items returned. */
export const MAX_ACTIVITY_ITEMS = 100;

/** Blocks the backend does not record anywhere (so they can't be counted). */
export const UNTRACKED_BLOCK_SOURCES = [
  'Command guard (blocked shell commands)',
  'Mission policy',
  'Quality gate',
  'Team budget',
  'Starting a team without approval',
] as const;

/** How an item ended. */
export type ActivityOutcome = 'approved' | 'denied' | 'answered' | 'expired' | 'withdrawn' | 'waiting' | 'sending' | 'sent' | 'discarded';

/** What kind of thing it was. */
export type ActivityCategory = 'question' | 'sensitive' | 'browser' | 'runtime_terms' | 'spend_cap' | 'whatsapp' | 'gmail';

/** One row of the recent list. */
export interface ActivityItem {
  id: string;
  category: ActivityCategory;
  /** Sensitive kind (publish / email / deploy / spend) when it is one */
  sensitive?: string;
  /** What it was, in the asker's words */
  title: string;
  /** Agent session that asked / was held */
  agentSession?: string;
  /** Its display name, when known */
  agent?: string;
  outcome: ActivityOutcome;
  /** The option the owner chose, when one was */
  answer?: string;
  /** When it was asked / held (ISO) */
  at: string;
  /** When it ended (ISO) */
  settledAt?: string;
  /** Decision card id (`D-n`) */
  decisionId?: string;
  /** Request it belongs to (links to `/tickets/requests/:id`) */
  requestId?: string;
  /** Work item / run it belongs to (links to `/tickets/runs/:id`) */
  workItemId?: string;
  /** Project ticket it belongs to */
  ticket?: { projectId: string; id: string; title: string };
}

/** Outcome counts. */
export interface OutcomeCounts {
  approved: number;
  denied: number;
  /** Answered with an option that is neither yes nor no */
  answered: number;
  /** Deadline passed (expired, or settled on its default) */
  expired: number;
  /** Withdrawn by the asker or skipped */
  withdrawn: number;
  /** Still waiting for the owner, any age */
  waiting: number;
}

/** A count from a source that may keep no history. */
export interface TrackedCount<T> {
  tracked: boolean;
  /** Why not, or a limit of what is counted */
  note?: string;
  counts?: T;
}

/** What `GET /api/security/approvals` returns. */
export interface ApprovalActivity {
  days: number;
  /** Window start, ISO */
  since: string;
  /** Operations blocked outright: no source records them today */
  blocked: TrackedCount<{ total: number }> & { sources: readonly string[] };
  /** Owner decision cards asked in the window */
  asked: number;
  outcomes: OutcomeCounts;
  /** Browser actions held for approval */
  browser: TrackedCount<{ held: number; approved: number; refused: number; expired: number; waiting: number }>;
  /** Sensitive decision cards in the window */
  sensitive: { total: number; publish: number; email: number; deploy: number; spend: number };
  /** Runtime Terms of Service consent cards in the window */
  runtimeTerms: { asked: number; accepted: number; declined: number; waiting: number };
  /** WhatsApp replies drafted by agents that wait for the owner's go */
  whatsapp: TrackedCount<{ held: number; sent: number; discarded: number; waiting: number; sending: number }>;
  /** Gmail sends held for the owner (only the ones waiting now are known) */
  gmail: TrackedCount<{ waiting: number }>;
  /** Newest first */
  items: ActivityItem[];
}

/** Collaborators (each may be unavailable; tests inject fakes). */
export interface ApprovalActivityDeps {
  /** Decision cards created at or after `since` plus every one still waiting */
  decisions: (sinceMs: number) => Promise<OwnerDecision[]>;
  /** Held browser actions raised at or after `since`; null when the browser approval service isn't running */
  browserHolds: (sinceMs: number) => Promise<HeldBrowserAction[] | null>;
  /** WhatsApp drafts proposed at or after `since`; null when the inbox isn't set up */
  whatsappDrafts: (sinceMs: number) => Promise<WhatsAppDraft[] | null>;
  /** Gmail sends held right now */
  gmailHeld: () => HeldSend[];
  /** Display name of a session */
  nameOf: (session: string) => string | undefined;
  now?: () => Date;
}

const PENDING = new Set(['open', 'parked']);
/** Sensitive asks counted on their own (browser actions and Terms have their own counts). */
const SENSITIVE_KINDS = new Set<string>(['publish', 'email', 'deploy', 'spend']);
const DENY_RE = /(^\s*no\b|\bdeny\b|\bdon'?t\b|\bdo not\b|\breject|\brefuse|\bdecline|\bstop\b|\bcancel\b|\bkeep (it )?stopped\b|\bnot now\b|\bskip\b|\bdiscard)/i;
const APPROVE_RE = /(^\s*(yes|ok|okay|sure|go|do it)\b|\bapprove|\ballow|\bagree|\baccept|\bsend\b|\bpublish|\bdeploy|\bship\b|\bmerge\b|\bproceed|\bcontinue|\bboost|\bunlimited|\bgo ahead|\bkeep going)/i;

/**
 * Whether an option label reads as yes, no, or neither.
 *
 * @param label - Option label the owner chose
 * @returns `approved`, `denied` or `answered`
 */
export function classifyAnswer(label: string | undefined): 'approved' | 'denied' | 'answered' {
  if (!label) return 'answered';
  if (DENY_RE.test(label)) return 'denied';
  if (APPROVE_RE.test(label)) return 'approved';
  return 'answered';
}

/**
 * How a decision card ended.
 *
 * @param d - Decision
 * @returns Outcome and the chosen label
 */
export function decisionOutcome(d: Pick<OwnerDecision, 'status' | 'chosenKey' | 'options' | 'answerText'>): { outcome: ActivityOutcome; answer?: string } {
  if (PENDING.has(d.status)) return { outcome: 'waiting' };
  if (d.status === 'expired' || d.status === 'defaulted') return { outcome: 'expired' };
  if (d.status === 'cancelled' || d.status === 'skipped') return { outcome: 'withdrawn' };
  const label = d.options.find((o) => o.key === d.chosenKey)?.label ?? d.answerText;
  return { outcome: classifyAnswer(label), ...(label ? { answer: label } : {}) };
}

/**
 * Category of a decision card.
 *
 * @param d - Decision
 * @returns Category
 */
export function decisionCategory(d: Pick<OwnerDecision, 'kind' | 'sensitive'>): ActivityCategory {
  if (d.kind === 'browser_action' || d.sensitive === 'browser_action') return 'browser';
  if (d.kind === 'runtime_terms' || d.sensitive === 'runtime_terms') return 'runtime_terms';
  if (d.kind === 'spend_cap') return 'spend_cap';
  if (d.sensitive) return 'sensitive';
  return 'question';
}

/**
 * Clamp the requested window to 7 or 30 days.
 *
 * @param raw - Query value
 * @returns 7 or 30
 */
export function parseActivityDays(raw: unknown): number {
  return Number(raw) >= 30 ? 30 : 7;
}

/**
 * Approval activity aggregator.
 */
export class ApprovalActivityService {
  private readonly now: () => Date;

  /** @param deps - Collaborators */
  constructor(private readonly deps: ApprovalActivityDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Aggregate the window.
   *
   * @param days - 7 or 30
   * @returns Activity
   */
  async query(days: number): Promise<ApprovalActivity> {
    const n = parseActivityDays(days);
    const nowMs = this.now().getTime();
    const sinceMs = nowMs - n * 24 * 60 * 60 * 1000;
    const [decisions, holds, drafts] = await Promise.all([
      this.deps.decisions(sinceMs).catch(() => [] as OwnerDecision[]),
      this.deps.browserHolds(sinceMs).catch(() => null),
      this.deps.whatsappDrafts(sinceMs).catch(() => null),
    ]);
    const gmail = (() => {
      try {
        return this.deps.gmailHeld();
      } catch {
        return [] as HeldSend[];
      }
    })();

    const items: ActivityItem[] = [];
    const outcomes: OutcomeCounts = { approved: 0, denied: 0, answered: 0, expired: 0, withdrawn: 0, waiting: 0 };
    const sensitive = { total: 0, publish: 0, email: 0, deploy: 0, spend: 0 };
    const terms = { asked: 0, accepted: 0, declined: 0, waiting: 0 };
    let asked = 0;
    const decisionIds = new Set<string>();

    for (const d of decisions) {
      const created = Date.parse(d.createdAt);
      const inWindow = Number.isFinite(created) && created >= sinceMs;
      const { outcome, answer } = decisionOutcome(d);
      if (!inWindow && outcome !== 'waiting') continue;
      if (inWindow) asked += 1;
      outcomes[outcome as keyof OutcomeCounts] += 1;
      const category = decisionCategory(d);
      if (inWindow && d.sensitive && SENSITIVE_KINDS.has(d.sensitive)) {
        sensitive.total += 1;
        sensitive[d.sensitive as 'publish' | 'email' | 'deploy' | 'spend'] += 1;
      }
      if (category === 'runtime_terms') {
        if (inWindow) terms.asked += 1;
        if (outcome === 'approved') terms.accepted += 1;
        else if (outcome === 'denied') terms.declined += 1;
        else if (outcome === 'waiting') terms.waiting += 1;
      }
      decisionIds.add(d.id);
      const session = d.browser?.agentSession ?? d.requestedBy;
      items.push({
        id: d.id,
        category,
        ...(d.sensitive && category === 'sensitive' ? { sensitive: d.sensitive } : {}),
        title: d.title || d.question,
        ...(session ? { agentSession: session, agent: this.deps.nameOf(session) ?? session } : {}),
        outcome,
        ...(answer ? { answer } : {}),
        at: d.createdAt,
        ...(d.resolvedAt ? { settledAt: d.resolvedAt } : {}),
        decisionId: d.id,
        ...(d.requestRef?.requestId ? { requestId: d.requestRef.requestId } : {}),
        ...(d.workItemId ? { workItemId: d.workItemId } : {}),
        ...(d.ticket ? { ticket: { projectId: d.ticket.projectId, id: d.ticket.id, title: d.ticket.title } } : {}),
      });
    }

    let browser: ApprovalActivity['browser'];
    if (holds === null) {
      browser = { tracked: false, note: 'Browser approvals are not running on this machine.' };
    } else {
      const c = { held: 0, approved: 0, refused: 0, expired: 0, waiting: 0 };
      for (const a of holds) {
        if (a.raisedAt < sinceMs && a.status !== 'pending') continue;
        if (a.raisedAt >= sinceMs) c.held += 1;
        if (a.status === 'approved') c.approved += 1;
        else if (a.status === 'rejected') c.refused += 1;
        else if (a.status === 'pending') c.waiting += 1;
        else c.expired += 1;
        if (a.decisionId && decisionIds.has(a.decisionId)) continue;
        items.push({
          id: a.pendingId,
          category: 'browser',
          title: `${a.target}${a.where ? ` on ${a.where}` : ''}`,
          agentSession: a.agentSession,
          agent: a.agentName ?? this.deps.nameOf(a.agentSession) ?? a.agentSession,
          outcome: a.status === 'approved' ? 'approved' : a.status === 'rejected' ? 'denied' : a.status === 'pending' ? 'waiting' : 'expired',
          at: new Date(a.raisedAt).toISOString(),
          ...(a.settledAt ? { settledAt: new Date(a.settledAt).toISOString() } : {}),
          ...(a.decisionId ? { decisionId: a.decisionId } : {}),
        });
      }
      browser = { tracked: true, counts: c, ...(n > BROWSER_HISTORY_DAYS ? { note: `Settled browser actions are kept ${BROWSER_HISTORY_DAYS} days.` } : {}) };
    }

    let whatsapp: ApprovalActivity['whatsapp'];
    if (drafts === null) {
      whatsapp = { tracked: false, note: 'The WhatsApp inbox is not set up on this machine.' };
    } else {
      const c = { held: 0, sent: 0, discarded: 0, waiting: 0, sending: 0 };
      for (const w of drafts) {
        // Only agent drafts wait for the owner's go; the owner's own are not holds.
        if (!w.createdBy) continue;
        if (w.createdAt < sinceMs && w.status !== 'pending' && w.status !== 'sending') continue;
        if (w.createdAt >= sinceMs) c.held += 1;
        // `sending`: the owner said go and it is on its way — in progress, not waiting on the owner.
        const outcome: ActivityOutcome =
          w.status === 'sent' ? 'sent' : w.status === 'discarded' ? 'discarded' : w.status === 'sending' ? 'sending' : 'waiting';
        if (outcome === 'sent') c.sent += 1;
        else if (outcome === 'discarded') c.discarded += 1;
        else if (outcome === 'sending') c.sending += 1;
        else c.waiting += 1;
        items.push({
          id: w.id,
          category: 'whatsapp',
          title: `WhatsApp reply ${w.code}`,
          agentSession: w.createdBy,
          agent: this.deps.nameOf(w.createdBy) ?? w.createdBy,
          outcome,
          at: new Date(w.createdAt).toISOString(),
          ...(w.sentAt || w.discardedAt ? { settledAt: new Date((w.sentAt ?? w.discardedAt) as number).toISOString() } : {}),
        });
      }
      whatsapp = { tracked: true, counts: c };
    }

    for (const g of gmail) {
      items.push({
        id: g.id,
        category: 'gmail',
        title: `Email "${g.subject}" to ${g.to}`,
        agentSession: g.agentSession,
        agent: this.deps.nameOf(g.agentSession) ?? g.agentSession,
        outcome: 'waiting',
        at: new Date(g.heldAt).toISOString(),
      });
    }

    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return {
      days: n,
      since: new Date(sinceMs).toISOString(),
      blocked: { tracked: false, note: 'These blocks are not recorded yet, so they can\'t be counted.', sources: UNTRACKED_BLOCK_SOURCES },
      asked,
      outcomes,
      browser,
      sensitive,
      runtimeTerms: terms,
      whatsapp,
      gmail: { tracked: true, note: 'Only the sends waiting now are known; settled ones are not kept.', counts: { waiting: gmail.length } },
      items: items.slice(0, MAX_ACTIVITY_ITEMS),
    };
  }
}
