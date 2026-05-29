/**
 * WikiWorkItemBridgeService — materialises pending wiki work as claimable WIs.
 *
 * Replaces the wiki-bookkeep / wiki-reflect "shouldFire ≥ threshold" cron
 * model with the same V3 pool the rest of the system uses. Two source
 * streams feed the pool:
 *
 *   1. Pending `wiki-queue` items (one WI per vault that has ≥ 1 pending
 *      item; the agent drains the whole vault in that WI).
 *   2. Legacy `.crewly/knowledge/*` migration candidates per project (one
 *      WI per project root with > 0 proposed pages).
 *
 * Idle agents claim them through `TaskPoolService.claimFromPool` — no
 * extra cron decisions about who to ping. Failures route through the
 * standard task:failed / reconciler escalation paths (closing the loop
 * with the 2026-05-27 reconciler-escalation fix in
 * `reconciler-data-provider.ts:applyCorrection`).
 *
 * PR-1 routing (conservative): both kinds target the orchestrator
 * session. The wiki skills today live under `config/skills/orchestrator/`,
 * so ORC is the only role with a built-in handler. Broadening to TLs is
 * a follow-up once the skills are promoted to a shared path.
 *
 * Dedupe: at most one non-terminal WI per (kind, vaultPath/projectRoot).
 *
 * @module services/wiki/wiki-workitem-bridge.service
 */

import os from 'os';
import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { WikiQueueService } from './wiki-queue.service.js';
import { WikiMigrateService } from './wiki-migrate.service.js';
import { WikiCleanupService } from './wiki-cleanup.service.js';
import { discoverWikiVaults } from './wiki-bookkeep-trigger.service.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import { atomicWriteJson, safeReadJson, ensureDir } from '../../utils/file-io.utils.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_TARGET_AGENT = 'crewly-orc';
/**
 * Hard cap on how many new WIs a single tick can publish. PTY-backed
 * agents (Claude Code) flood their paste buffer when too many
 * `[SYSTEM — TASK RECOVERY]` messages arrive in rapid succession —
 * observed during the 2026-05-27 first boot of the bridge: 11 WIs hit
 * ORC in 0.97s, the PTY buffer choked, and ORC sat "Reticulating…" for
 * 13 min until the reconciler revoked the claim. Two per tick gives
 * the worker breathing room; the next interval will pick up the rest.
 */
const DEFAULT_MAX_CREATES_PER_TICK = 2;
/**
 * Cooldown between creating WIs for the same (kind, vault/project) key.
 * Default 30 min.
 *
 * Why: pool-only dedupe is insufficient when ORC's recovery flow forcibly
 * deletes WIs via `DELETE /api/task-pool/:id?force=1` to escape its own
 * PTY-flood state (observed 2026-05-27 22:46:49, post-session-restart
 * cleanup wiped 10 wiki WIs). A removed WI is no longer in the pool, so
 * the next tick's `snapshotInflight` misses it and re-creates a duplicate
 * with a fresh id. Cooldown blocks that loop by tracking
 * "last attempted create" in-memory regardless of pool state.
 */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
/**
 * State-file name (under {@link getCrewlyHomePath}). Used to persist
 * {@link WikiWorkItemBridgeService.lastCreatedAt} across restarts so an
 * operator's cancel decision isn't undone by the next boot tick. Without
 * persistence: cancel a WI → restart → bridge's in-memory cooldown is
 * empty → re-creates the WI within seconds.
 */
const STATE_FILE_NAME = 'wiki-bridge-state.json';
/** Persisted state version — bump on shape change to invalidate old files. */
const STATE_VERSION = 1;
/**
 * Cap on entries in the persisted map. Old entries are no-ops anyway
 * (their cooldown has long expired), but pruning keeps the file small.
 */
const STATE_MAX_ENTRIES = 1000;

interface PersistedBridgeState {
  version: number;
  /** key (`${kind}:${path}`) → last-created epoch ms. */
  lastCreatedAt: Record<string, number>;
}

function emptyState(): PersistedBridgeState {
  return { version: STATE_VERSION, lastCreatedAt: {} };
}

