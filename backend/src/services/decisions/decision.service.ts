/**
 * Decision cards (specs/2026-10-01-decision-cards.md).
 *
 * The responsible agent asks the owner ONE structured question; its own
 * Slack bot posts a Block Kit card in the team channel (the ticket's thread,
 * or a new thread), and the owner answers with a button, a reaction, a
 * thread reply or the dashboard. The answer updates the card in place, goes
 * into the ticket log, is delivered to the asking agent and clears the
 * owner-message watchdog for that thread. At the deadline the default is
 * applied — except for sensitive asks, which are re-asked once and parked.
 *
 * Every collaborator is injected ({@link DecisionServiceDeps}); the wiring
 * with the real Slack / tickets / agents lives in `decision.wiring.ts`.
 *
 * @module services/decisions/decision.service
 */

import { AgentPromptReferenceService } from '../orc/agent-prompt-reference.service.js';
import { DECISION_CONSTANTS, OPEN_ITEMS_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { questionSimilarity } from '../open-items/open-item-card.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { SlackBlock, SlackIncomingMessage, SlackOutgoingMessage } from '../../types/slack.types.js';
import type {
  AskOwnerInput,
  DecisionAnswerFile,
  DecisionAnswerVia,
  DecisionChoice,
  DecisionKind,
  DecisionOption,
  DecisionSensitiveKind,
  DecisionSource,
  DecisionSystemRef,
  OwnerDecision,
} from '../../types/decision.types.js';
import { DecisionContractError, matchOption, parseOptions, resolveDefault, validateAskOwner } from './decision-contract.js';
import {
  answerFilesOf,
  canRemind,
  cardFallbackText,
  choiceFromReaction,
  choiceFromText,
  deadlineDefaultLine,
  defaultIsSafe,
  describeAnswerFiles,
  slackTsAfter,
  waitReminderLine,
  defaultLabel,
  formatWhen,
  optionLabel,
  parseButtonValue,
  renderOpenCard,
  renderSettledCard,
  settledLine,
  noOption,
  isSkipWord,
  skipChoice,
  ticketThreadRootText,
} from './decision-card.js';
import { DecisionStore, PENDING_DECISION_STATUSES } from './decision-store.js';
import type { TicketThreadStore } from './ticket-thread-store.js';

/** Thrown for requests the caller must fix (HTTP 4xx). */
export class DecisionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}

/** The slice of SlackService used here. */
export interface DecisionSlackApi {
  isConnected(): boolean;
  sendMessage(message: SlackOutgoingMessage): Promise<string>;
  updateMessage(channelId: string, messageTs: string, text: string, blocks?: SlackBlock[], botToken?: string): Promise<void>;
}

/** How an agent posts: its own bot token, else the shared bot with its name/icon. */
export interface DecisionPostIdentity {
  botToken?: string;
  username?: string;
  iconEmoji?: string;
  iconUrl?: string;
}

/** A ticket the question is about, resolved by the wiring. */
export interface DecisionTicketContext {
  projectId: string;
  projectPath: string;
  projectName?: string;
  id: string;
  title: string;
  /** Session that owns the question: the assignee, else the team's lead */
  asker: string;
  /** Team whose channel carries the card */
  teamId?: string;
}

/** A Slack place to post into. */
export interface DecisionSlackPlace {
  slackChannelId: string;
  threadTs?: string;
  teamId?: string;
}

/** Collaborators. */
export interface DecisionServiceDeps {
  store: DecisionStore;
  threads: TicketThreadStore;
  slack: () => DecisionSlackApi | null;
  /** This instance (button values carry it; Cloud routes clicks by it) */
  instanceId: () => string;
  /** Whether a Slack user may answer (the owner) */
  isOwner: (slackUserId: string) => boolean;
  /** The owner's Slack user id, for mentions in reminders */
  ownerUserId?: () => string | null;
  /** Display name of a Slack user ("Steve") */
  userName?: (slackUserId: string) => Promise<string | undefined>;
  /** How an agent posts */
  identityOf: (session: string) => Promise<DecisionPostIdentity>;
  /** Slack channel of a team */
  teamChannelOf: (teamId: string) => Promise<string | null>;
  /** The team an agent belongs to */
  teamOf: (session: string) => Promise<string | undefined>;
  /** Resolve a ticket ask (access-checked); throws DecisionError */
  resolveTicket: (project: string, ticketId: string, callerSession: string | undefined) => Promise<DecisionTicketContext>;
  /** Mark the ticket as waiting on the owner (label + log line) */
  markTicketAsked: (ctx: DecisionTicketContext, question: string, decisionId: string) => Promise<void>;
  /** Append a ticket log line; `clearNeedsOwner` removes the needs-owner label */
  logTicket: (ticket: NonNullable<OwnerDecision['ticket']>, line: string, clearNeedsOwner: boolean) => Promise<void>;
  /** The Slack destination of the agent's current work, when it is a Slack place */
  workDestination?: (session: string) => Promise<DecisionSlackPlace | null>;
  /** The work item the agent is on */
  currentWorkItemId?: (session: string) => Promise<string | undefined>;
  /** Deliver a message to an agent (wakes a stopped one); false when it could not */
  deliverToAgent: (session: string, text: string) => Promise<boolean>;
  /** Close the owner-message watchdog entries this agent owes in the thread */
  closeWatchdog?: (session: string, slackChannelId: string, threadTs: string) => void;
  /** The owner's DM with the bot of `identity` (system decisions); null when there is none */
  ownerDmOf?: (identity: DecisionPostIdentity) => Promise<string | null>;
  /**
   * When the agent asked the question a `reply_question` card tracks (its
   * open item's `createdAt`). Tells a backfilled legacy card (no `source`)
   * from a live one in {@link DecisionService.skipAll}.
   */
  openItemAskedAt?: (ref: NonNullable<OwnerDecision['requestRef']>) => Promise<string | undefined>;
  /**
   * Why what the card tracks is already closed (its open item / Request /
   * ticket), or null while it still needs an answer. Checked right before
   * anything is posted to the owner: a moot card is withdrawn silently
   * (specs/2026-10-02-decision-card-thread-answers.md §3).
   */
  trackedClosed?: (d: OwnerDecision) => Promise<string | null>;
  /** The asking agent's display name ("Owen"), for "so Owen will go with …" */
  displayName?: (session: string) => Promise<string | undefined>;
  now?: () => Date;
  logger?: ComponentLogger;
}

/** A decision the harness asks itself ({@link DecisionService.askSystem}). */
export interface SystemAskInput {
  /** Kind whose registered handler acts on the answer */
  kind: DecisionKind;
  system: DecisionSystemRef;
  /** Card header */
  title: string;
  /** One line */
  question: string;
  /** Extra mrkdwn sections under the question */
  body?: string[];
  /** `["Label", "Label — detail"]` or `[{label, detail?}]` */
  options: unknown[];
  /** Option label */
  default: string;
  deadline: Date;
  sensitive?: DecisionSensitiveKind;
}

/** What a Slack interaction did. */
export interface InteractionOutcome {
  handled: boolean;
  reason: string;
  decision?: OwnerDecision;
}

/** A Slack `block_actions` payload (the fields used). */
export interface BlockActionsPayload {
  type?: string;
  user?: { id?: string; name?: string; username?: string };
  actions?: Array<{ action_id?: string; value?: string; action_ts?: string }>;
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
}

/** A `reaction_added` event (the fields used). */
export interface ReactionEvent {
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
}

/**
 * Acts on the outcome of a decision Crewly asked itself ({@link DecisionKind}).
 */
export interface DecisionKindHandler {
  /**
   * Called once when such a decision settles (resolved, defaulted at the
   * deadline, parked, cancelled or expired). Does the kind's work (e.g. lets a held
   * browser click through) and returns the note for the asking agent, which
   * replaces the generic `[DECISION]` note; null sends nothing.
   *
   * @param decision - The settled decision
   * @param fallback - The generic note the asker would get without a handler (null for none)
   * @returns Note for the asker, or null
   */
  onSettled(decision: OwnerDecision, fallback?: string | null): Promise<string | null>;
}

