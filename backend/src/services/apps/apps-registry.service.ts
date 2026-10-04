/**
 * AppsRegistryService — the apps this instance published, kept in
 * `<CREWLY_HOME>/apps/registry.json`.
 *
 * It answers two questions: which app an agent's publish goes to (so the
 * same agent republishing the same directory lands on the same app), and
 * which agent to wake when an app changes. It also keeps each app's change
 * cursor for the poller (specs/2026-10-04-crewly-apps-p2.md §2, §5).
 *
 * @module services/apps/apps-registry.service
 */

import { promises as fs } from 'fs';
import path from 'path';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';

/** One app this instance published. */
export interface AppRegistryEntry {
  appId: string;
  name: string;
  url: string;
  /** The agent woken for this app's changes (the last publisher); null = orchestrator */
  agentSession: string | null;
  /** Absolute source directory or file it was published from */
  source: string | null;
  currentVersion: number | null;
  /** Last change seq handled by the poller; null until it first reads the head */
  cursor: number | null;
  createdAt: string;
  updatedAt: string;
  /** Gone from Cloud (404): no longer polled */
  deleted?: boolean;
  /** Last successful wake per recipient (session, or the orchestrator key), epoch ms: the cooldown survives a restart */
  wakes?: Record<string, number>;
  /** Seqs above `cursor` already delivered (another batch for this app is still pending): skipped when re-read */
  delivered?: number[];
  /** Visitor-triggered wakes on a UTC day, and visitor submissions not delivered over the daily cap (P3 §3) */
  visitorWakes?: VisitorWakeState;
}

/** The daily cap on visitor-triggered wakes (P3 §3). */
export interface VisitorWakeState {
  /** UTC day `YYYY-MM-DD` that `count` belongs to */
  day: string;
  /** Visitor-triggered wakes delivered that day */
  count: number;
  /** Visitor submissions counted but not delivered (over the cap), not yet reported to the agent */
  skipped: number;
}

interface RegistryFile {
  apps: Record<string, AppRegistryEntry>;
}

/** What to look an app up by when publishing. */
export interface AppLookup {
  appId?: string;
  agentSession?: string | null;
  source?: string | null;
  name?: string | null;
}

/**
 * File-backed registry. All writes are serialised in-process.
 */
export class AppsRegistryService {
  private readonly file: string;
  private data: RegistryFile | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param crewlyHome - CREWLY_HOME directory
   */
  constructor(crewlyHome: string) {
    this.file = path.join(crewlyHome, CREWLY_APPS_CONSTANTS.REGISTRY_DIR, CREWLY_APPS_CONSTANTS.REGISTRY_FILE);
  }

  private async load(): Promise<RegistryFile> {
    if (!this.data) {
      const raw = await safeReadJson<RegistryFile>(this.file, { apps: {} });
      this.data = raw && typeof raw === 'object' && raw.apps && typeof raw.apps === 'object' ? raw : { apps: {} };
    }
    return this.data;
  }

