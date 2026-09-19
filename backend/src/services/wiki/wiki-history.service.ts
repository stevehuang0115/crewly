/**
 * WikiHistoryService — per-page revision history (who changed what).
 *
 * Before a page is overwritten, superseded, accepted from a proposal, or
 * deleted, its previous content is snapshotted to
 * `<vault>/.wiki-history/<page path>/<ISO>.md` together with the author.
 * That gives multi-writer vaults (several teachers, several agents) an
 * audit trail without depending on the vault living in a git repository.
 * Capped per page; oldest snapshots roll off.
 *
 * @module services/wiki/wiki-history.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { WIKI_KB_CONSTANTS } from '../../constants.js';

/** One snapshot. */
export interface WikiRevision {
  at: string;
  /** Who made the change that replaced this content. */
  author: string;
  /** `write` | `supersede` | `accept_proposal` | `delete` */
  action: string;
  bytes: number;
  file: string;
}

/**
 * Snapshots prior page content under `.wiki-history/`.
 */
export class WikiHistoryService {
  private static instance: WikiHistoryService | null = null;
  private readonly logger: ComponentLogger;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiHistory');
  }

  static getInstance(): WikiHistoryService {
    if (!this.instance) this.instance = new WikiHistoryService();
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Snapshot the current content of a page before it changes. No-op when
   * the page does not exist yet. Never throws.
   *
   * @param vaultPath - Vault root
   * @param relativePath - Vault-relative page path
   * @param author - Session/user making the change
   * @param action - What is about to happen
   * @returns The revision written, or null
   */
  async snapshot(vaultPath: string, relativePath: string, author: string, action: string): Promise<WikiRevision | null> {
    const abs = path.join(vaultPath, relativePath);
    if (!existsSync(abs)) return null;
    try {
      const content = await fs.readFile(abs, 'utf8');
      const dir = this.historyDir(vaultPath, relativePath);
      await fs.mkdir(dir, { recursive: true });
      const at = this.now().toISOString();
      const file = path.join(dir, `${at.replace(/[:.]/g, '-')}.md`);
      const meta = `<!-- crewly-wiki-history author=${JSON.stringify(author)} action=${action} at=${at} -->\n`;
      await fs.writeFile(file, meta + content, 'utf8');
      await this.prune(dir);
      return { at, author, action, bytes: Buffer.byteLength(content, 'utf8'), file };
    } catch (err) {
      this.logger.debug('history snapshot failed (non-fatal)', { relativePath, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * List revisions of a page, newest first.
   *
   * @param vaultPath - Vault root
   * @param relativePath - Vault-relative page path
   * @returns Revisions
   */
  async list(vaultPath: string, relativePath: string): Promise<WikiRevision[]> {
    const dir = this.historyDir(vaultPath, relativePath);
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort().reverse();
    } catch {
      return [];
    }
    const out: WikiRevision[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const raw = await fs.readFile(file, 'utf8');
        const m = raw.match(/^<!-- crewly-wiki-history author=(".*?") action=(\S+) at=(\S+) -->\n/);
        out.push({
          at: m ? m[3] : '',
          author: m ? (JSON.parse(m[1]) as string) : 'unknown',
          action: m ? m[2] : 'unknown',
          bytes: Buffer.byteLength(raw, 'utf8') - (m ? m[0].length : 0),
          file,
        });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /**
   * Read one revision's content (meta line stripped).
   *
   * @param file - Absolute snapshot file (from {@link list})
   * @returns Content
   */
  async read(file: string): Promise<string> {
    const raw = await fs.readFile(file, 'utf8');
    return raw.replace(/^<!-- crewly-wiki-history [^\n]* -->\n/, '');
  }

  private historyDir(vaultPath: string, relativePath: string): string {
    return path.join(vaultPath, WIKI_KB_CONSTANTS.HISTORY_DIR, relativePath.replace(/\\/g, '/'));
  }

  private async prune(dir: string): Promise<void> {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
    const excess = names.length - WIKI_KB_CONSTANTS.HISTORY_MAX_REVISIONS;
    for (let i = 0; i < excess; i++) await fs.unlink(path.join(dir, names[i])).catch(() => undefined);
  }
}
