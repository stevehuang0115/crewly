/**
 * WikiLogCompileService — turns the week's log entries into a digest page.
 *
 * Agents append learnings to `llm-curated/log.md` and nothing ever read
 * them back (#1345): bookkeep waited for ten net-new *pages* and reflect
 * fed a queue nobody drained. This service does the deterministic half of
 * "compile": once a day it takes the non-noise, not-yet-compiled entries
 * of the last `COMPILE_WINDOW_DAYS`, groups them by category and topic,
 * and writes (or appends to) one page per vault and ISO week under
 * `llm-curated/digests/`, through the normal ingest path so the page gets
 * frontmatter, an index line and history. Compiled entries are remembered
 * by body key in `<vault>/.wiki-compile-state.json` so a later run does
 * not compile them again. No LLM; an agent can still rewrite a digest into
 * a proper topic page.
 *
 * Work records (#1349, `work_record` entries) get their own sections ahead
 * of the learning groups: "Work done", "Errors and fixes", "Collaboration".
 *
 * @module services/wiki/wiki-log-compile.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { WIKI_LOG_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { WikiIngestService } from './wiki-ingest.service.js';
import {
  logBodyKey,
  logEntryCategory,
  logEntryTopic,
  parseLogEntries,
  recentContentEntries,
  type WikiLogEntryRecord,
} from './wiki-log-entries.js';
import { isWorkRecordEntry, parseWorkRecordBody, type ParsedWorkRecord } from './work-record.js';

/** A work record entry with its parsed fields. */
interface DigestRecord {
  entry: WikiLogEntryRecord;
  parsed: ParsedWorkRecord;
}

/** Persisted per-vault compile bookkeeping. */
interface CompileState {
  /** Body keys already compiled, oldest first (bounded). */
  compiledKeys: string[];
  /** ISO time of the last page write. */
  lastCompiledAt: string | null;
}

/** Options for {@link WikiLogCompileService.compile}. */
export interface WikiLogCompileOptions {
  /** Report only; write nothing (page or state). */
  dryRun?: boolean;
  /** Clock (tests). */
  now?: number;
  /** Window override (tests). */
  windowDays?: number;
  /** Minimum-entries override (tests). */
  minEntries?: number;
}

/** Outcome of one vault's compile. */
export interface WikiLogCompileResult {
  vaultPath: string;
  /** False when the log is missing, too few new entries, or ingest refused the page. */
  compiled: boolean;
  reason?: 'no_log' | 'too_few_entries' | 'ingest_refused';
  /** Uncompiled non-noise entries found in the window. */
  candidates: number;
  /** Entries written into the digest. */
  entriesCompiled: number;
  /** Vault-relative digest page (planned in a dry run). */
  pagePath?: string;
  /** Topic groups written. */
  groups: number;
  dryRun: boolean;
}

/**
 * ISO-8601 week label (`YYYY-Www`) of a date.
 *
 * @param ms - Epoch ms
 * @returns Label such as `2026-W42`
 */
