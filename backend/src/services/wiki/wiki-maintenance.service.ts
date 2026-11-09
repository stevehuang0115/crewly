/**
 * WikiMaintenanceService — the scheduler behind log hygiene (#1345).
 *
 * One hourly tick:
 *   - every tick: a queue drain pass ({@link WikiQueueDrainService});
 *   - once per day (and on the first tick after boot when the last daily
 *     pass is older than a day): log rotation, digest compile and the
 *     knowledge-gap roll-up (#914, itself once per ISO week) for every
 *     discovered vault.
 *
 * The first tick runs `MAINTENANCE_BOOT_DELAY_MS` after `start()` so boot
 * I/O settles first. State (last daily pass) lives in
 * `CREWLY_HOME/wiki-maintenance-state.json`. `CREWLY_WIKI_MAINTENANCE=false`
 * disables the whole thing. Every step is non-fatal and logged.
 *
 * @module services/wiki/wiki-maintenance.service
 */

import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { WIKI_LOG_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, safeReadJson, ensureDir } from '../../utils/file-io.utils.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { discoverWikiVaults } from './wiki-bookkeep-trigger.service.js';
import { WikiLogRotationService, type WikiLogRotateResult } from './wiki-log-rotation.service.js';
import { WikiLogCompileService, type WikiLogCompileResult } from './wiki-log-compile.service.js';
import { WikiQueueDrainService, type WikiQueueDrainResult } from './wiki-queue-drain.service.js';
import { WikiKnowledgeGapsService, type WikiKnowledgeGapsResult } from './wiki-knowledge-gaps.service.js';

/** Persisted scheduler state. */
interface MaintenanceState {
  /** ISO time the last rotation + compile pass finished. */
  lastDailyAt: string | null;
}

/** Options for {@link WikiMaintenanceService}. */
export interface WikiMaintenanceOptions {
  /** Tick interval (default hourly). */
  intervalMs?: number;
  /** Gap between daily passes (default 24 h). */
  dailyMs?: number;
  /** Delay before the first tick (default 90 s; 0 = immediate). */
  bootDelayMs?: number;
  /** State file (default under CREWLY_HOME). `null` keeps state in memory (tests). */
  statePath?: string | null;
  /** Vault discovery override (tests). */
  discoverRoots?: () => Promise<string[]>;
  /** Service overrides (tests). */
  rotation?: WikiLogRotationService;
  compile?: WikiLogCompileService;
  drain?: WikiQueueDrainService;
  gaps?: WikiKnowledgeGapsService;
  /** Clock (tests). */
  now?: () => number;
  /** Dry run: every step reports and writes nothing. */
  dryRun?: boolean;
  /**
   * Held before the boot tick (crewly#1353): resolves when the restore queue
   * is drained and memory is calm, or when it gave up waiting. Default: none.
   */
  bootGate?: BootGate;
}

/** Waits for a quiet machine before a boot pass; `reduced` when it gave up waiting. */
export type BootGate = () => Promise<{ reduced: boolean; waitedMs: number; reason?: string }>;

/** Outcome of one tick. */
export interface WikiMaintenanceTickResult {
  drain: WikiQueueDrainResult | null;
  /** Set when the daily pass ran this tick. */
  daily?: { vaults: string[]; rotated: WikiLogRotateResult[]; compiled: WikiLogCompileResult[]; gaps: WikiKnowledgeGapsResult[] };
  skippedDaily?: 'not_due';
}

/**
 * Hourly wiki maintenance scheduler. Start at boot, stop at shutdown.
 */
export class WikiMaintenanceService {
  private static instance: WikiMaintenanceService | null = null;
  private readonly logger: ComponentLogger;
  private readonly intervalMs: number;
  private readonly dailyMs: number;
  private readonly bootDelayMs: number;
  private readonly statePath: string | null;
  private readonly discoverRoots: () => Promise<string[]>;
  private readonly rotation: WikiLogRotationService;
  private readonly compile: WikiLogCompileService;
  private readonly drain: WikiQueueDrainService;
  private readonly gaps: WikiKnowledgeGapsService;
  private readonly nowFn: () => number;
  private readonly dryRun: boolean;
  private readonly bootGate: BootGate | null;
  private timer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
  private running = false;
  private state: MaintenanceState = { lastDailyAt: null };
  private stateLoaded = false;

