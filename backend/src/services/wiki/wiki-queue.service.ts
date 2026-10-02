/**
 * WikiQueueService — file-backed queue of "wiki-worthy" content
 * that agents enqueue from inside their conversations.
 *
 * Design (Steve, 2026-05-22 redesign — replacing the keyword heuristic):
 *
 *   1. The orchestrator-system-prompt rule teaches agents to call the
 *      `wiki-queue-add` skill when a turn produces content with lasting
 *      value (decision, person fact, customer info, pattern, learning).
 *      Agents — not regex — decide.
 *
 *   2. Items sit in the queue with `status: pending` until an agent
 *      claims one via `wiki-process-queue` and chooses (a) where in the
 *      vault to put it OR (b) skip it because it's not actually worth
 *      saving. The agent's LLM is the classifier; we never pre-pick a
 *      taxonomy beyond the frozen folders.
 *
 *   3. Bookkeeping cron / threshold reads the same queue + vault stats
 *      so it can decide when to ask an agent for a consolidation pass.
 *
 * Storage: `~/.crewly/wiki-queue/<id>.json`. Single flat directory;
 * cross-vault filtering happens at list time via the `vaultPath` field
 * inside each record.
 *
 * @module services/wiki/wiki-queue.service
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { WikiSourceType } from './wiki-ingest.service.js';
import { WIKI_QUEUE_CONSTANTS } from '../../constants.js';

export type WikiQueueStatus = 'pending' | 'claimed' | 'processed' | 'skipped';

export interface WikiQueueItem {
  id: string;
  vaultPath: string;
  queuedAt: string;
  queuedBy: string;
  sourceType: WikiSourceType;
  sourceRef: string;
  content: string;
  /** Agent's note: WHY this is worth ingesting. Audit + helps the processor. */
  reason: string;
  status: WikiQueueStatus;
  claimedBy?: string;
  /** Set when the sweep moved this item to the dead-letter folder. */
  expiredAt?: string;
  /** Why the sweep expired it (age, last status). */
  expireReason?: string;
  claimedAt?: string;
  processedAt?: string;
  result?: {
    ingested: boolean;
    pagesWritten?: string[];
    targetPath?: string;
    summary?: string;
    skipReason?: string;
  };
}

export interface WikiQueueAddInput {
  vaultPath: string;
  queuedBy: string;
  sourceType: WikiSourceType;
  sourceRef: string;
  content: string;
  reason: string;
}

export interface WikiQueueListFilter {
  vaultPath?: string;
  status?: WikiQueueStatus;
  queuedBy?: string;
  /** Cap on returned items. Default 50. */
  limit?: number;
  /**
   * Sort order before the limit is applied. Default `newest` (UI lists).
   * Consumers draining the queue use `oldest` so old items cannot starve.
   */
  order?: 'newest' | 'oldest';
}

export interface WikiQueueStats {
  pending: number;
  claimed: number;
  processed: number;
  skipped: number;
  total: number;
  /** `queuedAt` of the oldest pending item, or null when nothing is pending. */
  oldestPendingQueuedAt: string | null;
}

/** Options for {@link WikiQueueService.sweep}. */
export interface WikiQueueSweepOptions {
  /** Current time in epoch ms (test seam). Default `Date.now()`. */
  now?: number;
  /** Pending/claimed items older than this are dead-lettered. */
  maxItemAgeMs?: number;
  /** Claims older than this are released back to pending. */
  claimTimeoutMs?: number;
}

/** Pending backlog of one vault, as seen by a sweep. */
export interface WikiQueueVaultBacklog {
  /** Normalised vault path. */
  vaultPath: string;
  /** Items still pending after the sweep. */
  pending: number;
  /** `queuedAt` of the oldest of them. */
  oldestQueuedAt: string;
}

/** Outcome of {@link WikiQueueService.sweep}. */
export interface WikiQueueSweepResult {
  /** Items moved to the dead-letter folder. */
  expired: WikiQueueItem[];
  /** Ids of claims released back to pending. */
  releasedClaims: string[];
  /** Remaining pending backlog per vault. */
  backlog: WikiQueueVaultBacklog[];
}

/**
 * Canonical form of a vault path, so `/p/.crewly/wiki/` and
 * `/p/.crewly/wiki` (or a path with `..`) name the same vault. Queue
 * filters used to compare the raw strings; an item stored with a trailing
 * slash never matched the discovered vault and was never drained (#914).
 *
 * @param vaultPath - Absolute vault path as given by a caller
 * @returns The resolved path without a trailing separator
 */
