/**
 * WikiIngestService — write into a vault's `llm-curated/`.
 *
 * Two kinds of write:
 *   - **log entry** (default): append to `llm-curated/log.md`. Cheap,
 *     append-only, no gate beyond confidentiality. This is where "maybe
 *     useful" goes — the default is NOT to keep.
 *   - **page** (`targetRelativePath` under llm-curated/): a piece of
 *     knowledge. Passes the retention gate (title + one-line summary +
 *     keep_because), the vault's write policy (a `proposed_only` role's
 *     page lands in `_proposed/` until a canonical role accepts), the
 *     confidentiality gate (secrets never; PII per vault), gets YAML
 *     frontmatter, an index line, and a history snapshot of what it
 *     replaced.
 *
 * Frozen-path contract (§2): refuses ANY write whose target lives under a
 * `hardcoded:` folder. SchemaLoaderService.isFrozenPath() is the gate.
 *
 * @module services/wiki/wiki-ingest.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SchemaLoaderService } from './schema-loader.service.js';
import { VaultSchema } from './wiki.types.js';
import { WIKI_KB_CONSTANTS, type WikiKeepBecause } from '../../constants.js';
import { checkRetention, parsePage, serializePage, oneLine, type WikiPageFrontmatter } from './wiki-page.js';
import { applyPrivacyGate } from './wiki-redaction.js';
import { decideWrite } from './wiki-policy.js';
import { WikiIndexService } from './wiki-index.service.js';
import { WikiHistoryService } from './wiki-history.service.js';

/**
 * Categories of sources that trigger ingest. Mirrors §4 (ingest trigger
 * taxonomy) plus `user_chat` for the demo path.
 */
export type WikiSourceType =
  | 'user_chat'
  | 'slack_message'
  | 'spec_file'
  | 'pr_merge'
  | 'record_learning'
  | 'task_verified';

export interface WikiIngestInput {
  /** Absolute path to the vault root (containing SCHEMA.md). */
  vaultPath: string;
  /** Where the content came from. */
  sourceType: WikiSourceType;
  /** Stable reference for audit (URL, file path, WI id, chat msg id). */
  sourceRef: string;
  /** Body content to ingest. Empty bodies are rejected. */
  sourceBody: string;
  /** Session/user that authored the source — appears in the log header. */
  callerSession?: string;
  /** Writer's role as resolved by the server (undefined = owner/UI). Drives write_policy. */
  callerRole?: string;
  /** Optional override of the relative target path; defaults to `llm-curated/log.md`. */
  targetRelativePath?: string;
  /** Page writes only: the page's name. */
  title?: string;
  /** Page writes only: the one-line conclusion — what this means for us. */
  summary?: string;
  /** Page writes only: why it earns a page. */
  keepBecause?: WikiKeepBecause | string;
  tags?: string[];
  /** Page writes only: roles that may read it (default: the vault's default_visibility). */
  visibility?: string[];
  /** Page writes only: replace the page instead of appending to it (default: append). */
  replace?: boolean;
}

export interface WikiIngestResult {
  ok: true;
  pagesWritten: string[];
  logEntry: string;
  frozenPathsTouched: string[];
  /** True when the page landed in `_proposed/` (writer is a proposed_only role). */
  proposed?: boolean;
  /** PII pattern names that were masked (vault privacy `mask`). */
  masked?: string[];
  indexUpdated?: boolean;
}

export interface WikiIngestRefusedGate {
  ok: false;
  reason: 'retention_gate' | 'secret_detected' | 'pii_refused';
  message: string;
  /** retention_gate: missing fields; privacy: matched pattern names. */
  details: string[];
}

export interface WikiIngestRefusedFrozen {
  ok: false;
  reason: 'frozen_path';
  attemptedPath: string;
  frozenFolders: string[];
}

export interface WikiIngestRefusedInvalid {
  ok: false;
  reason: 'invalid_input' | 'schema_missing' | 'empty_body';
  message: string;
}

export type WikiIngestOutcome =
  | WikiIngestResult
  | WikiIngestRefusedFrozen
  | WikiIngestRefusedInvalid
  | WikiIngestRefusedGate;