  constructor(opts: WikiMaintenanceOptions = {}) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiMaintenance');
    this.intervalMs = opts.intervalMs ?? WIKI_LOG_CONSTANTS.MAINTENANCE_INTERVAL_MS;
    this.dailyMs = opts.dailyMs ?? WIKI_LOG_CONSTANTS.MAINTENANCE_DAILY_MS;
    this.bootDelayMs = opts.bootDelayMs ?? WIKI_LOG_CONSTANTS.MAINTENANCE_BOOT_DELAY_MS;
    this.statePath = opts.statePath === null ? null : opts.statePath ?? path.join(getCrewlyHomePath(), WIKI_LOG_CONSTANTS.MAINTENANCE_STATE_FILE);
    this.discoverRoots = opts.discoverRoots ?? discoverWikiVaults;
    this.rotation = opts.rotation ?? WikiLogRotationService.getInstance();
    this.compile = opts.compile ?? WikiLogCompileService.getInstance();
    this.drain = opts.drain ?? WikiQueueDrainService.getInstance();
    this.gaps = opts.gaps ?? WikiKnowledgeGapsService.getInstance();
    this.nowFn = opts.now ?? (() => Date.now());
    this.dryRun = opts.dryRun === true;
    this.bootGate = opts.bootGate ?? null;
  }

  static getInstance(): WikiMaintenanceService | null {
    return this.instance;
  }

  /** Wire / detach the production singleton. */
  static setInstance(next: WikiMaintenanceService | null): void {
    if (this.instance && this.instance !== next) this.instance.stop();
    this.instance = next;
  }

  /**
   * Begin ticking. Idempotent. Returns false when the kill switch is set.
   *
   * @returns Whether the scheduler started
   */
  start(): boolean {
    if (this.timer) return true;
    if (process.env[WIKI_LOG_CONSTANTS.MAINTENANCE_ENV_KILL_SWITCH] === 'false') {
      this.logger.warn(`WikiMaintenance disabled via ${WIKI_LOG_CONSTANTS.MAINTENANCE_ENV_KILL_SWITCH}=false — not starting`);
      return false;
    }
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.bootTick();
    }, this.bootDelayMs);
    this.bootTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.logger.info('WikiMaintenance started', { intervalMs: this.intervalMs, dailyMs: this.dailyMs, bootDelayMs: this.bootDelayMs, dryRun: this.dryRun, bootGate: !!this.bootGate });
    return true;
  }

  /**
   * The boot tick: waits at the boot gate (restore queue drained, memory
   * calm) when one is wired, then ticks. Public for tests.
   *
   * @returns What ran
   */
  async bootTick(): Promise<WikiMaintenanceTickResult> {
    if (this.bootGate) {
      try {
        const gate = await this.bootGate();
        if (gate.waitedMs > 0) this.logger.info('WikiMaintenance boot pass waited for a quiet machine', { waitedMs: gate.waitedMs, reduced: gate.reduced, reason: gate.reason });
      } catch (err) {
        this.logger.warn('WikiMaintenance boot gate failed (running anyway)', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.tick();
  }

  /** Stop ticking. Safe to call more than once. */
  stop(): void {
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('WikiMaintenance stopped');
    }
  }

  /**
   * Whether the daily pass is due.
   *
   * @returns True when no daily pass is recorded or it is older than `dailyMs`
   */
  isDailyDue(): boolean {
    if (!this.state.lastDailyAt) return true;
    const last = Date.parse(this.state.lastDailyAt);
    return !Number.isFinite(last) || this.nowFn() - last >= this.dailyMs;
  }

  /**
   * One tick: drain, then the daily pass when due. Public for tests and
   * an on-demand run.
   *
   * @param opts - `force` runs the daily pass whether or not it is due
   * @returns What ran
   */
  async tick(opts: { force?: boolean } = {}): Promise<WikiMaintenanceTickResult> {
    const result: WikiMaintenanceTickResult = { drain: null };
    if (this.running) {
      this.logger.debug('WikiMaintenance tick already running — skipping overlap');
      return result;
    }
    this.running = true;
    try {
      await this.loadState();
      try {
        result.drain = await this.drain.drain({ dryRun: this.dryRun, now: this.nowFn() });
      } catch (err) {
        this.logger.warn('WikiMaintenance: drain failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      }

      if (!opts.force && !this.isDailyDue()) {
        result.skippedDaily = 'not_due';
        return result;
      }
      const vaults = await this.discoverRoots();
      const now = this.nowFn();
      const rotated = await this.rotation.rotateAll(vaults, { dryRun: this.dryRun, now });
      const compiled = await this.compile.compileAll(vaults, { dryRun: this.dryRun, now });
      const gaps = await this.gaps.compileAll(vaults, { dryRun: this.dryRun, now });
      result.daily = { vaults, rotated, compiled, gaps };
      this.logger.info('WikiMaintenance daily pass', {
        dryRun: this.dryRun,
        vaults: vaults.length,
        rotated: rotated.filter((r) => r.rotated).map((r) => ({ vault: r.vaultPath, bytes: r.bytes, entries: r.entries, carried: r.carried, archive: r.archivePath })),
        compiled: compiled.filter((c) => c.compiled).map((c) => ({ vault: c.vaultPath, page: c.pagePath, entries: c.entriesCompiled })),
        gaps: gaps.filter((g) => g.compiled).map((g) => ({ vault: g.vaultPath, page: g.pagePath, gaps: g.rollup.gaps.length, target: g.target, workItemId: g.workItemId ?? null, skipped: g.workItemSkipped ?? null })),
      });
      if (!this.dryRun) {
        this.state = { lastDailyAt: new Date(now).toISOString() };
        await this.saveState();
      }
      return result;
    } catch (err) {
      this.logger.warn('WikiMaintenance tick failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      return result;
    } finally {
      this.running = false;
    }
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    if (!this.statePath) return;
    try {
      const data = await safeReadJson<Partial<MaintenanceState> | null>(this.statePath, null);
      if (data && typeof data.lastDailyAt === 'string') this.state = { lastDailyAt: data.lastDailyAt };
    } catch (err) {
      this.logger.warn('WikiMaintenance: failed to load state (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async saveState(): Promise<void> {
    if (!this.statePath) return;
    try {
      await ensureDir(path.dirname(this.statePath));
      await atomicWriteJson(this.statePath, this.state);
    } catch (err) {
      this.logger.warn('WikiMaintenance: failed to persist state (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
