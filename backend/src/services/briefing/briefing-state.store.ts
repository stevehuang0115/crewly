/**
 * Briefing state store: what Drive mode remembers per item — hidden until
 * (next / later), a pending lookup, the agent's answer to it — in
 * `<crewlyHome>/briefing-state.json` (specs/2026-10-08-drive-mode.md).
 *
 * Owner answers are never stored here: they go straight to the card or the
 * thread. The owner's follow-up *question* is kept while the agent looks it
 * up, so the briefer can say what was asked when the answer comes back.
 *
 * @module services/briefing/briefing-state.store
 */

import * as fs from 'fs';
import * as path from 'path';
import { BRIEFING_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import type { BriefingItemState, BriefingStateFile } from './briefing.types.js';

/** Read / write the briefing state. Writes are serialised. */
export class BriefingStateStore {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath - State file; default `<crewlyHome>/briefing-state.json` (resolved per call)
   */
  constructor(private readonly filePath?: string) {}

  /** @returns Absolute path of the state file */
  getFilePath(): string {
    return this.filePath ?? path.join(getCrewlyHomePath(), BRIEFING_CONSTANTS.STATE_FILENAME);
  }

  /**
   * The whole state (empty when missing or unreadable).
   *
   * @returns State
   */
  async read(): Promise<BriefingStateFile> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.getFilePath(), 'utf8')) as Partial<BriefingStateFile>;
      if (raw && raw.version === 1 && raw.items && typeof raw.items === 'object') return { version: 1, items: raw.items };
    } catch {
      // missing or unreadable: start empty
    }
    return { version: 1, items: {} };
  }

  /**
   * Change one item's state. `fn` returns the new state, or null to forget it.
   *
   * @param id - Item id
   * @param fn - Updater
   * @returns The new state (null when forgotten)
   */
  update(id: string, fn: (cur: BriefingItemState) => BriefingItemState | null): Promise<BriefingItemState | null> {
    const run = this.chain.then(async () => {
      const state = await this.read();
      const next = fn(state.items[id] ?? {});
      if (next && Object.keys(next).length > 0) state.items[id] = next;
      else delete state.items[id];
      await this.write(state);
      return next;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Drop the state of items that no longer exist.
   *
   * @param keep - Ids still in the queue (or pending)
   */
  prune(keep: ReadonlySet<string>): Promise<void> {
    const run = this.chain.then(async () => {
      const state = await this.read();
      const stale = Object.keys(state.items).filter((id) => !keep.has(id));
      if (stale.length === 0) return;
      for (const id of stale) delete state.items[id];
      await this.write(state);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async write(state: BriefingStateFile): Promise<void> {
    const file = this.getFilePath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  }
}