/** WorkItem.metadata.kind value identifying a wiki queue drain WI. */
export const META_KIND_WIKI_DRAIN = 'wiki_queue_drain' as const;
/** WorkItem.metadata.kind value identifying a wiki legacy migration WI. */
export const META_KIND_WIKI_MIGRATE = 'wiki_legacy_migrate' as const;
/** WorkItem.metadata.kind value identifying a wiki cleanup (low-quality removal) WI. */
export const META_KIND_WIKI_CLEANUP = 'wiki_quality_cleanup' as const;

/**
 * Per-WI chunk size for cleanup. The bridge surfaces at most this many
 * candidate page paths per WorkItem; if a vault has more candidates,
 * the bridge creates one WI per chunk on successive ticks. 10 keeps the
 * agent's per-WI workload small enough to actually read each page
 * before deciding keep/delete.
 */
const CLEANUP_CHUNK_SIZE = 10;
/**
 * Skip cleanup-WI creation until the vault has at least this many
 * candidates. Avoids spawning a WI for a vault that has 1-2 minor
 * blemishes — the bridge has better things to do.
 */
const CLEANUP_MIN_CANDIDATES = 10;

const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
  'done',
  'verified',
  'cancelled',
  'failed',
  'rejected',
]);

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface WikiWorkItemBridgeOptions {
  /** How often to scan vaults + projects (default 10 min). */
  intervalMs?: number;
  /** Target agent session for the created WIs (default `crewly-orc`). */
  targetAgent?: string;
  /**
   * Max new WIs to publish per tick (default 2). Throttles PTY flood —
   * see {@link DEFAULT_MAX_CREATES_PER_TICK}.
   */
  maxCreatesPerTick?: number;
  /**
   * Per-key cooldown (default 30 min) between successive create attempts
   * for the same vault path or project root. Survives pool deletes —
   * see {@link DEFAULT_COOLDOWN_MS}.
   */
  cooldownMs?: number;
  /** Time source override (test seam). Returns `Date.now()` by default. */
  now?: () => number;
  /**
   * Override the state file path (test seam). When omitted, the bridge
   * resolves `~/.crewly/wiki-bridge-state.json` via `getCrewlyHomePath()`.
   * Passing `null` disables persistence entirely — handy for unit tests
   * that don't want filesystem side effects.
   */
  statePath?: string | null;
  /** Vault discovery override (default: `discoverWikiVaults`). */
  discoverRoots?: () => Promise<string[]>;
  /** Project-root discovery override (default: cwd + projects.json entries). */
  discoverProjectRoots?: () => Promise<string[]>;
  /** Wiki queue service override (test seam). */
  queueService?: WikiQueueService;
  /** Wiki migrate service override (test seam). */
  migrateService?: WikiMigrateService;
  /** Wiki cleanup service override (test seam). */
  cleanupService?: WikiCleanupService;
  /** Task pool override (test seam). */
  taskPool?: TaskPoolService;
}

export interface WikiBridgeTickResult {
  scannedVaults: string[];
  createdForVault: string[];
  skippedInflightVaults: string[];
  scannedProjects: string[];
  createdForProject: string[];
  skippedInflightProjects: string[];
  /** Candidates that were eligible but deferred to the next tick because of {@link WikiWorkItemBridgeOptions.maxCreatesPerTick}. */
  deferredByThrottle: string[];
  /** Candidates skipped because their cooldown hasn't elapsed yet. */
  skippedByCooldown: string[];
  /** Vault paths for which a cleanup WI was created this tick. */
  createdCleanupForVault: string[];
}

/**
 * Periodic bridge: pending wiki queue items + migration candidates
 * become claimable WorkItems in the V3 pool.
 */
export class WikiWorkItemBridgeService {
  private static instance: WikiWorkItemBridgeService | null = null;
  private readonly logger: ComponentLogger;
  private readonly intervalMs: number;
  private readonly targetAgent: string;
  private readonly maxCreatesPerTick: number;
  private readonly cooldownMs: number;
  private readonly nowFn: () => number;
  private readonly discoverRoots: () => Promise<string[]>;
  private readonly discoverProjectRoots: () => Promise<string[]>;
  private readonly queue: WikiQueueService;
  private readonly migrate: WikiMigrateService;
  private readonly cleanup: WikiCleanupService;
  private readonly pool: TaskPoolService;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Per-key (kind + path) last-create timestamp. Survives pool deletes. */
  private readonly lastCreatedAt = new Map<string, number>();
  /** Absolute path of the persisted state file (or `null` to disable). */
  private readonly statePath: string | null;
  /** True after `loadStateFromDisk` has either populated or no-op'd. */
  private stateLoaded = false;

