/**
 * WikiProcessService — bundles "claim a pending item + build the
 * system-context the agent's LLM needs to classify it."
 *
 * Per Steve's 2026-05-22 redesign:
 *   - the skill DOES NOT pick a target folder. The agent picks.
 *   - there is NO preset taxonomy beyond the frozen folders (sop/,
 *     team-norm/, memory/, sop-overrides/). Everything under
 *     llm-curated/* is fair game; the agent invents folder names.
 *   - the agent reads the queue item's `reason` (which we forced it to
 *     write at queue-add time) PLUS the existing vault state (so it
 *     doesn't re-classify into a duplicate of an existing page).
 *
 * Lifecycle this service participates in:
 *   pending → (this service)  → claimed + context payload returned
 *           → (agent's LLM, outside the skill) picks target path
 *           → (agent calls wiki-ingest)         → page written
 *           → (agent calls queue/:id/process)   → status=processed
 *
 * @module services/wiki/wiki-process.service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { WikiQueueService, WikiQueueItem } from './wiki-queue.service.js';
import {
  WikiQueryService,
  WikiQuerySystemContext,
} from './wiki-query.service.js';

export interface WikiProcessClaimInput {
  /** Agent session claiming the item. */
  claimedBy: string;
  /** Filter the queue to a specific vault (default: any). */
  vaultPath?: string;
  /** Skip this many leading pending items. Lets the agent re-roll after a skip. */
  offset?: number;
  /** For the vault context: how many candidate pages to include. */
  topK?: number;
  /** For the vault context: how many recent log entries. */
  recentLogEntries?: number;
}

export interface WikiProcessClaimResult {
  /** The claimed queue item. */
  item: WikiQueueItem;
  /**
   * System-context the agent's LLM should classify against. Includes the
   * vault SCHEMA, frozen-path list, recent log, and top-K candidate pages
   * by keyword overlap with the queue item's content.
   *
   * `null` if the vault has no SCHEMA.md (rare — vault wasn't initialized).
   */
  vaultContext: WikiQuerySystemContext | null;
  /** Synthesis instructions for the agent's LLM. */
  classifierNotes: string[];
}

export type WikiProcessClaimOutcome =
  | { ok: true; result: WikiProcessClaimResult }
  | { ok: false; reason: 'no_pending_items' | 'vault_query_failed'; message: string };

/**
 * Stateless façade — both backing services (queue, query) are singletons.
 */
export class WikiProcessService {
  private static instance: WikiProcessService | null = null;
  private readonly logger: ComponentLogger;

  constructor(
    private readonly queue: WikiQueueService = WikiQueueService.getInstance(),
    private readonly query: WikiQueryService = WikiQueryService.getInstance(),
  ) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiProcess');
  }

  static getInstance(): WikiProcessService {
    if (!this.instance) this.instance = new WikiProcessService();
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Claim the next pending item + return the vault context the agent
   * needs to classify it. The caller (agent runtime) then runs an LLM
   * call against this context + the item's content/reason, picks a
   * target page, and calls `wiki-ingest` + `/queue/:id/process` to
   * commit.
   */
  async claimNext(input: WikiProcessClaimInput): Promise<WikiProcessClaimOutcome> {
    if (!input.claimedBy) {
      return {
        ok: false,
        reason: 'no_pending_items',
        message: 'claimedBy is required',
      };
    }
    const pending = await this.queue.list({
      status: 'pending',
      vaultPath: input.vaultPath,
      limit: 1 + (input.offset ?? 0),
    });
    const offset = input.offset ?? 0;
    if (pending.length <= offset) {
      return {
        ok: false,
        reason: 'no_pending_items',
        message: input.vaultPath
          ? `No pending items in queue for vault ${input.vaultPath}`
          : 'No pending items in queue',
      };
    }
    // Items are newest-first; oldest pending is the last one.
    // Phase 1 picks newest after offset; future heuristics can swap order.
    const target = pending[offset];

    const claimed = await this.queue.claim(target.id, input.claimedBy);

    // Build vault context for the agent's LLM. We use the queue item's
    // content as the query so the candidate-page search surfaces the
    // most-likely existing pages to merge into / dedupe against.
    const vaultQuery = await this.query.query({
      vaultPath: claimed.vaultPath,
      query: claimed.content,
      topK: input.topK ?? 5,
      recentLogEntries: input.recentLogEntries ?? 10,
    });

    if (!vaultQuery.ok) {
      this.logger.warn('WikiProcess vault query failed', {
        itemId: claimed.id,
        reason: vaultQuery.reason,
        message: vaultQuery.message,
      });
      // We've already claimed; return what we have. Caller's runtime can
      // still classify with just the item — the vault context is a help,
      // not a hard requirement.
      return {
        ok: true,
        result: {
          item: claimed,
          vaultContext: null,
          classifierNotes: this.classifierNotes(),
        },
      };
    }

    this.logger.info('WikiProcess claimed', {
      itemId: claimed.id,
      vaultPath: claimed.vaultPath,
      claimedBy: input.claimedBy,
      candidatePages: vaultQuery.context.candidatePages.length,
    });

    return {
      ok: true,
      result: {
        item: claimed,
        vaultContext: vaultQuery.context,
        classifierNotes: this.classifierNotes(),
      },
    };
  }

  /**
   * The contract the agent's LLM must honor when classifying. Kept
   * short so it can be inlined into the runtime's task-instruction.
   */
  private classifierNotes(): string[] {
    return [
      'You have ALREADY decided this item is wiki-worthy at queue-add time (see item.reason). Do NOT re-justify; classify.',
      'Pick the target page path under llm-curated/. You may invent sub-folder names — there is NO preset taxonomy. Examples: llm-curated/customers/anthropic.md, llm-curated/decisions/2026-05-22-pricing-lock.md, llm-curated/patterns/embedding-fallback.md.',
      'NEVER target a frozen folder (vaultContext.schemaSummary.frozenPaths). The ingest call will reject these with HTTP 422.',
      'PREFER merging into an existing relevant page over creating a new one. Use vaultContext.candidatePages to check first; only create a new page when nothing fits.',
      'If after reading the context you decide the item is actually NOT wiki-worthy after all (duplicate of existing content, low signal), mark it skipped via POST /queue/:id/skip with a `skipReason`.',
      'When committing: 1) call wiki-ingest with the target path; 2) call POST /queue/:id/process with { ingested, pagesWritten, targetPath, summary }.',
    ];
  }
}
