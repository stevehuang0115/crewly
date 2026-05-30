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
import { atomicWriteJson, safeReadJson, ensureDir } from '../../utils/file-io.utils.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

const STATE_FILE_NAME = 'wiki-bookkeep-trigger-state.json';

/** Persisted per-vault state: the consolidation high-water mark + last fire. */
interface VaultBookkeepState {
  /** Total md count we last established as the baseline (high-water mark). */
  baselineMdCount: number;
  /** Last time we fired a bookkeep notification for this vault (ms epoch). */
  lastFiredAt: number;
}

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
  /**
   * Where to persist per-vault baseline + debounce state. Defaults to
   * `~/.crewly/wiki-bookkeep-trigger-state.json`. Pass `null` to disable
   * persistence (tests) so the trigger keeps state in-memory only.
   */
  statePath?: string | null;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 6 * 3600 * 1000;

/**
 * Discover absolute vault paths by walking the well-known Crewly roots:
 *   - `<env CREWLY_PROJECT_VAULT_PATH>` (single explicit override)
 *   - `<process.cwd>/.crewly/wiki` (current project vault — the OSS's own dir)
 *   - `~/.crewly/projects.json` → every registered project's `.crewly/wiki`
 *     (Closie, Flopost, CE, etc. — each team manages a project, and that
 *      project gets its own vault per v2.1 spec §1)
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

  // (NEW 2026-05-27) Every registered project's wiki. Without this, only
  // the OSS's own cwd project (Crewly itself) surfaces — Closie/Flopost/CE
  // managed by their teams stay invisible despite being real projects.
  const projectsJsonPath = path.join(os.homedir(), '.crewly/projects.json');
  if (existsSync(projectsJsonPath)) {
    try {
      const raw = await fs.readFile(projectsJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as Array<{ path?: string }>;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry.path === 'string' && path.isAbsolute(entry.path)) {
            candidates.push(path.join(entry.path, '.crewly/wiki'));
          }
        }
      }
    } catch {
      // malformed projects.json — skip; partial discovery is fine
    }
  }

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
  /** vaultPath → persisted baseline + last-fired state. */
  private readonly state = new Map<string, VaultBookkeepState>();
  /** Per-vault locks so two overlapping ticks don't double-fire. */
  private inflight = new Set<string>();
  private readonly statePath: string | null;
  private stateLoaded = false;

  constructor(opts: WikiBookkeepTriggerOptions) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiBookkeepTrigger');
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fireFn = opts.fireFn;
    this.discoverRoots = opts.discoverRoots ?? discoverWikiVaults;
    this.bookkeepService = opts.bookkeepService ?? WikiBookkeepService.getInstance();
    if (opts.statePath === null) {
      this.statePath = null;
    } else if (typeof opts.statePath === 'string') {
      this.statePath = opts.statePath;
    } else {
      this.statePath = path.join(getCrewlyHomePath(), STATE_FILE_NAME);
    }
  }

  /**
   * Load per-vault baseline + debounce state from disk (once). Without this,
   * the in-memory ledger resets on every backend restart, so the next tick
   * re-fires for every eligible vault — the "noise burst after a restart".
   */
  private async loadStateFromDisk(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    if (!this.statePath) return;
    try {
      const data = await safeReadJson<Record<string, VaultBookkeepState> | null>(this.statePath, null);
      if (data && typeof data === 'object') {
        for (const [vault, entry] of Object.entries(data)) {
          if (
            entry &&
            typeof entry.baselineMdCount === 'number' &&
            typeof entry.lastFiredAt === 'number'
          ) {
            this.state.set(vault, entry);
          }
        }
        this.logger.info('WikiBookkeepTrigger loaded persisted state', {
          statePath: this.statePath,
          vaults: this.state.size,
        });
      }
    } catch (err) {
      // A transient read error (e.g. EACCES) must not abort the tick — start
      // with an empty ledger this run; a later tick re-establishes baselines.
      this.logger.warn('WikiBookkeepTrigger: failed to load state (non-fatal)', {
        statePath: this.statePath,
        error: (err as Error).message,
      });
    }
  }

  /** Persist the per-vault state map (best-effort; failures are logged, not thrown). */
  private async saveStateToDisk(): Promise<void> {
    if (!this.statePath) return;
    try {
      const payload: Record<string, VaultBookkeepState> = {};
      for (const [vault, entry] of this.state) payload[vault] = entry;
      await ensureDir(path.dirname(this.statePath));
      await atomicWriteJson(this.statePath, payload);
    } catch (err) {
      this.logger.warn('WikiBookkeepTrigger: failed to persist state (non-fatal)', {
        statePath: this.statePath,
        error: (err as Error).message,
      });
    }
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
    await this.loadStateFromDisk();
    const vaults = await this.discoverRoots();
    const result = {
      scanned: [...vaults],
      fired: [] as string[],
      skippedByDebounce: [] as string[],
      quietVaults: [] as string[],
    };
    let stateDirty = false;
    for (const v of vaults) {
      if (this.inflight.has(v)) continue;
      this.inflight.add(v);
      try {
        const prior = this.state.get(v);
        const outcome = await this.bookkeepService.generate({
          vaultPath: v,
          baselineMdCount: prior?.baselineMdCount,
        });
        if (!outcome.ok) {
          this.logger.warn('WikiBookkeepTrigger: bookkeep failed for vault', {
            vault: v,
            reason: outcome.reason,
          });
          continue;
        }
        const total = outcome.report.totalMdCount;

        // First sight of a vault: establish the baseline at the current count
        // and DON'T fire. This is what stops a freshly-migrated vault (every
        // file mtime-recent) from firing on its entire backlog — only pages
        // added AFTER this point count toward the next threshold.
        if (!prior) {
          this.state.set(v, { baselineMdCount: total, lastFiredAt: 0 });
          stateDirty = true;
          result.quietVaults.push(v);
          continue;
        }

        // A vault that shrank (cleanup deleted pages) lowers the baseline so
        // future adds are measured from the new floor — keep it persisted.
        if (total < prior.baselineMdCount) {
          prior.baselineMdCount = total;
          stateDirty = true;
        }

        if (!outcome.report.shouldFire) {
          result.quietVaults.push(v);
          continue;
        }
        if (Date.now() - prior.lastFiredAt < this.debounceMs) {
          result.skippedByDebounce.push(v);
          continue;
        }
        // Fire, then advance the baseline to the current count so we don't
        // re-fire until another `threshold` net-new pages accumulate.
        prior.lastFiredAt = Date.now();
        prior.baselineMdCount = total;
        stateDirty = true;
        try {
          await this.fireFn(v, outcome.report);
          result.fired.push(v);
          this.logger.info('WikiBookkeepTrigger fired', {
            vault: v,
            netNewMd: outcome.report.netNewMdCount,
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
    if (stateDirty) await this.saveStateToDisk();
    return result;
  }

  /**
   * Test affordance: clear the in-memory baseline + debounce ledger. Leaves
   * `stateLoaded` set so a subsequent `tick()` does NOT reload persisted state
   * (which would undo the clear).
   */
  _resetDebounceForTesting(): void {
    this.state.clear();
  }
}
