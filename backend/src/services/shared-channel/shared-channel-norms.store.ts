/**
 * Local store of per-link shared-channel norms (crewly#1543 slice 6): one
 * small JSON file under the Crewly home directory, `linkId` →
 * {@link SharedChannelNorm}. Only the owner writes it (REST, or "Send and
 * always allow" on a held card).
 *
 * @module services/shared-channel/shared-channel-norms.store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import { EMPTY_NORM, normalizeAllowances, type SharedChannelNorm, type SharedNormAllowance, type SharedNormUpdate } from './shared-channel-norms.js';

/** Persistent per-link norms. Reads never throw. */
export class SharedChannelNormsStore {
  private data: Record<string, SharedChannelNorm> | null = null;

  /**
   * @param file - Absolute path of the JSON file
   * @param now - Clock (tests)
   */
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * @param dir - Directory that holds the file (e.g. `~/.crewly`)
   * @param fileName - File name
   * @returns A store for `<dir>/<fileName>`
   */
  static inDir(dir: string, fileName: string): SharedChannelNormsStore {
    return new SharedChannelNormsStore(join(dir, fileName));
  }

  private load(): Record<string, SharedChannelNorm> {
    if (this.data) return this.data;
    const parsed: Record<string, SharedChannelNorm> = {};
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
            const r = v as Record<string, unknown>;
            parsed[k] = {
              norm: typeof r.norm === 'string' ? r.norm.slice(0, SHARED_CHANNEL_CONSTANTS.NORM_MAX_CHARS) : '',
              allow: Array.isArray(r.allow) ? normalizeAllowances(r.allow) : [],
              updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
            };
          }
        }
      }
    } catch {
      // A corrupt file means no norms: every internal message is held again, never loosened.
    }
    this.data = parsed;
    return parsed;
  }

  /**
   * @param linkId - Link id
   * @returns The link's norm (an empty one when unset)
   */
  get(linkId: string): SharedChannelNorm {
    const n = this.load()[linkId];
    return n ? { ...n, allow: [...n.allow] } : { ...EMPTY_NORM, allow: [] };
  }

  /**
   * Apply an owner's change. Fields left out are kept.
   *
   * @param linkId - Link id
   * @param update - New norm text and/or allowances
   * @returns The norm before and after
   * @throws When the file cannot be written (the change is not kept)
   */
  set(linkId: string, update: SharedNormUpdate): { before: SharedChannelNorm; after: SharedChannelNorm } {
    const before = this.get(linkId);
    const after: SharedChannelNorm = {
      norm: update.norm ?? before.norm,
      allow: update.allow ? normalizeAllowances(update.allow) : before.allow,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const next = { ...this.load(), [linkId]: after };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.data = next;
    return { before, after: { ...after, allow: [...after.allow] } };
  }

  /**
   * Add allowances to a link (the card's "Send and always allow").
   *
   * @param linkId - Link id
   * @param keys - Allowances to add
   * @returns The norm before and after
   * @throws When the file cannot be written
   */
  addAllowances(linkId: string, keys: readonly SharedNormAllowance[]): { before: SharedChannelNorm; after: SharedChannelNorm } {
    const current = this.get(linkId);
    return this.set(linkId, { allow: [...current.allow, ...keys] });
  }
}
