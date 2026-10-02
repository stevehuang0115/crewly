/**
 * Hourly count of orchestrator turns, by why it was woken
 * (specs/2026-10-01-orc-status-wakes.md).
 *
 * Every orchestrator turn re-reads its whole context (~70k tokens on
 * 2026-09-29), so the number of turns IS the cost. Once an hour the counter
 * logs one line:
 *
 *   orc wakes: 14 (owner 3, delegated-done 2, escalations 1, digest 2, other 6)
 *
 * - `N` and `owner` are counted when the queue processor starts an
 *   orchestrator turn (`owner` = any non-system source: Slack, web chat, …).
 * - `delegated-done`, `escalations`, `digest` are counted when the status
 *   router decides to wake the orchestrator (several queued system events
 *   can coalesce into one turn, so these may add up to more than the turns
 *   they caused).
 * - `other` = turns that are neither owner messages nor status-router wakes
 *   (cron, wiki, triggers, enforcer reminders, …).
 *
 * @module services/orc/orc-wake-counter
 */

import { MESSAGE_SOURCES, ORC_WAKE_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { OrcWakeCategory } from './orc-status-routing.js';

/** One hour's numbers. */
export interface OrcWakeCounts {
  /** Orchestrator turns started */
  turns: number;
  /** Turns for an owner message */
  owner: number;
  /** Status-router wakes: [DONE] on orchestrator-delegated work (incl. owed deliveries) */
  delegatedDone: number;
  /** Status-router wakes: [BLOCKED]/[FAILED] with no lead to take it */
  escalations: number;
  /** Status digests sent */
  digest: number;
  /** Status-router wakes for an answer that was not a status line */
  statusOther: number;
}

/** A fresh, zeroed count. */
function zero(): OrcWakeCounts {
  return { turns: 0, owner: 0, delegatedDone: 0, escalations: 0, digest: 0, statusOther: 0 };
}

/**
 * The log line for one period.
 *
 * @param c - Counts
 * @returns `orc wakes: N (owner X, delegated-done Y, escalations Z, digest W, other V)`
 */
export function formatOrcWakeLine(c: OrcWakeCounts): string {
  const routed = c.delegatedDone + c.escalations + c.digest;
  const other = Math.max(0, c.turns - c.owner - routed);
  return `orc wakes: ${c.turns} (owner ${c.owner}, delegated-done ${c.delegatedDone}, escalations ${c.escalations}, digest ${c.digest}, other ${other})`;
}

/** Counts orchestrator wakes and logs them once per period. */
export class OrcWakeCounter {
  private static instance: OrcWakeCounter | null = null;
  private counts: OrcWakeCounts = zero();
  private periodStart: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly logger: ComponentLogger;

  /**
   * @param now - Clock (tests)
   */
  constructor(private readonly now: () => number = Date.now) {
    this.periodStart = now();
    this.logger = LoggerService.getInstance().createComponentLogger('OrcWakes');
  }

  /** The process-wide counter. */
  static getInstance(): OrcWakeCounter {
    if (!OrcWakeCounter.instance) OrcWakeCounter.instance = new OrcWakeCounter();
    return OrcWakeCounter.instance;
  }

  /** Drop the singleton (tests). */
  static resetInstance(): void {
    OrcWakeCounter.instance?.stop();
    OrcWakeCounter.instance = null;
  }

  /** Log every {@link ORC_WAKE_CONSTANTS.COUNTER_LOG_INTERVAL_MS}. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), ORC_WAKE_CONSTANTS.COUNTER_LOG_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop the periodic log. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * An orchestrator turn started (queue processor).
   *
   * @param source - Message source of the turn
   */
  noteTurn(source: string): void {
    this.counts.turns += 1;
    if (source !== MESSAGE_SOURCES.SYSTEM_EVENT) this.counts.owner += 1;
  }

  /**
   * The status router decided to wake the orchestrator.
   *
   * @param category - Why
   */
  noteRouted(category: OrcWakeCategory): void {
    switch (category) {
      case 'owner':
      case 'delegated-done':
        this.counts.delegatedDone += 1;
        break;
      case 'escalation':
        this.counts.escalations += 1;
        break;
      case 'digest':
        this.counts.digest += 1;
        break;
      default:
        this.counts.statusOther += 1;
    }
  }

  /** The current period's numbers (copy). */
  snapshot(): OrcWakeCounts {
    return { ...this.counts };
  }

  /**
   * Log the period's line and start a new period.
   *
   * @returns The logged line
   */
  flush(): string {
    const line = formatOrcWakeLine(this.counts);
    this.logger.info(line, {
      since: new Date(this.periodStart).toISOString(),
      ...this.counts,
    });
    this.counts = zero();
    this.periodStart = this.now();
    return line;
  }
}
