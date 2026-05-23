/**
 * WikiIngestService — write canonical pages into a vault's `llm-curated/`.
 *
 * Phase A scope per v2.1 spec: append entries to `llm-curated/log.md` for
 * every chat/spec/learning source. Decisions/pattern pages (separate files
 * under `llm-curated/decisions/`) are gated behind the LLM routing layer
 * which lands in Phase B.
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
  /** Optional override of the relative target path; defaults to `llm-curated/log.md`. */
  targetRelativePath?: string;
}

export interface WikiIngestResult {
  ok: true;
  pagesWritten: string[];
  logEntry: string;
  frozenPathsTouched: string[];
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
  | WikiIngestRefusedInvalid;

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

  constructor(schemaLoader?: SchemaLoaderService) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiIngest');
    this.schemaLoader = schemaLoader ?? new SchemaLoaderService();
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

    const target = input.targetRelativePath ?? DEFAULT_LOG_RELATIVE_PATH;
    if (this.schemaLoader.isFrozenPath(schema, target)) {
      return {
        ok: false,
        reason: 'frozen_path',
        attemptedPath: target,
        frozenFolders: this.schemaLoader.getFrozenPaths(schema),
      };
    }

    const absoluteTarget = path.join(input.vaultPath, target);
    await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });

    const logEntry = this.formatLogEntry(input);
    await this.appendOrCreate(absoluteTarget, logEntry, input);

    this.logger.info('WikiIngest wrote log entry', {
      vault: input.vaultPath,
      target,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      bodyBytes: input.sourceBody.length,
    });

    return {
      ok: true,
      pagesWritten: [target],
      logEntry,
      frozenPathsTouched: [],
    };
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

  private async appendOrCreate(
    absolutePath: string,
    entry: string,
    input: WikiIngestInput,
  ): Promise<void> {
    if (!existsSync(absolutePath)) {
      const header = this.buildPageHeader(absolutePath, input);
      await fs.writeFile(absolutePath, header + entry, 'utf8');
      return;
    }
    await fs.appendFile(absolutePath, entry, 'utf8');
  }

  /**
   * Pick the right header for a freshly-created page:
   *   - `log.md`            → audit-log preamble (append-only)
   *   - `decisions/*.md`    → decision-page title + provenance block
   *   - anything else       → minimal title block from the source ref
   */
  private buildPageHeader(absolutePath: string, input: WikiIngestInput): string {
    const basename = absolutePath.split(/[/\\]/).pop() ?? '';
    if (basename === 'log.md') {
      return '# Activity log\n\nAppend-only log of ingested sources. Each entry: `## [<ISO>] <sourceType> | <caller>`.\n';
    }
    if (absolutePath.includes('/decisions/')) {
      const title = this.sanitizeOneLine(input.sourceBody, 80);
      const caller = input.callerSession ?? input.sourceRef;
      return [
        `# ${title}`,
        '',
        `> **source:** \`${this.sanitizeOneLine(input.sourceRef, 200)}\`  `,
        `> **caller:** \`${this.sanitizeOneLine(caller, 80)}\`  `,
        `> **recorded:** ${new Date().toISOString()}`,
        '',
        '---',
        '',
      ].join('\n');
    }
    // Generic non-log target: minimal title block.
    return `# ${this.sanitizeOneLine(input.sourceRef, 80)}\n\n`;
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
