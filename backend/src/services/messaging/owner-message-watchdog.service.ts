/**
 * Unanswered-owner-message watchdog.
 *
 * Every owner message delivered to an agent on this machine ends in either an
 * answer the owner can see, or ONE plain-words note in the same thread saying
 * who it is waiting on and why. Four different bugs on 2026-09-30 each lost an
 * owner message silently; each was fixed on its own, but nothing guaranteed
 * the end-to-end property. This does.
 *
 * Timeline per message (constants in OWNER_MESSAGE_WATCHDOG_CONSTANTS):
 *  - an answer (or a settled placeholder, or `reply --none`) clears it;
 *  - a placeholder showing while the agent is mid-turn extends the wait, up
 *    to BUSY_EXTEND_CAP_MS, then a note;
 *  - T1 → one re-delivery ("nudge") to the responsible agent, waking it;
 *    an agent that cannot be reached skips straight to the note;
 *  - T2 → one note, and the message is no longer tracked.
 *
 * The service is transport-agnostic: what counts as "delivered", "answered",
 * "busy" and how to nudge / post a note are injected (see the wiring module).
 *
 * @module services/messaging/owner-message-watchdog.service
 * @see specs/2026-09-30-owner-message-guarantee.md
 */

import { formatTokens } from '../usage/token-format.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, OWNER_MESSAGE_WATCHDOG_CONSTANTS as C } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { traceHarness } from '../trace/trace-recorder.js';

/** Where the owner wrote: a Slack conversation, or a Crewly chat (portal / Talk / dashboard). */
export type OwnerMessageSurface = 'slack' | 'chat';

/** What a watched message needs to be tracked. */
export interface OwnerMessageTrackInput {
  surface: OwnerMessageSurface;
  /** Slack channel / DM id (slack surface) */
  slackChannelId?: string;
  /** Slack thread root the answer belongs in (slack surface) */
  threadTs?: string;
  /** The owner's Slack message ts (dedupe key for slack) */
  sourceTs?: string;
  /** chat-v2 channel / conversation the message was recorded in (both surfaces when known) */
  chatChannelId?: string;
  /** chat-v2 thread the answer belongs in (huddles) */
  chatThreadId?: string;
  /** chat-v2 message id (dedupe key for chat) */
  messageId?: string;
  /** The agent that must answer (nudged at T1, named in the note) */
  responsible: string;
  /** Every agent that holds the message */
  recipients: readonly string[];
  /** True when at least one recipient was required to answer (DM, @mention, woken lead) */
  required: boolean;
  /** The owner's words */
  text: string;
  /** When it arrived (epoch ms); defaults to now */
  receivedAt?: number;
}

/** One tracked message. */
export interface OwnerMessageEntry {
  key: string;
  surface: OwnerMessageSurface;
  slackChannelId?: string;
  threadTs?: string;
  sourceTs?: string;
  chatChannelId?: string;
  chatThreadId?: string;
  messageId?: string;
  responsible: string;
  recipients: string[];
  required: boolean;
  /** Clipped owner text */
  preview: string;
  receivedAt: number;
  /**
   * `waiting` → `nudged` (re-delivered once) → noted. `login_wait`: the
   * agent's runtime is signed out; the owner was told, and the message is
   * re-delivered when the login is back ({@link OwnerMessageWatchdogService.resumeAfterLogin}).
   * `failed_wait`: the agent's turns fail (its model run errors); the owner
   * was told once, and the message is re-delivered on a backing-off timer
   * (FAILED_RETRY_BACKOFF_MS; never for credit / quota) and when a turn
   * succeeds ({@link OwnerMessageWatchdogService.resumeAfterRecovery}).
   */
  stage: 'waiting' | 'nudged' | 'login_wait' | 'failed_wait';
  /** Why the agent's turns fail, while `failed_wait` */
  failedDetail?: string;
  /** Timed re-deliveries made while `failed_wait` */
  failedRetries?: number;
  /** The failure needs credit / quota back: no timed re-delivery */
  failedNeedsCredit?: boolean;
  /** When the owner was told the agent's turns fail (once per message) */
  failedNotedAt?: number;
  /** Runtime word of the login it waits on ("claude"), while `login_wait` */
  loginRuntime?: string;
  nudgedAt?: number;
  /** A nudge that could not reach the agent */
  nudgeBlocked?: { reason: NudgeBlockReason; detail?: string };
  /** An interim note was posted in chat (a visible "working on it") */
  interimAt?: number;
  /** The nudged agent started a turn after the nudge */
  busyAfterNudge?: boolean;
  /** …and finished it */
  turnDoneAfterNudge?: boolean;
  /** Extension already logged */
  extendedLogged?: boolean;
}

