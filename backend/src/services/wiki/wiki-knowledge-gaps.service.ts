/**
 * WikiKnowledgeGapsService — turns the week's zero-hit queries into a page
 * and one piece of work for the team lead (#914 P1).
 *
 * `wiki-query` and `recall` append every query to `llm-curated/usage.jsonl`,
 * including the ones that found nothing. The bookkeep report listed five of
 * them, and nobody read the bookkeep report. Once per ISO week, from the
 * maintenance daily pass, this service:
 *
 *   1. reads the window's ledger events and keeps the misses (`miss` or an
 *      empty hit list);
 *   2. folds them by normalised query text into distinct gaps — how often,
 *      who asked, first and last time — and drops a gap the vault answered
 *      later in the window (the same question later returned hits);
 *   3. writes `llm-curated/gaps/<week>.md` through the normal ingest path
 *      (frontmatter, index line, history) — replaced, not appended, when the
 *      same week is compiled again;
 *   4. hands the vault's team lead (the orchestrator for the global vault)
 *      one WorkItem to decide, per gap, whether it deserves a page. Never
 *      when the lead is dormant: a chore is not worth a wake.
 *
 * No LLM. A short query (`QUERY_MIN_CHARS`) is a stray token and ignored; a
 * long one (`QUERY_MAX_CHARS`) is pasted text, counted but not listed.
 *
 * Recall searches every vault at once, so a team vault's ledger holds
 * recall rows only as echoes of a cross-vault search (and, before the
 * 1.20.397 ledger fix, a miss in every team vault for one unanswered
 * global recall — 33 phantom gaps per dormant team on 2026-10-24). A team
 * vault is only ever asked directly through `wiki-query`, so its page is
 * built from `wiki-query` rows alone; recall misses belong to the global or
 * project vault that owns the question.
 *
 * @module services/wiki/wiki-knowledge-gaps.service
 */

import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { ORCHESTRATOR_SESSION_NAME, WIKI_GAPS_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';
import { WikiIngestService } from './wiki-ingest.service.js';
import { WikiUsageService, type WikiUsageEvent } from './wiki-usage.service.js';
import { isoWeekLabel } from './wiki-log-compile.service.js';

/** One distinct unanswered question. */
export interface KnowledgeGap {
  /** The query as first asked (original casing, whitespace collapsed). */
  query: string;
  /** Times it was asked and found nothing in the window. */
  count: number;
  /** Agents that asked, most frequent first (capped). */
  agents: string[];
  /** Retrieval paths it came through (`recall`, `wiki-query`, …). */
  via: string[];
  /** ISO time of the first and last miss. */
  firstAt: string;
  lastAt: string;
}

/** Outcome of folding a window's events. */
export interface KnowledgeGapRollup {
  /** Every ledger event in the window. */
  queries: number;
  /** Events that found nothing. */
  misses: number;
  /** Distinct gaps, most-asked first (capped at `MAX_GAPS_PER_PAGE`). */
  gaps: KnowledgeGap[];
  /** Distinct gaps before the cap. */
  distinct: number;
  /** Misses whose query looked like pasted text (longer than `QUERY_MAX_CHARS`). */
  pastedText: number;
  /** Distinct questions that missed first and were answered later in the window. */
  answeredLater: number;
}

/** The pool slice this service needs. */
export interface KnowledgeGapsPool {
  addToPool(workItem: WorkItem): Promise<void>;
}

/** Construction options. */
export interface WikiKnowledgeGapsOptions {
  ingest?: WikiIngestService;
  usage?: WikiUsageService;
  /** Where the lead's review WorkItem goes. Omit to write the page only. */
  pool?: KnowledgeGapsPool;
  /** Team lead for a vault; `null` falls back to `fallbackTarget`. */
  resolveTarget?: (vaultPath: string) => Promise<string | null>;
  /** Whether a target may be given work now; default: always. */
  isTargetAwake?: (sessionName: string) => Promise<boolean>;
  /** Target for the global vault when no lead resolves (default: the orchestrator). */
  fallbackTarget?: string;
  /** Human label of a vault for the WorkItem title (team name); `null` falls back to the folder name. */
  labelFor?: (vaultPath: string) => Promise<string | null>;
}

/** Options for {@link WikiKnowledgeGapsService.compile}. */
export interface WikiKnowledgeGapsCompileOptions {
  /** Report only; write nothing (page, state or WorkItem). */
  dryRun?: boolean;
  /** Clock (tests). */
  now?: number;
  /** Window override (tests). */
  windowDays?: number;
  /** Compile even when this week was already compiled (the page is replaced; no second WorkItem). */
  force?: boolean;
}

/** Outcome of one vault's compile. */
export interface WikiKnowledgeGapsResult {
  vaultPath: string;
  /** ISO week the page is for. */
  week: string;
  /** False when nothing was (or would be) written. */
  compiled: boolean;
  reason?: 'not_due' | 'no_queries' | 'no_gaps' | 'ingest_refused';
  rollup: KnowledgeGapRollup;
  /** Vault-relative page (planned in a dry run). */
  pagePath?: string;
  /** Lead WorkItem created this run. */
  workItemId?: string;
  /** Who the WorkItem went to (or would go to). */
  target?: string;
  /** Why no WorkItem was created although the page was. */
  workItemSkipped?: 'no_pool' | 'no_lead' | 'target_dormant' | 'already_raised' | 'dry_run';
  dryRun: boolean;
}

/** Persisted per-vault state. */
interface GapsState {
  /** Last ISO week compiled. */
  lastWeek: string | null;
  /** ISO time of the last page write. */
  lastCompiledAt: string | null;
  /** WorkItem raised for `lastWeek`, if any. */
  workItemId: string | null;
}

/**
 * Normalise a query for grouping: case, whitespace, trailing punctuation.
 *
 * @param query - Raw query text
 * @returns Grouping key
 */
export function gapKey(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:!?。，；：！？]+$/u, '')
    .trim();
}

