/**
 * Wiki record attach — puts the records an agent already holds in front of
 * it when a message arrives, instead of relying on the agent to look.
 *
 * Why: on 2026-11-19 a sales agent answered the owner about a customer in
 * nine seconds without reading that customer's record (a meeting on 10/9, a
 * proposal sent on 10/13), and proposed what had already been done. The
 * prompt already said "research the customer first"; the rule was skipped
 * because the question read as a general one. A record that has to be
 * remembered to be read is not a memory.
 *
 * How: wiki pages under the entity folders (`customers/`, `people/`,
 * `projects/`, `products/`) carry `aliases` in their front-matter. When a
 * person's message is about to be delivered, the names in the message and
 * its thread are matched literally against those aliases (no model call),
 * and the matching pages are attached to the delivered copy, clipped.
 *
 * Who may see what: a page's `visibility` (roles) and `visible_to_people`
 * are honoured for the receiving agent. A page restricted to people is
 * attached only in a private conversation with the owner; anywhere else the
 * agent gets one line saying a restricted record exists, never its content.
 *
 * @module services/wiki/wiki-record-attach.service
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { WIKI_RECORD_ATTACH_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { isVisibleTo, oneLine, parsePage, type WikiPageFrontmatter } from './wiki-page.js';

/** An entity page as indexed for matching. */
export interface EntityPage {
  vaultPath: string;
  /** Vault-relative path, e.g. `llm-curated/customers/robohub.md` */
  relativePath: string;
  title: string;
  summary: string;
  /** Names the entity goes by, as written; the title is always one of them */
  aliases: string[];
  frontmatter: Partial<WikiPageFrontmatter>;
  body: string;
  updated?: string;
}

/** A page matched in a text, with the names that matched. */
export interface EntityMatch {
  page: EntityPage;
  matched: string[];
  /** Total occurrences of its names in the text */
  count: number;
}

/** What the delivery path asks for. */
export interface AttachRequest {
  /** The agent the message is delivered to */
  agentSession: string;
  /** The message plus the thread around it */
  text: string;
  /** Vaults the agent reads from */
  vaultPaths: readonly string[];
  /** The agent's role, for `visibility` */
  viewerRole?: string;
  /** True in a private conversation with the owner (restricted pages may be shown) */
  ownerOnlyAudience: boolean;
}

/** Dependencies (all optional; tests override). */
export interface WikiRecordAttachDeps {
  now?: () => number;
  /** Records what was attached (the wiki usage ledger). Must not throw. */
  recordUsage?: (vaultPath: string, event: { via: string; agent: string; query: string; hits: string[]; miss: boolean }) => void;
}

/** CJK scripts are written without spaces: a name is matched as a substring. */
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/**
 * Escape a string for use inside a RegExp.
 *
 * @param value - Raw text
 * @returns The escaped text
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count the occurrences of a name in a text. A name in Latin letters must
 * stand as a whole word ("Xin" does not match "taxing"); a CJK name is a
 * substring. Names shorter than the configured minimum never match.
 *
 * @param text - Text to search
 * @param alias - A name of the entity
 * @returns Number of occurrences
 */
export function countAlias(text: string, alias: string): number {
  const name = alias.trim();
  if (!name) return 0;
  const cjk = CJK.test(name);
  const min = cjk ? WIKI_RECORD_ATTACH_CONSTANTS.MIN_ALIAS_CHARS_CJK : WIKI_RECORD_ATTACH_CONSTANTS.MIN_ALIAS_CHARS;
  if (name.length < min) return 0;
  const pattern = cjk
    ? new RegExp(escapeRegExp(name), 'giu')
    : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu');
  return (text.match(pattern) ?? []).length;
}

/**
 * Match entity pages against a text.
 *
 * @param text - The message and its thread
 * @param pages - Candidate pages
 * @returns Pages with at least one name in the text, most mentioned first
 */
export function matchEntities(text: string, pages: readonly EntityPage[]): EntityMatch[] {
  const matches: EntityMatch[] = [];
  for (const page of pages) {
    const matched: string[] = [];
    let count = 0;
    for (const alias of page.aliases) {
      const n = countAlias(text, alias);
      if (n > 0) {
        matched.push(alias);
        count += n;
      }
    }
    if (count > 0) matches.push({ page, matched, count });
  }
  return matches.sort((a, b) => b.count - a.count || a.page.relativePath.localeCompare(b.page.relativePath));
}

/**
 * Read the names of an entity from its front-matter.
 *
 * @param fm - Page front-matter
 * @returns The title plus `aliases`, de-duplicated, as written
 */
