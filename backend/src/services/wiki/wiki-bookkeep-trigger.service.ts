/**
 * WikiBookkeepTriggerService — periodic vault scan that fires a
 * notification to ORC when bookkeeping is due.
 *
 * Per Steve's 2026-05-22 design point #5: "还要时不时让 agent 针对自己的
 * vault 进行 bookkeeping (可以根据存入的 md 数量来 trigger), 譬如过去
 * N 天超过 X 个 md, 然后总结一下."
 *
 * Mechanism:
 *   - every `intervalMs` (default 30 min) tick
 *   - discover known vaults (project + team + global) by walking known
 *     filesystem roots for SCHEMA.md
 *   - call `WikiBookkeepService.generate` for each
 *   - if `report.shouldFire`, invoke the caller-injected `fireFn` (in
 *     production: enqueue a `[BOOKKEEP] vault=…` message to ORC)
 *   - debounce per-vault so we don't spam — only refire after
 *     `debounceMs` (default 6 h)
 *
 * The service intentionally does NOT do the consolidation itself — it
 * notifies the agent, which then runs `wiki-bookkeep` + `wiki-ingest`
 * (per the orchestrator system prompt rule).
 *
 * @module services/wiki/wiki-bookkeep-trigger.service
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { WikiBookkeepService, WikiBookkeepReport } from './wiki-bookkeep.service.js';

export type WikiBookkeepFireFn = (
  vaultPath: string,
  report: WikiBookkeepReport,
) => Promise<void> | void;

export interface WikiBookkeepTriggerOptions {
  /** Interval between scans, ms. Default 30 minutes. */
  intervalMs?: number;
  /** Minimum gap between fires for the same vault, ms. Default 6 hours. */
  debounceMs?: number;
  /** Caller-injected notifier. Production wires this to enqueue a message to ORC. */
  fireFn: WikiBookkeepFireFn;
  /** Optional override of the discovery roots (tests). */
  discoverRoots?: () => Promise<string[]>;
  /** Optional override of the bookkeep service (tests). */
  bookkeepService?: WikiBookkeepService;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 6 * 3600 * 1000;

/**
 * Discover absolute vault paths by walking the well-known Crewly roots:
 *   - `<env CREWLY_PROJECT_VAULT_PATH>` (single explicit override)
 *   - `<process.cwd>/.crewly/wiki` (current project vault)
 *   - `~/.crewly/teams/<uuid>/wiki` (every team vault)
 *   - `~/.crewly/global-wiki` (ORC cross-project vault, if present)
 *
 * A path is only included if `SCHEMA.md` exists inside it.
 */
export async function discoverWikiVaults(): Promise<string[]> {
  const found = new Set<string>();
  const candidates: string[] = [];

  const fromEnv = process.env['CREWLY_PROJECT_VAULT_PATH'];
  if (fromEnv && path.isAbsolute(fromEnv)) candidates.push(fromEnv);
  candidates.push(path.join(process.cwd(), '.crewly/wiki'));
  candidates.push(path.join(os.homedir(), '.crewly/global-wiki'));

  const teamsRoot = path.join(os.homedir(), '.crewly/teams');
  if (existsSync(teamsRoot)) {
    try {
      const entries = await fs.readdir(teamsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        candidates.push(path.join(teamsRoot, entry.name, 'wiki'));
      }
    } catch {
      // ignore — partial discovery is fine
    }
  }

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'SCHEMA.md'))) {
      found.add(candidate);
    }
  }
  return [...found].sort();
}

/**
 * Periodic vault-bookkeep trigger. Start at boot, stop at shutdown.
 */
export class WikiBookkeepTriggerService {
  private static instance: WikiBookkeepTriggerService | null = null;
  private readonly logger: ComponentLogger;
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private readonly fireFn: WikiBookkeepFireFn;
  private readonly discoverRoots: () => Promise<string[]>;
  private readonly bookkeepService: WikiBookkeepService;
  private timer: NodeJS.Timeout | null = null;
  /** vaultPath → last fired timestamp (ms). */
  private readonly lastFiredAt = new Map<string, number>();
  /** Per-vault locks so two overlapping ticks don't double-fire. */
  private inflight = new Set<string>();

  constructor(opts: WikiBookkeepTriggerOptions) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiBookkeepTrigger');
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fireFn = opts.fireFn;
    this.discoverRoots = opts.discoverRoots ?? discoverWikiVaults;
    this.bookkeepService = opts.bookkeepService ?? WikiBookkeepService.getInstance();
  }

  static getInstance(): WikiBookkeepTriggerService | null {
    return this.instance;
  }

  /** Wire the production singleton. Pass null to detach (tests / shutdown). */
  static setInstance(next: WikiBookkeepTriggerService | null): void {
    if (this.instance && this.instance !== next) this.instance.stop();
    this.instance = next;
  }

  /** Begin scanning. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't keep the event loop alive just for bookkeeping.
    this.timer.unref?.();
    this.logger.info('WikiBookkeepTrigger started', {
      intervalMs: this.intervalMs,
      debounceMs: this.debounceMs,
    });
  }

  /** Stop scanning. Safe to call multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('WikiBookkeepTrigger stopped');
    }
  }

  /**
   * Run one scan pass. Public for test + the manual
   * `/api/wiki/bookkeep/trigger-now` endpoint.
   */
  async tick(): Promise<{
    scanned: string[];
    fired: string[];
    skippedByDebounce: string[];
    quietVaults: string[];
  }> {
    const vaults = await this.discoverRoots();
    const result = {
      scanned: [...vaults],
      fired: [] as string[],
      skippedByDebounce: [] as string[],
      quietVaults: [] as string[],
    };
    for (const v of vaults) {
      if (this.inflight.has(v)) continue;
      this.inflight.add(v);
      try {
        const outcome = await this.bookkeepService.generate({ vaultPath: v });
        if (!outcome.ok) {
          this.logger.warn('WikiBookkeepTrigger: bookkeep failed for vault', {
            vault: v,
            reason: outcome.reason,
          });
          continue;
        }
        if (!outcome.report.shouldFire) {
          result.quietVaults.push(v);
          continue;
        }
        const last = this.lastFiredAt.get(v) ?? 0;
        if (Date.now() - last < this.debounceMs) {
          result.skippedByDebounce.push(v);
          continue;
        }
        this.lastFiredAt.set(v, Date.now());
        try {
          await this.fireFn(v, outcome.report);
          result.fired.push(v);
          this.logger.info('WikiBookkeepTrigger fired', {
            vault: v,
            recentMd: outcome.report.recentMdCount,
            threshold: outcome.report.threshold,
            duplicates: outcome.report.duplicateCandidates.length,
          });
        } catch (err) {
          this.logger.warn('WikiBookkeepTrigger: fireFn threw (swallowed)', {
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

  /** Test affordance: clear the debounce ledger. */
  _resetDebounceForTesting(): void {
    this.lastFiredAt.clear();
  }
}