/**
 * Fold a window's ledger events into distinct gaps. Pure.
 *
 * @param events - Ledger events, any order
 * @returns Counts and the distinct gaps, most-asked first then most recent
 *
 * @example
 * ```typescript
 * const r = rollupGaps(events);
 * // r.gaps[0] === { query: 'refund policy', count: 3, agents: ['kai'], … }
 * ```
 */
export function rollupGaps(events: readonly WikiUsageEvent[]): KnowledgeGapRollup {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const answered = new Map<string, number>(); // key → last time it returned hits (ms)
  for (const e of sorted) {
    if (!e.miss && Array.isArray(e.hits) && e.hits.length > 0) answered.set(gapKey(e.query ?? ''), Date.parse(e.at));
  }

  const byKey = new Map<string, { gap: KnowledgeGap; agents: Map<string, number>; via: Set<string> }>();
  let misses = 0;
  let pastedText = 0;
  for (const e of sorted) {
    // Only an explicit miss counts: a row with no hits and `miss: false` says
    // the vault was searched and another vault answered.
    if (e.miss !== true) continue;
    misses++;
    const text = (e.query ?? '').replace(/\s+/g, ' ').trim();
    const key = gapKey(text);
    if (key.length < WIKI_GAPS_CONSTANTS.QUERY_MIN_CHARS) continue;
    if (text.length > WIKI_GAPS_CONSTANTS.QUERY_MAX_CHARS) {
      pastedText++;
      continue;
    }
    const agent = e.agent || 'unknown';
    const slot = byKey.get(key);
    if (slot) {
      slot.gap.count++;
      slot.gap.lastAt = e.at;
      slot.agents.set(agent, (slot.agents.get(agent) ?? 0) + 1);
      slot.via.add(e.via);
    } else {
      byKey.set(key, {
        gap: { query: text, count: 1, agents: [], via: [], firstAt: e.at, lastAt: e.at },
        agents: new Map([[agent, 1]]),
        via: new Set([e.via]),
      });
    }
  }

  let answeredLater = 0;
  const gaps: KnowledgeGap[] = [];
  for (const [key, slot] of byKey) {
    const hitAt = answered.get(key);
    if (hitAt !== undefined && hitAt > Date.parse(slot.gap.lastAt)) {
      answeredLater++;
      continue;
    }
    slot.gap.agents = [...slot.agents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a).slice(0, WIKI_GAPS_CONSTANTS.MAX_AGENTS_PER_GAP);
    slot.gap.via = [...slot.via].sort();
    gaps.push(slot.gap);
  }
  gaps.sort((a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt) || a.query.localeCompare(b.query));

  return {
    queries: events.length,
    misses,
    gaps: gaps.slice(0, WIKI_GAPS_CONSTANTS.MAX_GAPS_PER_PAGE),
    distinct: gaps.length,
    pastedText,
    answeredLater,
  };
}

/**
 * Weekly knowledge-gap pages per vault. Singleton apart from the per-vault
 * state file; tests construct their own.
 */
