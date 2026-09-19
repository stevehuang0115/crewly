/**
 * WikiCurationService — the two canonical-role operations on pages:
 *
 *  - **supersede**: a conclusion changed. The old page is not deleted; it
 *    gets `superseded_by` + a reason, drops out of default retrieval, and
 *    its index line carries the marker. The change of judgement is the
 *    valuable content, so it stays readable on request.
 *  - **proposals**: pages written by `proposed_only` roles wait under
 *    `llm-curated/_proposed/`. A canonical role accepts (moved into place,
 *    indexed, history snapshot) or rejects (removed, recorded in log.md).
 *
 * @module services/wiki/wiki-curation.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { WIKI_KB_CONSTANTS } from '../../constants.js';
import { SchemaLoaderService } from './schema-loader.service.js';
import { WikiIndexService } from './wiki-index.service.js';
import { WikiHistoryService } from './wiki-history.service.js';
import { parsePage, serializePage, type WikiPageFrontmatter } from './wiki-page.js';
import { canReview } from './wiki-policy.js';
import { walkCuratedPages } from './wiki-vault-walk.js';

/** Structured failure. */
export interface CurationFailure {
  ok: false;
  reason: 'invalid_input' | 'schema_missing' | 'not_found' | 'forbidden' | 'frozen_path';
  message: string;
}

/** A pending proposal. */
export interface WikiProposal {
  /** Path under `_proposed/` (vault-relative). */
  proposedPath: string;
  /** Where it would land on acceptance. */
  targetPath: string;
  title: string;
  summary: string;
  proposedBy: string;
  recorded: string;
}

/**
 * Supersede + proposal review.
 */
export class WikiCurationService {
  private static instance: WikiCurationService | null = null;
  private readonly logger: ComponentLogger;

