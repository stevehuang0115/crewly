/**
 * Loop cap for colleague messages.
 *
 * Two agents can answer each other forever. Colleague messages between the
 * same two agents (both directions together) are counted in a sliding window;
 * past {@link COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES} in the window no
 * more go through until older ones age out. Both machines run the guard (the
 * sender refuses, the receiver drops), so a runaway on one side cannot wake
 * the other.
 *
 * @module services/colleague/colleague-loop-guard
 */

import { COLLEAGUE_MESSAGE_CONSTANTS } from '../../constants.js';

/** Options (tests inject the clock and smaller limits). */
export interface ColleagueLoopGuardOptions {
  now?: () => number;
  maxMessages?: number;
  windowMs?: number;
}

/** Sliding-window counter per agent pair. */
export class ColleagueLoopGuard {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxMessages: number;
  private readonly windowMs: number;

  constructor(options: ColleagueLoopGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxMessages = options.maxMessages ?? COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES;
    this.windowMs = options.windowMs ?? COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_WINDOW_MS;
  }

  /**
   * The key of a pair, the same from both sides.
   *
   * @param a - One agent (`instanceId:session`)
   * @param b - The other agent
   * @returns Order-independent key
   */
  static pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /**
   * Count one message for the pair, unless the cap is reached.
   *
   * @param key - {@link ColleagueLoopGuard.pairKey}
   * @returns `allowed` (and the message is counted), or `retryAfterMs` until the oldest one ages out
   */
  take(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxMessages) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(0, recent[0] + this.windowMs - now) };
    }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent); // most recent last, for pruning
    if (this.hits.size > COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MAX_PAIRS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return { allowed: true };
  }
}