/** Why a nudge could not reach the agent. */
export type NudgeBlockReason = 'asleep' | 'login' | 'error' | 'spend_cap';

/** Outcome of one nudge. */
export type NudgeOutcome = { outcome: 'sent' } | { outcome: 'blocked'; reason: NudgeBlockReason; detail?: string };

/** Pending sign-in, for the one-tap fix in the note. */
export interface LoginHint {
  /** Human name of the runtime ("Claude", "Codex") */
  runtime: string;
  /** Word the owner types after `relogin` / 重新登录 ("claude", "codex") */
  runtimeCmd: string;
}

/** Injected behaviour. */
export interface OwnerMessageWatchdogDeps {
  /** Is the agent mid-turn right now? */
  isBusy: (agentSession: string) => boolean;
  /** Is a "working on it" placeholder showing where the answer will land (slack surface)? */
  hasVisiblePlaceholder?: (entry: OwnerMessageEntry) => boolean;
  /** Re-deliver the message to its responsible agent, waking it when stopped. */
  nudge: (entry: OwnerMessageEntry, waitedMinutes: number) => Promise<NudgeOutcome>;
  /** Post the note where the owner wrote. Returns false when it could not be posted. */
  postNote: (entry: OwnerMessageEntry, text: string) => Promise<boolean>;
  /** A sign-in the agent's runtime is waiting for, if any. */
  loginRequired?: (agentSession: string) => LoginHint | null;
  /** The agent's daily token cap stop, if any (specs/2026-10-02-spend-cap.md) */
  spendCapped?: (agentSession: string) => { capTokens: number; scope?: string; teamName?: string } | null;
  /** Display name for notes ("Ella"); defaults to the session name. */
  displayNameOf?: (agentSession: string) => string;
  /** Persisted state; omitted in tests that do not exercise restarts. */
  storePath?: string;
  /** Clock (tests). */
  now?: () => number;
}

/** Row of the debug listing. */
export interface OwnerMessageListing {
  key: string;
  surface: OwnerMessageSurface;
  where: string;
  responsible: string;
  recipients: string[];
  required: boolean;
  ageMinutes: number;
  stage: OwnerMessageEntry['stage'];
  nudgedMinutesAgo?: number;
  nudgeBlocked?: OwnerMessageEntry['nudgeBlocked'];
  preview: string;
}

/**
 * Whether a whole message is a bare acknowledgement ("好", "ok", "👍", "谢谢")
 * that needs no answer.
 *
 * @param text - The owner's message
 * @returns True for an acknowledgement from ACK_WORDS
 */