export class WikiKnowledgeGapsService {
  private static instance: WikiKnowledgeGapsService | null = null;
  private readonly logger: ComponentLogger;
  private readonly ingest: WikiIngestService;
  private readonly usage: WikiUsageService;
  private readonly pool: KnowledgeGapsPool | null;
  private readonly resolveTarget: ((vaultPath: string) => Promise<string | null>) | null;
  private readonly isTargetAwake: ((sessionName: string) => Promise<boolean>) | null;
  private readonly fallbackTarget: string;
  private readonly labelFor: ((vaultPath: string) => Promise<string | null>) | null;

  constructor(opts: WikiKnowledgeGapsOptions = {}) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiKnowledgeGaps');
    this.ingest = opts.ingest ?? WikiIngestService.getInstance();
    this.usage = opts.usage ?? WikiUsageService.getInstance();
    this.pool = opts.pool ?? null;
    this.resolveTarget = opts.resolveTarget ?? null;
    this.isTargetAwake = opts.isTargetAwake ?? null;
    this.fallbackTarget = opts.fallbackTarget ?? ORCHESTRATOR_SESSION_NAME;
    this.labelFor = opts.labelFor ?? null;
  }

  static getInstance(): WikiKnowledgeGapsService {
    if (!this.instance) this.instance = new WikiKnowledgeGapsService();
    return this.instance;
  }

  /** Wire the production instance (built with a pool and a lead resolver). */
  static setInstance(next: WikiKnowledgeGapsService | null): void {
    this.instance = next;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Compile one vault's gap page for the current ISO week, once per week.
   *
   * @param vaultPath - Vault root
   * @param opts - Dry run, clock, window and force
   * @returns What was (or would be) written
   *
   * @example
   * ```typescript
   * const r = await WikiKnowledgeGapsService.getInstance().compile(vault);
   * // r.compiled && r.pagePath === 'llm-curated/gaps/2026-W43.md'
   * ```
   */
  async compile(vaultPath: string, opts: WikiKnowledgeGapsCompileOptions = {}): Promise<WikiKnowledgeGapsResult> {
    const dryRun = opts.dryRun === true;
    const now = opts.now ?? Date.now();
    const windowDays = opts.windowDays ?? WIKI_GAPS_CONSTANTS.WINDOW_DAYS;
    const week = isoWeekLabel(now);
    const empty: KnowledgeGapRollup = { queries: 0, misses: 0, gaps: [], distinct: 0, pastedText: 0, answeredLater: 0 };
    const base: WikiKnowledgeGapsResult = { vaultPath, week, compiled: false, rollup: empty, dryRun };

    const state = await this.readState(vaultPath);
    if (!opts.force && state.lastWeek === week) return { ...base, reason: 'not_due' };

    const usage = new WikiUsageService(() => new Date(now));
    const kind = vaultKind(vaultPath);
    // A team vault is only asked directly through wiki-query; its recall
    // rows are echoes of cross-vault searches and never its own gaps.
    const events = (await usage.events(vaultPath, windowDays)).filter((e) => kind !== 'team' || e.via !== 'recall');
    if (events.length === 0) return { ...base, reason: 'no_queries' };
    const rollup = rollupGaps(events);
    if (rollup.gaps.length === 0) return { ...base, rollup, reason: 'no_gaps' };

    const pagePath = `${WIKI_GAPS_CONSTANTS.DIR}/${week}.md`;
    const body = this.renderBody(rollup, now, windowDays);
    const result: WikiKnowledgeGapsResult = { ...base, compiled: true, rollup, pagePath };
    const target = await this.targetFor(vaultPath, kind);
    if (target) result.target = target;

    if (dryRun) {
      result.workItemSkipped = 'dry_run';
      this.logger.info('WikiKnowledgeGaps dry run — would write gap page', { vaultPath, pagePath, gaps: rollup.gaps.length, target });
      return result;
    }

    const n = rollup.gaps.length;
    const outcome = await this.ingest.ingest({
      vaultPath,
      sourceType: 'record_learning',
      sourceRef: `wiki-knowledge-gaps:${week}:${new Date(now).toISOString()}`,
      sourceBody: body,
      callerSession: WIKI_GAPS_CONSTANTS.CALLER_SESSION,
      targetRelativePath: pagePath,
      title: `Knowledge gaps ${week}`,
      summary: `${n} question${n === 1 ? '' : 's'} agents asked in the last ${windowDays} days that this vault could not answer — the team lead decides which deserve a page.`,
      keepBecause: 'changes_decision',
      tags: ['knowledge-gaps', week],
      replace: true,
    });
    if (!outcome.ok) {
      this.logger.warn('WikiKnowledgeGaps: ingest refused the gap page (non-fatal)', { vaultPath, pagePath, reason: outcome.reason });
      return { ...base, rollup, reason: 'ingest_refused' };
    }

    let workItemId: string | null = state.lastWeek === week ? state.workItemId : null;
    if (workItemId) {
      result.workItemSkipped = 'already_raised';
    } else if (!this.pool) {
      result.workItemSkipped = 'no_pool';
    } else if (!target) {
      result.workItemSkipped = 'no_lead';
    } else if (!(await this.targetAwake(target))) {
      result.workItemSkipped = 'target_dormant';
    } else {
      const wi = this.buildWorkItem(vaultPath, week, target, pagePath, rollup, body, await this.label(vaultPath));
      await this.pool.addToPool(wi);
      workItemId = wi.id;
      result.workItemId = wi.id;
    }

    await this.writeState(vaultPath, { lastWeek: week, lastCompiledAt: new Date(now).toISOString(), workItemId });
    this.logger.info('WikiKnowledgeGaps wrote gap page', { vaultPath, pagePath, gaps: n, misses: rollup.misses, target, workItemId: result.workItemId ?? null, skipped: result.workItemSkipped ?? null });
    return result;
  }

  /**
   * Compile every vault in a list; failures are logged per vault.
   *
   * @param vaults - Vault roots
   * @param opts - Passed to {@link compile}
   * @returns One result per vault that did not throw
   */
  async compileAll(vaults: readonly string[], opts: WikiKnowledgeGapsCompileOptions = {}): Promise<WikiKnowledgeGapsResult[]> {
    const out: WikiKnowledgeGapsResult[] = [];
    for (const vaultPath of vaults) {
      try {
        out.push(await this.compile(vaultPath, opts));
      } catch (err) {
        this.logger.warn('WikiKnowledgeGaps failed for vault (non-fatal)', { vaultPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------

  /**
   * Markdown body: a dated heading with the counts, one bullet per gap
   * (query, times asked, who, last asked, path), then what the lead does
   * with it.
   *
   * @param rollup - Folded gaps
   * @param now - Epoch ms of the run
   * @param windowDays - Window the counts cover
   * @returns Markdown
   */
  renderBody(rollup: KnowledgeGapRollup, now: number, windowDays: number): string {
    const date = new Date(now).toISOString().slice(0, 10);
    const lines: string[] = [
      `## Compiled ${date} — ${rollup.queries} queries in ${windowDays} days, ${rollup.misses} found nothing, ${rollup.distinct} distinct gap${rollup.distinct === 1 ? '' : 's'}`,
      '',
    ];
    const notes: string[] = [];
    if (rollup.answeredLater > 0) notes.push(`${rollup.answeredLater} question${rollup.answeredLater === 1 ? '' : 's'} missed first and found a page later in the week — not listed.`);
    if (rollup.pastedText > 0) notes.push(`${rollup.pastedText} miss${rollup.pastedText === 1 ? '' : 'es'} looked like pasted text (longer than ${WIKI_GAPS_CONSTANTS.QUERY_MAX_CHARS} characters) — counted, not listed.`);
    if (rollup.distinct > rollup.gaps.length) notes.push(`Only the ${rollup.gaps.length} most-asked of ${rollup.distinct} gaps are listed.`);
    if (notes.length) lines.push(...notes.map((t) => `_${t}_`), '');

    lines.push(`### Unanswered questions (${rollup.gaps.length})`, '');
    for (const g of rollup.gaps) {
      const who = g.agents.join(', ');
      const times = g.count === 1 ? 'asked once' : `asked ${g.count}×`;
      lines.push(`- **${g.query}** — ${times} by ${who}; last ${g.lastAt.slice(0, 10)} via ${g.via.join('/')}`);
    }
    lines.push('', '### What to do', '',
      '- For each question that has an answer worth keeping: write the page (wiki-ingest with a one-line summary and a keep_because) so the next search finds it.',
      '- For a question that does not deserve a page (one-off, already covered under other words, or not this vault\'s business): say so in the WorkItem result, one line per question.',
      '- The owner is not involved: never post this list, or the fact that you worked it, in the owner\'s thread.',
    );
    return lines.join('\n').trim();
  }

  /**
   * The lead's review WorkItem: title with the vault and the count, the
   * rendered page as the brief.
   */
  private buildWorkItem(vaultPath: string, week: string, target: string, pagePath: string, rollup: KnowledgeGapRollup, body: string, label: string): WorkItem {
    const n = rollup.gaps.length;
    return createWorkItem({
      type: 'delegate',
      owner: target === ORCHESTRATOR_SESSION_NAME ? 'orchestrator' : 'team_lead',
      target,
      title: `Review knowledge gaps ${week} — ${label} (${n} unanswered question${n === 1 ? '' : 's'})`,
      description: `Agents asked ${n} question${n === 1 ? '' : 's'} this week that the ${label} vault could not answer. Read ${pagePath} (vault ${vaultPath}) and decide, per question, whether it deserves a page: write it with wiki-ingest, or say in one line why not. Do not involve the owner.`,
      briefMarkdown: `# Knowledge gaps ${week} — ${label}\n\nVault: \`${vaultPath}\`\nPage: \`${pagePath}\`\n\n${body}`,
      maxRetries: 1,
      metadata: {
        kind: WIKI_GAPS_CONSTANTS.WORKITEM_KIND,
        vaultPath,
        week,
        pagePath,
        gaps: n,
        autoCreated: true,
      },
    });
  }

  /**
   * Who reviews a vault's gaps: its team lead. Only the global vault falls
   * back to the orchestrator; a team or project vault without a lead gets
   * the page and no WorkItem (one unanswered question is not worth an
   * orchestrator turn per vault).
   */
  private async targetFor(vaultPath: string, kind: VaultKind): Promise<string | null> {
    const fallback = kind === 'global' ? this.fallbackTarget : null;
    if (!this.resolveTarget) return fallback;
    try {
      return (await this.resolveTarget(vaultPath)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** Human label for the WorkItem title: the wired resolver (team name), else the folder. */
  private async label(vaultPath: string): Promise<string> {
    if (this.labelFor) {
      try {
        const named = await this.labelFor(vaultPath);
        if (named && named.trim()) return named.trim();
      } catch {
        /* fall through to the folder name */
      }
    }
    return vaultLabel(vaultPath);
  }

  /** Errors count as dormant: a chore is never worth risking a wake. */
  private async targetAwake(target: string): Promise<boolean> {
    if (!this.isTargetAwake) return true;
    try {
      return await this.isTargetAwake(target);
    } catch {
      return false;
    }
  }

  private statePath(vaultPath: string): string {
    return path.join(vaultPath, WIKI_GAPS_CONSTANTS.STATE_FILE);
  }

  private async readState(vaultPath: string): Promise<GapsState> {
    const data = await safeReadJson<Partial<GapsState> | null>(this.statePath(vaultPath), null);
    return {
      lastWeek: typeof data?.lastWeek === 'string' ? data.lastWeek : null,
      lastCompiledAt: typeof data?.lastCompiledAt === 'string' ? data.lastCompiledAt : null,
      workItemId: typeof data?.workItemId === 'string' ? data.workItemId : null,
    };
  }

  private async writeState(vaultPath: string, state: GapsState): Promise<void> {
    await atomicWriteJson(this.statePath(vaultPath), state);
  }
}

/** Where a vault sits: the cross-project global vault, a team vault, or a project vault. */
export type VaultKind = 'global' | 'team' | 'project';

/**
 * Classify a vault by its path.
 *
 * @param vaultPath - `~/.crewly/global-wiki`, `~/.crewly/teams/<id>/wiki` or `<project>/.crewly/wiki`
 * @returns The vault kind (anything unrecognised counts as a project vault)
 */
export function vaultKind(vaultPath: string): VaultKind {
  const normalized = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.endsWith('/global-wiki')) return 'global';
  if (/\/teams\/[^/]+\/wiki$/.test(normalized)) return 'team';
  return 'project';
}

/**
 * Short human label for a vault: the project or team folder it belongs to.
 *
 * @param vaultPath - `<project>/.crewly/wiki`, `~/.crewly/teams/<id>/wiki` or `~/.crewly/global-wiki`
 * @returns `crewly`, `<team-id>` or `global`
 */
export function vaultLabel(vaultPath: string): string {
  const normalized = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.endsWith('/global-wiki')) return 'global';
  if (normalized.endsWith('/.crewly/wiki')) return path.basename(normalized.slice(0, -'/.crewly/wiki'.length)) || 'project';
  if (normalized.endsWith('/wiki')) return path.basename(normalized.slice(0, -'/wiki'.length)) || 'vault';
  return path.basename(normalized) || 'vault';
}