/** A question Crewly builds itself (no ask-owner contract parsing). */
export interface PrebuiltAsk {
  kind: DecisionKind;
  /** Agent the question is about — its bot posts the card and it gets the answer */
  asker: string;
  question: string;
  options: DecisionOption[];
  defaultKey: string;
  yesKey?: string;
  deadline: Date;
  sensitive?: DecisionSensitiveKind;
  browser?: OwnerDecision['browser'];
  /** Card header (default "Decision D-n") */
  title?: string;
  /** Extra mrkdwn sections under the question (e.g. the quoted context a question points back at) */
  body?: string[];
  /** Post the card here (a thread) instead of the agent's work destination */
  place?: OwnerDecision['place'];
  /** The Request open item it tracks */
  requestRef?: OwnerDecision['requestRef'];
  /** `backfill` when the open-items backfill carded an old reply */
  source?: DecisionSource;
  /** When the agent asked it (ISO) */
  askedAt?: string;
}

/** Where a skipped question must not be asked again ({@link DecisionService.findSkipped}). */
export interface SkipScope {
  /** The Request the question was about */
  requestId?: string;
  /** The project ticket the question was about */
  ticket?: { projectPath: string; id: string };
  /** The asking agent (used only when there is no request / ticket) */
  asker?: string;
}

/** Filters of {@link DecisionService.skipAll}. */
export interface SkipAllInput {
  /** Only decisions created before this moment */
  olderThan?: Date;
  /** `backfill` = only cards the open-items backfill created; `all` (default) = every open card */
  source?: 'backfill' | 'all';
  /** Report what would be skipped without changing anything */
  dryRun?: boolean;
}

/** One row of {@link SkipAllResult}. */
export interface SkipAllRow {
  id: string;
  question: string;
  asker: string;
  createdAt: string;
  ticket?: string;
  source: DecisionSource;
  /** What skipping does to it: a real skip, or (sensitive / system / browser) its safe "no" option */
  outcome: 'skipped' | 'declined';
}

/** Result of {@link DecisionService.skipAll}. */
export interface SkipAllResult {
  dryRun: boolean;
  /** How many open decisions match */
  matched: number;
  /** Ids actually settled (empty on a dry run) */
  settled: string[];
  rows: SkipAllRow[];
}

/** Handlers per kind (process-wide: the browser side may start before the service). */
const KIND_HANDLERS = new Map<DecisionKind, DecisionKindHandler>();

/**
 * The scope keys of a decision for the skipped-question dedupe: its Request
 * and its ticket; the asking agent only when it has neither.
 *
 * @param s - Scope
 * @returns Keys
 */
export function skipScopeKeys(s: SkipScope): string[] {
  const keys: string[] = [];
  if (s.requestId) keys.push(`request:${s.requestId}`);
  if (s.ticket) keys.push(`ticket:${s.ticket.projectPath}#${s.ticket.id}`);
  if (keys.length === 0 && s.asker) keys.push(`agent:${s.asker}`);
  return keys;
}

/**
 * The dedupe scope of a stored decision.
 *
 * @param d - Decision
 * @returns Scope
 */
function scopeOf(d: Pick<OwnerDecision, 'requestRef' | 'ticket' | 'asker'>): SkipScope {
  return {
    ...(d.requestRef ? { requestId: d.requestRef.requestId } : {}),
    ...(d.ticket ? { ticket: { projectPath: d.ticket.projectPath, id: d.ticket.id } } : {}),
    asker: d.asker,
  };
}

/**
 * Next local `hour`:00 strictly tomorrow.
 *
 * @param now - Clock
 * @param hour - Local hour
 * @returns Date
 */
function tomorrowAt(now: Date, hour: number): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * Decision cards service.
 */
export class DecisionService {
  private static instance: DecisionService | null = null;

  private readonly deps: DecisionServiceDeps;
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  /**
   * @param deps - Collaborators
   */
  constructor(deps: DecisionServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('DecisionCards');
    this.now = deps.now ?? (() => new Date());
  }

  /** @returns The process-wide instance, or null before wiring */
  static getInstance(): DecisionService | null {
    return DecisionService.instance;
  }

  /** @param service - Instance to install (null clears) */
  static setInstance(service: DecisionService | null): void {
    DecisionService.instance = service;
  }

  /**
   * Register the handler of a decision kind.
   *
   * @param kind - Decision kind
   * @param handler - Handler (null removes it)
   */
  static registerKindHandler(kind: DecisionKind, handler: DecisionKindHandler | null): void {
    if (handler) KIND_HANDLERS.set(kind, handler);
    else KIND_HANDLERS.delete(kind);
  }

  /** Start the deadline / reminder tick. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), DECISION_CONSTANTS.TICK_MS);
    this.timer.unref?.();
    const once = setTimeout(() => void this.refreshStaleCards(), DECISION_CONSTANTS.STALE_CARD_REFRESH_DELAY_MS);
    once.unref?.();
  }

  /**
   * Redraw open cards drawn with an older layout revision, so cards posted
   * before a layout change (e.g. the Skip button) get the new controls.
   * Paced to stay under Slack's chat.update rate limit; never throws.
   *
   * @param gapMs - Pause between two redraws (tests pass 0)
   * @returns How many cards were redrawn
   */
  async refreshStaleCards(gapMs: number = DECISION_CONSTANTS.STALE_CARD_REFRESH_GAP_MS): Promise<number> {
    const slack = this.deps.slack();
    if (!slack || !slack.isConnected()) return 0;
    let refreshed = 0;
    try {
      const stale = await this.deps.store.list(
        (d) => d.status === 'open' && !!d.card && d.card.renderRev !== DECISION_CONSTANTS.CARD_RENDER_REV,
      );
      for (const d of stale) {
        if (!(await this.refreshCard(d))) continue;
        await this.deps.store.update(d.id, (cur) =>
          cur.card ? { card: { ...cur.card, renderRev: DECISION_CONSTANTS.CARD_RENDER_REV } } : null,
        );
        refreshed += 1;
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      }
      if (refreshed > 0) this.logger.info('Redrew open decision cards with the current layout', { refreshed });
    } catch (err) {
      this.logger.warn('Could not redraw stale decision cards', { error: errText(err) });
    }
    return refreshed;
  }

  /** Stop the tick. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------------------
  // Asking
  // ---------------------------------------------------------------------------

  /**
   * Ask the owner. Validates the contract, stores the decision and posts the
   * card as the responsible agent's own bot.
   *
   * @param callerSession - Agent calling ask-owner (undefined = owner / dashboard)
   * @param input - The ask
   * @returns The stored decision (with `card`, or `postError` when Slack refused; retried on the tick)
   * @throws DecisionError(400) for a contract violation, other 4xx from ticket resolution
   */
  async ask(callerSession: string | undefined, input: AskOwnerInput): Promise<OwnerDecision> {
    let ask;
    try {
      ask = validateAskOwner(input, this.now());
    } catch (err) {
      if (err instanceof DecisionContractError) throw new DecisionError(400, err.message);
      throw err;
    }
    let asker = callerSession;
    let ticket: OwnerDecision['ticket'];
    let teamId: string | undefined;
    if (ask.ticketId && ask.project) {
      const ctx = await this.deps.resolveTicket(ask.project, ask.ticketId, callerSession);
      asker = ctx.asker;
      teamId = ctx.teamId;
      ticket = { projectId: ctx.projectId, projectPath: ctx.projectPath, projectName: ctx.projectName, id: ctx.id, title: ctx.title };
    }
    if (!asker) throw new DecisionError(400, 'Who is asking? Run ask-owner from an agent session, or name a --ticket.');
    const skipped = await this.findSkipped({ ...(ticket ? { ticket: { projectPath: ticket.projectPath, id: ticket.id } } : {}), asker }, ask.question);
    if (skipped) throw this.alreadySkippedError(skipped);
    if (!teamId) teamId = await this.deps.teamOf(asker).catch(() => undefined);
    const workItemId = callerSession ? await this.deps.currentWorkItemId?.(callerSession).catch(() => undefined) : undefined;

    const decision = await this.deps.store.create({
      question: ask.question,
      options: ask.options,
      defaultKey: ask.defaultKey,
      deadline: ask.deadline.toISOString(),
      ...(ask.sensitive ? { sensitive: ask.sensitive } : {}),
      requestedBy: callerSession ?? 'owner',
      asker,
      ...(ticket ? { ticket } : {}),
      ...(teamId ? { teamId } : {}),
      ...(workItemId ? { workItemId } : {}),
      status: 'open',
    });
    if (ticket && ask.ticketId && ask.project) {
      await this.deps
        .markTicketAsked({ ...ticket, asker, teamId }, ask.question, decision.id)
        .catch((err) => this.logger.warn('Could not mark the ticket as waiting on the owner', { decisionId: decision.id, error: errText(err) }));
    }
    this.logger.info('Owner decision asked', { decisionId: decision.id, asker, requestedBy: decision.requestedBy, ticket: ticket?.id, sensitive: decision.sensitive });
    // The same question Crewly already carded from the agent's reply
    // (specs/2026-10-01-reply-open-items.md §4): this ask replaces that card.
    await this.cancelWhere(
      (d) => d.kind === 'reply_question' && d.asker === asker && questionSimilarity(d.question, ask.question) >= OPEN_ITEMS_CONSTANTS.SAME_QUESTION_SIMILARITY,
      `superseded by ${decision.id}`,
    ).catch((err) => this.logger.debug('Could not withdraw the reply-question card', { error: errText(err) }));
    return this.postCard(decision);
  }

