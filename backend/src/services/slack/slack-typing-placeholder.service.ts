/**
 * "Agent is working on it…" placeholders in Slack.
 *
 * Slack offers bots no typing indicator, so the moment a Slack message is
 * handed to an agent, the agent's own bot posts a placeholder ("⚙️ Ella is
 * working on it…") where the reply will appear. When the reply arrives the
 * placeholder is edited into it — no extra message. An agent that stays
 * silent past the timeout has its placeholder edited to a "still working"
 * note so nothing dangles forever.
 *
 * Only agents with an installed bot get placeholders (editing needs the
 * token that posted the message).
 *
 * @module services/slack/slack-typing-placeholder.service
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { SLACK_TYPING_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/**
 * Whether an agent message is an interim note ("got it — here is my plan")
 * rather than the answer: the mirror posts it and puts the placeholder back.
 *
 * @param message - Anything carrying chat-v2 metadata
 * @returns True when flagged interim
 */
export function isInterim(message: { metadata?: Record<string, unknown> }): boolean {
  return message.metadata?.[SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY] === true;
}

/** The slice of SlackService this service uses. */
export interface TypingSlackApi {
  isConnected(): boolean;
  sendMessage(message: {
    channelId: string;
    text: string;
    threadTs?: string;
    botToken?: string;
    username?: string;
    iconEmoji?: string;
    iconUrl?: string;
    skipChatV2Mirror?: boolean;
  }): Promise<string>;
  updateMessage(channelId: string, messageTs: string, text: string, blocks?: undefined, botToken?: string): Promise<void>;
  deleteMessage?(channelId: string, messageTs: string, botToken?: string): Promise<void>;
  addReaction?(channelId: string, messageTs: string, emoji: string, botToken?: string): Promise<void>;
}

/** What the agent is doing while the reply is owed. */
export type TypingPhase = 'waking' | 'typing';

/**
 * Who posts the placeholder: the agent's own bot (`botToken`) or, for an
 * agent without an installed bot, the master bot wearing the agent's
 * name/icon (`username` / `iconEmoji` / `iconUrl`). Either way the
 * message can later be edited into the reply by the same principal.
 */
export interface TypingIdentity {
  displayName: string;
  botToken?: string;
  username?: string;
  iconEmoji?: string;
  iconUrl?: string;
}

/** Where a placeholder lives and which bot posted it. */
export interface TypingPlaceholder {
  slackChannelId: string;
  ts: string;
  threadTs?: string;
  /** Undefined when the master bot posted it. */
  botToken?: string;
  displayName: string;
  phase: TypingPhase;
  /** The person's message this placeholder answers (gets ✅ when the agent settles without replying) */
  sourceTs?: string;
  /** When it was posted (ms) — the order replies are owed in */
  postedAt?: number;
}

/** Identifies one pending reply: this agent, in this Slack conversation/thread. */
export interface TypingKeyParts {
  agentSession: string;
  slackChannelId: string;
  threadTs?: string;
}

/** Constructor dependencies. */
export interface SlackTypingPlaceholderDeps {
  slack: TypingSlackApi;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  /**
   * Where outstanding placeholders are kept across restarts. Without it a
   * restart forgot them and nothing ever took them down (Atlas's 17:02
   * "working on it" stayed after the 17:40 restart, 2026-09-25).
   */
  storePath?: string;
  /**
   * Whether the agent is in the middle of a turn right now. Consulted when a
   * placeholder that was too young to take down at turn end is looked at
   * again; without it the second look takes it down unconditionally.
   */
  isAgentMidTurn?: (agentSession: string) => boolean;
  /** Override for {@link SLACK_TYPING_CONSTANTS.REPLACE_BY_EDIT} (tests). */
  replaceByEdit?: boolean;
}

/**
 * Posts, resolves, and expires typing placeholders.
 */
