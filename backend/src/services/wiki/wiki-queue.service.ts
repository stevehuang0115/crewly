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
}

export interface WikiQueueStats {
  pending: number;
  claimed: number;
  processed: number;
  skipped: number;
  total: number;
}

const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_REASON_BYTES = 2 * 1024;

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
      vaultPath: input.vaultPath,
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

  /** List items, newest-first, optionally filtered. */
  async list(filter: WikiQueueListFilter = {}): Promise<WikiQueueItem[]> {
    await this.ensureRoot();
    const limit = filter.limit ?? 50;
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const items: WikiQueueItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const item = await this.readItemFile(path.join(this.rootDir, entry.name));
      if (!item) continue;
      if (filter.vaultPath && item.vaultPath !== filter.vaultPath) continue;
      if (filter.status && item.status !== filter.status) continue;
      if (filter.queuedBy && item.queuedBy !== filter.queuedBy) continue;
      items.push(item);
    }
    items.sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1));
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
    };
    for (const it of items) {
      counts[it.status]++;
    }
    return counts;
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
