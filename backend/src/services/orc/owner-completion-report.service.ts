/**
 * Finished owner-requested work is always reported back where the owner asked.
 *
 * Incident 2026-10-07: the owner commented in the schedule app about a "Zeng
 * Ming three-stage opportunity map". Lyra answered in the comment's Slack
 * thread "draft goes to you first", Ella opened CREW-305/309/310 and
 * delegated them; everything was verified by 17:37Z and nobody told the
 * owner. Nothing in the harness asked for that report.
 *
 * A CHAIN is every work item whose owner origin names the same place (an app
 * comment, a Slack thread / DM, a chat conversation) and records who received
 * the owner's request (`origin.receivedBy` — set only on work an agent created
 * while handling the owner's message, and inherited by its delegations,
 * verify items and retries). Trigger / cron / agent-internal work has no
 * owner origin and never forms a chain.
 *
 * When the last open item of a chain is closed (verified / done; cancelled
 * and failed items count as closed, at least one must have succeeded):
 *
 *  1. after SETTLE_MS of staying closed (the lead may still hand out the next
 *     step) — unless an agent already answered in the owner's place after
 *     the work finished — the responsible agent (`receivedBy`) gets ONE
 *     nudge asking it to report the result there, in plain words;
 *  2. no agent answer there within NUDGE_GRACE_MS → the harness posts ONE
 *     line there itself (as the agent's bot when it can): the deliverable in
 *     plain words, in the owner's language, no ids / links / files / sizes
 *     (crewly#1357, `owner-completion-report.text.ts`).
 *
 * Only a genuine owner origin forms a chain: work an agent delegated on its
 * own initiative carries an agent origin (crewly#1357) and is never reported
 * to the owner by the harness.
 *
 * Team work the orchestrator delegated for the owner (stamped with a lead
 * report, crewly#1371) forms its own chain per team: the team lead is the
 * responsible agent, the nudge asks it to report in the team channel, and the
 * fallback line is posted there as the lead — never in the orchestrator's
 * thread. Only `reply --work-item` on the chain's items counts as its report.
 *
 * Each chain is handled once (persisted, so a restart neither repeats nor
 * forgets a step). Work added to the same place after a chain was handled
 * starts a new chain. Chains whose responsible agent is the orchestrator are
 * skipped: OrcDeliveryEnforcer already keeps reminding the orc until it
 * answers. The owner only reads; nothing here asks the owner to act.
 *
 * Harness text to agents is English; the one line to the owner is in the
 * owner's language.
 *
 * @module services/orc/owner-completion-report.service
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, OWNER_COMPLETION_REPORT_CONSTANTS as C, TEAM_LEAD_REPORT_CONSTANTS } from '../../constants.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { isPastReminderCutoff, leadStaleNotice, reminderFooter } from './harness-reminder.js';
import { detectOwnerLanguage, fallbackLine, leadFallbackLine, type OwnerLanguage } from './owner-completion-report.text.js';
import { leadReportOf, originOfWorkItem, type LeadReport, type WorkItemOrigin } from './work-item-destination.js';
import { approvalLink } from './team-lead-report.js';

/** An owner origin. */
export type OwnerOrigin = Extract<WorkItemOrigin, { kind: 'owner' }>;

/** Where the owner asked, resolved for posting. */
export type ReportPlace =
  | { kind: 'app-comment'; appId: string; commentId: string; slackChannelId?: string; threadTs?: string; label: string }
  | { kind: 'slack'; slackChannelId: string; threadTs?: string; label: string }
  | { kind: 'chat'; conversationId: string; chatThreadId?: string; label: string };

/** Statuses after which a work item is not going to do more. */
const CLOSED: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['done', 'verified', 'cancelled', 'failed']);
/** Statuses that mean the work succeeded. */
const SUCCEEDED: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['done', 'verified']);

/**
 * The place key of an owner origin: one per app comment / Slack thread (or
 * DM) / chat conversation thread.
 *
 * @param origin - Owner origin
 * @returns Key, or null when the origin names no place
 */
export function ownerPlaceKey(origin: OwnerOrigin): string | null {
  if (origin.appComment?.appId && origin.appComment.commentId) return `app:${origin.appComment.appId}/${origin.appComment.commentId}`;
  if (origin.slackChannelId) return origin.threadTs ? `slack:${origin.slackChannelId}:${origin.threadTs}` : `slack:${origin.slackChannelId}`;
  if (origin.conversationId) return origin.chatThreadId ? `chat:${origin.conversationId}:${origin.chatThreadId}` : `chat:${origin.conversationId}`;
  return null;
}

