/**
 * "Agent is typing…" placeholders in Slack.
 *
 * Slack offers bots no typing indicator, so the moment a Slack message is
 * handed to an agent, the agent's own bot posts a placeholder ("💭 Ella is
 * typing…") where the reply will appear. When the reply arrives the
 * placeholder is edited into it — no extra message. An agent that stays
 * silent past the timeout has its placeholder edited to a "still working"
 * note so nothing dangles forever.
 *
 * Only agents with an installed bot get placeholders (editing needs the
 * token that posted the message).
 *
 * @module services/slack/slack-typing-placeholder.service
 */

import { SLACK_TYPING_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/** The slice of SlackService this service uses. */
export interface TypingSlackApi {
  isConnected(): boolean;
  sendMessage(message: { channelId: string; text: string; threadTs?: string; botToken?: string; skipChatV2Mirror?: boolean }): Promise<string>;
  updateMessage(channelId: string, messageTs: string, text: string, blocks?: undefined, botToken?: string): Promise<void>;
}

/** Where a placeholder lives and which bot posted it. */
export interface TypingPlaceholder {
  slackChannelId: string;
  ts: string;
  threadTs?: string;
  botToken: string;
  displayName: string;
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
}

/**
 * Posts, resolves, and expires typing placeholders.
 */
export class SlackTypingPlaceholderService {
  private readonly logger: ComponentLogger;
  private readonly pending = new Map<string, { placeholder: TypingPlaceholder; timer: ReturnType<typeof setTimeout> }>();

  /**
   * @param deps - Slack slice plus optional timer overrides for tests
   */
  constructor(private readonly deps: SlackTypingPlaceholderDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('SlackTyping');
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
  async begin(key: TypingKeyParts, identity: { botToken: string; displayName: string }): Promise<TypingPlaceholder | null> {
    if (!this.deps.slack.isConnected()) return null;
    const k = keyOf(key);
    const existing = this.pending.get(k);
    if (existing) return existing.placeholder;
    try {
      const ts = await this.deps.slack.sendMessage({
        channelId: key.slackChannelId,
        text: SLACK_TYPING_CONSTANTS.TYPING_TEXT.replace('{name}', identity.displayName),
        ...(key.threadTs ? { threadTs: key.threadTs } : {}),
        botToken: identity.botToken,
        skipChatV2Mirror: true,
      });
      const placeholder: TypingPlaceholder = {
        slackChannelId: key.slackChannelId,
        ts,
        ...(key.threadTs ? { threadTs: key.threadTs } : {}),
        botToken: identity.botToken,
        displayName: identity.displayName,
      };
      const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      const timer = setTimer(() => void this.expire(k), this.deps.timeoutMs ?? SLACK_TYPING_CONSTANTS.TIMEOUT_MS);
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
      this.pending.set(k, { placeholder, timer });
      return placeholder;
    } catch (err) {
      this.logger.debug('Typing placeholder not posted', { key: k, error: err instanceof Error ? err.message : String(err) });
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
    if (!entry) return null;
    (this.deps.clearTimer ?? clearTimeout)(entry.timer);
    this.pending.delete(k);
    return entry.placeholder;
  }

  /**
   * Edit the pending placeholder into the reply, or post the reply fresh
   * when there is none. Falls back to a fresh post when the edit fails.
   *
   * @param key - Agent + conversation (+ thread)
   * @param text - The reply
   * @param identity - The agent's bot token
   * @returns 'edited' | 'posted'
   */
  async resolve(key: TypingKeyParts, text: string, identity: { botToken: string }): Promise<'edited' | 'posted'> {
    const placeholder = this.take(key);
    if (placeholder) {
      try {
        await this.deps.slack.updateMessage(placeholder.slackChannelId, placeholder.ts, text, undefined, placeholder.botToken);
        return 'edited';
      } catch (err) {
        this.logger.warn('Could not edit the typing placeholder into the reply — posting it instead', {
          key: keyOf(key),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await this.deps.slack.sendMessage({
      channelId: key.slackChannelId,
      text,
      ...(key.threadTs ? { threadTs: key.threadTs } : {}),
      botToken: identity.botToken,
      skipChatV2Mirror: true,
    });
    return 'posted';
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
