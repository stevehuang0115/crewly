/**
 * Durable store of signal digests (#987, specs/2026-10-03-signal-digest.md).
 *
 * One JSON file under CREWLY_HOME with a monotonically increasing id counter,
 * so `SD-3` is never reused. All writes are serialised and atomic. Digests
 * untouched for {@link SIGNAL_DIGEST_CONSTANTS.KEEP_MS} are pruned.
 *
 * @module services/signal-digest/signal-digest-store
 */

import * as path from 'path';
import { SIGNAL_DIGEST_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import type { SignalDigest, SignalSiteSources } from '../../types/signal-digest.types.js';

/** On-disk shape. */
interface DigestFile {
  nextId: number;
  digests: SignalDigest[];
  /** Latest source report per site (key: lower-cased site) */
  siteSources: Record<string, SignalSiteSources>;
}

/**
 * Store key of a site.
 *
 * @param site - Site
 * @returns Lower-cased, trimmed
 */
function siteKey(site: string): string {
  return site.trim().toLowerCase();
}

/**
 * Deep copy (digests hold nested item arrays).
 *
 * @param d - Digest
 * @returns Independent copy
 */
function copy(d: SignalDigest): SignalDigest {
  return JSON.parse(JSON.stringify(d)) as SignalDigest;
}

/**
 * Persistent digest store.
 */
export class SignalDigestStore {
  private data: DigestFile | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath - JSON file
   * @param now - Clock (tests)
   */
  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Store under a CREWLY_HOME.
   *
   * @param crewlyHome - CREWLY_HOME
   * @returns The store
   */
  static inHome(crewlyHome: string): SignalDigestStore {
    return new SignalDigestStore(path.join(crewlyHome, SIGNAL_DIGEST_CONSTANTS.STORE_FILENAME));
  }

  /**
   * Add a digest, assigning its id.
   *
   * @param draft - Digest without id/timestamps
   * @returns The stored digest
   */
  async create(draft: Omit<SignalDigest, 'id' | 'createdAt' | 'updatedAt'>): Promise<SignalDigest> {
    return this.serial(async () => {
      const data = await this.load();
      const at = this.now().toISOString();
      const digest: SignalDigest = { ...copy(draft as SignalDigest), id: `${SIGNAL_DIGEST_CONSTANTS.ID_PREFIX}${data.nextId}`, createdAt: at, updatedAt: at };
      data.nextId += 1;
      data.digests.push(digest);
      await this.save();
      return copy(digest);
    });
  }

  /**
   * Change a digest under the write lock.
   *
   * @param id - Digest id
   * @param fn - Gets a copy; returns the new digest, or null to leave it alone
   * @returns The updated digest, or null when missing / unchanged
   */
  async update(id: string, fn: (d: SignalDigest) => SignalDigest | null): Promise<SignalDigest | null> {
    return this.serial(async () => {
      const data = await this.load();
      const idx = data.digests.findIndex((d) => d.id === id);
      if (idx < 0) return null;
      const next = fn(copy(data.digests[idx]));
      if (!next) return null;
      const stored: SignalDigest = { ...next, id, updatedAt: this.now().toISOString() };
      data.digests[idx] = stored;
      await this.save();
      return copy(stored);
    });
  }

  /**
   * One digest.
   *
   * @param id - Digest id
   * @returns Copy, or null
   */
  async get(id: string): Promise<SignalDigest | null> {
    const data = await this.load();
    const d = data.digests.find((x) => x.id === id);
    return d ? copy(d) : null;
  }

  /**
   * All digests, newest first, optionally filtered.
   *
   * @param filter - Predicate
   * @returns Copies
   */
  async list(filter?: (d: SignalDigest) => boolean): Promise<SignalDigest[]> {
    const data = await this.load();
    return data.digests
      .filter((d) => !filter || filter(d))
      .map(copy)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id, undefined, { numeric: true }));
  }

  /**
   * A site's latest source report.
   *
   * @param site - Site
   * @returns Copy, or null when none was reported
   */
  async getSiteSources(site: string): Promise<SignalSiteSources | null> {
    const data = await this.load();
    const s = data.siteSources[siteKey(site)];
    return s ? (JSON.parse(JSON.stringify(s)) as SignalSiteSources) : null;
  }

  /**
   * Change a site's source report under the write lock.
   *
   * @param site - Site
   * @param fn - Gets a copy (null when none); returns the new report
   * @returns The stored report
   */
  async updateSiteSources(site: string, fn: (cur: SignalSiteSources | null) => SignalSiteSources): Promise<SignalSiteSources> {
    return this.serial(async () => {
      const data = await this.load();
      const key = siteKey(site);
      const cur = data.siteSources[key];
      const next = fn(cur ? (JSON.parse(JSON.stringify(cur)) as SignalSiteSources) : null);
      data.siteSources[key] = next;
      await this.save();
      return JSON.parse(JSON.stringify(next)) as SignalSiteSources;
    });
  }

  /**
   * Drop digests with nothing open that were last changed before the keep window.
   *
   * @returns How many were dropped
   */
  async prune(): Promise<number> {
    return this.serial(async () => {
      const data = await this.load();
      const cutoff = this.now().getTime() - SIGNAL_DIGEST_CONSTANTS.KEEP_MS;
      const before = data.digests.length;
      data.digests = data.digests.filter((d) => d.items.some((i) => i.status === 'open') || Date.parse(d.updatedAt) >= cutoff);
      const dropped = before - data.digests.length;
      if (dropped > 0) await this.save();
      return dropped;
    });
  }

  private async load(): Promise<DigestFile> {
    if (this.data) return this.data;
    const raw = await safeReadJson<Partial<DigestFile>>(this.filePath, {});
    const digests = Array.isArray(raw.digests) ? raw.digests : [];
    const maxId = digests.reduce((m, d) => Math.max(m, Number(String(d.id).replace(SIGNAL_DIGEST_CONSTANTS.ID_PREFIX, '')) || 0), 0);
    const siteSources = raw.siteSources && typeof raw.siteSources === 'object' && !Array.isArray(raw.siteSources) ? raw.siteSources : {};
    this.data = { nextId: Math.max(Number(raw.nextId) || 1, maxId + 1), digests, siteSources };
    return this.data;
  }

  private async save(): Promise<void> {
    if (this.data) await atomicWriteJson(this.filePath, this.data);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