  /**
   * Ask the owner on the harness's own behalf (no agent): the card goes to
   * the owner's DM with this machine's orc bot, and the answer goes to the
   * kind's handler only — no agent is told or woken.
   *
   * @param input - The ask
   * @returns The stored decision (with `card`, or `postError`; retried on the tick)
   * @throws DecisionError(400) for bad options / default / deadline
   */
  async askSystem(input: SystemAskInput): Promise<OwnerDecision> {
    let options;
    let defaultKey;
    try {
      options = parseOptions(input.options);
      defaultKey = resolveDefault(input.default, options);
    } catch (err) {
      if (err instanceof DecisionContractError) throw new DecisionError(400, err.message);
      throw err;
    }
    if (input.deadline.getTime() <= this.now().getTime()) throw new DecisionError(400, 'deadline is in the past');
    const decision = await this.deps.store.create({
      kind: input.kind,
      question: input.question.replace(/\s+/g, ' ').trim().slice(0, DECISION_CONSTANTS.QUESTION_MAX_CHARS),
      options,
      defaultKey,
      deadline: input.deadline.toISOString(),
      ...(input.sensitive ? { sensitive: input.sensitive } : {}),
      requestedBy: 'crewly',
      asker: ORCHESTRATOR_SESSION_NAME,
      system: input.system,
      title: input.title,
      ...(input.body?.length ? { body: input.body } : {}),
      status: 'open',
    });
    this.logger.info('System decision asked', { decisionId: decision.id, kind: input.kind, key: input.system.key });
    return this.postCard(decision);
  }

  /**
   * Ask a question Crewly built itself (e.g. a held browser action). The card
   * goes where an ask-owner card without a ticket goes: the thread of the
   * agent's current work item, else its team channel — from its own bot.
   *
   * @param ask - The prebuilt question
   * @returns The stored decision (with `card`, or `postError`; retried on the tick)
   */
  async askPrebuilt(ask: PrebuiltAsk): Promise<OwnerDecision> {
    const skipped = await this.findSkipped({ ...(ask.requestRef ? { requestId: ask.requestRef.requestId } : {}), asker: ask.asker }, ask.question);
    if (skipped) throw this.alreadySkippedError(skipped);
    const teamId = await this.deps.teamOf(ask.asker).catch(() => undefined);
    const workItemId = await this.deps.currentWorkItemId?.(ask.asker).catch(() => undefined);
    const decision = await this.deps.store.create({
      kind: ask.kind,
      question: ask.question,
      options: ask.options,
      defaultKey: ask.defaultKey,
      ...(ask.yesKey ? { yesKey: ask.yesKey } : {}),
      deadline: ask.deadline.toISOString(),
      ...(ask.sensitive ? { sensitive: ask.sensitive } : {}),
      ...(ask.browser ? { browser: ask.browser } : {}),
      ...(ask.title ? { title: ask.title } : {}),
      ...(ask.body?.length ? { body: ask.body } : {}),
      ...(ask.place ? { place: ask.place } : {}),
      ...(ask.requestRef ? { requestRef: ask.requestRef } : {}),
      ...(ask.source ? { source: ask.source } : {}),
      ...(ask.askedAt ? { askedAt: ask.askedAt } : {}),
      requestedBy: ask.asker,
      asker: ask.asker,
      ...(teamId ? { teamId } : {}),
      ...(workItemId ? { workItemId } : {}),
      status: 'open',
    });
    this.logger.info('Owner decision asked by Crewly', { decisionId: decision.id, kind: ask.kind, asker: ask.asker });
    return this.postCard(decision);
  }

  /**
   * Post a line in a decision's card thread (as the asker's bot).
   *
   * @param id - Decision id
   * @param text - mrkdwn text
   * @returns True when there was a card to reply to
   */
  async replyInThread(id: string, text: string): Promise<boolean> {
    const d = await this.deps.store.get(id);
    if (!d?.card) return false;
    await this.postInThread(d, text);
    return true;
  }

  /**
   * Mark an open decision as expired: what it asked about is gone. The card
   * says so, and the kind's handler tells the agent.
   *
   * @param id - Decision id
   * @returns The expired decision, or null when it was not pending
   */
  async expire(id: string): Promise<OwnerDecision | null> {
    const expired = await this.deps.store.update(id, (cur) =>
      PENDING_DECISION_STATUSES.has(cur.status) ? { status: 'expired', resolvedAt: this.now().toISOString(), remindAt: undefined } : null,
    );
    if (!expired) return null;
    await this.refreshCard(expired);
    if (expired.ticket) await this.logTicket(expired, `owner decision ${expired.id}: expired`, true);
    await this.notifyAsker(expired, null);
    this.logger.info('Owner decision expired', { decisionId: id });
    return expired;
  }

  /**
   * Post (or re-try posting) the card of an open decision.
   *
   * @param decision - Decision without a card
   * @returns The decision with `card` or `postError`
   */
  async postCard(decision: OwnerDecision): Promise<OwnerDecision> {
    const slack = this.deps.slack();
    if (!slack || !slack.isConnected()) {
      return (await this.deps.store.update(decision.id, () => ({ postError: 'Slack is not connected' }))) ?? decision;
    }
    try {
      const identity = await this.deps.identityOf(decision.asker);
      const place = await this.placeFor(decision, identity, slack);
      const blocks = renderOpenCard(decision, this.deps.instanceId(), this.now());
      const { ts, ownBot } = await this.send(slack, identity, {
        channelId: place.slackChannelId,
        text: cardFallbackText(decision),
        blocks,
        ...(place.threadTs ? { threadTs: place.threadTs } : {}),
      });
      const updated = await this.deps.store.update(decision.id, () => ({
        card: {
          slackChannelId: place.slackChannelId,
          messageTs: ts,
          ...(place.threadTs ? { threadTs: place.threadTs } : {}),
          postedBy: ownBot ? decision.asker : 'crewly',
          ownBot,
          renderRev: DECISION_CONSTANTS.CARD_RENDER_REV,
        },
        ...(place.teamId && !decision.teamId ? { teamId: place.teamId } : {}),
        postError: undefined,
      }));
      this.logger.info('Decision card posted', { decisionId: decision.id, channel: place.slackChannelId, threaded: !!place.threadTs, ownBot });
      return updated ?? decision;
    } catch (err) {
      const msg = err instanceof DecisionError ? err.message : errText(err);
      this.logger.warn('Decision card not posted (retried on the next tick)', { decisionId: decision.id, error: msg });
      return (await this.deps.store.update(decision.id, () => ({ postError: msg }))) ?? decision;
    }
  }