/**
 * The keys an answer in this place is recorded under (an app comment is also
 * answered in its Slack thread).
 *
 * @param origin - Owner origin
 * @param place - Its resolved place, when known
 * @returns Answer keys
 */
export function answerKeysOf(origin: OwnerOrigin, place?: ReportPlace | null): string[] {
  const keys = new Set<string>();
  const own = ownerPlaceKey(origin);
  if (own) keys.add(own);
  const ch = place && place.kind !== 'chat' ? place.slackChannelId : origin.slackChannelId;
  const ts = place && place.kind !== 'chat' ? place.threadTs : origin.threadTs;
  if (ch) keys.add(ts ? `slack:${ch}:${ts}` : `slack:${ch}`);
  if (origin.conversationId) keys.add(origin.chatThreadId ? `chat:${origin.conversationId}:${origin.chatThreadId}` : `chat:${origin.conversationId}`);
  return [...keys];
}

/** One chain of owner-requested work. */
export interface OwnerChain {
  key: string;
  origin: OwnerOrigin;
  items: WorkItem[];
  /** Some item is still open */
  open: boolean;
  /** At least one item succeeded */
  succeeded: boolean;
  /** Who received the owner's request (the team lead for team work, crewly#1371) */
  responsible: string;
  /** Team work the orchestrator delegated: the lead reports it in the team channel (crewly#1371) */
  leadReport?: LeadReport;
  /** Earliest / latest creation of its items (epoch ms) */
  firstCreatedAt: number;
  lastCreatedAt: number;
  /** When the work itself finished (latest completion of a non-verify item, epoch ms) */
  finishedAt: number;
  /**
   * When the last work was handed over (epoch ms, <= finishedAt): per work item,
   * the earlier of its completion and the creation of its verify item. A lead
   * usually posts the result in the owner's place while verifying, i.e. before
   * the item is marked verified (#1330), so answers count from here.
   */
  workDoneAt: number;
  /**
   * When the work started (earliest start, else creation, of a non-verify
   * item, epoch ms). A teammate or delegatee usually posts the deliverable in
   * the owner's thread and only then closes its item (crewly#1376): their
   * posts count as the report from here.
   */
  workStartedAt: number;
  /** Who the chain's work items were assigned to (sessions) */
  workers: string[];
}

const ms = (iso: string | undefined): number => Date.parse(iso ?? '') || 0;
const endOf = (wi: WorkItem): number => ms(wi.completedAt) || ms(wi.statusChangedAt) || ms(wi.createdAt);
const isVerifyItem = (wi: WorkItem): boolean => typeof (wi.metadata ?? {}).verifyOf === 'string';

/**
 * Group the pool into owner chains.
 *
 * @param items - Pool items
 * @param handledThrough - Per place key: items created at or before this (epoch ms) belong to a chain already handled
 * @returns Chains (only places with at least one item)
 */
export function collectOwnerChains(items: readonly WorkItem[], handledThrough: Readonly<Record<string, number>>): OwnerChain[] {
  const groups = new Map<string, { origin: OwnerOrigin; items: WorkItem[] }>();
  for (const wi of items) {
    const origin = originOfWorkItem(wi);
    if (origin?.kind !== 'owner' || !origin.receivedBy) continue;
    const placeKey = ownerPlaceKey(origin);
    if (!placeKey) continue;
    // Team work its lead reports (crewly#1371): one chain per team, so a thread
    // that holds items of two teams is reported by each team's lead separately.
    const stamp = leadReportOf(wi);
    const key = stamp ? `${placeKey}#team:${stamp.teamId}` : placeKey;
    if (ms(wi.createdAt) <= (handledThrough[key] ?? -Infinity)) continue;
    const g = groups.get(key) ?? { origin, items: [] };
    g.items.push(wi);
    groups.set(key, g);
  }
  const chains: OwnerChain[] = [];
  for (const [key, g] of groups) {
    const sorted = [...g.items].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    const first = sorted[0];
    const firstOrigin = (originOfWorkItem(first) as OwnerOrigin | null) ?? g.origin;
    const work = sorted.filter((w) => !isVerifyItem(w));
    const verifyCreated = new Map<string, number>();
    for (const v of sorted) {
      const of = (v.metadata ?? {}).verifyOf;
      if (typeof of !== 'string') continue;
      const at = ms(v.createdAt);
      if (at && at < (verifyCreated.get(of) ?? Infinity)) verifyCreated.set(of, at);
    }
    const finishedAt = Math.max(...(work.length ? work : sorted).map(endOf));
    const handedOver = (w: WorkItem): number => Math.min(endOf(w), verifyCreated.get(w.id) ?? Infinity);
    const leadReport = sorted.map((w) => leadReportOf(w)).find((r): r is LeadReport => !!r);
    chains.push({
      key,
      origin: firstOrigin,
      items: sorted,
      open: sorted.some((w) => !CLOSED.has(w.status)),
      succeeded: sorted.some((w) => SUCCEEDED.has(w.status)),
      responsible: leadReport?.lead ?? firstOrigin.receivedBy ?? first.target ?? '',
      ...(leadReport ? { leadReport } : {}),
      firstCreatedAt: ms(first.createdAt),
      lastCreatedAt: Math.max(...sorted.map((w) => ms(w.createdAt))),
      finishedAt,
      workDoneAt: Math.min(finishedAt, Math.max(...(work.length ? work : sorted).map(handedOver))),
      workStartedAt: Math.min(...(work.length ? work : sorted).map((w) => ms(w.startedAt) || ms(w.createdAt))),
      workers: [...new Set(sorted.map((w) => w.target).filter((t): t is string => typeof t === 'string' && !!t))],
    });
  }
  return chains;
}

