/**
 * Where each shared channel has been read up to: one small JSON file
 * (`linkId` → id of the last message mirrored).
 *
 * @module services/shared-channel/shared-channel-cursor.store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/** Persistent per-link cursors. Never throws. */
export class SharedChannelCursorStore {
  private data: Record<string, string> | null = null;

  /** @param file - Absolute path of the JSON file */
  constructor(private readonly file: string) {}

  /** @param dir - Directory that holds the file (e.g. `~/.crewly`) */
  static inDir(dir: string, fileName: string): SharedChannelCursorStore {
    return new SharedChannelCursorStore(join(dir, fileName));
  }

  private load(): Record<string, string> {
    if (this.data) return this.data;
    let parsed: Record<string, string> = {};
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string' && v) parsed[k] = v;
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
   * @returns The last mirrored message id, if any
   */
  get(linkId: string): string | undefined {
    return this.load()[linkId];
  }

  /**
   * @param linkId - Link id
   * @param messageId - The last message mirrored
   */
  set(linkId: string, messageId: string): void {
    const data = this.load();
    if (data[linkId] === messageId) return;
    data[linkId] = messageId;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Best effort: the chat row dedupe makes a re-read harmless.
    }
  }
}