  /**
   * Where the card goes: the ticket's thread (created on first use), else the
   * asker's current work destination, else a new thread in its team channel.
   */
  private async placeFor(decision: OwnerDecision, identity: DecisionPostIdentity, slack: DecisionSlackApi): Promise<DecisionSlackPlace> {
    if (decision.system) {
      const dm = await this.deps.ownerDmOf?.(identity);
      if (!dm) throw new DecisionError(409, "No Slack DM with the owner from this machine's orc bot");
      return { slackChannelId: dm };
    }
    if (decision.ticket) {
      const t = decision.ticket;
      const existing = await this.deps.threads.get(t.projectPath, t.id);
      if (existing) return { slackChannelId: existing.slackChannelId, threadTs: existing.threadTs, teamId: existing.teamId };
      const channel = decision.teamId ? await this.deps.teamChannelOf(decision.teamId) : null;
      if (!channel) throw new DecisionError(409, `No Slack team channel for ${t.id}'s team — link the team to Slack first`);
      const { ts } = await this.send(slack, identity, { channelId: channel, text: ticketThreadRootText(t) });
      const thread = await this.deps.threads.set(t.projectPath, t.id, { slackChannelId: channel, threadTs: ts, ...(decision.teamId ? { teamId: decision.teamId } : {}) });
      return { slackChannelId: thread.slackChannelId, threadTs: thread.threadTs, teamId: thread.teamId };
    }
    if (decision.place?.slackChannelId) {
      return { ...decision.place, ...(decision.teamId ? { teamId: decision.teamId } : {}) };
    }
    const work = await this.deps.workDestination?.(decision.asker).catch(() => null);
    if (work?.slackChannelId) return work;
    const channel = decision.teamId ? await this.deps.teamChannelOf(decision.teamId) : null;
    if (!channel) throw new DecisionError(409, `No Slack place to ask in: ${decision.asker} has no team channel and no Slack conversation in hand`);
    return { slackChannelId: channel, ...(decision.teamId ? { teamId: decision.teamId } : {}) };
  }

  /**
   * Send as the agent's own bot; when Slack refuses that bot (not in the
   * channel, revoked), fall back to the shared bot with the agent's name.
   */
  private async send(
    slack: DecisionSlackApi,
    identity: DecisionPostIdentity,
    message: Pick<SlackOutgoingMessage, 'channelId' | 'text' | 'blocks' | 'threadTs'>,
  ): Promise<{ ts: string; ownBot: boolean }> {
    const base: SlackOutgoingMessage = { ...message, skipChatV2Mirror: true };
    if (identity.botToken) {
      try {
        return { ts: await slack.sendMessage({ ...base, botToken: identity.botToken }), ownBot: true };
      } catch (err) {
        this.logger.warn("Agent's own bot could not post the decision card — using the shared bot", { channel: message.channelId, error: errText(err) });
      }
    }
    const { botToken: _drop, ...shared } = identity;
    return { ts: await slack.sendMessage({ ...base, ...shared }), ownBot: false };
  }

  // ---------------------------------------------------------------------------
  // Answers
  // ---------------------------------------------------------------------------

  /**
   * A Slack `block_actions` payload (Cloud relay, Socket Mode or the HTTP
   * endpoint). Ignores anything that is not one of this instance's cards.
   *
   * @param payload - Slack payload
   * @returns What happened
   */
  async handleInteraction(payload: BlockActionsPayload): Promise<InteractionOutcome> {
    const action = payload?.actions?.[0];
    if (!action?.action_id?.startsWith(DECISION_CONSTANTS.ACTION_PREFIX)) return { handled: false, reason: 'not a decision action' };
    const value = parseButtonValue(action.value);
    if (!value) return { handled: false, reason: 'unreadable button value' };
    const self = this.deps.instanceId();
    if (value.i && self && value.i !== self) return { handled: false, reason: `card belongs to instance ${value.i}` };
    const decision = await this.deps.store.get(value.d);
    if (!decision) return { handled: false, reason: `unknown decision ${value.d}` };
    const channel = payload.container?.channel_id ?? payload.channel?.id;
    const ts = payload.container?.message_ts ?? payload.message?.ts;
    if (!decision.card || decision.card.slackChannelId !== channel || decision.card.messageTs !== ts) {
      return { handled: false, reason: 'click is not on the stored card' };
    }
    const user = payload.user?.id ?? '';
    if (!user || !this.deps.isOwner(user)) {
      this.logger.info('Decision click by someone other than the owner — ignored', { decisionId: decision.id, user });
      return { handled: false, reason: 'not the owner', decision };
    }
    if (decision.status !== 'open') return { handled: false, reason: `already ${decision.status}`, decision };
    const choice: DecisionChoice =
      value.o === 'remind' ? { kind: 'remind' } : value.o === DECISION_CONSTANTS.SKIP_OPTION ? skipChoice(decision) : { kind: 'option', key: value.o };
    return this.apply(decision, choice, 'button', user);
  }

  /**
   * A reaction on a card: ✅ default/first, ❌ the "no" option, ⏰ remind,
   * 🚫 / ⏭️ skip.
   *
   * @param event - `reaction_added` event
   * @returns What happened
   */
  async handleReaction(event: ReactionEvent): Promise<InteractionOutcome> {
    const channel = event?.item?.channel;
    const ts = event?.item?.ts;
    if (!channel || !ts || !event.reaction) return { handled: false, reason: 'not a message reaction' };
    const decision = await this.deps.store.findByCard(channel, ts);
    if (!decision) return { handled: false, reason: 'not a decision card' };
    if (decision.status !== 'open') return { handled: false, reason: `already ${decision.status}`, decision };
    if (!event.user || !this.deps.isOwner(event.user)) return { handled: false, reason: 'not the owner', decision };
    const choice = choiceFromReaction(decision, event.reaction);
    if (!choice) return { handled: false, reason: `reaction :${event.reaction}: means nothing here`, decision };
    // A system decision takes only an unambiguous answer: ❌ = its "no" option.
    const name = event.reaction.replace(/::skin-tone-\d$/, '');
    const declining = [...DECISION_CONSTANTS.REACTION_REJECT, ...DECISION_CONSTANTS.REACTION_SKIP] as readonly string[];
    if (decision.system && !(declining.includes(name) && choice.kind === 'option' && choice.key === noOption(decision.options)?.key)) {
      return { handled: false, reason: 'system decisions take a button, an option name, ❌ or 🚫', decision };
    }
    return this.apply(decision, choice, 'reaction', event.user);
  }