export function isAcknowledgement(text: string): boolean {
  const normalised = (text ?? '')
    .toLowerCase()
    .replace(/[\s。，,.!！?？~～、;；:："'“”‘’()（）\[\]【】-]+/g, '')
    .trim();
  if (!normalised) return true;
  return C.ACK_WORDS.some((w) => w.replace(/\s+/g, '') === normalised);
}

/**
 * The dedupe key of a message.
 *
 * @param input - Track input (or entry)
 * @returns `slack:<channel>:<ts>` / `chat:<channel>:<messageId>`, or null when underspecified
 */
export function ownerMessageKey(input: Pick<OwnerMessageTrackInput, 'surface' | 'slackChannelId' | 'sourceTs' | 'threadTs' | 'chatChannelId' | 'messageId'>): string | null {
  if (input.surface === 'slack') {
    const ts = input.sourceTs ?? input.threadTs;
    return input.slackChannelId && ts ? `slack:${input.slackChannelId}:${ts}` : null;
  }
  return input.chatChannelId && input.messageId ? `chat:${input.chatChannelId}:${input.messageId}` : null;
}

/**
 * Tracks owner messages until they are answered, nudging and then noting.
 */
export class OwnerMessageWatchdogService {
  private readonly logger: ComponentLogger;
  private readonly entries = new Map<string, OwnerMessageEntry>();
  /** Recently finished keys, oldest first (Map keeps insertion order). */
  private readonly resolved = new Map<string, number>();
  /** Thread → when an answer was last seen there (answers can beat the tracking call). */
  private readonly recentAnswers = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  /**
   * @param deps - Injected behaviour (see {@link OwnerMessageWatchdogDeps})
   */
  constructor(private readonly deps: OwnerMessageWatchdogDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('OwnerMessageWatchdog');
    this.load();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Start the periodic evaluation. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), C.TICK_MS);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') (this.timer as { unref: () => void }).unref();
  }

  /** Stop the periodic evaluation. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * Start watching an owner message that was delivered to at least one agent.
   * A second delivery of the same message (a hand-off, a re-dispatch) updates
   * the entry rather than adding one; a message already answered is ignored.
   *
   * @param input - The message and who holds it
   * @returns The entry, or null when it is not tracked (ack, answered, underspecified)
   */
  track(input: OwnerMessageTrackInput): OwnerMessageEntry | null {
    const key = ownerMessageKey(input);
    if (!key) return null;
    if (!input.responsible) return null;
    if (isAcknowledgement(input.text)) {
      this.logger.debug('Owner acknowledgement — no answer owed', { key });
      return null;
    }
    if (this.resolved.has(key)) return null;
    const existing = this.entries.get(key);
    const receivedAt = input.receivedAt ?? this.now();
    if (!existing) {
      const answeredAt = this.recentAnswers.get(threadKeyOf(input));
      if (answeredAt !== undefined && answeredAt >= receivedAt) {
        this.logger.debug('Owner message already answered before it was tracked', { key });
        this.remember(key);
        return null;
      }
    }
    if (existing) {
      existing.recipients = [...new Set([...existing.recipients, ...input.recipients, input.responsible])];
      // A hand-off names the agent that now owns it.
      if (input.required || !existing.required) existing.responsible = input.responsible;
      existing.required = existing.required || input.required;
      if (!existing.chatChannelId && input.chatChannelId) existing.chatChannelId = input.chatChannelId;
      if (!existing.chatThreadId && input.chatThreadId) existing.chatThreadId = input.chatThreadId;
      this.persist();
      return existing;
    }
    const entry: OwnerMessageEntry = {
      key,
      surface: input.surface,
      ...(input.slackChannelId ? { slackChannelId: input.slackChannelId } : {}),
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.sourceTs ? { sourceTs: input.sourceTs } : {}),
      ...(input.chatChannelId ? { chatChannelId: input.chatChannelId } : {}),
      ...(input.chatThreadId ? { chatThreadId: input.chatThreadId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      responsible: input.responsible,
      recipients: [...new Set([...input.recipients, input.responsible])],
      required: input.required,
      preview: clip(input.text),
      receivedAt,
      stage: 'waiting',
    };
    this.entries.set(key, entry);
    if (this.entries.size > C.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.logger.warn('Owner message watchdog is full — dropping the oldest tracked message', { key: oldest });
        this.entries.delete(oldest);
      }
    }
    this.persist();
    this.logger.info('Tracking owner message until it is answered', {
      key,
      surface: entry.surface,
      responsible: entry.responsible,
      recipients: entry.recipients,
      required: entry.required,
    });
    return entry;
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  /**
   * Something the owner can see was posted in a Slack thread (an answer, a
   * file, a settled placeholder, a colleague on another machine).
   *
   * @param slackChannelId - Slack channel / DM
   * @param threadTs - Thread root (undefined = top level: clears nothing)
   * @param why - For the log
   * @returns How many entries were cleared
   */
  noteSlackAnswer(slackChannelId: string, threadTs: string | undefined, why: string): number {
    if (!threadTs) return 0;
    this.noteRecentAnswer(`slack:${slackChannelId}:${threadTs}`);
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.surface !== 'slack' || entry.slackChannelId !== slackChannelId) continue;
      if ((entry.threadTs ?? entry.sourceTs) !== threadTs) continue;
      this.finish(entry, `answered (${why})`);
      n += 1;
    }
    return n;
  }

  /**
   * An agent (or the orchestrator) spoke in a Crewly chat channel.
   *
   * @param chatChannelId - chat-v2 channel
   * @param threadId - Thread of the turn (null/undefined = top level)
   * @param interim - An interim note: shown, but the answer is still owed
   * @returns How many entries were cleared
   */
  noteChatAnswer(chatChannelId: string, threadId: string | null | undefined, interim: boolean): number {
    if (!interim) this.noteRecentAnswer(`chat:${chatChannelId}:${threadId ?? ''}`);
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.surface !== 'chat' || entry.chatChannelId !== chatChannelId) continue;
      // A huddle answer belongs in the message's thread; a DM has one conversation.
      if (entry.chatThreadId && threadId !== entry.chatThreadId) continue;
      if (interim) {
        entry.interimAt = this.now();
        this.persist();
        continue;
      }
      this.finish(entry, 'answered (chat)');
      n += 1;
    }
    return n;
  }

  /**
   * The responsible agent said no answer is needed (`reply --none`) for what
   * it was asked in this conversation.
   *
   * @param agentSession - The agent
   * @param where - Conversation (and thread) of its turn origin
   * @returns How many entries were closed
   */
  closeByAgent(
    agentSession: string,
    where: { chatChannelId?: string; slackChannelId?: string; threadTs?: string },
  ): number {
    let n = 0;
    // Only the agent that must answer can waive the answer: a colleague that
    // was merely told about the message saying "not for me" settles nothing.
    for (const entry of this.owedBy(agentSession).filter((e) => e.responsible === agentSession)) {
      const sameChat = where.chatChannelId && entry.chatChannelId === where.chatChannelId;
      const sameSlack =
        where.slackChannelId &&
        entry.slackChannelId === where.slackChannelId &&
        (!where.threadTs || (entry.threadTs ?? entry.sourceTs) === where.threadTs);
      if (!sameChat && !sameSlack) continue;
      this.finish(entry, `closed by ${agentSession}: no answer needed`);
      n += 1;
    }
    return n;
  }

  /**
   * An agent's working status changed. After a nudge, an optional-only
   * message whose agent then finished a whole turn without answering is
   * that agent's judgement ("not for me") — closed quietly at the next tick.
   *
   * @param agentSession - The agent
   * @param busy - True when a turn started, false when it ended
   */
  noteAgentTurn(agentSession: string, busy: boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.stage !== 'nudged' || entry.responsible !== agentSession) continue;
      if (busy) entry.busyAfterNudge = true;
      else if (entry.busyAfterNudge) entry.turnDoneAfterNudge = true;
    }
  }

  /**
   * Open messages an agent holds (responsible or recipient), oldest first.
   *
   * @param agentSession - The agent
   * @returns Entries
   */
  owedBy(agentSession: string): OwnerMessageEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.responsible === agentSession || e.recipients.includes(agentSession))
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }

  /**
   * Debug listing of what is still waiting.
   *
   * @returns One row per tracked message, oldest first
   */
  list(): OwnerMessageListing[] {
    const now = this.now();
    return [...this.entries.values()]
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .map((e) => ({
        key: e.key,
        surface: e.surface,
        where:
          e.surface === 'slack'
            ? `${e.slackChannelId}:${e.threadTs ?? e.sourceTs ?? ''}`
            : `${e.chatChannelId}${e.chatThreadId ? `#${e.chatThreadId}` : ''}`,
        responsible: e.responsible,
        recipients: e.recipients,
        required: e.required,
        ageMinutes: Math.floor((now - e.receivedAt) / 60000),
        stage: e.stage,
        ...(e.nudgedAt !== undefined ? { nudgedMinutesAgo: Math.floor((now - e.nudgedAt) / 60000) } : {}),
        ...(e.nudgeBlocked ? { nudgeBlocked: e.nudgeBlocked } : {}),
        preview: e.preview,
      }));
  }

  /** Number of tracked messages. */
  get size(): number {
    return this.entries.size;
  }

  // -------------------------------------------------------------------------
  // Timeline
  // -------------------------------------------------------------------------

  /**
   * Evaluate every tracked message once. Safe to call concurrently (a second
   * call while one runs is a no-op).
   *
   * @returns When the evaluation is done
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const entry of [...this.entries.values()]) {
        if (!this.entries.has(entry.key)) continue;
        try {
          await this.evaluate(entry);
        } catch (err) {
          this.logger.warn('Owner message watchdog step failed', {
            key: entry.key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(entry: OwnerMessageEntry): Promise<void> {
    const now = this.now();
    const age = now - entry.receivedAt;
    if (entry.stage === 'login_wait') {
      // Parked until the login is back. If the agent stopped needing a
      // sign-in without our hearing of it (signed in on the machine), go on.
      if (age > C.LOGIN_WAIT_DROP_MS) {
        this.finish(entry, 'login never came back');
        return;
      }
      if (!this.deps.loginRequired?.(entry.responsible)) await this.runNudge(entry, age, true);
      return;
    }
    if (entry.stage === 'failed_wait') {
      // The owner was told; keep trying while the agent's turns fail.
      if (age > C.LOGIN_WAIT_DROP_MS) {
        this.finish(entry, 'agent never recovered');
        return;
      }
      if (entry.failedNeedsCredit) return;
      const backoff = C.FAILED_RETRY_BACKOFF_MS[entry.failedRetries ?? 0];
      if (backoff === undefined) return;
      if (now - (entry.nudgedAt ?? 0) >= backoff) {
        entry.failedRetries = (entry.failedRetries ?? 0) + 1;
        await this.runNudge(entry, age, true);
      }
      return;
    }
    if (age > C.STALE_DROP_MS) {
      this.logger.warn('Owner message unanswered for hours (restored after downtime) — dropped without a note', {
        key: entry.key,
        responsible: entry.responsible,
        ageMinutes: Math.floor(age / 60000),
      });
      this.finish(entry, 'stale');
      return;
    }

    // Working on it where the owner can see it: leave it alone, up to the cap.
    if (this.isVisiblyWorking(entry)) {
      if (age >= C.BUSY_EXTEND_CAP_MS) {
        await this.note(entry, 'cap');
        return;
      }
      if (age >= C.NUDGE_AFTER_MS && !entry.extendedLogged) {
        entry.extendedLogged = true;
        this.logger.info('Owner message still being worked on (placeholder showing, agent busy) — waiting longer', {
          key: entry.key,
          responsible: entry.responsible,
          ageMinutes: Math.floor(age / 60000),
        });
      }
      return;
    }

    if (entry.stage === 'waiting') {
      if (age < C.NUDGE_AFTER_MS) return;
      await this.runNudge(entry, age);
      return;
    }

    // Nudged.
    if (!entry.required && entry.turnDoneAfterNudge) {
      this.logger.info('Reminded agent finished its turn without answering an un-addressed owner message — taken as "not for me"', {
        key: entry.key,
        responsible: entry.responsible,
      });
      this.finish(entry, 'nudged agent judged no answer needed');
      return;
    }
    if (age >= C.NOTE_AFTER_MS && now - (entry.nudgedAt ?? 0) >= C.MIN_NOTE_GAP_AFTER_NUDGE_MS) {
      await this.note(entry, 'silent');
    }
  }

  private isVisiblyWorking(entry: OwnerMessageEntry): boolean {
    const visible =
      entry.surface === 'chat' ? entry.interimAt !== undefined : (this.deps.hasVisiblePlaceholder?.(entry) ?? false);
    return visible && this.deps.isBusy(entry.responsible);
  }

  private async runNudge(entry: OwnerMessageEntry, age: number, ignoreLogin: boolean = false): Promise<void> {
    const waited = Math.floor(age / 60000);
    const login = ignoreLogin ? null : (this.deps.loginRequired?.(entry.responsible) ?? null);
    let outcome: NudgeOutcome;
    const capped = this.deps.spendCapped?.(entry.responsible) ?? null;
    if (capped) {
      // A capped agent starts no new turn: a nudge would only queue again.
      outcome = {
        outcome: 'blocked',
        reason: 'spend_cap',
        detail: `${formatTokens(capped.capTokens)}${capped.scope === 'team' && capped.teamName ? ` for team ${capped.teamName}` : capped.scope === 'total' ? ' for all agents together' : ''}`,
      };
    } else if (login) {
      outcome = { outcome: 'blocked', reason: 'login' };
    } else {
      try {
        outcome = await this.deps.nudge(entry, waited);
      } catch (err) {
        outcome = { outcome: 'blocked', reason: 'error', detail: err instanceof Error ? err.message : String(err) };
      }
    }
    traceHarness('harness.nudge', {
      session: entry.responsible,
      summary: `Owner message unanswered for ${waited} min — nudged ${entry.responsible}: ${entry.preview}`,
      outcome: outcome.outcome === 'blocked' ? 'blocked' : 'ok',
      data: { waitedMinutes: waited, ...(outcome.outcome === 'blocked' ? { reason: outcome.reason } : {}) },
    });
    if (!this.entries.has(entry.key)) return; // answered while nudging
    if (outcome.outcome === 'blocked' && outcome.reason === 'login' && login) {
      // Tell the owner once, then keep the message: it is re-delivered when
      // the login is back instead of being dropped with the note.
      const first = entry.stage !== 'login_wait' && entry.loginRuntime === undefined;
      entry.stage = 'login_wait';
      entry.loginRuntime = login.runtimeCmd;
      entry.nudgedAt = this.now();
      this.persist();
      this.logger.warn('Owner message waits on a sign-in — kept for re-delivery after the login', {
        key: entry.key,
        responsible: entry.responsible,
        runtime: login.runtimeCmd,
        waitedMinutes: waited,
      });
      if (first) await this.postLoginNote(entry);
      return;
    }
    entry.stage = 'nudged';
    entry.nudgedAt = this.now();
    entry.busyAfterNudge = false;
    entry.turnDoneAfterNudge = false;
    if (outcome.outcome === 'blocked') {
      entry.nudgeBlocked = { reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) };
      this.logger.warn('Owner message unanswered and its agent cannot be reached — telling the owner now', {
        key: entry.key,
        responsible: entry.responsible,
        reason: outcome.reason,
        detail: outcome.detail,
        waitedMinutes: waited,
      });
      this.persist();
      await this.note(entry, 'blocked');
      return;
    }
    this.persist();
    this.logger.warn('Owner message unanswered — reminded the responsible agent', {
      key: entry.key,
      responsible: entry.responsible,
      waitedMinutes: waited,
      preview: entry.preview.slice(0, 80),
    });
  }

  /**
   * Post the one note and stop tracking.
   *
   * @param entry - The message
   * @param kind - Why now
   */
  private async note(entry: OwnerMessageEntry, kind: 'cap' | 'silent' | 'blocked'): Promise<void> {
    const text = this.noteText(entry, kind);
    let posted = false;
    try {
      posted = await this.deps.postNote(entry, text);
    } catch (err) {
      this.logger.warn('Owner message note could not be posted', {
        key: entry.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.logger.warn('Owner message unanswered — told the owner who it is waiting on', {
      key: entry.key,
      responsible: entry.responsible,
      kind,
      posted,
      ageMinutes: Math.floor((this.now() - entry.receivedAt) / 60000),
      note: text,
    });
    this.finish(entry, `noted (${kind})`);
  }

  /**
   * The note in plain words.
   *
   * @param entry - The message
   * @param kind - Why now
   * @returns The note text
   */
  noteText(entry: OwnerMessageEntry, kind: 'cap' | 'silent' | 'blocked'): string {
    const name = this.deps.displayNameOf?.(entry.responsible) || entry.responsible;
    const waited = String(Math.max(1, Math.floor((this.now() - entry.receivedAt) / 60000)));
    if (kind === 'blocked' && entry.nudgeBlocked?.reason === 'spend_cap') {
      const who = entry.responsible === ORCHESTRATOR_SESSION_NAME ? 'orc' : name;
      return fill(C.NOTE_SPEND_CAP_TEXT, { name, cap: entry.nudgeBlocked.detail ?? 'reached', who });
    }
    const login = this.deps.loginRequired?.(entry.responsible) ?? null;
    if (login) {
      return fill(C.NOTE_LOGIN_TEXT, { name, runtime: login.runtime, runtimeCmd: login.runtimeCmd });
    }
    if (kind === 'blocked' && entry.nudgeBlocked) {
      const detail = entry.nudgeBlocked.detail ? clip(entry.nudgeBlocked.detail, 120) : C.NOTE_UNKNOWN_DETAIL;
      return fill(entry.nudgeBlocked.reason === 'asleep' ? C.NOTE_ASLEEP_TEXT : C.NOTE_ERROR_TEXT, { name, detail });
    }
    if (kind === 'cap') return fill(C.NOTE_BUSY_CAP_TEXT, { name, waited });
    return fill(C.NOTE_SILENT_TEXT, { name, waited });
  }

  /**
   * Post the "signed out" note for a message without finishing it.
   *
   * @param entry - The message
   */
  private async postLoginNote(entry: OwnerMessageEntry): Promise<void> {
    const text = this.noteText(entry, 'blocked');
    let posted = false;
    try {
      posted = await this.deps.postNote(entry, text);
    } catch (err) {
      this.logger.warn('Owner message note could not be posted', { key: entry.key, error: err instanceof Error ? err.message : String(err) });
    }
    this.logger.warn('Owner message unanswered — told the owner it waits on a sign-in', { key: entry.key, responsible: entry.responsible, posted });
  }

  /**
   * A runtime's login is back: re-deliver every message that waited on it
   * (or on one of the restarted agents), waking the agent when needed. The
   * normal timeline (note if still silent) continues from there.
   *
   * @param match - Runtime word ("claude") and/or the agents that were restarted
   * @returns How many messages were re-delivered
   */
  async resumeAfterLogin(match: { runtimeCmd?: string; sessions?: readonly string[] }): Promise<number> {
    const sessions = new Set(match.sessions ?? []);
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (!this.entries.has(entry.key)) continue;
      const parked = entry.stage === 'login_wait' && match.runtimeCmd !== undefined && entry.loginRuntime === match.runtimeCmd;
      const restarted = sessions.has(entry.responsible) && entry.stage !== 'nudged';
      if (!parked && !restarted) continue;
      try {
        await this.runNudge(entry, this.now() - entry.receivedAt, true);
        n += 1;
      } catch (err) {
        this.logger.warn('Re-delivery after sign-in failed', { key: entry.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (n > 0) this.logger.info('Owner messages re-delivered after a sign-in', { count: n, runtime: match.runtimeCmd });
    return n;
  }

  /**
   * The agent's turn failed (its model run errored, crewly#1015 §2). Every
   * message it must answer is parked (`failed_wait`) — kept, re-delivered
   * on a backing-off timer (not at all when credit / quota is out) and when
   * a turn succeeds — and the owner is told once per message, with the
   * reason, instead of a "hasn't replied" note twenty minutes later.
   *
   * @param agentSession - The agent whose turn failed
   * @param detail - Why, in plain words
   * @param opts - `needsCredit`: out of credit / quota — no timed re-delivery
   * @returns How many messages are parked
   */
  async noteTurnFailed(agentSession: string, detail: string, opts: { needsCredit?: boolean } = {}): Promise<number> {
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.responsible !== agentSession) continue;
      if (entry.stage === 'login_wait') continue;
      if (!this.entries.has(entry.key)) continue;
      entry.stage = 'failed_wait';
      entry.failedDetail = detail;
      entry.failedNeedsCredit = opts.needsCredit === true;
      entry.nudgedAt = this.now();
      n += 1;
      if (entry.failedNotedAt === undefined) {
        const name = this.deps.displayNameOf?.(entry.responsible) || entry.responsible;
        const text = fill(C.NOTE_TURN_FAILED_TEXT, { name, detail: clip(detail, 160) || C.NOTE_UNKNOWN_DETAIL });
        let posted = false;
        try {
          posted = await this.deps.postNote(entry, text);
        } catch (err) {
          this.logger.warn('Owner message note could not be posted', { key: entry.key, error: err instanceof Error ? err.message : String(err) });
        }
        if (posted) entry.failedNotedAt = this.now();
        this.logger.warn("Owner message's agent failed its turn — owner told, message kept for re-delivery", {
          key: entry.key,
          responsible: entry.responsible,
          posted,
          detail,
        });
      }
    }
    if (n > 0) this.persist();
    return n;
  }

  /**
   * An agent whose turns were failing completed one: re-deliver what it
   * still owes (`failed_wait`). The normal timeline continues from there.
   *
   * @param agentSession - The agent
   * @returns How many messages were re-delivered
   */
  async resumeAfterRecovery(agentSession: string): Promise<number> {
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.stage !== 'failed_wait' || entry.responsible !== agentSession) continue;
      if (!this.entries.has(entry.key)) continue;
      entry.failedRetries = 0;
      try {
        await this.runNudge(entry, this.now() - entry.receivedAt, true);
        n += 1;
      } catch (err) {
        this.logger.warn('Re-delivery after recovery failed', { key: entry.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (n > 0) this.logger.info('Owner messages re-delivered — the agent is answering again', { agentSession, count: n });
    return n;
  }

  /**
   * Whether an answer was seen in a place since a time — the retry of a
   * failed turn is skipped when that turn already answered (crewly#1015
   * review H3).
   *
   * @param placePrefix - `slack:<channel>:<thread>` or `chat:<channel>:` (any thread)
   * @param since - Epoch ms
   * @returns True when answered there since then
   */
  answeredSince(placePrefix: string, since: number): boolean {
    for (const [k, at] of this.recentAnswers) if (k.startsWith(placePrefix) && at >= since) return true;
    return false;
  }

  private noteRecentAnswer(threadKey: string): void {
    const now = this.now();
    this.recentAnswers.delete(threadKey);
    this.recentAnswers.set(threadKey, now);
    for (const [k, at] of this.recentAnswers) {
      if (now - at <= C.RECENT_ANSWER_KEEP_MS && this.recentAnswers.size <= C.MAX_RESOLVED_KEYS) break;
      this.recentAnswers.delete(k);
    }
  }

  private remember(key: string): void {
    this.resolved.delete(key);
    this.resolved.set(key, this.now());
    while (this.resolved.size > C.MAX_RESOLVED_KEYS) {
      const oldest = this.resolved.keys().next().value;
      if (oldest === undefined) break;
      this.resolved.delete(oldest);
    }
  }

  private finish(entry: OwnerMessageEntry, why: string): void {
    if (!this.entries.delete(entry.key)) return;
    this.remember(entry.key);
    this.persist();
    this.logger.info('Owner message no longer tracked', { key: entry.key, why });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private persist(): void {
    const file = this.deps.storePath;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ entries: [...this.entries.values()], resolved: [...this.resolved.entries()] }),
        { mode: 0o600 },
      );
      renameSync(tmp, file);
    } catch (err) {
      this.logger.warn('Could not save the owner message watchdog state', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private load(): void {
    const file = this.deps.storePath;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        entries?: OwnerMessageEntry[];
        resolved?: Array<[string, number]>;
      };
      for (const [k, at] of raw.resolved ?? []) if (typeof k === 'string') this.resolved.set(k, at);
      for (const e of raw.entries ?? []) {
        if (!e?.key || typeof e.receivedAt !== 'number' || !e.responsible) continue;
        // Turn tracking does not survive a restart (the agent's turn did not either).
        e.busyAfterNudge = false;
        e.turnDoneAfterNudge = false;
        this.entries.set(e.key, e);
      }
      if (this.entries.size > 0) {
        this.logger.info('Restored unanswered owner messages from before the restart', { count: this.entries.size });
      }
    } catch (err) {
      this.logger.warn('Could not load the owner message watchdog state', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Where the answer to a message lands, as a recent-answer key.
 *
 * @param input - Track input
 * @returns `slack:<channel>:<thread>` or `chat:<channel>:<thread or ''>`
 */
function threadKeyOf(input: OwnerMessageTrackInput): string {
  if (input.surface === 'slack') return `slack:${input.slackChannelId}:${input.threadTs ?? input.sourceTs}`;
  return `chat:${input.chatChannelId}:${input.chatThreadId ?? ''}`;
}

/**
 * Clip text for logs / listings / nudges.
 *
 * @param text - Text
 * @param max - Limit
 * @returns Single-line clipped text
 */
function clip(text: string, max: number = C.PREVIEW_CHARS): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Fill `{name}` placeholders.
 *
 * @param template - Template
 * @param values - Values
 * @returns Filled text
 */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: OwnerMessageWatchdogService | null = null;

/** @returns The wired watchdog, or null before it started (and in tests). */
export function getOwnerMessageWatchdog(): OwnerMessageWatchdogService | null {
  return instance;
}

/** @param service - The watchdog to expose (null to clear) */
export function setOwnerMessageWatchdog(service: OwnerMessageWatchdogService | null): void {
  instance = service;
}