export function normalizeVaultPath(vaultPath: string): string {
  return path.resolve(vaultPath);
}

const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_REASON_BYTES = 2 * 1024;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * File-backed queue. Stateless other than the on-disk JSONs and an
 * in-memory cache of the root directory. Singleton because all writes
 * go to the same on-disk pool.
 */
export class WikiQueueService {
  private static instance: WikiQueueService | null = null;
  private readonly logger: ComponentLogger;
  private readonly rootDir: string;
  private initPromise: Promise<void> | null = null;

  constructor(rootDir?: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiQueue');
    this.rootDir = rootDir ?? path.join(os.homedir(), '.crewly', 'wiki-queue');
  }

  static getInstance(): WikiQueueService {
    if (!this.instance) this.instance = new WikiQueueService();
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /** Expose for tests. */
  getRootDir(): string {
    return this.rootDir;
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /** Enqueue a new candidate. Returns the persisted item. */
  async add(input: WikiQueueAddInput): Promise<WikiQueueItem> {
    this.validateAddInput(input);
    await this.ensureRoot();

    const item: WikiQueueItem = {
      id: randomUUID(),
      vaultPath: normalizeVaultPath(input.vaultPath),
      queuedAt: new Date().toISOString(),
      queuedBy: input.queuedBy,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      content: input.content,
      reason: input.reason,
      status: 'pending',
    };
    await this.writeItem(item);
    this.logger.info('WikiQueue add', {
      id: item.id,
      vaultPath: item.vaultPath,
      sourceType: item.sourceType,
      queuedBy: item.queuedBy,
      bytes: Buffer.byteLength(item.content, 'utf8'),
    });
    return item;
  }

  /**
   * List items, optionally filtered. Newest-first unless `order: 'oldest'`.
   * Vault paths are compared in normalised form (see {@link normalizeVaultPath}).
   *
   * @param filter - Vault / status / author filters, limit and order
   * @returns Matching items, sorted and capped
   */
  async list(filter: WikiQueueListFilter = {}): Promise<WikiQueueItem[]> {
    const limit = filter.limit ?? 50;
    const wantVault = filter.vaultPath ? normalizeVaultPath(filter.vaultPath) : null;
    const items = (await this.readAll()).filter(
      (item) =>
        (!wantVault || normalizeVaultPath(item.vaultPath) === wantVault) &&
        (!filter.status || item.status === filter.status) &&
        (!filter.queuedBy || item.queuedBy === filter.queuedBy),
    );
    const oldestFirst = filter.order === 'oldest';
    items.sort((a, b) => {
      if (a.queuedAt === b.queuedAt) return 0;
      const aFirst = oldestFirst ? a.queuedAt < b.queuedAt : a.queuedAt > b.queuedAt;
      return aFirst ? -1 : 1;
    });
    return items.slice(0, limit);
  }

  /** Fetch one by id. Returns null when missing. */
  async get(id: string): Promise<WikiQueueItem | null> {
    await this.ensureRoot();
    const file = path.join(this.rootDir, `${id}.json`);
    return this.readItemFile(file);
  }

  /**
   * Claim an item — only allowed when `status: pending`. Stamps the
   * claimant + timestamp atomically.
   */
  async claim(id: string, claimedBy: string): Promise<WikiQueueItem> {
    const item = await this.requireItem(id);
    if (item.status !== 'pending') {
      throw new Error(
        `WikiQueue.claim(${id}): item is ${item.status}; only pending items can be claimed`,
      );
    }
    const updated: WikiQueueItem = {
      ...item,
      status: 'claimed',
      claimedBy,
      claimedAt: new Date().toISOString(),
    };
    await this.writeItem(updated);
    this.logger.info('WikiQueue claim', { id, claimedBy });
    return updated;
  }

  /**
   * Mark processed. Requires the item to be `claimed` AND requires a
   * `result` with at least one of `pagesWritten` / `targetPath` / `summary`.
   */
  async markProcessed(
    id: string,
    result: NonNullable<WikiQueueItem['result']>,
  ): Promise<WikiQueueItem> {
    const item = await this.requireItem(id);
    if (item.status !== 'claimed') {
      throw new Error(
        `WikiQueue.markProcessed(${id}): item is ${item.status}; must be claimed first`,
      );
    }
    const updated: WikiQueueItem = {
      ...item,
      status: 'processed',
      processedAt: new Date().toISOString(),
      result,
    };
    await this.writeItem(updated);
    this.logger.info('WikiQueue processed', {
      id,
      pages: result.pagesWritten?.length ?? 0,
      target: result.targetPath,
    });
    return updated;
  }

  /** Mark skipped — agent decided this isn't wiki-worthy after all. */
  async markSkipped(id: string, skipReason: string): Promise<WikiQueueItem> {
    if (!skipReason || skipReason.trim().length === 0) {
      throw new Error('WikiQueue.markSkipped requires a non-empty skipReason');
    }
    const item = await this.requireItem(id);
    if (item.status !== 'claimed') {
      throw new Error(
        `WikiQueue.markSkipped(${id}): item is ${item.status}; must be claimed first`,
      );
    }
    const updated: WikiQueueItem = {
      ...item,
      status: 'skipped',
      processedAt: new Date().toISOString(),
      result: { ingested: false, skipReason },
    };
    await this.writeItem(updated);
    this.logger.info('WikiQueue skipped', { id, reason: skipReason });
    return updated;
  }

  /** Status counts, optionally scoped to a vault. */
  async getStats(vaultPath?: string): Promise<WikiQueueStats> {
    const items = await this.list({ vaultPath, limit: Number.MAX_SAFE_INTEGER });
    const counts: WikiQueueStats = {
      pending: 0,
      claimed: 0,
      processed: 0,
      skipped: 0,
      total: items.length,
      oldestPendingQueuedAt: null,
    };
    for (const it of items) {
      counts[it.status]++;
      if (
        it.status === 'pending' &&
        (counts.oldestPendingQueuedAt === null || it.queuedAt < counts.oldestPendingQueuedAt)
      ) {
        counts.oldestPendingQueuedAt = it.queuedAt;
      }
    }
    return counts;
  }

  /**
   * Housekeeping pass over the whole queue (#914). One read of the
   * directory does three things:
   *
   *   1. A `claimed` item whose claim is older than `claimTimeoutMs` goes
   *      back to `pending` — the agent that claimed it died or forgot to
   *      call process/skip, and nothing else would ever release it.
   *   2. A `pending`/`claimed` item queued longer ago than `maxItemAgeMs`
   *      moves to `<root>/dead-letter/<id>.json` with `expiredAt` +
   *      `expireReason`. Never deleted; one warn line per item.
   *   3. Reports the remaining pending backlog per vault (count + oldest
   *      `queuedAt`) so the caller can alert on stale vaults and on items
   *      whose vault is not discovered.
   *
   * Processed/skipped items are left alone (they are the audit trail).
   *
   * @param opts - Clock and age thresholds (defaults from WIKI_QUEUE_CONSTANTS)
   * @returns Expired items, released claim ids and per-vault backlog
   *
   * @example
   * ```typescript
   * const { expired, backlog } = await WikiQueueService.getInstance().sweep();
   * ```
   */
  async sweep(opts: WikiQueueSweepOptions = {}): Promise<WikiQueueSweepResult> {
    const now = opts.now ?? Date.now();
    const maxAge = opts.maxItemAgeMs ?? WIKI_QUEUE_CONSTANTS.MAX_ITEM_AGE_MS;
    const claimTimeout = opts.claimTimeoutMs ?? WIKI_QUEUE_CONSTANTS.CLAIM_TIMEOUT_MS;
    const result: WikiQueueSweepResult = { expired: [], releasedClaims: [], backlog: [] };
    const backlog = new Map<string, WikiQueueVaultBacklog>();

    for (const item of await this.readAll()) {
      if (item.status !== 'pending' && item.status !== 'claimed') continue;
      const queuedMs = Date.parse(item.queuedAt);
      if (Number.isFinite(queuedMs) && now - queuedMs > maxAge) {
        await this.deadLetter(item, now, queuedMs);
        result.expired.push(item);
        continue;
      }
      let current = item;
      if (item.status === 'claimed') {
        const claimedMs = Date.parse(item.claimedAt ?? '');
        if (Number.isFinite(claimedMs) && now - claimedMs <= claimTimeout) continue;
        current = { ...item, status: 'pending', claimedBy: undefined, claimedAt: undefined };
        await this.writeItem(current);
        result.releasedClaims.push(item.id);
        this.logger.warn('WikiQueue claim released — claimant never processed or skipped it', {
          id: item.id,
          vaultPath: item.vaultPath,
          claimedBy: item.claimedBy,
          claimedAt: item.claimedAt,
        });
      }
      const vaultPath = normalizeVaultPath(current.vaultPath);
      const entry = backlog.get(vaultPath);
      if (!entry) {
        backlog.set(vaultPath, { vaultPath, pending: 1, oldestQueuedAt: current.queuedAt });
      } else {
        entry.pending++;
        if (current.queuedAt < entry.oldestQueuedAt) entry.oldestQueuedAt = current.queuedAt;
      }
    }
    result.backlog = [...backlog.values()].sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));
    if (result.expired.length > 0 || result.releasedClaims.length > 0) {
      this.logger.warn('WikiQueue sweep', {
        expired: result.expired.length,
        releasedClaims: result.releasedClaims.length,
        deadLetterDir: this.getDeadLetterDir(),
      });
    }
    return result;
  }