  private mutate<T>(fn: (d: RegistryFile) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const d = await this.load();
      const out = fn(d);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await atomicWriteJson(this.file, d);
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Every app, deleted ones included.
   *
   * @returns Copies of the entries
   */
  async list(): Promise<AppRegistryEntry[]> {
    const d = await this.load();
    return Object.values(d.apps).map((e) => ({ ...e }));
  }

  /**
   * One app by id.
   *
   * @param appId - App id
   * @returns A copy, or null
   */
  async get(appId: string): Promise<AppRegistryEntry | null> {
    const d = await this.load();
    const e = d.apps[appId];
    return e ? { ...e } : null;
  }

  /**
   * The app a publish should go to: explicit id; else the same agent and
   * source; else the same agent and name (case-insensitive). Deleted apps
   * never match implicitly.
   *
   * @param q - Lookup keys
   * @returns The entry, or null (create a new app)
   */
  async find(q: AppLookup): Promise<AppRegistryEntry | null> {
    const d = await this.load();
    if (q.appId) return d.apps[q.appId] ? { ...d.apps[q.appId] } : null;
    const mine = Object.values(d.apps).filter((e) => !e.deleted && (e.agentSession ?? null) === (q.agentSession ?? null));
    if (q.source) {
      const bySource = mine.find((e) => e.source === q.source);
      if (bySource) return { ...bySource };
    }
    if (q.name) {
      const n = q.name.trim().toLowerCase();
      const byName = mine.find((e) => e.name.trim().toLowerCase() === n);
      if (byName) return { ...byName };
    }
    return null;
  }

  /**
   * Insert or update an entry (fields given replace the stored ones).
   *
   * @param appId - App id
   * @param patch - Fields to set
   * @returns The stored entry
   */
  upsert(appId: string, patch: Partial<Omit<AppRegistryEntry, 'appId'>>): Promise<AppRegistryEntry> {
    return this.mutate((d) => {
      const now = new Date().toISOString();
      const prev = d.apps[appId];
      const next: AppRegistryEntry = {
        appId,
        name: patch.name ?? prev?.name ?? appId,
        url: patch.url ?? prev?.url ?? `${CREWLY_APPS_CONSTANTS.APPS_ORIGIN}/${appId}`,
        agentSession: patch.agentSession !== undefined ? patch.agentSession : prev?.agentSession ?? null,
        source: patch.source !== undefined ? patch.source : prev?.source ?? null,
        currentVersion: patch.currentVersion !== undefined ? patch.currentVersion : prev?.currentVersion ?? null,
        cursor: patch.cursor !== undefined ? patch.cursor : prev?.cursor ?? null,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        ...(patch.deleted !== undefined ? { deleted: patch.deleted } : prev?.deleted ? { deleted: prev.deleted } : {}),
        ...(prev?.wakes ? { wakes: prev.wakes } : {}),
        ...(prev?.visitorWakes ? { visitorWakes: prev.visitorWakes } : {}),
        ...(prev?.delivered && patch.cursor === undefined ? { delivered: prev.delivered } : {}),
      };
      d.apps[appId] = next;
      return { ...next };
    });
  }

  /**
   * Store the poller's progress: the cursor and the seqs above it that were
   * already delivered (no-op for an unknown app or no change).
   *
   * @param appId - App id
   * @param cursor - Safe cursor (before every undelivered change)
   * @param delivered - Delivered seqs above the cursor
   */
  async setProgress(appId: string, cursor: number, delivered: number[]): Promise<void> {
    const current = (await this.load()).apps[appId];
    if (!current) return;
    const sorted = [...delivered].filter((n) => n > cursor).sort((a, b) => a - b);
    const same = current.cursor === cursor && JSON.stringify(current.delivered ?? []) === JSON.stringify(sorted);
    if (same) return;
    await this.mutate((d) => {
      const e = d.apps[appId];
      if (!e) return;
      e.cursor = cursor;
      if (sorted.length > 0) e.delivered = sorted;
      else delete e.delivered;
    });
  }

  /**
   * Record a successful wake for the cooldown.
   *
   * @param appId - App id
   * @param recipient - Session or orchestrator key
   * @param at - Epoch ms
   */
  async setLastWake(appId: string, recipient: string, at: number): Promise<void> {
    await this.mutate((d) => {
      const e = d.apps[appId];
      if (e) e.wakes = { ...(e.wakes ?? {}), [recipient]: at };
    });
  }

  /**
   * Store the visitor-wake cap state (P3 §3).
   *
   * @param appId - App id
   * @param state - Day, wakes that day, submissions skipped and not yet reported
   */
  async setVisitorWakes(appId: string, state: VisitorWakeState): Promise<void> {
    await this.mutate((d) => {
      const e = d.apps[appId];
      if (e) e.visitorWakes = { day: state.day, count: state.count, skipped: state.skipped };
    });
  }

  /**
   * Mark an app gone from Cloud.
   *
   * @param appId - App id
   */
  async markDeleted(appId: string): Promise<void> {
    await this.mutate((d) => {
      const e = d.apps[appId];
      if (e) {
        e.deleted = true;
        e.updatedAt = new Date().toISOString();
      }
    });
  }
}