  constructor(
    private readonly schemaLoader: SchemaLoaderService = new SchemaLoaderService(),
    private readonly index: WikiIndexService = WikiIndexService.getInstance(),
    private readonly history: WikiHistoryService = WikiHistoryService.getInstance(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiCuration');
  }

  static getInstance(): WikiCurationService {
    if (!this.instance) this.instance = new WikiCurationService();
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Mark `oldPath` as superseded by `newPath`.
   *
   * @param args - Vault, both pages, reason, who (session + resolved role)
   * @returns Outcome
   */
  async supersede(args: {
    vaultPath: string;
    oldPath: string;
    newPath: string;
    reason: string;
    callerSession?: string;
    callerRole?: string;
  }): Promise<{ ok: true; oldPath: string; newPath: string } | CurationFailure> {
    const schema = await this.loadSchema(args.vaultPath);
    if ('ok' in schema) return schema;
    if (!canReview(schema, args.callerRole)) {
      return { ok: false, reason: 'forbidden', message: `role "${args.callerRole}" cannot supersede pages (write_policy.canonical only)` };
    }
    const oldRel = normalize(args.oldPath);
    const newRel = normalize(args.newPath);
    if (!oldRel || !newRel || oldRel === newRel) {
      return { ok: false, reason: 'invalid_input', message: 'oldPath and newPath must be two different vault-relative pages' };
    }
    if (this.schemaLoader.isFrozenPath(schema, oldRel)) {
      return { ok: false, reason: 'frozen_path', message: `${oldRel} is frozen` };
    }
    const oldAbs = path.join(args.vaultPath, oldRel);
    const newAbs = path.join(args.vaultPath, newRel);
    if (!existsSync(oldAbs)) return { ok: false, reason: 'not_found', message: `${oldRel} does not exist` };
    if (!existsSync(newAbs)) return { ok: false, reason: 'not_found', message: `${newRel} does not exist` };

    const author = args.callerSession ?? 'owner';
    await this.history.snapshot(args.vaultPath, oldRel, author, 'supersede');
    const page = parsePage(await fs.readFile(oldAbs, 'utf8'));
    const fm: Partial<WikiPageFrontmatter> = {
      ...page.frontmatter,
      superseded_by: newRel,
      superseded_at: this.now().toISOString(),
      superseded_reason: args.reason?.trim() || 'superseded',
      updated: this.now().toISOString(),
    };
    await fs.writeFile(oldAbs, serializePage(fm, page.body), 'utf8');
    await this.index.upsert(args.vaultPath, oldRel, fm);
    this.logger.info('Wiki page superseded', { vault: args.vaultPath, oldPath: oldRel, newPath: newRel, by: author });
    return { ok: true, oldPath: oldRel, newPath: newRel };
  }

  /**
   * List pending proposals in a vault.
   *
   * @param vaultPath - Vault root
   * @returns Proposals, oldest first
   */
  async listProposals(vaultPath: string): Promise<WikiProposal[]> {
    const prefix = `${WIKI_KB_CONSTANTS.PROPOSED_DIR}/`;
    const out: WikiProposal[] = [];
    for (const ref of await walkCuratedPages(vaultPath, { includeProposed: true })) {
      if (!ref.relativePath.startsWith(prefix)) continue;
      let raw: string;
      try {
        raw = await fs.readFile(ref.absPath, 'utf8');
      } catch {
        continue;
      }
      const { frontmatter } = parsePage(raw);
      out.push({
        proposedPath: ref.relativePath,
        targetPath: `llm-curated/${ref.relativePath.slice(prefix.length)}`,
        title: String(frontmatter.title ?? path.basename(ref.relativePath, '.md')),
        summary: String(frontmatter.summary ?? ''),
        proposedBy: String(frontmatter.proposed_by ?? frontmatter.caller ?? 'unknown'),
        recorded: String(frontmatter.recorded ?? ''),
      });
    }
    return out.sort((a, b) => a.recorded.localeCompare(b.recorded));
  }

  /**
   * Accept a proposal: move it into place (appending to an existing page
   * of the same path), index it, snapshot what it replaced.
   *
   * @param args - Vault, proposed path, who (session + resolved role)
   * @returns Outcome with the final page path
   */
  async acceptProposal(args: {
    vaultPath: string;
    proposedPath: string;
    callerSession?: string;
    callerRole?: string;
  }): Promise<{ ok: true; pagePath: string } | CurationFailure> {
    const schema = await this.loadSchema(args.vaultPath);
    if ('ok' in schema) return schema;
    if (!canReview(schema, args.callerRole)) {
      return { ok: false, reason: 'forbidden', message: `role "${args.callerRole}" cannot accept proposals` };
    }
    const proposedRel = normalize(args.proposedPath);
    const prefix = `${WIKI_KB_CONSTANTS.PROPOSED_DIR}/`;
    if (!proposedRel.startsWith(prefix)) {
      return { ok: false, reason: 'invalid_input', message: `proposedPath must be under ${prefix}` };
    }
    const proposedAbs = path.join(args.vaultPath, proposedRel);
    if (!existsSync(proposedAbs)) return { ok: false, reason: 'not_found', message: `${proposedRel} does not exist` };
    const targetRel = `llm-curated/${proposedRel.slice(prefix.length)}`;
    const targetAbs = path.join(args.vaultPath, targetRel);
    const author = args.callerSession ?? 'owner';

    const proposal = parsePage(await fs.readFile(proposedAbs, 'utf8'));
    const { proposed_by: _proposedBy, ...rest } = proposal.frontmatter;
    void _proposedBy;
    const fm: Partial<WikiPageFrontmatter> = { ...rest, updated: this.now().toISOString() };
    let body = proposal.body;
    if (existsSync(targetAbs)) {
      await this.history.snapshot(args.vaultPath, targetRel, author, 'accept_proposal');
      const existing = parsePage(await fs.readFile(targetAbs, 'utf8'));
      body = `${existing.body.replace(/\s+$/, '')}\n\n${proposal.body.replace(/^#[^\n]*\n/, '').trim()}\n`;
      Object.assign(fm, { ...existing.frontmatter, ...rest, updated: fm.updated });
    }
    await fs.mkdir(path.dirname(targetAbs), { recursive: true });
    await fs.writeFile(targetAbs, serializePage(fm, body), 'utf8');
    await fs.unlink(proposedAbs);
    await this.index.upsert(args.vaultPath, targetRel, fm);
    this.logger.info('Wiki proposal accepted', { vault: args.vaultPath, pagePath: targetRel, by: author });
    return { ok: true, pagePath: targetRel };
  }

  /**
   * Reject a proposal: remove it and note the rejection in log.md.
   *
   * @param args - Vault, proposed path, reason, who
   * @returns Outcome
   */
  async rejectProposal(args: {
    vaultPath: string;
    proposedPath: string;
    reason?: string;
    callerSession?: string;
    callerRole?: string;
  }): Promise<{ ok: true } | CurationFailure> {
    const schema = await this.loadSchema(args.vaultPath);
    if ('ok' in schema) return schema;
    if (!canReview(schema, args.callerRole)) {
      return { ok: false, reason: 'forbidden', message: `role "${args.callerRole}" cannot reject proposals` };
    }
    const proposedRel = normalize(args.proposedPath);
    if (!proposedRel.startsWith(`${WIKI_KB_CONSTANTS.PROPOSED_DIR}/`)) {
      return { ok: false, reason: 'invalid_input', message: 'proposedPath must be under _proposed/' };
    }
    const abs = path.join(args.vaultPath, proposedRel);
    if (!existsSync(abs)) return { ok: false, reason: 'not_found', message: `${proposedRel} does not exist` };
    const author = args.callerSession ?? 'owner';
    await this.history.snapshot(args.vaultPath, proposedRel, author, 'delete');
    await fs.unlink(abs);
    const logPath = path.join(args.vaultPath, 'llm-curated', 'log.md');
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(
      logPath,
      `\n## [${this.now().toISOString()}] proposal_rejected | ${author}\n\nref: ${proposedRel}\n\n${(args.reason ?? 'rejected').trim()}\n`,
      'utf8',
    );
    this.logger.info('Wiki proposal rejected', { vault: args.vaultPath, proposedPath: proposedRel, by: author });
    return { ok: true };
  }

  private async loadSchema(vaultPath: string) {
    if (!vaultPath || !path.isAbsolute(vaultPath)) {
      return { ok: false as const, reason: 'invalid_input' as const, message: 'vaultPath must be absolute' };
    }
    try {
      return await this.schemaLoader.load(vaultPath);
    } catch (err) {
      return { ok: false as const, reason: 'schema_missing' as const, message: (err as Error).message };
    }
  }
}

function normalize(rel: string): string {
  return (rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.\//g, '');
}