  /**
   * Folder that holds expired items.
   *
   * @returns Absolute path of the dead-letter folder
   */
  getDeadLetterDir(): string {
    return path.join(this.rootDir, WIKI_QUEUE_CONSTANTS.DEAD_LETTER_DIR);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private validateAddInput(input: WikiQueueAddInput): void {
    if (!input.vaultPath || !path.isAbsolute(input.vaultPath)) {
      throw new Error('WikiQueue.add: vaultPath must be absolute');
    }
    if (!input.queuedBy) throw new Error('WikiQueue.add: queuedBy is required');
    if (!input.sourceType) throw new Error('WikiQueue.add: sourceType is required');
    if (!input.sourceRef) throw new Error('WikiQueue.add: sourceRef is required');
    const content = input.content ?? '';
    if (content.trim().length === 0) {
      throw new Error('WikiQueue.add: content is empty');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new Error(`WikiQueue.add: content exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    const reason = input.reason ?? '';
    if (reason.trim().length === 0) {
      throw new Error(
        'WikiQueue.add: reason is required — agents MUST justify why this is wiki-worthy',
      );
    }
    if (Buffer.byteLength(reason, 'utf8') > MAX_REASON_BYTES) {
      throw new Error(`WikiQueue.add: reason exceeds ${MAX_REASON_BYTES} bytes`);
    }
  }

  /**
   * Read every well-formed item in the queue root (not the dead-letter
   * folder — `readdir` is not recursive).
   *
   * @returns All items, unsorted
   */
  private async readAll(): Promise<WikiQueueItem[]> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const items: WikiQueueItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const item = await this.readItemFile(path.join(this.rootDir, entry.name));
      if (item) items.push(item);
    }
    return items;
  }

  /**
   * Move one item to the dead-letter folder, stamped with why. Written
   * there first, then removed from the queue, so a crash in between
   * leaves a duplicate rather than a loss.
   *
   * @param item - Item to expire
   * @param now - Current epoch ms
   * @param queuedMs - Item's `queuedAt` in epoch ms
   */
  private async deadLetter(item: WikiQueueItem, now: number, queuedMs: number): Promise<void> {
    const ageDays = Math.floor((now - queuedMs) / MS_PER_DAY);
    const expired: WikiQueueItem = {
      ...item,
      expiredAt: new Date(now).toISOString(),
      expireReason: `still ${item.status} after ${ageDays} days`,
    };
    const dir = this.getDeadLetterDir();
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${item.id}.json`);
    await fs.writeFile(`${target}.tmp`, JSON.stringify(expired, null, 2), 'utf8');
    await fs.rename(`${target}.tmp`, target);
    await fs.rm(path.join(this.rootDir, `${item.id}.json`), { force: true });
    this.logger.warn('WikiQueue item expired to dead-letter', {
      id: item.id,
      vaultPath: item.vaultPath,
      status: item.status,
      queuedAt: item.queuedAt,
      ageDays,
      file: target,
    });
  }

  private async ensureRoot(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = (async () => {
      if (!existsSync(this.rootDir)) {
        await fs.mkdir(this.rootDir, { recursive: true });
      }
    })();
    await this.initPromise;
  }

  private async writeItem(item: WikiQueueItem): Promise<void> {
    const file = path.join(this.rootDir, `${item.id}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(item, null, 2), 'utf8');
    await fs.rename(tmp, file); // atomic on the same filesystem
  }

  private async readItemFile(file: string): Promise<WikiQueueItem | null> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as WikiQueueItem;
      // Soft validation — discard rows that don't match the shape we own.
      if (!parsed.id || !parsed.status || !parsed.queuedAt) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async requireItem(id: string): Promise<WikiQueueItem> {
    const item = await this.get(id);
    if (!item) throw new Error(`WikiQueue: item not found: ${id}`);
    return item;
  }
}
