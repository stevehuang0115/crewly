/**
 * WikiReflectTriggerService — periodic nudge that pings ORC when no
 * `wiki-queue-add` has fired against a vault recently.
 *
 * Rationale (2026-05-24):
 *   The wiki infrastructure (queue, ingest, process, bookkeep) is shipped
 *   and instrumented, but `wiki-queue-add` fire-rate is effectively zero —
 *   the per-turn discipline in the role prompts is soft and rarely runs
 *   in practice. This trigger raises a hard nudge: every `intervalMs`,
 *   per vault, if no queue-add happened in the last `quietWindowMs`,
 *   fire a `[REFLECT-WIKI] vault=…` message via the caller-injected
 *   `fireFn`. ORC then either queues recent worth-saving items or no-ops.
 *
 * Mechanism mirrors `WikiBookkeepTriggerService` so they coexist cleanly:
 *   - scan vaults via `discoverWikiVaults`
 *   - per vault: count queue items added within `quietWindowMs`
 *   - if zero AND debounce window has elapsed → fire
 *
 * @module services/wiki/wiki-reflect-trigger.service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import {
  WikiQueueService,
  WikiQueueItem,
} from './wiki-queue.service.js';
import { discoverWikiVaults } from './wiki-bookkeep-trigger.service.js';

export interface WikiReflectFireMeta {
  /** vault path being nudged. */
  vaultPath: string;
  /** ms since the last queued item (Infinity if none). */
  msSinceLastQueueAdd: number;
  /** queue items added within `quietWindowMs`. */
  recentQueueAdds: number;
  /** total queue items (any status) currently in the vault. */
  totalQueueItems: number;
}

export type WikiReflectFireFn = (meta: WikiReflectFireMeta) => Promise<void> | void;

export interface WikiReflectTriggerOptions {
  /** Interval between scans, ms. Default 60 minutes. */
  intervalMs?: number;
  /** "Quiet" window — fire only when no add happened in this window. Default 4 hours. */
  quietWindowMs?: number;
  /** Minimum gap between fires for the same vault, ms. Default 4 hours. */
  debounceMs?: number;
  /** Caller-injected notifier (e.g. enqueue `[REFLECT-WIKI]` chat to ORC). */
  fireFn: WikiReflectFireFn;
  /** Optional discovery override (tests). */
  discoverRoots?: () => Promise<string[]>;
  /** Optional queue service override (tests). */
  queueService?: WikiQueueService;
  /** Optional time override (tests). */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_QUIET_WINDOW_MS = 4 * 60 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 4 * 60 * 60 * 1000;

/**
 * Reflect-trigger service. Start at boot, stop at shutdown.
 */
export class WikiReflectTriggerService {
  private static instance: WikiReflectTriggerService | null = null;
  private readonly logger: ComponentLogger;
  private readonly intervalMs: number;
  private readonly quietWindowMs: number;
  private readonly debounceMs: number;
  private readonly fireFn: WikiReflectFireFn;
  private readonly discoverRoots: () => Promise<string[]>;
  private readonly queueService: WikiQueueService;
  private readonly nowFn: () => number;
  private timer: NodeJS.Timeout | null = null;
  /** vaultPath → last fired timestamp (ms since epoch). */
  private readonly lastFiredAt = new Map<string, number>();
  /** Per-vault locks so overlapping ticks don't double-fire. */
  private readonly inflight = new Set<string>();

  constructor(opts: WikiReflectTriggerOptions) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiReflectTrigger');
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.quietWindowMs = opts.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fireFn = opts.fireFn;
    this.discoverRoots = opts.discoverRoots ?? discoverWikiVaults;
    this.queueService = opts.queueService ?? WikiQueueService.getInstance();
    this.nowFn = opts.now ?? (() => Date.now());
  }

  static getInstance(): WikiReflectTriggerService | null {
    return this.instance;
  }

  static setInstance(next: WikiReflectTriggerService | null): void {
    if (this.instance && this.instance !== next) this.instance.stop();
    this.instance = next;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.logger.info('WikiReflectTrigger started', {
      intervalMs: this.intervalMs,
      quietWindowMs: this.quietWindowMs,
      debounceMs: this.debounceMs,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('WikiReflectTrigger stopped');
    }
  }

  /**
   * Run one scan. Returns the per-vault outcome for observability + tests.
   */
  async tick(): Promise<{
    scanned: string[];
    fired: string[];
    skippedByActivity: string[];
    skippedByDebounce: string[];
  }> {
    const vaults = await this.discoverRoots();
    const result = {
      scanned: [...vaults],
      fired: [] as string[],
      skippedByActivity: [] as string[],
      skippedByDebounce: [] as string[],
    };

    const now = this.nowFn();
    const cutoff = now - this.quietWindowMs;

    for (const v of vaults) {
      if (this.inflight.has(v)) continue;
      this.inflight.add(v);
      try {
        const items: WikiQueueItem[] = await this.queueService.list({ vaultPath: v });

        let recentAdds = 0;
        let lastAddMs = -Infinity;
        for (const item of items) {
          const queuedAt = Date.parse(item.queuedAt);
          if (Number.isFinite(queuedAt)) {
            if (queuedAt >= cutoff) recentAdds++;
            if (queuedAt > lastAddMs) lastAddMs = queuedAt;
          }
        }

        if (recentAdds > 0) {
          result.skippedByActivity.push(v);
          continue;
        }
        const last = this.lastFiredAt.get(v) ?? 0;
        if (now - last < this.debounceMs) {
          result.skippedByDebounce.push(v);
          continue;
        }

        this.lastFiredAt.set(v, now);
        const msSinceLastQueueAdd =
          lastAddMs === -Infinity ? Number.POSITIVE_INFINITY : now - lastAddMs;
        try {
          await this.fireFn({
            vaultPath: v,
            msSinceLastQueueAdd,
            recentQueueAdds: recentAdds,
            totalQueueItems: items.length,
          });
          result.fired.push(v);
          this.logger.info('WikiReflectTrigger fired', {
            vault: v,
            totalQueueItems: items.length,
            msSinceLastQueueAdd:
              msSinceLastQueueAdd === Number.POSITIVE_INFINITY
                ? 'never'
                : Math.floor(msSinceLastQueueAdd / 1000),
          });
        } catch (err) {
          this.logger.warn('WikiReflectTrigger: fireFn threw (swallowed)', {
            vault: v,
            error: (err as Error).message,
          });
        }
      } finally {
        this.inflight.delete(v);
      }
    }
    return result;
  }

  /** Test affordance — clear debounce ledger. */
  _resetDebounceForTesting(): void {
    this.lastFiredAt.clear();
  }
}
