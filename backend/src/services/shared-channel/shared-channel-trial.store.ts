/**
 * The trial period of each shared-channel link (crewly#1543, owner decision
 * 2026-11-10): how many agent messages the owner has approved on it. Until
 * that reaches `SHARED_CHANNEL_CONSTANTS.TRIAL_HELD_SENDS`, every agent
 * message on the link is held. One small JSON file, `linkId` → count.
 *
 * @module services/shared-channel/shared-channel-trial.store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/** Persistent per-link approved-send counts. Never throws. */
export class SharedChannelTrialStore {
  private data: Record<string, number> | null = null;

  /** @param file - Absolute path of the JSON file */
  constructor(private readonly file: string) {}

  /**
   * @param dir - Directory that holds the file (e.g. `~/.crewly`)
   * @param fileName - File name
   * @returns A store for `<dir>/<fileName>`
   */
  static inDir(dir: string, fileName: string): SharedChannelTrialStore {
    return new SharedChannelTrialStore(join(dir, fileName));
  }

  private load(): Record<string, number> {
    if (this.data) return this.data;
    let parsed: Record<string, number> = {};
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v) && v > 0) parsed[k] = Math.floor(v);
          }
        }
      }
    } catch {
      parsed = {};
    }
    this.data = parsed;
    return parsed;
  }

  /**
   * @param linkId - Link id
   * @returns Agent messages the owner approved on the link so far
   */
  approvedCount(linkId: string): number {
    return this.load()[linkId] ?? 0;
  }

  /**
   * Count one more owner-approved send on a link.
   *
   * @param linkId - Link id
   * @returns The new count
   */
  noteApproved(linkId: string): number {
    const data = this.load();
    data[linkId] = (data[linkId] ?? 0) + 1;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Best effort: a lost count only means one more message is held.
    }
    return data[linkId]!;
  }
}