  constructor(opts: WikiWorkItemBridgeOptions = {}) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiWorkItemBridge');
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.targetAgent = opts.targetAgent ?? DEFAULT_TARGET_AGENT;
    this.maxCreatesPerTick = Math.max(1, opts.maxCreatesPerTick ?? DEFAULT_MAX_CREATES_PER_TICK);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.nowFn = opts.now ?? (() => Date.now());
    this.discoverRoots = opts.discoverRoots ?? discoverWikiVaults;
    this.discoverProjectRoots = opts.discoverProjectRoots ?? defaultProjectRoots;
    this.queue = opts.queueService ?? WikiQueueService.getInstance();
    this.migrate = opts.migrateService ?? WikiMigrateService.getInstance();
    this.cleanup = opts.cleanupService ?? WikiCleanupService.getInstance();
    this.pool = opts.taskPool ?? TaskPoolService.getInstance();
    if (opts.statePath === null) {
      this.statePath = null;
    } else if (typeof opts.statePath === 'string') {
      this.statePath = opts.statePath;
    } else {
      this.statePath = path.join(getCrewlyHomePath(), STATE_FILE_NAME);
    }
  }

  /**
   * Hydrate {@link lastCreatedAt} from disk. Idempotent — runs once per
   * service lifetime. Bad/missing/stale-version files reset to empty.
   */
  private async loadStateFromDisk(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    if (!this.statePath) return;
    const state = await safeReadJson<PersistedBridgeState>(
      this.statePath,
      emptyState(),
      this.logger,
    );
    if (!state || state.version !== STATE_VERSION || typeof state.lastCreatedAt !== 'object') {
      this.logger.debug('Bridge state file missing / wrong version — starting fresh', {
        statePath: this.statePath,
        loadedVersion: state?.version,
      });
      return;
    }
    let loadedCount = 0;
    const now = this.nowFn();
    for (const [key, ts] of Object.entries(state.lastCreatedAt)) {
      if (typeof ts !== 'number') continue;
      // Drop entries already past their cooldown — they're no-ops and
      // would just bloat memory.
      if (now - ts >= this.cooldownMs) continue;
      this.lastCreatedAt.set(key, ts);
      loadedCount++;
    }
    if (loadedCount > 0) {
      this.logger.info('Loaded bridge cooldown state', {
        statePath: this.statePath,
        activeCooldowns: loadedCount,
      });
    }
  }

  /**
   * Persist {@link lastCreatedAt} to disk. Best-effort — write failures
   * are logged but never throw (the bridge is non-essential infrastructure).
   * Prunes expired entries before writing so the file stays small.
   */
  private async saveStateToDisk(): Promise<void> {
    if (!this.statePath) return;
    try {
      const now = this.nowFn();
      const fresh: Record<string, number> = {};
      for (const [key, ts] of this.lastCreatedAt) {
        if (now - ts >= this.cooldownMs) continue;
        fresh[key] = ts;
      }
      // Cap the file to STATE_MAX_ENTRIES newest by timestamp. Production
      // expects ~10-50 entries; the cap is paranoia against a future
      // path-explosion bug.
      const entries = Object.entries(fresh);
      if (entries.length > STATE_MAX_ENTRIES) {
        entries.sort((a, b) => b[1] - a[1]);
        entries.length = STATE_MAX_ENTRIES;
      }
      const payload: PersistedBridgeState = {
        version: STATE_VERSION,
        lastCreatedAt: Object.fromEntries(entries),
      };
      await ensureDir(path.dirname(this.statePath));
      await atomicWriteJson(this.statePath, payload);
    } catch (err) {
      this.logger.warn('Bridge state persist failed (non-fatal)', {
        statePath: this.statePath,
        error: (err as Error).message,
      });
    }
  }

  /**
   * True iff the key's cooldown is still active (i.e., we created a WI
   * for this key recently). Survives forced pool deletes so an
   * agent-driven cleanup can't trick the bridge into re-creating
   * immediately.
   */
  private isCoolingDown(key: string): boolean {
    const last = this.lastCreatedAt.get(key);
    if (last == null) return false;
    return this.nowFn() - last < this.cooldownMs;
  }

  private markCreated(key: string): void {
    this.lastCreatedAt.set(key, this.nowFn());
  }

  static getInstance(): WikiWorkItemBridgeService | null {
    return this.instance;
  }

  /** Wire / detach the production singleton. */
  static setInstance(next: WikiWorkItemBridgeService | null): void {
    if (this.instance && this.instance !== next) this.instance.stop();
    this.instance = next;
  }

  /** Start the periodic scan. Idempotent. Fires an immediate tick. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.logger.info('WikiWorkItemBridge started', {
      intervalMs: this.intervalMs,
      targetAgent: this.targetAgent,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Single pass — exposed for tests and the initial boot-time fire. */
  async tick(): Promise<WikiBridgeTickResult> {
    const result: WikiBridgeTickResult = {
      scannedVaults: [],
      createdForVault: [],
      skippedInflightVaults: [],
      scannedProjects: [],
      createdForProject: [],
      skippedInflightProjects: [],
      deferredByThrottle: [],
      skippedByCooldown: [],
      createdCleanupForVault: [],
    };

    if (this.running) {
      // Overlapping ticks would create duplicates; the dedupe pass below
      // also catches it but cheaper to bail early.
      this.logger.debug('Tick already in progress — skipping overlap');
      return result;
    }
    this.running = true;
    let createdThisTick = 0;
    try {
      await this.loadStateFromDisk();
      const { inflightVaults, inflightProjects, inflightCleanupVaults } = await this.snapshotInflight();

      // Drains come first — they're cheap, fast, and the most common case.
      const vaults = await this.discoverRoots();
      for (const vaultPath of vaults) {
        result.scannedVaults.push(vaultPath);
        if (inflightVaults.has(vaultPath)) {
          result.skippedInflightVaults.push(vaultPath);
          continue;
        }
        const key = `${META_KIND_WIKI_DRAIN}:${vaultPath}`;
        if (this.isCoolingDown(key)) {
          result.skippedByCooldown.push(vaultPath);
          continue;
        }
        try {
          const pending = await this.queue.list({
            vaultPath,
            status: 'pending',
            limit: 200,
          });
          if (pending.length === 0) continue;
          if (createdThisTick >= this.maxCreatesPerTick) {
            result.deferredByThrottle.push(vaultPath);
            continue;
          }
          await this.createDrainWorkItem(vaultPath, pending.length);
          this.markCreated(key);
          result.createdForVault.push(vaultPath);
          createdThisTick++;
        } catch (err) {
          this.logger.debug('queue.list / drain WI create failed (non-fatal)', {
            vaultPath,
            error: (err as Error).message,
          });
        }
      }

      const projects = await this.discoverProjectRoots();
      for (const projectRoot of projects) {
        result.scannedProjects.push(projectRoot);
        if (inflightProjects.has(projectRoot)) {
          result.skippedInflightProjects.push(projectRoot);
          continue;
        }
        const key = `${META_KIND_WIKI_MIGRATE}:${projectRoot}`;
        if (this.isCoolingDown(key)) {
          result.skippedByCooldown.push(projectRoot);
          continue;
        }
        try {
          const scan = await this.migrate.scan({ projectRoot });
          if (!scan.ok) continue;
          if (!scan.legacyDetected) continue;
          // Count NET-NEW pages only. A scan keeps already-migrated entries in
          // `proposedPages` tagged with skipReason 'already migrated' (apply-only
          // reasons like write_failed never appear on a scan result). Counting
          // the raw length means a fully-migrated vault still reports
          // proposed > 0, so the gate below never trips and the bridge re-creates
          // a no-op migrate WI every cooldown cycle (churn loop). Only pages with
          // no skipReason represent genuine new work for the migrate agent.
          const proposed = scan.proposedPages.filter((p) => !p.skipReason).length;
          if (proposed === 0) continue;
          if (createdThisTick >= this.maxCreatesPerTick) {
            result.deferredByThrottle.push(projectRoot);
            continue;
          }
          await this.createMigrateWorkItem(projectRoot, proposed);
          this.markCreated(key);
          result.createdForProject.push(projectRoot);
          createdThisTick++;
        } catch (err) {
          this.logger.debug('migrate.scan / migrate WI create failed (non-fatal)', {
            projectRoot,
            error: (err as Error).message,
          });
        }
      }

      // Third pass: cleanup. Re-walk the same vault list (already scanned
      // above for drain) and ask the cleanup service if it has candidates.
      // Same dedupe + cooldown + throttle apply. Each cleanup WI carries
      // up to CLEANUP_CHUNK_SIZE explicit page paths; if the vault has
      // more, the next bridge tick (post-cooldown) creates a fresh WI
      // for the next chunk — the agent doesn't have to handle all of
      // it in one session.
      for (const vaultPath of vaults) {
        if (inflightCleanupVaults.has(vaultPath)) continue;
        const cleanupKey = `${META_KIND_WIKI_CLEANUP}:${vaultPath}`;
        if (this.isCoolingDown(cleanupKey)) {
          result.skippedByCooldown.push(`cleanup:${vaultPath}`);
          continue;
        }
        try {
          const scan = await this.cleanup.scan({ vaultPath });
          if (!scan.ok || !('candidates' in scan)) continue;
          if (scan.candidates.length < CLEANUP_MIN_CANDIDATES) continue;
          if (createdThisTick >= this.maxCreatesPerTick) {
            result.deferredByThrottle.push(`cleanup:${vaultPath}`);
            continue;
          }
          await this.createCleanupWorkItem(
            vaultPath,
            scan.candidates.slice(0, CLEANUP_CHUNK_SIZE),
            scan.candidates.length,
          );
          this.markCreated(cleanupKey);
          result.createdCleanupForVault.push(vaultPath);
          createdThisTick++;
        } catch (err) {
          this.logger.debug('cleanup.scan / cleanup WI create failed (non-fatal)', {
            vaultPath,
            error: (err as Error).message,
          });
        }
      }

      if (result.deferredByThrottle.length > 0) {
        this.logger.info('WikiWorkItemBridge throttled — deferred to next tick', {
          createdThisTick,
          maxCreatesPerTick: this.maxCreatesPerTick,
          deferredCount: result.deferredByThrottle.length,
          nextTickInMs: this.intervalMs,
        });
      }
      // Persist any state mutations from this tick. One write per tick
      // amortises filesystem cost even if many keys were updated.
      if (createdThisTick > 0) {
        await this.saveStateToDisk();
      }
    } catch (err) {
      this.logger.warn('WikiWorkItemBridge tick failed (non-fatal)', {
        error: (err as Error).message,
      });
    } finally {
      this.running = false;
    }
    return result;
  }

  /**
   * Build the dedupe sets from the pool's current contents. A WI is
   * "in-flight" if its kind metadata matches and its status is not
   * terminal — i.e. it's still queued/claimed/running/etc.
   */
  private async snapshotInflight(): Promise<{
    inflightVaults: Set<string>;
    inflightProjects: Set<string>;
    inflightCleanupVaults: Set<string>;
  }> {
    const inflightVaults = new Set<string>();
    const inflightProjects = new Set<string>();
    const inflightCleanupVaults = new Set<string>();
    const allItems = await this.pool.getAllItems();
    for (const wi of allItems) {
      if (TERMINAL_STATUSES.has(wi.status)) continue;
      const meta = wi.metadata ?? {};
      const kind = meta['kind'];
      if (kind === META_KIND_WIKI_DRAIN && typeof meta['vaultPath'] === 'string') {
        inflightVaults.add(meta['vaultPath']);
      } else if (kind === META_KIND_WIKI_MIGRATE && typeof meta['projectRoot'] === 'string') {
        inflightProjects.add(meta['projectRoot']);
      } else if (kind === META_KIND_WIKI_CLEANUP && typeof meta['vaultPath'] === 'string') {
        inflightCleanupVaults.add(meta['vaultPath']);
      }
    }
    return { inflightVaults, inflightProjects, inflightCleanupVaults };
  }

  private async createDrainWorkItem(vaultPath: string, pendingCount: number): Promise<void> {
    const scope = describeVaultScope(vaultPath);
    const wi: WorkItem = createWorkItem({
      type: 'delegate',
      owner: 'orchestrator',
      target: this.targetAgent,
      title: `Drain ${pendingCount} wiki queue item(s) — ${scope}`,
      description: `Process ${pendingCount} pending wiki queue items in ${vaultPath}.`,
      briefMarkdown: drainBrief(vaultPath, pendingCount),
      maxRetries: 1,
      metadata: {
        kind: META_KIND_WIKI_DRAIN,
        vaultPath,
        pendingCount,
        autoCreated: true,
      },
    });
    await this.pool.addToPool(wi);
    this.logger.info('Created wiki-drain WorkItem', {
      workItemId: wi.id,
      vaultPath,
      pendingCount,
      target: this.targetAgent,
    });
  }

  private async createCleanupWorkItem(
    vaultPath: string,
    chunk: ReadonlyArray<{ relPath: string; reasons: string[]; confidence: number | null; bytes: number }>,
    totalCandidates: number,
  ): Promise<void> {
    const scope = describeVaultScope(vaultPath);
    const wi: WorkItem = createWorkItem({
      type: 'delegate',
      owner: 'orchestrator',
      target: this.targetAgent,
      title: `Cleanup ${chunk.length} of ${totalCandidates} low-quality wiki page(s) — ${scope}`,
      description: `Review ${chunk.length} cleanup candidates in ${vaultPath}; decide keep/delete; call wiki-cleanup --apply with the final list.`,
      briefMarkdown: cleanupBrief(vaultPath, chunk, totalCandidates),
      maxRetries: 1,
      metadata: {
        kind: META_KIND_WIKI_CLEANUP,
        vaultPath,
        chunkSize: chunk.length,
        totalCandidates,
        candidates: chunk.map((c) => ({
          relPath: c.relPath,
          reasons: c.reasons,
          confidence: c.confidence,
          bytes: c.bytes,
        })),
        autoCreated: true,
      },
    });
    await this.pool.addToPool(wi);
    this.logger.info('Created wiki-cleanup WorkItem', {
      workItemId: wi.id,
      vaultPath,
      chunkSize: chunk.length,
      totalCandidates,
      target: this.targetAgent,
    });
  }

  private async createMigrateWorkItem(projectRoot: string, proposedCount: number): Promise<void> {
    const wi: WorkItem = createWorkItem({
      type: 'delegate',
      owner: 'orchestrator',
      target: this.targetAgent,
      title: `Migrate ${proposedCount} legacy wiki item(s) — ${path.basename(projectRoot)}`,
      description: `Apply wiki-migrate for ${projectRoot} (${proposedCount} new pages).`,
      briefMarkdown: migrateBrief(projectRoot, proposedCount),
      maxRetries: 1,
      metadata: {
        kind: META_KIND_WIKI_MIGRATE,
        projectRoot,
        proposedCount,
        autoCreated: true,
      },
    });
    await this.pool.addToPool(wi);
    this.logger.info('Created wiki-migrate WorkItem', {
      workItemId: wi.id,
      projectRoot,
      proposedCount,
      target: this.targetAgent,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort label for a vault path that surfaces in UI/list views.
 * Order matters: check global before the generic project tail.
 */
export function describeVaultScope(vaultPath: string): string {
  if (vaultPath.endsWith('global-wiki')) return 'global';
  const homeTeams = path.join(os.homedir(), '.crewly/teams');
  if (vaultPath.startsWith(homeTeams + path.sep)) {
    const remainder = vaultPath.slice(homeTeams.length + 1);
    const teamId = remainder.split(path.sep)[0] ?? '?';
    return `team ${teamId}`;
  }
  const parent = path.dirname(path.dirname(vaultPath));
  return `project ${path.basename(parent)}`;
}

function drainBrief(vaultPath: string, pendingCount: number): string {
  return [
    '# Wiki Queue Drain',
    '',
    '**This is a bridge-auto maintenance WorkItem.** See the "Bridge-auto',
    'WorkItems" rule in your prompt — process via the skill, do not delete.',
    '',
    `**Vault:** \`${vaultPath}\``,
    `**Pending items:** ${pendingCount}`,
    '',
    `**Partial progress is the norm** — drain whatever you can in this turn`,
    `(5-20 items is a healthy chunk; you do not need to clear all ${pendingCount}).`,
    'When you mark this WI `done`, the bridge cooldown (30 min) expires and a',
    'fresh WI appears with whatever remains. Iterative drain over multiple',
    'sessions is the design.',
    '',
    '```bash',
    `bash {{ORCHESTRATOR_SKILLS_PATH}}/wiki-process-queue/execute.sh --vault ${vaultPath}`,
    '```',
    '',
    'Each invocation claims one item, lets you read context, then commits via `POST /queue/<id>/process` (or `/skip`). Repeat 5-20 times per WI, then mark `done` via `complete-task` with a one-line summary of what you drained.',
  ].join('\n');
}

function cleanupBrief(
  vaultPath: string,
  chunk: ReadonlyArray<{ relPath: string; reasons: string[]; confidence: number | null; bytes: number }>,
  totalCandidates: number,
): string {
  const lines: string[] = [
    '# Wiki Quality Cleanup',
    '',
    '**This is a bridge-auto maintenance WorkItem.** See the "Bridge-auto',
    'WorkItems" rule in your prompt — process via the skill, do not delete.',
    '',
    `**Vault:** \`${vaultPath}\``,
    `**Candidates in this WI:** ${chunk.length}`,
    `**Total candidates in vault:** ${totalCandidates}`,
    '',
    `**Partial progress is the norm** — review the ${chunk.length} pages in this WI, decide keep/delete for each, then call \`wiki-cleanup --apply --pages "..."\` with ONLY the relPaths you decided to delete. The next bridge tick (30 min cooldown) creates a fresh WI with the next ${chunk.length}. No need to drain everything in one session.`,
    '',
    '## Candidates',
    '',
  ];
  for (const c of chunk) {
    const conf = c.confidence === null ? 'unknown' : c.confidence.toFixed(2);
    lines.push(`- \`${c.relPath}\` (confidence=${conf}, ${c.bytes} bytes) — ${c.reasons.join('; ')}`);
  }
  lines.push(
    '',
    '## Workflow',
    '',
    '1. For each candidate, run `wiki-page-read` (or grep the file directly) to check whether it has any real value despite the flag. A `confidence=0.3` page might still be the only documentation of a critical gotcha.',
    '2. Build a comma-separated list of relPaths you want to delete.',
    '3. Run apply:',
    '',
    '```bash',
    `bash {{ORCHESTRATOR_SKILLS_PATH}}/wiki-cleanup/execute.sh --vault ${vaultPath} --apply --pages "<rel1>,<rel2>,..."`,
    '```',
    '',
    '4. Archive lives at `<vault>/.wiki-cleanup-archive.json` — every deleted page\'s body + frontmatter is preserved, so cleanup is reversible.',
    '5. Mark this WI done via `complete-task` with a one-line summary (`deleted N of ' + chunk.length + ', kept M, archive grew by ...`).',
  );
  return lines.join('\n');
}

function migrateBrief(projectRoot: string, proposedCount: number): string {
  return [
    '# Wiki Legacy Migration',
    '',
    '**This is a bridge-auto maintenance WorkItem.** See the "Bridge-auto',
    'WorkItems" rule in your prompt — process via the skill, do not delete.',
    '',
    `**Project root:** \`${projectRoot}\``,
    `**Proposed new pages:** ${proposedCount}`,
    '',
    `**Partial progress is the norm** — ${proposedCount} sounds like a lot,`,
    'but the migrate service is idempotent: every successful page lands in',
    'the manifest and is skipped on the next run. So you can run `--apply`,',
    'let it work for a few minutes, mark this WI `done` whatever it migrated,',
    'and the next bridge tick (30 min cooldown) creates a fresh WI for what',
    'remains. No need to wait for the whole batch to complete.',
    '',
    '1. Dry-run first to sanity-check the proposal:',
    '```bash',
    `bash {{ORCHESTRATOR_SKILLS_PATH}}/wiki-migrate/execute.sh --project-root ${projectRoot}`,
    '```',
    '2. Apply (will resume from the manifest on subsequent runs):',
    '```bash',
    `bash {{ORCHESTRATOR_SKILLS_PATH}}/wiki-migrate/execute.sh --project-root ${projectRoot} --apply`,
    '```',
    '3. Report `applied`/`skipped` counts in `complete-task` output and mark `done`. The bridge will detect remaining items on its next tick.',
  ].join('\n');
}

/**
 * Default project-root discovery used by the production bridge. Mirrors
 * `discoverWikiVaults`'s project sources but returns roots, not vault paths.
 */
export async function defaultProjectRoots(): Promise<string[]> {
  const roots: string[] = [];
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, '.crewly'))) roots.push(cwd);
  const projectsJsonPath = path.join(os.homedir(), '.crewly/projects.json');
  if (existsSync(projectsJsonPath)) {
    try {
      const raw = await fs.readFile(projectsJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as Array<{ path?: string }>;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry.path === 'string' && path.isAbsolute(entry.path)) {
            roots.push(entry.path);
          }
        }
      }
    } catch {
      // malformed projects.json — partial discovery is fine
    }
  }
  return Array.from(new Set(roots));
}
