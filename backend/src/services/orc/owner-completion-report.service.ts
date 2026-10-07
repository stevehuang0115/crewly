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
 *     message asking it to report the result there;
 *  2. no agent answer there within REPORT_WAIT_MS → one reminder;
 *  3. still none after another REPORT_WAIT_MS → the harness posts a short
 *     factual summary there itself (as the agent's bot when it can).
 *
 * Each chain is handled once (persisted, so a restart neither repeats nor
 * forgets a step). Work added to the same place after a chain was handled
 * starts a new chain. Chains whose responsible agent is the orchestrator are
 * skipped: OrcDeliveryEnforcer already keeps reminding the orc until it
 * answers. The owner only reads; nothing here asks the owner to act.
 *
 * Harness text is English.
 *
 * @module services/orc/owner-completion-report.service
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, OWNER_COMPLETION_REPORT_CONSTANTS as C } from '../../constants.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { originOfWorkItem, type WorkItemOrigin } from './work-item-destination.js';

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
  /** Who received the owner's request */
  responsible: string;
  /** Earliest / latest creation of its items (epoch ms) */
  firstCreatedAt: number;
  lastCreatedAt: number;
  /** When the work itself finished (latest completion of a non-verify item, epoch ms) */
  finishedAt: number;
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
    const key = ownerPlaceKey(origin);
    if (!key) continue;
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
    chains.push({
      key,
      origin: firstOrigin,
      items: sorted,
      open: sorted.some((w) => !CLOSED.has(w.status)),
      succeeded: sorted.some((w) => SUCCEEDED.has(w.status)),
      responsible: firstOrigin.receivedBy ?? first.target ?? '',
      firstCreatedAt: ms(first.createdAt),
      lastCreatedAt: Math.max(...sorted.map((w) => ms(w.createdAt))),
      finishedAt: Math.max(...(work.length ? work : sorted).map(endOf)),
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
 * What the finished items left behind: their result / output summaries and
 * file paths, one line each.
 *
 * @param items - Chain items
 * @returns Evidence lines (possibly empty)
 */
export function evidenceLines(items: readonly WorkItem[]): string[] {
  const lines: string[] = [];
  for (const wi of items) {
    if (isVerifyItem(wi) || !SUCCEEDED.has(wi.status)) continue;
    const bag = { ...(wi.output ?? {}), ...(wi.result ?? {}) } as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['summary', 'message', 'text', 'evidence']) {
      if (typeof bag[k] === 'string' && (bag[k] as string).trim()) {
        parts.push(bag[k] as string);
        break;
      }
    }
    for (const k of ['files', 'artifacts', 'paths', 'evidencePaths', 'outputPaths']) {
      const v = bag[k];
      if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(', '));
      else if (typeof v === 'string') parts.push(v);
    }
    if (!parts.length) continue;
    lines.push(`${clip(wi.title, C.TITLE_MAX_CHARS)}: ${clip(parts.join(' — '), C.EVIDENCE_LINE_MAX_CHARS)}`);
    if (lines.length >= C.MAX_EVIDENCE_LINES) break;
  }
  return lines;
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
  firstCreatedAt: number;
  lastCreatedAt: number;
  finishedAt: number;
  /**
   * `settling` (closed, waiting SETTLE_MS) → `asked` → `reminded` → `posted`;
   * `answered`: an agent answered in the owner's place; `skipped`: the orc's
   * own enforcer covers it.
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
  /** Display name of an agent */
  displayNameOf?: (session: string) => string;
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
   */
  noteAnswer(key: string, at: number = this.now()): void {
    if (!key) return;
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
   */
  noteSlackAnswer(slackChannelId: string, threadTs?: string): void {
    if (!slackChannelId) return;
    if (threadTs) this.noteAnswer(`slack:${slackChannelId}:${threadTs}`);
    else this.noteAnswer(`slack:${slackChannelId}`);
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
   */
  noteChatAnswer(conversationId: string, chatThreadId?: string): void {
    if (!conversationId) return;
    this.noteAnswer(`chat:${conversationId}`);
    if (chatThreadId) this.noteAnswer(`chat:${conversationId}:${chatThreadId}`);
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
      replyWorkItemId: (mine ?? last).id,
      firstCreatedAt: chain.firstCreatedAt,
      lastCreatedAt: chain.lastCreatedAt,
      finishedAt: chain.finishedAt,
      stage: 'settling',
      closedSince: now,
    };
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
      }
    }
    const place = await this.deps.resolvePlace(record.origin).catch(() => null);
    if (this.answeredSince(record, place, record.finishedAt)) {
      this.end(record, 'answered', now);
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
        const ok = await this.deps.deliver(record.responsible, this.askText(record, place, false)).catch(() => false);
        record.stage = 'asked';
        record.askedAt = now;
        this.save();
        this.log.info('Asked the agent to report finished owner work', { key: record.key, agent: record.responsible, delivered: ok });
        return;
      }
      case 'asked': {
        if (now - Math.max(record.askedAt ?? 0, record.finishedAt) < C.REPORT_WAIT_MS || !place) return;
        const ok = await this.deps.deliver(record.responsible, this.askText(record, place, true)).catch(() => false);
        record.stage = 'reminded';
        record.remindedAt = now;
        this.save();
        this.log.info('Reminded the agent to report finished owner work', { key: record.key, agent: record.responsible, delivered: ok });
        return;
      }
      case 'reminded': {
        if (now - Math.max(record.remindedAt ?? 0, record.finishedAt) < C.REPORT_WAIT_MS || !place) return;
        const items = chain?.items ?? [];
        const posted = await this.deps.postFallback(place, record.responsible, this.fallbackText(record, items)).catch(() => false);
        this.log.info('Posted the finished owner work summary for the agent', { key: record.key, agent: record.responsible, posted });
        record.postedAt = now;
        this.end(record, 'posted', now);
        return;
      }
      default:
        this.end(record, record.stage, now);
    }
  }

  private answeredSince(record: ChainReportRecord, place: ReportPlace | null, since: number): boolean {
    return answerKeysOf(record.origin, place).some((k) => (this.store.answers[k] ?? 0) > since);
  }

  private name(session: string): string {
    return this.deps.displayNameOf?.(session) ?? session;
  }

  /**
   * The message asking the responsible agent for the report.
   *
   * @param record - Chain record
   * @param place - Where the owner asked
   * @param reminder - The second (last) ask
   * @returns English harness text
   */
  askText(record: ChainReportRecord, place: ReportPlace, reminder: boolean): string {
    const cmd =
      place.kind === 'app-comment'
        ? `${this.deps.appCommentsCmd ?? 'app-comments'} --app ${place.appId} --reply ${place.commentId} --text "<summary + where the files are>"`
        : `reply --work-item ${record.replyWorkItemId} "<summary + where the files are>"`;
    const head = reminder ? '[OWNER REPORT DUE — reminder]' : '[OWNER REPORT DUE]';
    const tail = reminder
      ? ` The owner has still not been told. If nothing is posted there within ${Math.round(C.REPORT_WAIT_MS / 60_000)} minutes, Crewly posts a short summary there for you.`
      : ' Write it for the owner: what was done, the result, and where the files are. One message; the owner only reads it.';
    return `${head} The work the owner asked for in ${place.label} is finished (${record.titles}). Report the result to the owner there now: ${cmd}.${tail}`;
  }

  /**
   * The harness's own summary, posted when the agent never reported.
   *
   * @param record - Chain record
   * @param items - The chain's items (for evidence), when still in the pool
   * @returns English harness text
   */
  fallbackText(record: ChainReportRecord, items: readonly WorkItem[]): string {
    const evidence = evidenceLines(items);
    const results = evidence.length ? `\nResults:\n${evidence.map((l) => `• ${l}`).join('\n')}` : '\nResults: see the work items in Crewly.';
    return `${this.name(record.responsible)} finished: ${record.titles}.${results}\n— sent by Crewly because no report was posted.`;
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
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): StoreShape {
    const fresh: StoreShape = { version: 1, since: this.now(), handledThrough: {}, active: {}, ended: {}, answers: {} };
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