/** Shorten to one line. */
function clip(text: string | undefined, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The titles of a chain's work (verify items left out), for a message.
 *
 * @param items - Chain items
 * @returns `"A", "B" and 2 more`
 */
export function titlesLine(items: readonly WorkItem[]): string {
  const work = items.filter((w) => !isVerifyItem(w) && SUCCEEDED.has(w.status));
  const titles = [...new Set((work.length ? work : items).map((w) => clip(w.title, C.TITLE_MAX_CHARS)).filter(Boolean))];
  const shown = titles.slice(0, C.MAX_TITLES).map((t) => `"${t}"`);
  const more = titles.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/**
 * What the finished items delivered, for the owner's one line: the result
 * summary of each succeeded work item when it has one, else its title.
 *
 * @param items - Chain items
 * @returns Raw texts (plain-worded later by `owner-completion-report.text.ts`)
 */
export function deliverableTexts(items: readonly WorkItem[]): string[] {
  const out: string[] = [];
  for (const wi of items) {
    if (isVerifyItem(wi) || !SUCCEEDED.has(wi.status)) continue;
    const bag = { ...(wi.output ?? {}), ...(wi.result ?? {}) } as Record<string, unknown>;
    const summary = typeof bag.summary === 'string' && bag.summary.trim() ? bag.summary : null;
    out.push(summary ?? wi.title ?? '');
  }
  return out;
}

/**
 * The titles a legacy record's `titles` line names (`"A", "B" and 2 more`).
 *
 * @param line - The titles line
 * @returns Titles
 */
function titlesOf(line: string): string[] {
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** One chain's report state (persisted). */
export interface ChainReportRecord {
  /** `<place key>#<first item created at>` */
  id: string;
  key: string;
  origin: OwnerOrigin;
  responsible: string;
  workItemIds: string[];
  titles: string;
  /** The item `reply --work-item` names */
  replyWorkItemId: string;
  /** What the work delivered (titles / summaries), for the fallback line; older records lack it */
  deliverables?: string[];
  firstCreatedAt: number;
  lastCreatedAt: number;
  finishedAt: number;
  /** Answers posted after this count as the report (see {@link OwnerChain.workDoneAt}); older records lack it */
  answerFrom?: number;
  /** Teammates' / delegatees' posts after this count as the report (crewly#1376); older records lack it */
  workStartedAt?: number;
  /** Sessions the chain's work items were assigned to (crewly#1376); older records lack it */
  workers?: string[];
  /** Team work: the lead reports it in the team channel (crewly#1371) */
  leadReport?: LeadReport;
  /**
   * `settling` (closed, waiting SETTLE_MS) → `asked` (the one nudge) →
   * `posted`; `answered`: an agent answered in the owner's place; `skipped`:
   * the orc's own enforcer covers it. `reminded` is kept for records written
   * before crewly#1357 (treated like `asked`).
   */
  stage: 'settling' | 'asked' | 'reminded' | 'posted' | 'answered' | 'skipped';
  closedSince: number;
  askedAt?: number;
  remindedAt?: number;
  postedAt?: number;
  endedAt?: number;
}

interface StoreShape {
  version: 1;
  /** Chains finished before this (epoch ms) are never reported (first start) */
  since: number;
  /** Place key → items created at or before this belong to a handled chain */
  handledThrough: Record<string, number>;
  /** Place key → the chain being reported */
  active: Record<string, ChainReportRecord>;
  /** Handled chains (id → ended at), for de-duplication */
  ended: Record<string, number>;
  /** Answer key → last agent answer there (epoch ms) */
  answers: Record<string, number>;
  /** Answer key → agent session → its last post there (epoch ms), when the author is known (crewly#1376) */
  answersBy: Record<string, Record<string, number>>;
}

/** Collaborators (all injectable). */
export interface OwnerCompletionReportDeps {
  /** Every work item in the pool */
  listItems: () => Promise<WorkItem[]>;
  /** Deliver a message to an agent (waking it when it is down); true when it was taken */
  deliver: (session: string, text: string) => Promise<boolean>;
  /** Resolve where the owner asked (null: nowhere to report) */
  resolvePlace: (origin: OwnerOrigin) => Promise<ReportPlace | null>;
  /** Post the harness's own summary in that place, as the agent when possible; true when posted */
  postFallback: (place: ReportPlace, agentSession: string, text: string) => Promise<boolean>;
  /** The language the owner writes in at that place (null: unknown → English) */
  ownerLanguage?: (origin: OwnerOrigin, place: ReportPlace | null) => Promise<OwnerLanguage | null>;
  /** Tell the responsible agent's team lead something (finished work too old to ask a report for); false when it could not */
  notifyLead?: (agentSession: string, text: string) => Promise<boolean>;
  /** Display name of an agent */
  displayNameOf?: (session: string) => string;
  /** The agent's teammates (sessions of every team it belongs to); their posts can be the report (crewly#1376) */
  teammatesOf?: (session: string) => Promise<readonly string[]> | readonly string[];
  /** The app-comments command agents run (`bash <skills>/core/app-comments/execute.sh`) */
  appCommentsCmd?: string;
  /** Crewly home (store directory) */
  crewlyHome: string;
  now?: () => number;
  logger?: ComponentLogger;
}

/** The harness rule that finished owner-requested work is reported to the owner. */
export class OwnerCompletionReportService {
  private readonly file: string;
  private store: StoreShape;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private answersDirty = false;
  private readonly log: ComponentLogger;

  constructor(private readonly deps: OwnerCompletionReportDeps) {
    this.file = path.join(deps.crewlyHome, C.STORE_FILE);
    this.log = deps.logger ?? LoggerService.getInstance().createComponentLogger('OwnerCompletionReport');
    this.store = this.load();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Start the periodic scan (idempotent). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), C.TICK_MS);
    this.timer.unref?.();
  }

  /** Stop the periodic scan. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.answersDirty) this.save();
  }

  /**
   * An agent (or the harness on its behalf) posted in a place. Interim
   * placeholders and owner posts must not be fed here.
   *
   * @param key - Answer key (`slack:<ch>:<ts>`, `slack:<ch>`, `chat:<conv>[:<thread>]`, `app:<app>/<comment>`)
   * @param at - When (epoch ms)
   * @param author - The agent session that posted, when known (also for posts made as the shared Crewly app on its behalf)
   */
  noteAnswer(key: string, at: number = this.now(), author?: string): void {
    if (!key) return;
    if (author) {
      const by = (this.store.answersBy[key] ??= {});
      if (at > (by[author] ?? 0)) {
        by[author] = at;
        this.answersDirty = true;
      }
    }
    const before = this.store.answers[key] ?? 0;
    if (at <= before) return;
    this.store.answers[key] = at;
    // Saved with the next scan: every agent post lands here.
    this.answersDirty = true;
  }

  /**
   * An agent posted in Slack (any machine).
   *
   * @param slackChannelId - Channel / DM
   * @param threadTs - Thread root, when in a thread
   * @param author - The agent session that posted, when known
   */
  noteSlackAnswer(slackChannelId: string, threadTs?: string, author?: string): void {
    if (!slackChannelId) return;
    if (threadTs) this.noteAnswer(`slack:${slackChannelId}:${threadTs}`, this.now(), author);
    else this.noteAnswer(`slack:${slackChannelId}`, this.now(), author);
  }

  /**
   * An agent replied on an app comment.
   *
   * @param appId - App
   * @param commentId - Comment
   */
  noteAppCommentAnswer(appId: string, commentId: string): void {
    if (appId && commentId) this.noteAnswer(`app:${appId}/${commentId}`);
  }

  /**
   * An agent posted in a chat conversation.
   *
   * @param conversationId - chat-v2 channel
   * @param chatThreadId - Thread, when in one
   * @param author - The agent session that posted, when known
   */
  noteChatAnswer(conversationId: string, chatThreadId?: string, author?: string): void {
    if (!conversationId) return;
    const at = this.now();
    this.noteAnswer(`chat:${conversationId}`, at, author);
    if (chatThreadId) this.noteAnswer(`chat:${conversationId}:${chatThreadId}`, at, author);
  }

  /**
   * An agent reported with `reply --work-item <id>`: the owner was told for
   * every chain that item belongs to, wherever the post landed (its thread
   * can differ from the thread the owner asked in) and whatever the item's
   * status now is (a verified item still counts). The reminder stops and no
   * cover message is posted (CREW-503).
   *
   * @param workItemId - The WorkItem the reply named
   * @returns How many chains were settled
   */
  noteWorkItemReply(workItemId: string): number {
    if (!workItemId) return 0;
    const now = this.now();
    // Also kept as an answer: a lead's report can come before its chain closes (crewly#1371).
    this.noteAnswer(`${TEAM_LEAD_REPORT_CONSTANTS.WORK_ITEM_ANSWER_PREFIX}${workItemId}`, now);
    let settled = 0;
    for (const record of Object.values(this.store.active)) {
      if (record.replyWorkItemId !== workItemId && !record.workItemIds.includes(workItemId)) continue;
      this.end(record, 'answered', now);
      settled++;
    }
    return settled;
  }

  /** Records being reported (tests / diagnostics). */
  get activeRecords(): ChainReportRecord[] {
    return Object.values(this.store.active);
  }

  /**
   * One scan: find finished chains and move each one step on. Never throws;
   * a scan already running is not doubled.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.scan();
    } catch (err) {
      this.log.warn('Owner completion report scan failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
      if (this.answersDirty) this.save();
    }
  }

  private async scan(): Promise<void> {
    const now = this.now();
    const items = await this.deps.listItems();
    const chains = collectOwnerChains(items, this.store.handledThrough);
    const byKey = new Map(chains.map((c) => [c.key, c]));

    // New finished chains start settling.
    for (const chain of chains) {
      if (chain.open || !chain.succeeded || this.store.active[chain.key]) continue;
      if (chain.finishedAt < this.store.since || now - chain.firstCreatedAt > C.MAX_CHAIN_AGE_MS) {
        this.markHandled(chain.key, chain.lastCreatedAt);
        continue;
      }
      const id = `${chain.key}#${chain.firstCreatedAt}`;
      if (this.store.ended[id]) {
        this.markHandled(chain.key, chain.lastCreatedAt);
        continue;
      }
      this.store.active[chain.key] = this.recordOf(id, chain, now);
      this.save();
    }

    for (const record of Object.values(this.store.active)) {
      const chain = byKey.get(record.key);
      await this.advance(record, chain ?? null, now);
    }
    this.prune(now);
  }

  private recordOf(id: string, chain: OwnerChain, now: number): ChainReportRecord {
    const mine = [...chain.items].reverse().find((w) => w.target === chain.responsible && !isVerifyItem(w));
    const last = [...chain.items].sort((a, b) => endOf(b) - endOf(a)).find((w) => !isVerifyItem(w)) ?? chain.items[chain.items.length - 1];
    return {
      id,
      key: chain.key,
      origin: chain.origin,
      responsible: chain.responsible,
      workItemIds: chain.items.map((w) => w.id),
      titles: titlesLine(chain.items),
      deliverables: deliverableTexts(chain.items),
      replyWorkItemId: (mine ?? last).id,
      firstCreatedAt: chain.firstCreatedAt,
      lastCreatedAt: chain.lastCreatedAt,
      finishedAt: chain.finishedAt,
      answerFrom: chain.workDoneAt,
      workStartedAt: chain.workStartedAt,
      workers: chain.workers,
      ...(chain.leadReport ? { leadReport: chain.leadReport } : {}),
      stage: 'settling',
      closedSince: now,
    };
  }

  /**
   * The team channel a lead reports team work in (crewly#1371): a new
   * top-level post there.
   *
   * @param report - The chain's lead report
   * @returns The place
   */
  private teamChannelPlace(report: LeadReport): ReportPlace {
    return { kind: 'slack', slackChannelId: report.slackChannelId, label: `#${report.channelName}` };
  }

  private async advance(record: ChainReportRecord, chain: OwnerChain | null, now: number): Promise<void> {
    if (chain) {
      record.workItemIds = chain.items.map((w) => w.id);
      record.lastCreatedAt = chain.lastCreatedAt;
      if (chain.open) {
        // More work joined the chain: wait for it, and count the wait again from its end.
        if (record.stage === 'settling') {
          delete this.store.active[record.key];
          this.save();
        }
        return;
      }
      if (chain.finishedAt > record.finishedAt) {
        record.finishedAt = chain.finishedAt;
        record.titles = titlesLine(chain.items);
        record.deliverables = deliverableTexts(chain.items);
      }
      record.answerFrom = chain.workDoneAt;
      record.workStartedAt = chain.workStartedAt;
      record.workers = chain.workers;
    }
    // Where the owner asked; for team work the lead reports in the team channel instead (crewly#1371).
    const ownerPlace = await this.deps.resolvePlace(record.origin).catch(() => null);
    const place = record.leadReport ? this.teamChannelPlace(record.leadReport) : ownerPlace;
    if (this.answeredSince(record, place, record.answerFrom ?? record.finishedAt)) {
      this.end(record, 'answered', now);
      return;
    }
    const teamPost = await this.teamPostedDeliverable(record, place);
    if (teamPost) {
      this.log.info('A teammate or delegatee already posted the work in the owner\'s place; no report needed', { key: record.key, agent: record.responsible, by: teamPost });
      this.end(record, 'answered', now);
      return;
    }
    // Finished too long ago to ask the agent now (a restart, a long outage): the lead decides, the
    // owner is not told about old work as if it were new.
    if ((record.stage === 'settling' || record.stage === 'asked') && isPastReminderCutoff(record.finishedAt, now)) {
      const lead = await this.deps
        .notifyLead?.(
          record.responsible,
          leadStaleNotice(`finished owner work without a report to the owner (${record.titles})`, record.responsible, record.finishedAt, now),
        )
        .catch(() => false);
      this.log.info('Finished owner work is too old to ask for a report; team lead told instead', { key: record.key, agent: record.responsible, lead: lead ?? false });
      this.end(record, 'skipped', now);
      return;
    }
    switch (record.stage) {
      case 'settling': {
        if (now - record.closedSince < C.SETTLE_MS) return;
        if (record.responsible === ORCHESTRATOR_SESSION_NAME) {
          this.log.info('Owner chain finished; the orchestrator delivery enforcer covers it', { key: record.key });
          this.end(record, 'skipped', now);
          return;
        }
        if (!place) {
          this.log.info('Owner chain finished but its place cannot be resolved; not reported', { key: record.key });
          this.end(record, 'skipped', now);
          return;
        }
        const ask = record.leadReport
          ? this.leadAskText(record, record.leadReport, await this.languageOf(record, ownerPlace), now)
          : this.askText(record, place);
        const ok = await this.deps.deliver(record.responsible, ask).catch(() => false);
        record.stage = 'asked';
        record.askedAt = now;
        this.save();
        this.log.info('Asked the agent to report finished owner work', { key: record.key, agent: record.responsible, delivered: ok });
        return;
      }
      case 'asked':
      case 'reminded': {
        // One nudge, then the grace period; the harness posts one plain line.
        const nudgedAt = Math.max(record.askedAt ?? 0, record.remindedAt ?? 0, record.finishedAt);
        if (now - nudgedAt < C.NUDGE_GRACE_MS || !place) return;
        if (!record.leadReport && this.ownDeliveryPosted(record, place)) {
          this.log.info('The agent already posted in the owner\'s place after starting the work; no harness line', { key: record.key, agent: record.responsible });
          this.end(record, 'answered', now);
          return;
        }
        const language = await this.languageOf(record, ownerPlace);
        const text = record.leadReport
          ? this.leadFallbackText(record, record.leadReport, chain?.items ?? [], language)
          : this.fallbackText(record, chain?.items ?? [], language);
        const posted = await this.deps.postFallback(place, record.responsible, text).catch(() => false);
        this.log.info('Posted the finished owner work line for the agent', { key: record.key, agent: record.responsible, language, posted });
        record.postedAt = now;
        this.end(record, 'posted', now);
        return;
      }
      default:
        this.end(record, record.stage, now);
    }
  }

  private answeredSince(record: ChainReportRecord, place: ReportPlace | null, since: number): boolean {
    // Team work: only the lead's `reply --work-item` on the chain's items counts —
    // any post in the team channel, or in the orchestrator's thread, does not (crewly#1371).
    const keys = record.leadReport
      ? record.workItemIds.map((id) => `${TEAM_LEAD_REPORT_CONSTANTS.WORK_ITEM_ANSWER_PREFIX}${id}`)
      : answerKeysOf(record.origin, place);
    return keys.some((k) => (this.store.answers[k] ?? 0) > since);
  }

  /**
   * Whether the responsible agent itself posted in the owner's place well after
   * the work started (OWN_POST_AS_REPORT_AFTER_MS): that post was its delivery,
   * and a harness "done" line after it says nothing new.
   *
   * @param record - Chain record
   * @param place - Where the owner asked
   * @returns True when such a post exists
   */
  private ownDeliveryPosted(record: ChainReportRecord, place: ReportPlace | null): boolean {
    if (record.workStartedAt === undefined) return false;
    const after = record.workStartedAt + C.OWN_POST_AS_REPORT_AFTER_MS;
    return answerKeysOf(record.origin, place).some((k) => (this.store.answersBy[k]?.[record.responsible] ?? 0) > after);
  }

  /**
   * A post in the owner's place, after the work started, by an agent that
   * did the chain's work or is on the responsible agent's team (crewly#1376):
   * they deliver in the thread first and close their item after, so a post
   * of theirs before the handover is the report. The responsible agent's own
   * early posts (its "on it" ack) do not count; team work the lead reports in
   * the team channel keeps its own rule (crewly#1371).
   *
   * @param record - Chain record
   * @param place - Where the owner asked
   * @returns The session that posted, or null
   */
  private async teamPostedDeliverable(record: ChainReportRecord, place: ReportPlace | null): Promise<string | null> {
    if (record.leadReport || record.workStartedAt === undefined) return null;
    const posts = answerKeysOf(record.origin, place).flatMap((k) =>
      Object.entries(this.store.answersBy[k] ?? {}).filter(([who, at]) => who !== record.responsible && at > record.workStartedAt!),
    );
    if (!posts.length) return null;
    const workers = new Set(record.workers ?? []);
    const byWorker = posts.find(([who]) => workers.has(who));
    if (byWorker) return byWorker[0];
    let mates: readonly string[] = [];
    try {
      mates = (await this.deps.teammatesOf?.(record.responsible)) ?? [];
    } catch {
      /* unknown teams: only the chain's own workers count */
    }
    const teammates = new Set(mates);
    return posts.find(([who]) => teammates.has(who))?.[0] ?? null;
  }

  /**
   * The owner's language where they asked (English when unknown).
   *
   * @param record - Chain record
   * @param ownerPlace - Where the owner asked
   * @returns Language
   */
  private async languageOf(record: ChainReportRecord, ownerPlace: ReportPlace | null): Promise<OwnerLanguage> {
    return (await this.deps.ownerLanguage?.(record.origin, ownerPlace).catch(() => null)) ?? detectOwnerLanguage(null);
  }

  /**
   * The nudge asking a team lead to report team work the orchestrator
   * delegated for the owner, in the team channel, as itself (crewly#1371).
   *
   * @param record - Chain record
   * @param report - Its lead report
   * @param language - The owner's language
   * @param now - Clock (epoch ms)
   * @returns English harness text
   */
  leadAskText(record: ChainReportRecord, report: LeadReport, language: OwnerLanguage = 'en', now: number = Date.now()): string {
    const link = approvalLink(record.origin);
    const worker = report.workerName ?? this.name(report.worker);
    const by = report.worker === report.lead ? 'You finished' : `${worker} finished`;
    const where = link ? `the orchestrator's thread with the owner (${link})` : `the owner's chat with the orchestrator`;
    return (
      `[OWNER REPORT DUE] ${by} work the owner approved in ${where}: ${record.titles}. ` +
      `You report it to the owner, as yourself, in #${report.channelName}; the orchestrator does not relay it. ` +
      `Post one or two plain lines in the owner's language (${language === 'zh' ? 'Chinese' : 'English'}): what the owner approved, the outcome with its link` +
      `${link ? `, and the link to the thread the approval came from (${link})` : ''}. ` +
      `No ticket or work item ids, no status lines. Run: reply --work-item ${record.replyWorkItemId} "<your message>" — it posts a new message in #${report.channelName}. ` +
      `If you do not post it within ${Math.round(C.NUDGE_GRACE_MS / 60_000)} minutes, Crewly posts one line there for you.` +
      reminderFooter(1, record.finishedAt, now)
    );
  }

  /**
   * The line the harness posts in the team channel, as the lead, when the
   * lead never reported team work (crewly#1371).
   *
   * @param record - Chain record
   * @param report - Its lead report
   * @param items - The chain's items, when still in the pool
   * @param language - The owner's language
   * @returns The line
   */
  leadFallbackText(record: ChainReportRecord, report: LeadReport, items: readonly WorkItem[], language: OwnerLanguage = 'en'): string {
    const fromPool = deliverableTexts(items);
    const deliverables = fromPool.length ? fromPool : record.deliverables?.length ? record.deliverables : titlesOf(record.titles);
    return leadFallbackLine({
      workerName: report.workerName ?? this.name(report.worker),
      deliverables,
      language,
      approvalLink: approvalLink(record.origin),
    });
  }

  private name(session: string): string {
    return this.deps.displayNameOf?.(session) ?? session;
  }

  /**
   * The one nudge asking the responsible agent for the report (crewly#1357:
   * one nudge, then the harness posts a line itself).
   *
   * @param record - Chain record
   * @param place - Where the owner asked
   * @param now - Clock (epoch ms)
   * @returns English harness text
   */
  askText(record: ChainReportRecord, place: ReportPlace, now: number = Date.now()): string {
    const cmd =
      place.kind === 'app-comment'
        ? `${this.deps.appCommentsCmd ?? 'app-comments'} --app ${place.appId} --reply ${place.commentId} --text "<what the owner got>"`
        : `reply --work-item ${record.replyWorkItemId} "<what the owner got>"`;
    return (
      `[OWNER REPORT DUE] The work the owner asked for in ${place.label} is finished (${record.titles}). ` +
      `Tell the owner there yourself, now: one short message in the owner's language saying what they got and where it is, in plain words — ` +
      `no work item ids, no internal links, file paths, codecs, sizes or logs. Run: ${cmd}. ` +
      `If nothing is posted there within ${Math.round(C.NUDGE_GRACE_MS / 60_000)} minutes, Crewly posts one line there for you.` +
      reminderFooter(1, record.finishedAt, now)
    );
  }

  /**
   * The one line the harness posts when the agent never reported: the
   * deliverable in plain words, in the owner's language, and the short
   * "sent by Crewly" marker. No ids, links, files, sizes or result dumps.
   *
   * @param record - Chain record
   * @param items - The chain's items, when still in the pool (their summaries are preferred)
   * @param language - The owner's language
   * @returns The line
   */
  fallbackText(record: ChainReportRecord, items: readonly WorkItem[], language: OwnerLanguage = 'en'): string {
    const fromPool = deliverableTexts(items);
    const deliverables = fromPool.length ? fromPool : record.deliverables?.length ? record.deliverables : titlesOf(record.titles);
    return fallbackLine({ agentName: this.name(record.responsible), deliverables, language });
  }

  private end(record: ChainReportRecord, stage: ChainReportRecord['stage'], now: number): void {
    record.stage = stage;
    record.endedAt = now;
    delete this.store.active[record.key];
    this.store.ended[record.id] = now;
    this.markHandled(record.key, record.lastCreatedAt);
  }

  private markHandled(key: string, lastCreatedAt: number): void {
    this.store.handledThrough[key] = Math.max(this.store.handledThrough[key] ?? -Infinity, lastCreatedAt);
    this.save();
  }

  private prune(now: number): void {
    let changed = false;
    for (const [id, at] of Object.entries(this.store.ended)) {
      if (now - at > C.RECORD_TTL_MS) {
        delete this.store.ended[id];
        changed = true;
      }
    }
    for (const [k, at] of Object.entries(this.store.answers)) {
      if (now - at > C.RECORD_TTL_MS) {
        delete this.store.answers[k];
        delete this.store.answersBy[k];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): StoreShape {
    const fresh: StoreShape = { version: 1, since: this.now(), handledThrough: {}, active: {}, ended: {}, answers: {}, answersBy: {} };
    try {
      if (!existsSync(this.file)) {
        this.store = fresh;
        this.save();
        return fresh;
      }
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<StoreShape>;
      return {
        version: 1,
        since: typeof raw.since === 'number' ? raw.since : fresh.since,
        handledThrough: raw.handledThrough && typeof raw.handledThrough === 'object' ? raw.handledThrough : {},
        active: raw.active && typeof raw.active === 'object' ? raw.active : {},
        ended: raw.ended && typeof raw.ended === 'object' ? raw.ended : {},
        answers: raw.answers && typeof raw.answers === 'object' ? raw.answers : {},
        answersBy: raw.answersBy && typeof raw.answersBy === 'object' ? raw.answersBy : {},
      };
    } catch (err) {
      this.log.warn('Owner completion report store unreadable; starting fresh', { error: err instanceof Error ? err.message : String(err) });
      return fresh;
    }
  }

  private save(): void {
    this.answersDirty = false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf-8');
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn('Owner completion report store not saved', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

let instance: OwnerCompletionReportService | null = null;

/**
 * The running service, once started at boot.
 *
 * @returns The service, or null
 */
export function getOwnerCompletionReport(): OwnerCompletionReportService | null {
  return instance;
}

/**
 * Set (or clear) the running service.
 *
 * @param service - Service or null
 */
export function setOwnerCompletionReport(service: OwnerCompletionReportService | null): void {
  instance = service;
}