  /**
   * An owner reply in a card's thread (channel or DM thread), posted after
   * the card. Text: the newest open card takes it; words that match no
   * option are passed to the asker verbatim. A voice note, audio or other
   * file with no text answers every open card in the thread "in thread"
   * (specs/2026-10-02-decision-card-thread-answers.md §1). Every such owner
   * message stamps `ownerRepliedAt` on the open cards there.
   *
   * @param message - Inbound Slack message
   * @returns What happened
   */
  async handleThreadReply(
    message: Pick<SlackIncomingMessage, 'channelId' | 'threadTs' | 'ts' | 'text' | 'userId' | 'authorAgentSession'> & Partial<Pick<SlackIncomingMessage, 'files'>>,
  ): Promise<InteractionOutcome> {
    if (!message.threadTs || message.threadTs === message.ts) return { handled: false, reason: 'not a thread reply' };
    if (message.authorAgentSession) return { handled: false, reason: 'written by an agent' };
    if (!message.userId || !this.deps.isOwner(message.userId)) return { handled: false, reason: 'not the owner' };
    const candidates = await this.deps.store.list(
      (d) =>
        d.status === 'open' &&
        !!d.card &&
        d.card.slackChannelId === message.channelId &&
        (d.card.threadTs === message.threadTs || d.card.messageTs === message.threadTs) &&
        // Only what the owner said after the card went up answers it.
        slackTsAfter(message.ts, d.card.messageTs),
    );
    if (candidates.length === 0) return { handled: false, reason: 'no open card in this thread' };
    const at = this.now().toISOString();
    for (const c of candidates) {
      await this.deps.store.update(c.id, (cur) => (cur.status === 'open' ? { ownerRepliedAt: at } : null)).catch(() => null);
    }
    const decision = candidates[0];
    const files = answerFilesOf(message.files);
    const text = message.text ?? '';
    if (decision.system) {
      const choice = systemChoiceFromText(decision, text);
      if (!choice) return { handled: false, reason: 'not one of the options', decision };
      return this.apply(decision, choice, 'reply', message.userId);
    }
    if (text.replace(/<@[A-Z0-9]+>/g, '').trim()) {
      const choice = choiceFromText(decision, text);
      if (!choice) return { handled: false, reason: 'empty reply', decision };
      return this.apply(decision, choice, 'reply', message.userId, undefined, files);
    }
    if (files.length === 0) return { handled: false, reason: 'empty reply', decision };
    // A voice note / file can't pick an option: it answers the thread's open
    // questions as they stand, and each asker gets one note.
    const answerable = candidates.filter((c) => !c.system && c.kind !== 'browser_action');
    if (answerable.length === 0) return { handled: false, reason: 'a file does not answer this card', decision };
    const transcript = files.map((f) => f.transcript).filter((t): t is string => !!t).join(' ');
    const notes = new Map<string, string[]>();
    let first: InteractionOutcome | null = null;
    for (const c of answerable) {
      const out = await this.apply(c, { kind: 'thread', files, ...(transcript ? { text: transcript } : {}) }, 'thread', message.userId, notes);
      if (!first && out.handled) first = out;
    }
    for (const [asker, lines] of notes) {
      const d = answerable.find((c) => c.asker === asker) ?? decision;
      await this.tellAsker(d, lines.join('\n'));
    }
    return first ?? { handled: false, reason: 'already settled', decision };
  }

  /**
   * The owner answered from the dashboard.
   *
   * @param id - Decision id
   * @param optionKey - Option key (or label / number)
   * @returns The resolved decision
   * @throws DecisionError(404/409/400)
   */
  async chooseFromDashboard(id: string, optionKey: string): Promise<OwnerDecision> {
    const decision = await this.requirePending(id);
    const opt = decision.options.find((o) => o.key === optionKey) ?? decision.options.find((o) => o.label.toLowerCase() === String(optionKey).toLowerCase());
    if (!opt) throw new DecisionError(400, `"${optionKey}" is not an option of ${id} (${decision.options.map((o) => o.key).join(', ')})`);
    const out = await this.apply(decision, { kind: 'option', key: opt.key }, 'dashboard', this.deps.ownerUserId?.() ?? undefined);
    return out.decision ?? decision;
  }

  /**
   * "Remind me tomorrow" from the dashboard.
   *
   * @param id - Decision id
   * @returns The snoozed decision
   */
  async remindFromDashboard(id: string): Promise<OwnerDecision> {
    const decision = await this.requirePending(id);
    const out = await this.apply(decision, { kind: 'remind' }, 'dashboard', this.deps.ownerUserId?.() ?? undefined);
    return out.decision ?? decision;
  }

  /**
   * "Skip" from the dashboard (sensitive / system cards: their safe "no").
   *
   * @param id - Decision id
   * @returns The settled decision
   */
  async skipFromDashboard(id: string): Promise<OwnerDecision> {
    const decision = await this.requirePending(id);
    const out = await this.apply(decision, skipChoice(decision), 'dashboard', this.deps.ownerUserId?.() ?? undefined);
    return out.decision ?? decision;
  }

  /**
   * Skip every matching open decision at once ("clear the stale cards"):
   * each card is updated, each linked open item closed, and each asking
   * agent gets ONE note listing what it should drop. Sensitive / system /
   * browser cards get their safe "no" instead ({@link skipChoice}).
   *
   * @param input - Filters and dry-run
   * @returns What matched and what was settled
   */
  async skipAll(input: SkipAllInput = {}): Promise<SkipAllResult> {
    const before = input.olderThan?.getTime();
    const pending = await this.deps.store.list((d) => PENDING_DECISION_STATUSES.has(d.status) && (before === undefined || Date.parse(d.createdAt) < before));
    const rows: Array<{ d: OwnerDecision; row: SkipAllRow }> = [];
    for (const d of pending) {
      const source: DecisionSource = (await this.isBackfilled(d)) ? 'backfill' : 'live';
      if (input.source === 'backfill' && source !== 'backfill') continue;
      rows.push({
        d,
        row: {
          id: d.id,
          question: d.question,
          asker: d.asker,
          createdAt: d.createdAt,
          ...(d.ticket ? { ticket: d.ticket.id } : {}),
          source,
          outcome: skipChoice(d).kind === 'skip' ? 'skipped' : 'declined',
        },
      });
    }
    const result: SkipAllResult = { dryRun: input.dryRun === true, matched: rows.length, settled: [], rows: rows.map((r) => r.row) };
    if (input.dryRun) return result;
    const notes = new Map<string, string[]>();
    const owner = this.deps.ownerUserId?.() ?? undefined;
    for (const { d } of rows) {
      try {
        const out = await this.apply(d, skipChoice(d), 'bulk', owner, notes);
        if (out.handled) result.settled.push(d.id);
      } catch (err) {
        this.logger.warn('Bulk skip step failed', { decisionId: d.id, error: errText(err) });
      }
    }
    for (const [asker, lines] of notes) {
      const text =
        lines.length === 1
          ? lines[0]
          : `[DECISIONS] The owner cleared ${lines.length} old cards of yours. Drop each of these and don't ask again:\n${lines.map((l) => `- ${l}`).join('\n')}`;
      const ok = await this.deps.deliverToAgent(asker, text).catch(() => false);
      if (!ok) this.logger.warn('Could not deliver the bulk-skip note to the asking agent', { asker });
    }
    this.logger.info('Owner decisions skipped in bulk', { matched: result.matched, settled: result.settled.length, source: input.source ?? 'all', olderThan: input.olderThan?.toISOString() });
    return result;
  }

  /**
   * A question the owner skipped in the same scope within
   * {@link DECISION_CONSTANTS.SKIP_DEDUPE_MS}: the agent must not ask it again.
   *
   * @param scope - Request / ticket (or the asker when it has neither)
   * @param question - The question about to be asked
   * @returns The skipped decision, or null
   */
  async findSkipped(scope: SkipScope, question: string): Promise<OwnerDecision | null> {
    const keys = new Set(skipScopeKeys(scope));
    if (keys.size === 0 || !question.trim()) return null;
    const since = this.now().getTime() - DECISION_CONSTANTS.SKIP_DEDUPE_MS;
    const skipped = await this.deps.store.list((d) => d.status === 'skipped' && Date.parse(d.resolvedAt ?? d.updatedAt) >= since);
    return (
      skipped.find(
        (d) =>
          skipScopeKeys(scopeOf(d)).some((k) => keys.has(k)) &&
          questionSimilarity(d.question, question) >= DECISION_CONSTANTS.SKIP_SAME_QUESTION_SIMILARITY,
      ) ?? null
    );
  }

  /** The refusal for a re-ask of a skipped question. */
  private alreadySkippedError(d: OwnerDecision): DecisionError {
    return new DecisionError(
      409,
      `The owner skipped this question (${d.id}, "${d.question}") — drop it, don't ask again.`,
    );
  }

  /**
   * Whether the open-items backfill created this card: `source` when set;
   * for older cards, a reply-question card made long after the agent asked.
   *
   * @param d - Decision
   * @returns True for a backfilled card
   */
  async isBackfilled(d: OwnerDecision): Promise<boolean> {
    if (d.source) return d.source === 'backfill';
    if (d.kind !== 'reply_question' || !d.requestRef) return false;
    const askedAt = d.askedAt ?? (await this.deps.openItemAskedAt?.(d.requestRef).catch(() => undefined));
    if (!askedAt) return false;
    return Date.parse(d.createdAt) - Date.parse(askedAt) >= DECISION_CONSTANTS.BACKFILL_CARD_MIN_LAG_MS;
  }