export function aliasesOf(fm: Partial<WikiPageFrontmatter>): string[] {
  const raw = fm['aliases'];
  const listed = Array.isArray(raw) ? raw.map((v) => String(v)) : typeof raw === 'string' ? raw.split(',') : [];
  const names = [typeof fm.title === 'string' ? fm.title : '', ...listed].map((n) => n.trim()).filter((n) => n.length > 0);
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Render the block attached to the delivered copy of a message.
 *
 * @param shown - Pages the agent may read, in order
 * @param restricted - Number of matching pages withheld from this conversation
 * @returns The block, or '' when there is nothing to say
 */
export function renderRecords(shown: readonly EntityMatch[], restricted: number): string {
  if (shown.length === 0 && restricted === 0) return '';
  const { PAGE_BODY_MAX_CHARS, TOTAL_MAX_CHARS } = WIKI_RECORD_ATTACH_CONSTANTS;
  const lines: string[] = [];
  if (shown.length > 0) {
    lines.push(
      '[Records you already hold on what this conversation mentions. Crewly looked them up in the wiki; nobody asked you to. ' +
        'Read them before you answer: do not propose what a record says is already done, and say so when your answer goes beyond them. ' +
        'They are internal: use them to be accurate, do not quote them to anyone outside the team.]',
    );
    for (const match of shown) {
      const { page } = match;
      const where = page.relativePath.replace(/^llm-curated\//, '');
      lines.push(`## ${page.title} — ${where}${page.updated ? `, updated ${page.updated.slice(0, 10)}` : ''} (matched: ${match.matched.join(', ')})`);
      if (page.summary) lines.push(page.summary);
      const body = page.body.trim();
      if (body) {
        lines.push(body.length > PAGE_BODY_MAX_CHARS ? `${body.slice(0, PAGE_BODY_MAX_CHARS)} …[clipped; the full page is ${where}]` : body);
      }
    }
  }
  if (restricted > 0) {
    lines.push(
      `[${restricted === 1 ? 'A record' : `${restricted} records`} on a name in this conversation ${restricted === 1 ? 'is' : 'are'} restricted to certain people and ${restricted === 1 ? 'is' : 'are'} not shown here. If you need ${restricted === 1 ? 'it' : 'them'}, ask the owner in a private conversation.]`,
    );
  }
  lines.push('[end of records]');
  const block = lines.join('\n');
  return block.length > TOTAL_MAX_CHARS ? `${block.slice(0, TOTAL_MAX_CHARS)} …[clipped]\n[end of records]` : block;
}

/**
 * Service — see module docs.
 */
export class WikiRecordAttachService {
  private readonly logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('WikiRecordAttach');
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; pages: EntityPage[] }>();

  constructor(private readonly deps: WikiRecordAttachDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * The entity pages of a vault (cached for a few minutes).
   *
   * @param vaultPath - Vault root
   * @returns Pages under the entity folders that parse and carry a title
   */
  async listEntityPages(vaultPath: string): Promise<EntityPage[]> {
    const cached = this.cache.get(vaultPath);
    if (cached && this.now() - cached.at < WIKI_RECORD_ATTACH_CONSTANTS.INDEX_TTL_MS) return cached.pages;
    const pages: EntityPage[] = [];
    for (const folder of WIKI_RECORD_ATTACH_CONSTANTS.ENTITY_FOLDERS) {
      const dir = path.join(vaultPath, 'llm-curated', folder);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue; // the folder does not exist in this vault
      }
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        try {
          const page = parsePage(await fs.readFile(path.join(dir, name), 'utf8'));
          const fm = page.frontmatter;
          if (typeof fm.title !== 'string' || !fm.title.trim() || fm.superseded_by) continue;
          pages.push({
            vaultPath,
            relativePath: `llm-curated/${folder}/${name}`,
            title: fm.title.trim(),
            summary: typeof fm.summary === 'string' ? oneLine(fm.summary, 240) : '',
            aliases: aliasesOf(fm),
            frontmatter: fm,
            body: page.body,
            ...(typeof fm.updated === 'string' ? { updated: fm.updated } : typeof fm.recorded === 'string' ? { updated: fm.recorded } : {}),
          });
        } catch (err) {
          this.logger.debug('Entity page skipped (unreadable)', { vaultPath, name, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    this.cache.set(vaultPath, { at: this.now(), pages });
    return pages;
  }

  /** Forget cached page lists (after a page write, and in tests). */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * The records block for one delivery.
   *
   * @param request - Who receives the message, its text, and where to look
   * @returns The block to attach, or '' when no page matches. Never throws.
   */
  async blockFor(request: AttachRequest): Promise<string> {
    try {
      const text = request.text.slice(0, WIKI_RECORD_ATTACH_CONSTANTS.TEXT_SCAN_MAX_CHARS);
      if (!text.trim()) return '';
      const pages = (await Promise.all(request.vaultPaths.map((v) => this.listEntityPages(v)))).flat();
      if (pages.length === 0) return '';
      const matches = matchEntities(text, pages);
      if (matches.length === 0) return '';

      const shown: EntityMatch[] = [];
      let restricted = 0;
      for (const match of matches) {
        const fm = match.page.frontmatter;
        if (!isVisibleTo(fm, request.viewerRole)) continue; // not for this agent's role: say nothing
        const people = Array.isArray(fm.visible_to_people) ? fm.visible_to_people : [];
        if (people.length > 0 && !request.ownerOnlyAudience) {
          restricted += 1;
          continue;
        }
        if (shown.length < WIKI_RECORD_ATTACH_CONSTANTS.MAX_PAGES) shown.push(match);
      }
      const block = renderRecords(shown, restricted);
      if (block) {
        const byVault = new Map<string, string[]>();
        for (const m of shown) byVault.set(m.page.vaultPath, [...(byVault.get(m.page.vaultPath) ?? []), m.page.relativePath]);
        for (const [vaultPath, hits] of byVault) {
          try {
            this.deps.recordUsage?.(vaultPath, {
              via: WIKI_RECORD_ATTACH_CONSTANTS.USAGE_VIA,
              agent: request.agentSession,
              query: shown.flatMap((m) => m.matched).join(', '),
              hits,
              miss: false,
            });
          } catch {
            /* the ledger is best effort */
          }
        }
        this.logger.info('Records attached to a delivery', {
          agent: request.agentSession,
          pages: shown.map((m) => m.page.relativePath),
          restricted,
          chars: block.length,
        });
      }
      return block;
    } catch (err) {
      this.logger.warn('Record lookup failed; the message is delivered without records', {
        agent: request.agentSession,
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }
}