export class SlackTypingPlaceholderService {
  private readonly logger: ComponentLogger;
  private readonly pending = new Map<string, { placeholder: TypingPlaceholder; timer: ReturnType<typeof setTimeout>; slowTimer?: ReturnType<typeof setTimeout>; startedAt: number }>();
  /**
   * Placeholders that timed out into "still working on this". The reply that
   * finally arrives must still remove them: forgetting them at timeout left
   * the owner a "⏱ still working" line under every slow answer (2026-09-25).
   */
  private readonly expired = new Map<string, { placeholder: TypingPlaceholder; at: number }>();
  /** Placeholders being posted right now (two copies of one message must not post two). */
  private readonly inFlight = new Map<string, Promise<TypingPlaceholder | null>>();
  /**
   * One operation at a time per thread. An interim note (take the
   * placeholder down, put a fresh one back) racing the final answer let the
   * answer find nothing to replace and then the fresh placeholder appear
   * under it, where it stayed (2026-09-28).
   */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Agents with a turn-end second look already scheduled. */
  private readonly recheckScheduled = new Set<string>();
  /** Told when a thread gets a placeholder or an answer (see {@link onThreadActivity}). */
  private readonly threadListeners = new Set<(slackChannelId: string, threadTs?: string) => void>();

  /**
   * @param deps - Slack slice plus optional timer overrides for tests
   */
  constructor(private readonly deps: SlackTypingPlaceholderDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('SlackTyping');
    this.loadPersisted();
  }

  /**
   * Post a placeholder for a reply that is now owed. Replaces a still-pending
   * placeholder for the same key (a second message before the first reply)
   * by leaving the old one alone and tracking the new one only.
   *
   * @param key - Agent + conversation (+ thread)
   * @param identity - The agent's bot token and display name
   * @returns The placeholder, or null when Slack is disconnected or the post failed
   */
  async begin(
    key: TypingKeyParts,
    identity: TypingIdentity,
    phase: TypingPhase = 'typing',
    sourceTs?: string,
  ): Promise<TypingPlaceholder | null> {
    if (!this.deps.slack.isConnected()) return null;
    this.notifyThread(key);
    const k = keyOf(key);
    const existing = this.pending.get(k);
    if (existing) {
      // A second message under the same placeholder: the latest one is what
      // gets the ✅ if the agent settles without replying.
      if (sourceTs) existing.placeholder.sourceTs = sourceTs;
      return existing.placeholder;
    }
    const running = this.inFlight.get(k);
    if (running) return running;
    // Behind any answer being posted in this thread right now: the answer
    // takes down what is there, then this placeholder goes up — never the
    // other way round.
    const task = this.withLock(k, async () => {
      const now = this.pending.get(k);
      if (now) {
        if (sourceTs) now.placeholder.sourceTs = sourceTs;
        return now.placeholder;
      }
      return this.post(k, key, identity, phase, sourceTs);
    }).finally(() => this.inFlight.delete(k));
    this.inFlight.set(k, task);
    return task;
  }

  /**
   * Be told whenever a thread gets a placeholder (posted by anyone — the
   * agent's `--working`, the router, the harness) or an answer. The
   * harness's own "working on it" watch uses this to stand down.
   *
   * @param listener - Called with the Slack channel and thread
   * @returns Unsubscribe function
   */
  onThreadActivity(listener: (slackChannelId: string, threadTs?: string) => void): () => void {
    this.threadListeners.add(listener);
    return () => {
      this.threadListeners.delete(listener);
    };
  }