  /**
   * Withdraw open decisions (the asker no longer needs an answer, or the
   * ticket's mark was cleared).
   *
   * @param filter - Which decisions
   * @param note - Why (ticket log)
   * @returns How many were withdrawn
   */
  async cancelWhere(filter: (d: OwnerDecision) => boolean, note?: string): Promise<number> {
    const open = await this.deps.store.list((d) => PENDING_DECISION_STATUSES.has(d.status) && filter(d));
    for (const d of open) {
      const done = await this.deps.store.update(d.id, (cur) =>
        PENDING_DECISION_STATUSES.has(cur.status)
          ? { status: 'cancelled', resolvedAt: this.now().toISOString(), remindAt: undefined, ...(note?.trim() ? { closedReason: note.trim() } : {}) }
          : null,
      );
      if (!done) continue;
      await this.refreshCard(done);
      if (done.kind) await this.notifyAsker(done, null);
      this.logger.info('Owner decision withdrawn', { decisionId: d.id, note });
    }
    return open.length;
  }

  /**
   * List decisions.
   *
   * @param which - `open` (open + parked) or `all`
   * @returns Decisions, newest first
   */
  async list(which: 'open' | 'all' = 'open'): Promise<OwnerDecision[]> {
    const all = await this.deps.store.list(which === 'open' ? (d) => PENDING_DECISION_STATUSES.has(d.status) : undefined);
    return all.slice(0, DECISION_CONSTANTS.MAX_LISTED);
  }

  /**
   * One decision.
   *
   * @param id - Decision id
   * @returns Decision or null
   */
  get(id: string): Promise<OwnerDecision | null> {
    return this.deps.store.get(id);
  }

  private async requirePending(id: string): Promise<OwnerDecision> {
    const decision = await this.deps.store.get(id);
    if (!decision) throw new DecisionError(404, `Decision ${id} not found`);
    if (!PENDING_DECISION_STATUSES.has(decision.status)) throw new DecisionError(409, `Decision ${id} is already ${decision.status}`);
    return decision;
  }

  /**
   * Apply a choice: resolve (or snooze), update the card, log the ticket,
   * tell the asker, close the watchdog entry.
   */
  private async apply(
    decision: OwnerDecision,
    choice: DecisionChoice,
    via: DecisionAnswerVia,
    user: string | undefined,
    batchNotes?: Map<string, string[]>,
    files: DecisionAnswerFile[] = [],
  ): Promise<InteractionOutcome> {
    const now = this.now();
    if (choice.kind === 'skip') return this.applySkip(decision, via, user, batchNotes);
    if (choice.kind === 'remind' && !canRemind(decision)) {
      return { handled: false, reason: 'remind is not offered on this card', decision };
    }
    if (choice.kind === 'text' && decision.kind === 'browser_action') {
      // A held click is approved or not: words that are neither leave it open.
      return { handled: false, reason: 'reply is neither yes nor no', decision };
    }
    if (choice.kind === 'remind') {
      const remindAt = tomorrowAt(now, DECISION_CONSTANTS.REMIND_HOUR_LOCAL);
      const minDeadline = remindAt.getTime() + DECISION_CONSTANTS.REMIND_GRACE_MS;
      const updated = await this.deps.store.update(decision.id, (cur) =>
        PENDING_DECISION_STATUSES.has(cur.status)
          ? {
              status: 'open',
              remindAt: remindAt.toISOString(),
              deadline: new Date(Math.max(Date.parse(cur.deadline), minDeadline)).toISOString(),
              // A parked sensitive ask that is snoozed gets its re-ask cycle back.
              reaskedAt: cur.status === 'parked' ? undefined : cur.reaskedAt,
            }
          : null,
      );
      if (!updated) return { handled: false, reason: 'already settled', decision };
      await this.refreshCard(updated);
      if (updated.ticket) await this.logTicket(updated, `owner decision ${updated.id}: remind tomorrow (${via})`, false);
      this.logger.info('Owner decision snoozed to tomorrow', { decisionId: decision.id, via });
      return { handled: true, reason: 'snoozed', decision: updated };
    }

    const patch: Partial<OwnerDecision> =
      choice.kind === 'option'
        ? { status: 'resolved', chosenKey: choice.key, answerText: undefined }
        : choice.kind === 'thread'
          ? { status: 'resolved', chosenKey: undefined, answerText: choice.text?.slice(0, 2000), answerFiles: choice.files }
          : { status: 'resolved', chosenKey: undefined, answerText: choice.text.slice(0, 2000) };
    if (files.length > 0 && choice.kind !== 'thread') patch.answerFiles = files;
    const resolved = await this.deps.store.update(decision.id, (cur) =>
      PENDING_DECISION_STATUSES.has(cur.status)
        ? { ...patch, answeredVia: via, ...(user ? { answeredBy: user } : {}), resolvedAt: now.toISOString(), remindAt: undefined }
        : null,
    );
    if (!resolved) return { handled: false, reason: 'already settled', decision };
    await this.refreshCard(resolved);
    const answer = resolved.chosenKey
      ? optionLabel(resolved, resolved.chosenKey)
      : resolved.answeredVia === 'thread'
        ? `answered in the thread with ${describeAnswerFiles(resolved.answerFiles ?? [])}`
        : `“${resolved.answerText}”`;
    if (resolved.ticket) await this.logTicket(resolved, `owner decision ${resolved.id}: ${answer} (${via})`, true);
    await this.notifyAsker(resolved, this.answerNote(resolved), batchNotes);
    this.closeWatchdog(resolved);
    this.logger.info('Owner decision resolved', { decisionId: resolved.id, via, chosen: resolved.chosenKey ?? 'text' });
    return { handled: true, reason: 'resolved', decision: resolved };
  }

  /**
   * The owner skipped a card: settle it as `skipped`, show who skipped it,
   * close what it tracks, and tell the asker once to drop it.
   */
  private async applySkip(decision: OwnerDecision, via: DecisionAnswerVia, user: string | undefined, batchNotes?: Map<string, string[]>): Promise<InteractionOutcome> {
    const now = this.now();
    const skipped = await this.deps.store.update(decision.id, (cur) =>
      PENDING_DECISION_STATUSES.has(cur.status)
        ? { status: 'skipped', chosenKey: undefined, answerText: undefined, answeredVia: via, ...(user ? { answeredBy: user } : {}), resolvedAt: now.toISOString(), remindAt: undefined }
        : null,
    );
    if (!skipped) return { handled: false, reason: 'already settled', decision };
    await this.refreshCard(skipped);
    if (skipped.ticket) await this.logTicket(skipped, `owner decision ${skipped.id}: skipped by the owner (${via})`, true);
    await this.notifyAsker(skipped, this.skipNote(skipped), batchNotes);
    this.closeWatchdog(skipped);
    this.logger.info('Owner decision skipped', { decisionId: skipped.id, via });
    return { handled: true, reason: 'skipped', decision: skipped };
  }

  /** The note the asker receives when the owner skipped its question. */
  private skipNote(d: OwnerDecision): string {
    return `[DECISION ${d.id}] The owner skipped this — drop it, don't ask again: "${d.question}"${d.ticket ? ` (ticket ${d.ticket.id})` : ''}.`;
  }

  /** The note the asker receives when the owner answered. */
  private answerNote(d: OwnerDecision): string {
    const where = this.whereLine(d);
    const about = `for: "${d.question}"${d.ticket ? ` (ticket ${d.ticket.id})` : ''}`;
    const files = filesLine(d.answerFiles ?? []);
    if (d.chosenKey) {
      return `[DECISION ${d.id}] The owner chose "${optionLabel(d, d.chosenKey)}" ${about}. Act on it now.${files}${where}`;
    }
    if (d.answeredVia === 'thread') {
      const what = describeAnswerFiles(d.answerFiles ?? []);
      const transcript = d.answerText ? ` Slack's transcript: "${d.answerText}".` : '';
      return (
        `[DECISION ${d.id}] The owner answered ${about} in the card's thread with ${what} (no text).${transcript}${files} ` +
        `Read it as their decision and act on it; if it is genuinely unclear, ask once more with ask-owner.${where}`
      );
    }
    return `[DECISION ${d.id}] The owner answered in words ${about}: "${d.answerText ?? ''}".${files} Read it as their decision and act on it; if it is genuinely unclear, ask once more with ask-owner.${where}`;
  }