const DEFAULT_LOG_RELATIVE_PATH = 'llm-curated/log.md';
const MAX_BODY_BYTES = 64 * 1024;

// Spec note (Steve, 2026-05-22): the earlier keyword-based
// `detectMessageShape` heuristic + `buildDecisionSlug` + `ingestDecision`
// dual-write were REMOVED. Routing into `llm-curated/<folder>/<page>.md`
// is now agent-driven via `wiki-process-queue` + the agent's own LLM gate
// — see WikiQueueService for the queue + the orchestrator system prompt
// for the rule that says "queue worth-saving content as you see it." This
// service stays low-level: it only writes the path the caller (skill,
// route, queue processor) specifies, after the frozen-path gate.

/**
 * Writes ingest pages to a vault. Construct one per process; stateless.
 */
export class WikiIngestService {
  private static instance: WikiIngestService | null = null;
  private readonly logger: ComponentLogger;
  private readonly schemaLoader: SchemaLoaderService;
  private readonly index: WikiIndexService;
  private readonly history: WikiHistoryService;

  constructor(schemaLoader?: SchemaLoaderService, index?: WikiIndexService, history?: WikiHistoryService) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiIngest');
    this.schemaLoader = schemaLoader ?? new SchemaLoaderService();
    this.index = index ?? WikiIndexService.getInstance();
    this.history = history ?? WikiHistoryService.getInstance();
  }

  static getInstance(): WikiIngestService {
    if (!this.instance) {
      this.instance = new WikiIngestService();
    }
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Ingest a single source into the vault.
   *
   * Errors are returned as structured outcomes — this method never throws
   * on legitimate refusals (frozen path, missing schema, empty body) so
   * callers can fold the result into their normal control flow.
   */
  async ingest(input: WikiIngestInput): Promise<WikiIngestOutcome> {
    const validation = this.validateInput(input);
    if (validation) {
      return validation;
    }

    let schema: VaultSchema;
    try {
      schema = await this.schemaLoader.load(input.vaultPath);
    } catch (err) {
      return {
        ok: false,
        reason: 'schema_missing',
        message: (err as Error).message,
      };
    }

    const target = (input.targetRelativePath ?? DEFAULT_LOG_RELATIVE_PATH).replace(/\\/g, '/').replace(/^\/+/, '');
    if (this.schemaLoader.isFrozenPath(schema, target)) {
      return {
        ok: false,
        reason: 'frozen_path',
        attemptedPath: target,
        frozenFolders: this.schemaLoader.getFrozenPaths(schema),
      };
    }
    if (target.includes('..')) {
      return { ok: false, reason: 'invalid_input', message: 'targetRelativePath may not contain ".."' };
    }

    // Confidentiality gate — applies to log entries and pages alike.
    const gate = applyPrivacyGate(input.sourceBody, schema.privacy);
    if (!gate.ok) {
      this.logger.warn('WikiIngest refused by the confidentiality gate', { vault: input.vaultPath, target, reason: gate.reason, patterns: gate.patterns });
      return { ok: false, reason: gate.reason, message: gate.message, details: gate.patterns };
    }
    const safeInput: WikiIngestInput = { ...input, sourceBody: gate.body };

    const isLogTarget = path.basename(target) === 'log.md';
    if (isLogTarget) {
      const absoluteTarget = path.join(input.vaultPath, target);
      await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
      const logEntry = this.formatLogEntry(safeInput);
      await this.appendOrCreate(absoluteTarget, logEntry);
      this.logger.info('WikiIngest wrote log entry', {
        vault: input.vaultPath,
        target,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        bodyBytes: safeInput.sourceBody.length,
      });
      return { ok: true, pagesWritten: [target], logEntry, frozenPathsTouched: [], masked: gate.masked };
    }

    return this.writePage(schema, target, safeInput, gate.masked);
  }

  /**
   * Write (create, append to, or replace) a knowledge page. See the module
   * header for the gates it passes.
   *
   * @param schema - Vault schema
   * @param target - Vault-relative page path (validated, not frozen)
   * @param input - Ingest input with a body that already passed the privacy gate
   * @param masked - PII pattern names masked in the body
   * @returns Outcome
   */
  private async writePage(
    schema: VaultSchema,
    target: string,
    input: WikiIngestInput,
    masked: string[],
  ): Promise<WikiIngestOutcome> {
    if (!target.startsWith('llm-curated/')) {
      return { ok: false, reason: 'invalid_input', message: 'pages live under llm-curated/ (log entries go to llm-curated/log.md)' };
    }
    const existingAbs = path.join(input.vaultPath, target);
    const existing = existsSync(existingAbs) ? parsePage(await fs.readFile(existingAbs, 'utf8')) : null;

    // Retention gate: a page needs title + summary + keep_because. An
    // append to an existing page that already has them inherits them.
    const supplied: Partial<WikiPageFrontmatter> = {
      ...(existing?.frontmatter ?? {}),
      ...(input.title ? { title: oneLine(input.title, WIKI_KB_CONSTANTS.TITLE_MAX_CHARS) } : {}),
      ...(input.summary ? { summary: oneLine(input.summary, WIKI_KB_CONSTANTS.SUMMARY_MAX_CHARS + 1) } : {}),
      ...(input.keepBecause ? { keep_because: input.keepBecause as WikiKeepBecause } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
    };
    if (!supplied.title && existing === null) supplied.title = this.titleFromBody(input.sourceBody);
    const refusal = checkRetention(supplied);
    if (refusal) {
      return { ok: false, reason: 'retention_gate', message: refusal.message, details: refusal.missing };
    }
    if (!schema.retention.keep_because.includes(String(supplied.keep_because))) {
      return {
        ok: false,
        reason: 'retention_gate',
        message: `This vault keeps pages only for: ${schema.retention.keep_because.join(' | ')}.`,
        details: ['keep_because'],
      };
    }

    // Write policy: proposed_only roles land in _proposed/.
    const decision = decideWrite(schema, input.callerRole);
    const proposed = decision === 'proposed';
    const finalTarget = proposed && !target.startsWith(`${WIKI_KB_CONSTANTS.PROPOSED_DIR}/`)
      ? `${WIKI_KB_CONSTANTS.PROPOSED_DIR}/${target.replace(/^llm-curated\//, '')}`
      : target;
    const abs = path.join(input.vaultPath, finalTarget);
    const prior = existsSync(abs) ? parsePage(await fs.readFile(abs, 'utf8')) : null;

    const now = new Date().toISOString();
    const author = input.callerSession ?? input.sourceRef;
    const fm: Partial<WikiPageFrontmatter> = {
      ...(prior?.frontmatter ?? {}),
      ...supplied,
      source: oneLine(input.sourceRef, 200),
      caller: oneLine(author, 80),
      recorded: prior?.frontmatter.recorded ?? now,
      updated: now,
      ...(proposed ? { proposed_by: oneLine(author, 80) } : {}),
    };
    if (!fm.visibility && schema.privacy.default_visibility.length > 0) fm.visibility = schema.privacy.default_visibility;

    const entry = this.formatPageEntry(input);
    const body = prior && !input.replace
      ? `${prior.body.replace(/\s+$/, '')}\n${entry}`
      : `# ${fm.title}\n${entry}`;

    await this.history.snapshot(input.vaultPath, finalTarget, author, 'write');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, serializePage(fm, body), 'utf8');

    let indexUpdated = false;
    if (!proposed) {
      await this.index.upsert(input.vaultPath, finalTarget, fm);
      indexUpdated = true;
    }

    this.logger.info(proposed ? 'WikiIngest wrote a proposed page' : 'WikiIngest wrote page', {
      vault: input.vaultPath,
      target: finalTarget,
      sourceType: input.sourceType,
      keepBecause: fm.keep_because,
      callerRole: input.callerRole ?? 'owner',
      appended: !!prior && !input.replace,
    });
    return {
      ok: true,
      pagesWritten: [finalTarget],
      logEntry: entry,
      frozenPathsTouched: [],
      proposed,
      masked,
      indexUpdated,
    };
  }

  /**
   * The provenance block appended to a page for each ingest.
   *
   * @param input - Ingest input
   * @returns Markdown block
   */
  private formatPageEntry(input: WikiIngestInput): string {
    const ts = new Date().toISOString();
    const caller = this.sanitizeOneLine(input.callerSession ?? input.sourceRef, 80);
    return [
      '',
      this.sanitizeBody(input.sourceBody),
      '',
      `<sub>${input.sourceType} · ${this.sanitizeOneLine(input.sourceRef, 200)} · ${caller} · ${ts}</sub>`,
      '',
    ].join('\n');
  }

  private titleFromBody(body: string): string {
    const heading = body.match(/^#\s+(.+)$/m);
    return oneLine(heading ? heading[1] : body, WIKI_KB_CONSTANTS.TITLE_MAX_CHARS);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private validateInput(input: WikiIngestInput): WikiIngestRefusedInvalid | null {
    if (!input.vaultPath || !path.isAbsolute(input.vaultPath)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: `vaultPath must be an absolute path, got "${input.vaultPath ?? ''}"`,
      };
    }
    if (!input.sourceType) {
      return { ok: false, reason: 'invalid_input', message: 'sourceType is required' };
    }
    if (!input.sourceRef) {
      return { ok: false, reason: 'invalid_input', message: 'sourceRef is required' };
    }
    const body = input.sourceBody ?? '';
    if (body.trim().length === 0) {
      return {
        ok: false,
        reason: 'empty_body',
        message: 'sourceBody is empty after trimming whitespace',
      };
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: `sourceBody exceeds ${MAX_BODY_BYTES} bytes`,
      };
    }
    return null;
  }

  /**
   * Build the markdown entry. Format is chosen to be safely append-only
   * (no preceding section to rewrite) and grep-friendly:
   *
   *   ## [<ISO>] <sourceType> | <callerSession or sourceRef>
   *
   *   ref: <sourceRef>
   *
   *   <body>
   */
  private formatLogEntry(input: WikiIngestInput): string {
    const ts = new Date().toISOString();
    const header = this.sanitizeOneLine(input.callerSession ?? input.sourceRef, 80);
    const body = this.sanitizeBody(input.sourceBody);
    const ref = this.sanitizeOneLine(input.sourceRef, 200);
    return [
      '',
      `## [${ts}] ${input.sourceType} | ${header}`,
      '',
      `ref: ${ref}`,
      '',
      body,
      '',
    ].join('\n');
  }

  private async appendOrCreate(absolutePath: string, entry: string): Promise<void> {
    if (!existsSync(absolutePath)) {
      const header = this.buildPageHeader();
      await fs.writeFile(absolutePath, header + entry, 'utf8');
      return;
    }
    await fs.appendFile(absolutePath, entry, 'utf8');
  }

  /**
   * Header for a freshly-created `log.md` (pages are built by {@link writePage}).
   *
   * @returns The activity-log preamble
   */
  private buildPageHeader(): string {
    return '# Activity log\n\nAppend-only log of ingested sources. Each entry: `## [<ISO>] <sourceType> | <caller>`.\n';
  }

  /**
   * Defuse markers a future skill might mis-route on: `[CHAT]`, `[NOTIFY]`,
   * `[EVENT]`, `[ESCALATION]` get a zero-width space inserted so they're
   * still human-readable but don't trigger regex matchers downstream.
   * (Mirrors the escalation-router sanitizer from PR #606.)
   */
  private sanitizeBody(body: string): string {
    const trimmed = body.replace(/\r\n/g, '\n').trim();
    return trimmed.replace(
      /\[(CHAT|NOTIFY|EVENT|ESCALATION)\]/g,
      (_match, tag) => `[​${tag}]`,
    );
  }

  private sanitizeOneLine(value: string, maxLen: number): string {
    const flat = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (flat.length <= maxLen) return flat;
    return flat.slice(0, maxLen - 1) + '…';
  }
}