export function isoWeekLabel(ms: number): string {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of the current week decides the ISO year.
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Compiles vault log entries into weekly digest pages. Stateless singleton
 * apart from the per-vault state file.
 */
export class WikiLogCompileService {
  private static instance: WikiLogCompileService | null = null;
  private readonly logger: ComponentLogger;

  constructor(private readonly ingest: WikiIngestService = WikiIngestService.getInstance()) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiLogCompile');
  }

  static getInstance(): WikiLogCompileService {
    if (!this.instance) this.instance = new WikiLogCompileService();
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Compile one vault's uncompiled recent entries into this week's digest.
   *
   * @param vaultPath - Vault root
   * @param opts - Dry run, clock and threshold overrides
   * @returns What was (or would be) written
   *
   * @example
   * ```typescript
   * const r = await WikiLogCompileService.getInstance().compile(vault);
   * // r.compiled && r.pagePath === 'llm-curated/digests/2026-W42.md'
   * ```
   */
  async compile(vaultPath: string, opts: WikiLogCompileOptions = {}): Promise<WikiLogCompileResult> {
    const dryRun = opts.dryRun === true;
    const now = opts.now ?? Date.now();
    const windowDays = opts.windowDays ?? WIKI_LOG_CONSTANTS.COMPILE_WINDOW_DAYS;
    const minEntries = opts.minEntries ?? WIKI_LOG_CONSTANTS.COMPILE_MIN_ENTRIES;
    const base: WikiLogCompileResult = { vaultPath, compiled: false, candidates: 0, entriesCompiled: 0, groups: 0, dryRun };

    let raw: string;
    try {
      raw = await fs.readFile(path.join(vaultPath, WIKI_LOG_CONSTANTS.LOG_RELATIVE_PATH), 'utf8');
    } catch {
      return { ...base, reason: 'no_log' };
    }

    const state = await this.readState(vaultPath);
    const done = new Set(state.compiledKeys);
    const candidates = recentContentEntries(parseLogEntries(raw), windowDays, now)
      .filter((e) => !done.has(logBodyKey(e.body)))
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .slice(0, WIKI_LOG_CONSTANTS.COMPILE_MAX_ENTRIES);
    base.candidates = candidates.length;
    if (candidates.length < minEntries) return { ...base, reason: 'too_few_entries' };

    const week = isoWeekLabel(now);
    const pagePath = `${WIKI_LOG_CONSTANTS.COMPILE_DIR}/${week}.md`;
    // The ingest refuses a body over its cap, so a long week is compiled in
    // parts: the oldest entries now, the rest on the next run (they stay
    // uncompiled candidates while they are in the window).
    let taken = candidates;
    let split = this.splitRecords(taken);
    let groups = this.group(split.others);
    let body = this.renderBody(groups, taken, now, split.records);
    while (Buffer.byteLength(body, 'utf8') > WIKI_LOG_CONSTANTS.COMPILE_MAX_BODY_BYTES && taken.length > minEntries) {
      taken = taken.slice(0, Math.max(minEntries, Math.floor(taken.length * 0.75)));
      split = this.splitRecords(taken);
      groups = this.group(split.others);
      body = this.renderBody(groups, taken, now, split.records);
    }
    if (taken.length < candidates.length) {
      this.logger.info('WikiLogCompile: digest trimmed to fit the ingest body cap; the rest waits for the next run', {
        vaultPath,
        pagePath,
        candidates: candidates.length,
        compiled: taken.length,
        bytes: Buffer.byteLength(body, 'utf8'),
      });
    }
    const { records, others } = split;
    const result: WikiLogCompileResult = { ...base, compiled: true, entriesCompiled: taken.length, pagePath, groups: groups.length };

    if (dryRun) {
      this.logger.info('WikiLogCompile dry run — would write digest', { vaultPath, pagePath, entries: candidates.length, groups: groups.length, records: records.length });
      return result;
    }

    const counts = this.categoryCounts(others);
    const summaryLead = records.length > 0
      ? `${records.length} work record${records.length === 1 ? '' : 's'}${others.length > 0 ? ` and ${others.length} learnings (${counts})` : ''} from the vault log`
      : `${taken.length} learnings from the vault log (${counts})`;
    const outcome = await this.ingest.ingest({
      vaultPath,
      sourceType: 'record_learning',
      sourceRef: `wiki-log-compile:${week}:${new Date(now).toISOString()}`,
      sourceBody: body,
      callerSession: 'system:wiki-log-compile',
      targetRelativePath: pagePath,
      title: `Digest ${week}`,
      summary: `${summaryLead} compiled ${new Date(now).toISOString().slice(0, 10)} — read before working on these topics; promote what still matters to its own page.`,
      keepBecause: 'reusable_method',
      tags: ['digest', week],
    });
    if (!outcome.ok) {
      this.logger.warn('WikiLogCompile: ingest refused the digest page (non-fatal)', {
        vaultPath,
        pagePath,
        reason: outcome.reason,
        message: 'message' in outcome ? outcome.message : undefined,
        bytes: Buffer.byteLength(body, 'utf8'),
      });
      return { ...base, reason: 'ingest_refused', candidates: candidates.length };
    }

    const keys = [...state.compiledKeys, ...taken.map((e) => logBodyKey(e.body))];
    await this.writeState(vaultPath, {
      compiledKeys: keys.slice(-WIKI_LOG_CONSTANTS.COMPILE_STATE_MAX_KEYS),
      lastCompiledAt: new Date(now).toISOString(),
    });
    this.logger.info('WikiLogCompile wrote digest', { vaultPath, pagePath, entries: taken.length, ofCandidates: candidates.length, groups: groups.length });
    return result;
  }

  /**
   * Compile every vault in a list; failures are logged per vault.
   *
   * @param vaults - Vault roots
   * @param opts - Passed to {@link compile}
   * @returns One result per vault checked
   */
  async compileAll(vaults: readonly string[], opts: WikiLogCompileOptions = {}): Promise<WikiLogCompileResult[]> {
    const out: WikiLogCompileResult[] = [];
    for (const vaultPath of vaults) {
      try {
        out.push(await this.compile(vaultPath, opts));
      } catch (err) {
        this.logger.warn('WikiLogCompile failed for vault (non-fatal)', { vaultPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------

  /**
   * Group entries by `<category> / <topic>`, largest groups first, stable
   * within a group (oldest first).
   *
   * @param entries - Candidate entries
   * @returns Groups with a label and members
   */
  private group(entries: readonly WikiLogEntryRecord[]): Array<{ label: string; members: WikiLogEntryRecord[] }> {
    const byLabel = new Map<string, WikiLogEntryRecord[]>();
    for (const e of entries) {
      const category = logEntryCategory(e.body);
      const topic = logEntryTopic(e.body);
      const label = topic.toLowerCase() === category ? category : `${category} / ${topic}`;
      const list = byLabel.get(label) ?? [];
      list.push(e);
      byLabel.set(label, list);
    }
    return [...byLabel.entries()]
      .map(([label, members]) => ({ label, members }))
      .sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
  }

  /**
   * `k gotchas, m decisions, …` for the page summary.
   *
   * @param entries - Entries
   * @returns Comma-separated counts, most frequent first
   */
  private categoryCounts(entries: readonly WikiLogEntryRecord[]): string {
    const counts = new Map<string, number>();
    for (const e of entries) {
      const c = logEntryCategory(e.body);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${n} ${c}`)
      .join(', ');
  }

  /**
   * Separate work records (#1349) from learnings. A record whose body does
   * not parse is kept as a learning so nothing is dropped.
   *
   * @param entries - Candidate entries
   * @returns Records with parsed fields, and the rest
   */
  private splitRecords(entries: readonly WikiLogEntryRecord[]): { records: DigestRecord[]; others: WikiLogEntryRecord[] } {
    const records: DigestRecord[] = [];
    const others: WikiLogEntryRecord[] = [];
    for (const e of entries) {
      const parsed = isWorkRecordEntry(e) ? parseWorkRecordBody(e.body) : null;
      if (parsed) records.push({ entry: e, parsed });
      else others.push(e);
    }
    return { records, others };
  }

  /**
   * Markdown body of one compile run: a dated heading; when the run holds
   * work records, `### Work done`, `### Errors and fixes` and
   * `### Collaboration` (the digest renders task titles, never ticket ids —
   * those stay on each record's `meta:` line); then one `###` per learning
   * group with one bullet per entry (author, date, body clipped).
   *
   * @param groups - Grouped learning entries
   * @param all - All entries in the run (for the date range)
   * @param now - Epoch ms of the run
   * @param records - Work records in the run
   * @returns Markdown
   */
  private renderBody(groups: ReadonlyArray<{ label: string; members: WikiLogEntryRecord[] }>, all: readonly WikiLogEntryRecord[], now: number, records: readonly DigestRecord[] = []): string {
    const first = all[0]?.timestamp.slice(0, 10) ?? '';
    const last = all[all.length - 1]?.timestamp.slice(0, 10) ?? '';
    const lines: string[] = [`## Compiled ${new Date(now).toISOString().slice(0, 10)} — ${all.length} entries from ${first} to ${last}`, ''];
    if (records.length > 0) lines.push(...this.renderRecordSections(records));
    for (const g of groups) {
      lines.push(`### ${g.label} (${g.members.length})`, '');
      for (const e of g.members) {
        const body = e.body.replace(/\s+/g, ' ').trim();
        const clipped = body.length > WIKI_LOG_CONSTANTS.COMPILE_ENTRY_MAX_CHARS ? `${body.slice(0, WIKI_LOG_CONSTANTS.COMPILE_ENTRY_MAX_CHARS - 1)}…` : body;
        lines.push(`- ${e.timestamp.slice(0, 10)} · ${e.caller}: ${clipped}`);
      }
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  /**
   * The three record sections. "Work done" lists every record (asked by →
   * done by → outputs → outcome); "Errors and fixes" the records that met
   * errors; "Collaboration" counts, per pair, delegations, asks and reviews.
   *
   * @param records - Records of the run, oldest first
   * @returns Markdown lines (each section followed by a blank line)
   */
  private renderRecordSections(records: readonly DigestRecord[]): string[] {
    const lines: string[] = [`### Work done (${records.length})`, ''];
    for (const { entry, parsed } of records) {
      const parts = [`asked by ${parsed.askedBy || 'unknown'}`, `done by ${parsed.doneBy || 'unknown'}`];
      if (parsed.did) parts.push(this.clipText(parsed.did, WIKI_LOG_CONSTANTS.COMPILE_ENTRY_MAX_CHARS / 2));
      if (parsed.outputs.length) parts.push(`outputs: ${parsed.outputs.slice(0, 3).join('; ')}`);
      lines.push(`- ${entry.timestamp.slice(0, 10)} · **${parsed.title}** — ${parts.join(' → ')} → ${parsed.outcome || 'unknown'}`);
    }
    lines.push('');

    const withErrors = records.filter((r) => r.parsed.errors.length > 0);
    if (withErrors.length > 0) {
      lines.push(`### Errors and fixes (${withErrors.length})`, '');
      for (const { entry, parsed } of withErrors) {
        lines.push(`- ${entry.timestamp.slice(0, 10)} · ${parsed.title} (${parsed.doneBy || 'unknown'}): ${this.clipText(parsed.errors.join('; '), WIKI_LOG_CONSTANTS.COMPILE_ENTRY_MAX_CHARS)}`);
      }
      lines.push('');
    }

    const pairs = new Map<string, Map<string, number>>();
    const count = (from: string, to: string, how: string): void => {
      if (!from || !to || from === to) return;
      const key = `${from} → ${to}`;
      const byHow = pairs.get(key) ?? new Map<string, number>();
      byHow.set(how, (byHow.get(how) ?? 0) + 1);
      pairs.set(key, byHow);
    };
    for (const { parsed } of records) {
      const asker = parsed.askedBy.replace(/\s*\((?:team lead|orchestrator)\)/, '').replace(/\s+for the owner.*$/, '').replace(/\s*\([^)]*\)$/, '').trim();
      if (asker && !asker.startsWith('schedule') && asker !== 'Crewly (system)') count(asker, parsed.doneBy, 'delegation');
      for (const h of parsed.helpers) {
        if (h.how === 'delegated') count(parsed.doneBy, h.name, 'delegation');
        else if (h.how === 'asked') count(parsed.doneBy, h.name, h.rest.includes('answered') ? 'ask answered' : 'ask unanswered');
        else count(h.name, parsed.doneBy, 'review');
      }
    }
    if (pairs.size > 0) {
      lines.push(`### Collaboration (${pairs.size} pair${pairs.size === 1 ? '' : 's'})`, '');
      const rows = [...pairs.entries()]
        .map(([pair, byHow]) => ({ pair, total: [...byHow.values()].reduce((a, b) => a + b, 0), detail: [...byHow.entries()].sort((a, b) => b[1] - a[1]).map(([how, n]) => `${n} ${how}${n === 1 || how.endsWith('answered') ? '' : 's'}`).join(', ') }))
        .sort((a, b) => b.total - a.total || a.pair.localeCompare(b.pair));
      for (const r of rows) lines.push(`- ${r.pair}: ${r.detail}`);
      lines.push('');
    }
    return lines;
  }

  private clipText(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  private statePath(vaultPath: string): string {
    return path.join(vaultPath, WIKI_LOG_CONSTANTS.COMPILE_STATE_FILE);
  }

  private async readState(vaultPath: string): Promise<CompileState> {
    const data = await safeReadJson<Partial<CompileState> | null>(this.statePath(vaultPath), null);
    return {
      compiledKeys: Array.isArray(data?.compiledKeys) ? data.compiledKeys.filter((k): k is string => typeof k === 'string') : [],
      lastCompiledAt: typeof data?.lastCompiledAt === 'string' ? data.lastCompiledAt : null,
    };
  }

  private async writeState(vaultPath: string, state: CompileState): Promise<void> {
    await atomicWriteJson(this.statePath(vaultPath), state);
  }
}
