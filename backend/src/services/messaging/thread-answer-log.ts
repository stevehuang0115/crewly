/**
 * Thread answer log: who posted in an owner's Slack thread, and when.
 *
 * `delegate-task --thread` uses it to refuse a delegation when another agent
 * already answered the owner there (CREW-878; Marketing lead, 10/22 and
 * 10/25: the owner got two answers). Source: every post that goes through
 * {@link SlackAgentPostService} reports itself to `onAgentSlackPost`,
 * including `reply --work-item`, `--new-thread` and `--ticket` posts, which
 * are not in chat history (they post with `skipChatV2Mirror`). So this log
 * sees the posts `search-chat` misses. In memory only: a restart forgets it,
 * and an unknown history never blocks a delegation.
 *
 * @module services/messaging/thread-answer-log
 */

import { TL_DELEGATION_CONSTANTS } from '../../constants.js';
import { onAgentSlackPost, type AgentSlackPost } from './owner-thread-sentinel.service.js';

const C = TL_DELEGATION_CONSTANTS;

/** One remembered agent post. */
export interface ThreadPost {
  /** The agent that posted */
  agent: string;
  /** Epoch ms */
  at: number;
  /** Clipped text */
  preview: string;
}

/**
 * Remembers recent agent posts per Slack thread.
 */
export class ThreadAnswerLog {
  private readonly threads = new Map<string, ThreadPost[]>();

  /**
   * @param now - Clock (ms), injectable for tests
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Remember an agent post. Posts without a thread are ignored.
   *
   * @param post - The post as reported by the Slack post service
   */
  record(post: AgentSlackPost): void {
    if (!post.threadTs || !post.slackChannelId || !post.agent) return;
    const key = `${post.slackChannelId}:${post.threadTs}`;
    const list = (this.threads.get(key) ?? []).filter((p) => this.now() - p.at <= C.THREAD_POST_TTL_MS);
    list.push({ agent: post.agent, at: this.now(), preview: clip(post.text, C.THREAD_POST_PREVIEW_CHARS) });
    while (list.length > C.THREAD_POSTS_KEPT) list.shift();
    // Re-insert so the Map keeps the least recently used thread first.
    this.threads.delete(key);
    this.threads.set(key, list);
    while (this.threads.size > C.THREAD_LOG_MAX_THREADS) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
  }

  /**
   * Posts in a thread newer than the owner's last message, by anyone but the
   * delegator (its own interim posts are not "someone else answered").
   *
   * @param key - `<channel>:<thread ts>`
   * @param ownerAt - Epoch ms of the owner's last message there
   * @param delegator - The agent delegating
   * @returns Matching posts, oldest first (empty when none)
   */
  answersSince(key: string, ownerAt: number, delegator?: string): ThreadPost[] {
    const cutoff = this.now() - C.THREAD_POST_TTL_MS;
    return (this.threads.get(key) ?? []).filter((p) => p.at > ownerAt && p.at >= cutoff && p.agent !== delegator);
  }
}

/**
 * @param text - Any text
 * @param max - Longest result
 * @returns The text on one line, cut to `max` characters
 */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

let instance: ThreadAnswerLog | null = null;

/**
 * Start remembering agent posts (once; later calls return the same log).
 *
 * @returns The log
 */
export function installThreadAnswerLog(): ThreadAnswerLog {
  if (instance) return instance;
  const log = new ThreadAnswerLog();
  onAgentSlackPost((post) => log.record(post));
  instance = log;
  return log;
}

/** @returns The installed log, or null before it started (and in tests) */
export function getThreadAnswerLog(): ThreadAnswerLog | null {
  return instance;
}

/** @param log - Log to expose (null to clear), for tests */
export function setThreadAnswerLog(log: ThreadAnswerLog | null): void {
  instance = log;
}