  /**
   * Where the asker's follow-up belongs: a command naming the decision — the
   * harness finds the card's thread (specs/2026-10-02-harness-owned-routing.md §4).
   */
  private whereLine(d: OwnerDecision): string {
    if (!d.card) return '';
    return ` To post an update for the owner, run: reply --decision ${d.id} "<your message>" — Crewly posts it in the card's thread.`;
  }

  // ---------------------------------------------------------------------------
  // Deadlines and reminders
  // ---------------------------------------------------------------------------

  /**
   * One pass: retry unposted cards, post due reminders, apply defaults at
   * the deadline, re-ask / park sensitive asks, prune old decisions.
   *
   * @returns Ids acted on
   */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const acted: string[] = [];
    try {
      const now = this.now();
      for (const d of await this.deps.store.list((x) => x.status === 'open')) {
        try {
          if (!d.card) {
            // A card Slack refused is retried every few minutes, not every tick.
            if (d.postError && now.getTime() - Date.parse(d.updatedAt) < DECISION_CONSTANTS.POST_RETRY_MS) continue;
            if ((await this.postCard(d)).card) acted.push(d.id);
            continue;
          }
          if (d.remindAt && Date.parse(d.remindAt) <= now.getTime()) {
            await this.remindNow(d);
            acted.push(d.id);
            continue;
          }
          if (Date.parse(d.deadline) > now.getTime()) continue;
          if (d.defaultKey === DECISION_CONSTANTS.WAIT_DEFAULT && !d.sensitive) {
            if (await this.waitStep(d, now)) acted.push(d.id);
            continue;
          }
          // A default that never lets anything through (a held browser
          // action's No, a declined Terms card) is applied even when sensitive.
          if (d.sensitive && !defaultIsSafe(d)) {
            if (await this.sensitiveStep(d, now)) acted.push(d.id);
          } else if (await this.applyDefault(d, now)) {
            acted.push(d.id);
          }
        } catch (err) {
          this.logger.warn('Decision tick step failed', { decisionId: d.id, error: errText(err) });
        }
      }
      await this.deps.store.prune().catch(() => 0);
    } finally {
      this.ticking = false;
    }
    return acted;
  }

  /**
   * Withdraw a card whose tracked item is already closed, silently: the
   * card says why, nothing is posted in the thread and the asker is not woken
   * (specs/2026-10-02-decision-card-thread-answers.md §3).
   *
   * @param d - Open decision about to post something to the owner
   * @returns True when it was withdrawn
   */
  private async withdrawIfMoot(d: OwnerDecision): Promise<boolean> {
    if (!this.deps.trackedClosed) return false;
    const reason = await this.deps.trackedClosed(d).catch(() => null);
    if (!reason) return false;
    const n = await this.cancelWhere((x) => x.id === d.id, reason);
    if (n > 0) this.logger.info('Decision card withdrawn before posting: what it tracks is already closed', { decisionId: d.id, reason });
    return n > 0;
  }

  /** Post the "Remind me tomorrow" reminder in the card's thread. */
  private async remindNow(d: OwnerDecision): Promise<void> {
    if (await this.withdrawIfMoot(d)) return;
    const updated = await this.deps.store.update(d.id, (cur) => (cur.status === 'open' && cur.remindAt ? { remindAt: undefined } : null));
    if (!updated) return;
    const owner = this.deps.ownerUserId?.();
    await this.postInThread(updated, `${owner ? `<@${owner}> ` : ''}Reminder: ${updated.question} — tap an answer on the card above, or reply here.`);
    await this.refreshCard(updated);
  }

  /**
   * A `wait` card past its deadline (specs/2026-10-02-decision-card-thread-answers.md §2):
   * first only the asker is told — nothing goes to the owner; later, once, a
   * reminder that says what to do, when the owner has not touched the thread.
   */
  private async waitStep(d: OwnerDecision, now: Date): Promise<boolean> {
    if (!d.deadlineNoticeAt) {
      if (await this.withdrawIfMoot(d)) return true;
      const updated = await this.deps.store.update(d.id, (cur) => (cur.status === 'open' && !cur.deadlineNoticeAt ? { deadlineNoticeAt: now.toISOString() } : null));
      if (!updated) return false;
      if (updated.ticket) await this.logTicket(updated, `owner decision ${updated.id}: no answer by the deadline — still waiting (nothing posted to the owner)`, false);
      await this.tellAsker(
        updated,
        `[DECISION ${updated.id}] The deadline for "${updated.question}" passed with no answer. Nothing was posted to the owner. ` +
          `Keep this work parked until they answer. If it is already settled or no longer needed, withdraw it: ask-owner --cancel ${updated.id} --reason "<why>".${this.whereLine(updated)}`,
      );
      this.logger.info('Wait-default decision past its deadline — asker told, nothing posted', { decisionId: updated.id });
      return true;
    }
    if (d.waitReminderAt || d.ownerRepliedAt) return false;
    if (now.getTime() < Date.parse(d.deadlineNoticeAt) + DECISION_CONSTANTS.WAIT_REMINDER_DELAY_MS) return false;
    if (await this.withdrawIfMoot(d)) return true;
    const updated = await this.deps.store.update(d.id, (cur) =>
      cur.status === 'open' && !cur.waitReminderAt && !cur.ownerRepliedAt ? { waitReminderAt: now.toISOString() } : null,
    );
    if (!updated) return false;
    await this.postInThread(updated, waitReminderLine(updated, this.deps.ownerUserId?.()));
    this.logger.info('Wait-default decision: one reminder posted', { decisionId: updated.id });
    return true;
  }

  /** Non-sensitive deadline with a real default: apply it and say who does what. */
  private async applyDefault(d: OwnerDecision, now: Date): Promise<boolean> {
    if (await this.withdrawIfMoot(d)) return true;
    const line = deadlineDefaultLine(d, now, await this.askerName(d));
    const resolved = await this.deps.store.update(d.id, (cur) =>
      cur.status === 'open' ? { status: 'defaulted', chosenKey: cur.defaultKey, answeredVia: 'deadline', resolvedAt: now.toISOString() } : null,
    );
    if (!resolved) return false;
    await this.refreshCard(resolved);
    await this.postInThread(resolved, line);
    if (resolved.ticket) await this.logTicket(resolved, `owner decision ${resolved.id}: no answer — default "${defaultLabel(resolved)}" applied`, true);
    await this.notifyAsker(
      resolved,
      `[DECISION ${resolved.id}] No answer by the deadline for: "${resolved.question}"${resolved.ticket ? ` (ticket ${resolved.ticket.id})` : ''}. Going with the default: "${defaultLabel(resolved)}". Act on it now.${this.whereLine(resolved)}`,
    );
    this.closeWatchdog(resolved);
    this.logger.info('Owner decision defaulted at the deadline', { decisionId: resolved.id, chosen: resolved.chosenKey });
    return true;
  }

  /** Sensitive deadline: re-ask once after 24 h, then park. Never auto-applied. */
  private async sensitiveStep(d: OwnerDecision, now: Date): Promise<boolean> {
    if (!d.reaskedAt) {
      const due = Math.max(Date.parse(d.deadline), Date.parse(d.createdAt) + DECISION_CONSTANTS.SENSITIVE_REASK_AFTER_MS);
      if (now.getTime() < due) return false;
      if (await this.withdrawIfMoot(d)) return true;
      const updated = await this.deps.store.update(d.id, (cur) => (cur.status === 'open' && !cur.reaskedAt ? { reaskedAt: now.toISOString() } : null));
      if (!updated) return false;
      const owner = this.deps.ownerUserId?.();
      await this.postInThread(
        updated,
        `${owner ? `<@${owner}> ` : ''}Still need your answer: ${updated.question} This needs your OK (${updated.sensitive}), so I'm not going ahead without it.`,
      );
      await this.refreshCard(updated);
      this.logger.info('Sensitive owner decision re-asked', { decisionId: d.id });
      return true;
    }
    if (now.getTime() < Date.parse(d.reaskedAt) + DECISION_CONSTANTS.SENSITIVE_PARK_AFTER_REASK_MS) return false;
    const parked = await this.deps.store.update(d.id, (cur) => (cur.status === 'open' ? { status: 'parked' } : null));
    if (!parked) return false;
    await this.refreshCard(parked);
    if (parked.ticket) await this.logTicket(parked, `owner decision ${parked.id}: no answer after a re-ask — parked (sensitive: ${parked.sensitive})`, false);
    await this.notifyAsker(
      parked,
      `[DECISION ${parked.id}] No answer to: "${parked.question}" even after a re-ask. It needs the owner's OK (${parked.sensitive}), so it is PARKED: do not do it. Move on to other work; you will get a [DECISION] message if the owner answers.`,
    );
    this.logger.info('Sensitive owner decision parked', { decisionId: d.id });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Slack helpers
  // ---------------------------------------------------------------------------

  /** Re-render the card for the decision's current state (with the posting bot's token). */
  private async refreshCard(d: OwnerDecision): Promise<boolean> {
    const slack = this.deps.slack();
    if (!d.card || !slack) return false;
    const now = this.now();
    const pending = d.status === 'open';
    let ownerName: string | undefined;
    if (!pending && d.answeredBy) ownerName = await this.deps.userName?.(d.answeredBy).catch(() => undefined);
    const askerName = d.status === 'defaulted' ? await this.askerName(d) : undefined;
    const blocks = pending ? renderOpenCard(d, this.deps.instanceId(), now) : renderSettledCard(d, ownerName, now, askerName);
    const text = pending ? cardFallbackText(d) : `${cardFallbackText(d)} — ${settledLine(d, ownerName, now, askerName)}`;
    const token = d.card.ownBot ? (await this.deps.identityOf(d.card.postedBy).catch(() => ({}) as DecisionPostIdentity)).botToken : undefined;
    try {
      await slack.updateMessage(d.card.slackChannelId, d.card.messageTs, text, blocks, token);
      return true;
    } catch (err) {
      this.logger.warn('Could not update the decision card', { decisionId: d.id, error: errText(err) });
      return false;
    }
  }

  /** The asking agent's display name ("Owen"), when known. */
  private async askerName(d: OwnerDecision): Promise<string | undefined> {
    if (d.system) return undefined;
    const named = await this.deps.displayName?.(d.asker).catch(() => undefined);
    if (named) return named;
    const identity = await this.deps.identityOf(d.asker).catch(() => ({}) as DecisionPostIdentity);
    return identity.username && identity.username !== d.asker ? identity.username : undefined;
  }

  /** Post a line in the card's thread, as the asker. */
  private async postInThread(d: OwnerDecision, text: string): Promise<void> {
    const slack = this.deps.slack();
    if (!d.card || !slack || !slack.isConnected()) return;
    try {
      const identity = await this.deps.identityOf(d.asker);
      await this.send(slack, identity, { channelId: d.card.slackChannelId, text, threadTs: d.card.threadTs ?? d.card.messageTs });
    } catch (err) {
      this.logger.warn('Could not post in the decision thread', { decisionId: d.id, error: errText(err) });
    }
  }

  private async logTicket(d: OwnerDecision, line: string, settled: boolean): Promise<void> {
    if (!d.ticket) return;
    let clear = false;
    if (settled) {
      const others = await this.deps.store.list(
        (x) => x.id !== d.id && PENDING_DECISION_STATUSES.has(x.status) && x.ticket?.projectPath === d.ticket?.projectPath && x.ticket?.id === d.ticket?.id,
      );
      clear = others.length === 0;
    }
    await this.deps.logTicket(d.ticket, line, clear).catch((err) => this.logger.warn('Could not log the decision on the ticket', { decisionId: d.id, error: errText(err) }));
  }

  /**
   * Tell the asker how a decision settled: through its kind's handler when
   * it has one (which also acts on the answer), else with `fallback`.
   */
  private async notifyAsker(d: OwnerDecision, fallback: string | null, batchNotes?: Map<string, string[]>): Promise<void> {
    const handler = d.kind ? KIND_HANDLERS.get(d.kind) : undefined;
    let text = fallback;
    if (handler) {
      try {
        text = await handler.onSettled(d, fallback);
      } catch (err) {
        this.logger.warn('Decision kind handler failed', { decisionId: d.id, kind: d.kind, error: errText(err) });
      }
    }
    if (!text) return;
    // Bulk skip: one note per agent, sent by the caller.
    if (batchNotes && !d.system) {
      batchNotes.set(d.asker, [...(batchNotes.get(d.asker) ?? []), text]);
      return;
    }
    await this.tellAsker(d, text);
  }

  private async tellAsker(d: OwnerDecision, text: string): Promise<void> {
    // A harness-owned decision is handled by its kind's handler; no agent is woken.
    if (d.system) return;
    const ok = await this.deps.deliverToAgent(d.asker, text).catch(() => false);
    // A bare `reply` after this prompt follows the decision, not an unrelated
    // newer work item — recorded only once it was delivered.
    if (ok && (d.card || d.ticket)) AgentPromptReferenceService.getInstance().note(d.asker, { decisionId: d.id }, `[DECISION ${d.id}]`);
    if (!ok) this.logger.warn('Could not deliver the decision to the asking agent', { decisionId: d.id, asker: d.asker });
    // The orchestrator asked on the owner's behalf for a ticket it does not own: tell it too.
    if (d.requestedBy !== d.asker && d.requestedBy === ORCHESTRATOR_SESSION_NAME) {
      await this.deps.deliverToAgent(d.requestedBy, text).catch(() => false);
    }
  }

  private closeWatchdog(d: OwnerDecision): void {
    if (!d.card || !this.deps.closeWatchdog) return;
    try {
      this.deps.closeWatchdog(d.asker, d.card.slackChannelId, d.card.threadTs ?? d.card.messageTs);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * A system decision's thread reply: an option (label, key, number) or a
 * "no" word for its "no" option. Yes-words are ambiguous (two ways to agree)
 * and free text is not an answer.
 *
 * @param d - Decision
 * @param text - Owner's reply
 * @returns Choice, or null
 */
function systemChoiceFromText(d: OwnerDecision, text: string): DecisionChoice | null {
  const clean = text.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const opt = matchOption(clean, d.options);
  if (opt) return { kind: 'option', key: opt.key };
  const norm = clean.toLowerCase().replace(/[\s.。!！,，]+$/u, '');
  if ((DECISION_CONSTANTS.NO_WORDS as readonly string[]).includes(norm) || isSkipWord(norm)) {
    const no = noOption(d.options);
    if (no) return { kind: 'option', key: no.key };
  }
  return null;
}

/**
 * The files line of an answer note: name, type and link of each file, and how
 * to hear a voice note that came without a transcript.
 *
 * @param files - Answer files
 * @returns Text starting with a space, or '' for none
 */
function filesLine(files: readonly DecisionAnswerFile[]): string {
  if (files.length === 0) return '';
  const list = files.map((f) => `${f.name}${f.mimetype ? ` (${f.mimetype})` : ''}${f.permalink ? ` ${f.permalink}` : ''}`).join('; ');
  const unheard = files.some((f) => !f.transcript && /^(audio|video)\//.test(f.mimetype ?? ''));
  const hint = unheard
    ? ' If you have not heard it yet, transcribe it with the transcribe-audio skill (the file reached you with the owner\'s message, or fetch it from the link).'
    : '';
  return ` Files: ${list}.${hint}`;
}

/**
 * Message of an unknown error.
 *
 * @param err - Thrown value
 * @returns Text
 */
function errText(err: unknown): string {
  if (err && typeof err === 'object') {
    const data = (err as { data?: { error?: string } }).data;
    if (typeof data?.error === 'string') return data.error;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Re-exported for the deadline line in the dashboard/API. */
export { formatWhen };