  private notifyThread(key: TypingKeyParts): void {
    for (const listener of this.threadListeners) {
      try {
        listener(key.slackChannelId, key.threadTs);
      } catch (err) {
        this.logger.debug('Thread activity listener threw', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Run `fn` after every earlier operation on the same thread has finished.
   *
   * @param k - Thread key
   * @param fn - The operation
   * @returns Its result
   */
  private withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(k) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(k, tail);
    void tail.then(() => {
      if (this.locks.get(k) === tail) this.locks.delete(k);
    });
    return run;
  }

  /**
   * Move a pending placeholder to another phase (e.g. the agent finished
   * waking and now holds the message → "is working on it…"). No-op when nothing
   * is pending or the phase is unchanged.
   *
   * @param key - Agent + conversation (+ thread)
   * @param phase - New phase
   */
  async setPhase(key: TypingKeyParts, phase: TypingPhase): Promise<void> {
    const k = keyOf(key);
    await this.inFlight.get(k);
    const entry = this.pending.get(k);
    if (!entry || entry.placeholder.phase === phase) return;
    entry.placeholder.phase = phase;
    if (entry.slowTimer) {
      (this.deps.clearTimer ?? clearTimeout)(entry.slowTimer);
      entry.slowTimer = undefined;
    }
    await this.edit(entry.placeholder, this.textFor(phase, entry.placeholder.displayName));
  }

  /**
   * The reply will not come (agent could not be started / delivery
   * failed): say so in place of the placeholder and stop tracking it.
   *
   * @param key - Agent + conversation (+ thread)
   */
  async fail(key: TypingKeyParts): Promise<void> {
    const k = keyOf(key);
    await this.inFlight.get(k);
    const [placeholder, ...others] = this.takeAll(key);
    if (!placeholder) return;
    await this.edit(placeholder, SLACK_TYPING_CONSTANTS.FAILED_TEXT.replace('{name}', placeholder.displayName));
    for (const other of others) await this.remove(other);
  }

  private textFor(phase: TypingPhase, name: string): string {
    return (phase === 'waking' ? SLACK_TYPING_CONSTANTS.WAKING_TEXT : SLACK_TYPING_CONSTANTS.TYPING_TEXT).replace('{name}', name);
  }

  private async edit(placeholder: TypingPlaceholder, text: string): Promise<void> {
    try {
      await this.deps.slack.updateMessage(placeholder.slackChannelId, placeholder.ts, text, undefined, placeholder.botToken);
    } catch (err) {
      this.logger.debug('Typing placeholder edit failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async post(
    k: string,
    key: TypingKeyParts,
    identity: TypingIdentity,
    phase: TypingPhase,
    sourceTs?: string,
  ): Promise<TypingPlaceholder | null> {
    try {
      const ts = await this.deps.slack.sendMessage({
        channelId: key.slackChannelId,
        text: this.textFor(phase, identity.displayName),
        ...(key.threadTs ? { threadTs: key.threadTs } : {}),
        ...principalOf(identity),
        skipChatV2Mirror: true,
      });
      const placeholder: TypingPlaceholder = {
        slackChannelId: key.slackChannelId,
        ts,
        ...(key.threadTs ? { threadTs: key.threadTs } : {}),
        ...(identity.botToken ? { botToken: identity.botToken } : {}),
        displayName: identity.displayName,
        phase,
        ...(sourceTs ? { sourceTs } : {}),
        postedAt: Date.now(),
      };
      const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      const unref = (t: ReturnType<typeof setTimeout>): void => {
        if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
      };
      const timer = setTimer(() => void this.expire(k), this.deps.timeoutMs ?? SLACK_TYPING_CONSTANTS.TIMEOUT_MS);
      unref(timer);
      const entry: { placeholder: TypingPlaceholder; timer: ReturnType<typeof setTimeout>; slowTimer?: ReturnType<typeof setTimeout>; startedAt: number } = { placeholder, timer, startedAt: Date.now() };
      if (phase === 'waking') {
        // A cold start that drags on gets an honest note instead of a stale "waking up…".
        entry.slowTimer = setTimer(() => {
          if (this.pending.get(k)?.placeholder.phase === 'waking') {
            void this.edit(placeholder, SLACK_TYPING_CONSTANTS.WAKING_SLOW_TEXT.replace('{name}', identity.displayName));
          }
        }, SLACK_TYPING_CONSTANTS.WAKING_SLOW_MS);
        unref(entry.slowTimer);
      }
      this.pending.set(k, entry);
      this.persist();
      return placeholder;
    } catch (err) {
      // At debug this was invisible — the running log level emits none, so a
      // channel where the placeholder never posts looks identical to one
      // where the agent never answered (2026-09-21).
      this.logger.warn('Typing placeholder not posted — no "working on it" will show', {
        key: k,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Take the placeholder for a reply that just arrived (cancels its timeout).
   *
   * @param key - Agent + conversation (+ thread)
   * @returns The placeholder to edit, or null when none is pending
   */
  take(key: TypingKeyParts): TypingPlaceholder | null {
    const k = keyOf(key);
    const entry = this.pending.get(k);
    if (!entry) {
      const late = this.expired.get(k);
      if (!late) return null;
      this.expired.delete(k);
      this.persist();
      return late.placeholder;
    }
    (this.deps.clearTimer ?? clearTimeout)(entry.timer);
    if (entry.slowTimer) (this.deps.clearTimer ?? clearTimeout)(entry.slowTimer);
    this.pending.delete(k);
    this.persist();
    return entry.placeholder;
  }

  /**
   * Every placeholder outstanding in one thread (pending and timed out),
   * oldest first, no longer tracked. Timers are cancelled.
   *
   * @param key - Agent + conversation (+ thread)
   * @returns The placeholders, oldest first
   */
  private takeAll(key: TypingKeyParts): TypingPlaceholder[] {
    const k = keyOf(key);
    const out: TypingPlaceholder[] = [];
    // A timed-out placeholder is always the older one: a pending one is only
    // posted for a key once the previous one has left `pending`.
    const late = this.expired.get(k);
    if (late) {
      this.expired.delete(k);
      out.push(late.placeholder);
    }
    const entry = this.pending.get(k);
    if (entry) {
      (this.deps.clearTimer ?? clearTimeout)(entry.timer);
      if (entry.slowTimer) (this.deps.clearTimer ?? clearTimeout)(entry.slowTimer);
      this.pending.delete(k);
      out.push(entry.placeholder);
    }
    if (out.length > 0) this.persist();
    return out;
  }

  /**
   * Take one placeholder off Slack: deleted, or — where this bot cannot
   * delete — edited to the settled note so it no longer reads as pending.
   *
   * @param placeholder - The placeholder
   */
  private async remove(placeholder: TypingPlaceholder): Promise<void> {
    try {
      if (this.deps.slack.deleteMessage) {
        await this.deps.slack.deleteMessage(placeholder.slackChannelId, placeholder.ts, placeholder.botToken);
      } else {
        await this.deps.slack.updateMessage(
          placeholder.slackChannelId,
          placeholder.ts,
          SLACK_TYPING_CONSTANTS.SETTLED_TEXT.replace('{name}', placeholder.displayName),
          undefined,
          placeholder.botToken,
        );
      }
    } catch (err) {
      // Already gone (message_not_found) is the common case and harmless.
      this.logger.debug('Could not take a typing placeholder down', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * The answer for a thread arrived: it takes the place of the thread's
   * placeholder, and no other placeholder is left in that thread.
   *
   * With REPLACE_BY_EDIT (default) the OLDEST placeholder in the thread is
   * edited into the answer and every other one there is deleted — one
   * answer covering two messages sent back to back leaves nothing behind
   * (2026-09-28). Otherwise (the 2026-09-23 behaviour: an edit raises no
   * notification) the answer is posted as a new message and the
   * placeholders are deleted after it, so the thread never goes without
   * either. A failed edit falls back to posting.
   *
   * Waits for a placeholder still being posted in that thread, and for any
   * other operation there, so a placeholder can never go up after the
   * answer that should have replaced it.
   *
   * @param key - Agent + conversation (+ thread)
   * @param text - The reply
   * @param identity - The agent's bot token
   * @param opts - `reopen`: the reply is an interim note — put a fresh placeholder back under it, in the same step
   * @returns 'edited' when a placeholder became the reply, 'replaced' when the reply was posted and a placeholder removed, 'posted' when there was none
   */
  async resolve(
    key: TypingKeyParts,
    text: string,
    identity: TypingIdentity,
    opts: { reopen?: TypingPhase } = {},
  ): Promise<'replaced' | 'edited' | 'posted'> {
    const k = keyOf(key);
    this.notifyThread(key);
    await this.inFlight.get(k);
    return this.withLock(k, async () => {
      const [oldest, ...others] = this.takeAll(key);
      let outcome: 'replaced' | 'edited' | 'posted' | null = null;
      const byEdit = this.deps.replaceByEdit ?? SLACK_TYPING_CONSTANTS.REPLACE_BY_EDIT;
      if (oldest && (byEdit || !this.deps.slack.deleteMessage)) {
        try {
          await this.deps.slack.updateMessage(oldest.slackChannelId, oldest.ts, text, undefined, oldest.botToken);
          outcome = 'edited';
        } catch (err) {
          this.logger.warn('Could not edit the typing placeholder into the reply — posting it instead', {
            key: k,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!outcome) {
        await this.deps.slack.sendMessage({
          channelId: key.slackChannelId,
          text,
          ...(key.threadTs ? { threadTs: key.threadTs } : {}),
          ...principalOf(identity),
          skipChatV2Mirror: true,
        });
        if (oldest && this.deps.slack.deleteMessage) {
          try {
            await this.deps.slack.deleteMessage(oldest.slackChannelId, oldest.ts, oldest.botToken);
          } catch (err) {
            // The reply is up; a leftover "working on it…" is untidy, not wrong.
            this.logger.warn('Could not remove the typing placeholder after posting the reply', {
              key: k,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          outcome = 'replaced';
        } else {
          outcome = 'posted';
        }
      }
      // One answer covered several messages in this thread: their
      // placeholders go too.
      for (const other of others) await this.remove(other);
      if (others.length > 0) {
        this.logger.info('Answer covered several placeholders in one thread — extra ones taken down', { key: k, count: others.length });
      }
      if (opts.reopen) await this.post(k, key, identity, opts.reopen);
      return outcome;
    });
  }

  /**
   * The agent answered in this thread some other way (a file, a post with
   * its own thread): take every placeholder in the thread down.
   *
   * @param key - Agent + conversation (+ thread)
   * @returns How many were taken down
   */
  async dropThread(key: TypingKeyParts): Promise<number> {
    const k = keyOf(key);
    this.notifyThread(key);
    await this.inFlight.get(k);
    return this.withLock(k, async () => {
      const all = this.takeAll(key);
      for (const p of all) await this.remove(p);
      return all.length;
    });
  }

  /**
   * Whether a placeholder (pending or timed out) is outstanding in this thread.
   *
   * @param key - Agent + conversation (+ thread)
   * @returns True when the agent owes an answer there
   */
  owes(key: TypingKeyParts): boolean {
    const k = keyOf(key);
    return this.pending.has(k) || this.expired.has(k) || this.inFlight.has(k);
  }

  /**
   * The conversation an agent still owes an answer in, on one Slack channel
   * or DM: its pending (or timed-out) placeholder, OLDEST first. An agent that
   * answers with the `slack-post` skill instead of its reply skill names no
   * thread; this is where that answer belongs. Oldest, because answers come
   * in the order questions were asked: newest-first put the answer owed in
   * an earlier thread under the latest question (2026-09-28).
   *
   * @param agentSession - The agent
   * @param slackChannelId - Channel or DM it is posting to
   * @returns The key of the owed reply, or null
   */
  findOwed(agentSession: string, slackChannelId: string): TypingKeyParts | null {
    this.pruneExpired();
    const candidates: Array<{ key: TypingKeyParts; at: number }> = [];
    for (const [k, { placeholder, startedAt }] of this.pending) {
      if (placeholder.slackChannelId === slackChannelId && k.startsWith(`${agentSession}:`)) {
        candidates.push({ key: { agentSession, slackChannelId, ...(placeholder.threadTs ? { threadTs: placeholder.threadTs } : {}) }, at: placeholder.postedAt ?? startedAt });
      }
    }
    for (const [k, { placeholder, at }] of this.expired) {
      if (placeholder.slackChannelId === slackChannelId && k.startsWith(`${agentSession}:`)) {
        candidates.push({ key: { agentSession, slackChannelId, ...(placeholder.threadTs ? { threadTs: placeholder.threadTs } : {}) }, at: placeholder.postedAt ?? at });
      }
    }
    candidates.sort((a, b) => a.at - b.at);
    return candidates[0]?.key ?? null;
  }

  /**
   * The agent finished its turn. Any placeholder it still owes (pending, or
   * timed out into "still working") and is older than SETTLE_MIN_AGE_MS
   * means it decided no reply was needed — an "ok"/"好"/"没关系", or another
   * agent's acknowledgement. Take the placeholder down instead of leaving a
   * promise that never comes: the owner read those "⏱ still working — the
   * reply will follow" lines as unanswered messages (2026-09-25, 13 of them
   * in two days). A reply that still arrives later posts as a new message.
   *
   * @param agentSession - Agent whose turn ended
   * @param now - Clock (tests)
   * @returns How many placeholders were removed
   */
  async settleTurnWithoutReply(agentSession: string, now: number = Date.now()): Promise<number> {
    const minAge = SLACK_TYPING_CONSTANTS.SETTLE_MIN_AGE_MS;
    const victims: TypingPlaceholder[] = [];
    let youngest: number | null = null;
    for (const [k, entry] of [...this.pending]) {
      if (!k.startsWith(`${agentSession}:`)) continue;
      if (now - entry.startedAt < minAge) {
        youngest = Math.max(youngest ?? 0, entry.startedAt);
        continue;
      }
      if (this.inFlight.has(k)) continue;
      const clear = this.deps.clearTimer ?? ((t: ReturnType<typeof setTimeout>) => clearTimeout(t));
      clear(entry.timer);
      if (entry.slowTimer) clear(entry.slowTimer);
      this.pending.delete(k);
      victims.push(entry.placeholder);
    }
    for (const [k, { placeholder }] of [...this.expired]) {
      if (!k.startsWith(`${agentSession}:`)) continue;
      this.expired.delete(k);
      victims.push(placeholder);
    }
    for (const placeholder of victims) {
      try {
        if (this.deps.slack.deleteMessage) {
          await this.deps.slack.deleteMessage(placeholder.slackChannelId, placeholder.ts, placeholder.botToken);
        } else {
          await this.deps.slack.updateMessage(
            placeholder.slackChannelId,
            placeholder.ts,
            SLACK_TYPING_CONSTANTS.SETTLED_TEXT.replace('{name}', placeholder.displayName),
            undefined,
            placeholder.botToken,
          );
        }
      } catch (err) {
        this.logger.debug('Could not take down a settled placeholder', { error: err instanceof Error ? err.message : String(err) });
      }
      // Leave a trace on the person's message: read and handled, no reply
      // needed. With the placeholder gone and no reaction, an answer to the
      // agent's own question looked ignored (2026-09-25, Ella / "Muse").
      if (placeholder.sourceTs && this.deps.slack.addReaction) {
        try {
          await this.deps.slack.addReaction(placeholder.slackChannelId, placeholder.sourceTs, SLACK_TYPING_CONSTANTS.SETTLED_REACTION, placeholder.botToken);
        } catch (err) {
          this.logger.debug('Could not add the settled reaction', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    if (victims.length > 0) this.persist();
    if (victims.length > 0) {
      this.logger.info('Agent finished its turn without replying — placeholders taken down', { agentSession, count: victims.length });
    }
    if (youngest !== null) this.scheduleSettleRecheck(agentSession, youngest + minAge + SLACK_TYPING_CONSTANTS.SETTLE_RECHECK_MARGIN_MS);
    return victims.length;
  }

  /**
   * A placeholder too young to take down when the turn ended (it may belong
   * to a message delivered just before the idle signal) gets a second look
   * once it is old enough: gone then unless the agent is mid-turn — in which
   * case that turn's own end settles it. Without this it waited for the
   * agent's next turn, which might be hours away (2026-09-28).
   *
   * @param agentSession - Agent whose turn ended
   * @param at - When (epoch ms) the youngest skipped placeholder is old enough, margin included
   */
  private scheduleSettleRecheck(agentSession: string, at: number): void {
    if (this.recheckScheduled.has(agentSession)) return;
    this.recheckScheduled.add(agentSession);
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const t = setTimer(() => {
      this.recheckScheduled.delete(agentSession);
      if (this.deps.isAgentMidTurn?.(agentSession)) return;
      void this.settleTurnWithoutReply(agentSession, Math.max(Date.now(), at)).catch(() => undefined);
    }, Math.max(0, at - Date.now()));
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
  }

  /** Save outstanding placeholders (pending + timed out) so a restart can still take them down. */
  private persist(): void {
    if (!this.deps.storePath) return;
    try {
      const entries = [
        ...[...this.pending].map(([key, e]) => ({ key, placeholder: e.placeholder, at: e.startedAt })),
        ...[...this.expired].map(([key, e]) => ({ key, placeholder: e.placeholder, at: e.at })),
      ];
      mkdirSync(path.dirname(this.deps.storePath), { recursive: true });
      writeFileSync(this.deps.storePath, JSON.stringify({ entries }), { mode: 0o600 });
    } catch (err) {
      this.logger.debug('Could not save typing placeholders', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Placeholders outstanding at the last shutdown come back as timed out:
   * a reply that still arrives replaces them, the agent's next turn end
   * takes them down, and whatever nobody claims within BOOT_ORPHAN_MS (the
   * agent was never woken again) is taken down then.
   */
  private loadPersisted(): void {
    if (!this.deps.storePath || !existsSync(this.deps.storePath)) return;
    try {
      const { entries } = JSON.parse(readFileSync(this.deps.storePath, 'utf8')) as {
        entries: Array<{ key: string; placeholder: TypingPlaceholder; at: number }>;
      };
      const cutoff = Date.now() - SLACK_TYPING_CONSTANTS.EXPIRED_KEEP_MS;
      const fromBoot: string[] = [];
      for (const e of entries ?? []) {
        if (!e?.key || !e.placeholder?.ts || e.at < cutoff) continue;
        this.expired.set(e.key, { placeholder: e.placeholder, at: e.at });
        fromBoot.push(e.key);
      }
      if (fromBoot.length === 0) return;
      this.logger.info('Restored typing placeholders from before the restart', { count: fromBoot.length });
      const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      const t = setTimer(() => void this.dropOrphans(fromBoot), SLACK_TYPING_CONSTANTS.BOOT_ORPHAN_MS);
      if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
    } catch (err) {
      this.logger.debug('Could not load typing placeholders', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Take down restored placeholders nobody answered or settled since boot.
   *
   * @param keys - Keys restored at boot
   * @returns How many were taken down
   */
  async dropOrphans(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      const entry = this.expired.get(k);
      if (!entry) continue;
      this.expired.delete(k);
      n += 1;
      try {
        if (this.deps.slack.deleteMessage) {
          await this.deps.slack.deleteMessage(entry.placeholder.slackChannelId, entry.placeholder.ts, entry.placeholder.botToken);
        }
      } catch (err) {
        this.logger.debug('Could not take down an orphaned placeholder', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (n > 0) {
      this.persist();
      this.logger.info('Took down placeholders left over from before the restart', { count: n });
    }
    return n;
  }

  /** Forget timed-out placeholders older than EXPIRED_KEEP_MS. */
  private pruneExpired(): void {
    const cutoff = Date.now() - SLACK_TYPING_CONSTANTS.EXPIRED_KEEP_MS;
    for (const [k, v] of this.expired) if (v.at < cutoff) this.expired.delete(k);
  }

  /** Number of placeholders still waiting for a reply (tests / diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }

  private async expire(k: string): Promise<void> {
    const entry = this.pending.get(k);
    if (!entry) return;
    this.pending.delete(k);
    const { placeholder } = entry;
    this.pruneExpired();
    this.expired.set(k, { placeholder, at: Date.now() });
    this.persist();
    try {
      await this.deps.slack.updateMessage(
        placeholder.slackChannelId,
        placeholder.ts,
        SLACK_TYPING_CONSTANTS.TIMEOUT_TEXT.replace('{name}', placeholder.displayName),
        undefined,
        placeholder.botToken,
      );
    } catch (err) {
      this.logger.debug('Typing placeholder timeout edit failed', { key: k, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** The Slack posting fields for an identity: own bot token, or master bot + cosmetic name/icon. */
function principalOf(identity: TypingIdentity): { botToken?: string; username?: string; iconEmoji?: string; iconUrl?: string } {
  if (identity.botToken) return { botToken: identity.botToken };
  return {
    username: identity.username ?? identity.displayName,
    ...(identity.iconEmoji ? { iconEmoji: identity.iconEmoji } : {}),
    ...(identity.iconUrl ? { iconUrl: identity.iconUrl } : {}),
  };
}

function keyOf(key: TypingKeyParts): string {
  return `${key.agentSession}:${key.slackChannelId}:${key.threadTs ?? ''}`;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: SlackTypingPlaceholderService | null = null;

/** @returns The wired service, or null before Slack started. */
export function getSlackTypingPlaceholderService(): SlackTypingPlaceholderService | null {
  return instance;
}

/** @param service - The service to expose (null to clear, for tests) */
export function setSlackTypingPlaceholderService(service: SlackTypingPlaceholderService | null): void {
  instance = service;
}
