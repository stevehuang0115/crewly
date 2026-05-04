/**
 * Working Memory Service — auto-injectable "why am I awake" wake card
 * for agent prompts.
 *
 * Builds a compact (≤1.5KB) markdown card that summarizes the most-
 * recent active WorkItem assigned to an agent, the parent Request, the
 * upstream WorkItem chain (max 5), the required next action, and any
 * known constraints / open loops on the Request — so every agent wakes
 * with the answer to "why am I awake right now?" without having to
 * query the task pool manually.
 *
 * Per Memory Phase 1 / Fix M2: today, when an agent wakes (assigned
 * to a WorkItem), it doesn't automatically know its parent Request,
 * the upstream task chain, or relevant prior episodes — it receives
 * just the WorkItem description and has to query manually. This
 * service closes that gap by feeding a tiny wake card into prompt
 * assembly automatically, alongside the M1 mission card.
 *
 * Out of scope for Phase 1 (deferred to later phases):
 *   - Narrative summarization of upstream chain (no LLM round-trip)
 *   - Episode memory / event timeline (M5 work)
 *   - Vector embedding / semantic recall
 *   - Memory review queue / supersession
 *
 * @module services/memory/working-memory.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { RequestService } from '../v3/request.service.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/request.types.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on the rendered wake card. Spec calls for ≤1.5KB;
 * we cap at 1.5KB and truncate aggressively (drop optional sections
 * first, then trim verbose sections) when over budget.
 */
export const WAKE_CARD_HARD_CAP_BYTES = 1536;

/** Maximum WorkItems surfaced under "Upstream chain". */
const UPSTREAM_CHAIN_MAX_ITEMS = 5;

/**
 * WorkItem statuses that count as "currently active for this agent".
 *
 * An agent that is `proposed` an item is about to wake on it, an
 * `accepted` / `running` agent is mid-flight, and `blocked` /
 * `escalated` are still the agent's open loop. Terminal statuses
 * (done, verified, failed, cancelled) are NOT counted — the agent
 * has nothing to wake on if its only assignment is closed.
 */
const ACTIVE_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  'proposed',
  'accepted',
  'running',
  'blocked',
  'escalated',
]);

/** Maximum description length for a single line of WorkItem summary. */
const SUMMARY_LINE_MAX_CHARS = 140;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs accepted by `getWakeCardForAgent`.
 *
 * `sessionName` is what the WorkItem.target field is set to (e.g.
 * `crewly-product-leo-21a5477e`); the service uses this to find the
 * agent's currently-active WorkItem. `agentId` is used for logging
 * only (typically the same string, but we keep them separate so a
 * caller using memberId for logging can still set sessionName for
 * the lookup).
 */
export interface WakeCardRequest {
  /** Agent identifier — used for logging only. */
  agentId: string;
  /** Agent's session name — used to filter WorkItems by target. */
  sessionName: string;
  /** Absolute path to the project root that owns `.crewly/`. */
  projectPath: string;
  /** Optional team id — currently unused, reserved for future filters. */
  teamId?: string;
}

/**
 * Internal shape used during card rendering. Captures the data points
 * the spec calls out and lets `renderWakeCard` stay pure / testable.
 */
export interface WakeCardData {
  /** The current active WorkItem for this agent, if any. */
  current: WorkItem | null;
  /** The parent Request, if linked. */
  parentRequest: Request | null;
  /**
   * The upstream WorkItem chain (oldest → most-recent), up to
   * UPSTREAM_CHAIN_MAX_ITEMS entries. Excludes `current` itself.
   */
  upstreamChain: WorkItem[];
  /**
   * Open-loop / constraint summaries surfaced under "Known constraints".
   * Sourced from Request metadata when present.
   */
  openLoops: string[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Service that builds the working-memory wake card injected into
 * agent prompts.
 *
 * Singleton (mirrors {@link MissionContextService}). Caller side is
 * fail-soft: any read error logs a warning and the service returns
 * the empty string so prompt assembly never breaks.
 *
 * @example
 * ```typescript
 * const svc = WorkingMemoryService.getInstance();
 * const card = await svc.getWakeCardForAgent({
 *   agentId: 'member-uuid',
 *   sessionName: 'crewly-product-leo-21a5477e',
 *   projectPath: '/Users/me/projects/crewly',
 *   teamId: '28a4ac10-...',
 * });
 * if (card) prompt += `\n${card}`;
 * ```
 */
export class WorkingMemoryService {
  private static instance: WorkingMemoryService | null = null;
  private readonly logger: ComponentLogger;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger(
      'WorkingMemoryService',
    );
  }

  /** Get the shared singleton instance. */
  public static getInstance(): WorkingMemoryService {
    if (!WorkingMemoryService.instance) {
      WorkingMemoryService.instance = new WorkingMemoryService();
    }
    return WorkingMemoryService.instance;
  }

  /** Reset for tests. */
  public static clearInstance(): void {
    WorkingMemoryService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Build the working-memory wake card for an agent.
   *
   * Returns the empty string when no signals are available (no active
   * WorkItem assigned to this agent) — callers should treat empty
   * output as "skip the section entirely" rather than rendering an
   * empty heading.
   *
   * Errors reading the task pool / request store are caught and logged
   * as warnings; the method still returns the empty string so prompt
   * assembly never breaks.
   *
   * @param req - Request inputs
   * @returns A ≤1.5KB markdown card, or `''` when nothing is worth showing
   */
  public async getWakeCardForAgent(req: WakeCardRequest): Promise<string> {
    let data: WakeCardData;
    try {
      data = await this.collectWakeData(req);
    } catch (error) {
      this.logger.warn('Failed to collect wake-card data', {
        agentId: req.agentId,
        sessionName: req.sessionName,
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }

    if (!data.current) {
      this.logger.debug('No active WorkItem — emitting empty wake card', {
        agentId: req.agentId,
        sessionName: req.sessionName,
      });
      return '';
    }

    const card = renderWakeCard(data);
    const capped = enforceHardCap(card, WAKE_CARD_HARD_CAP_BYTES);

    this.logger.debug('Wake card built', {
      agentId: req.agentId,
      sessionName: req.sessionName,
      bytes: Buffer.byteLength(capped, 'utf8'),
      currentWorkItemId: data.current.id,
      requestId: data.current.requestId,
      upstreamCount: data.upstreamChain.length,
    });

    return capped;
  }

  // -------------------------------------------------------------------------
  // Data collection
  // -------------------------------------------------------------------------

  /**
   * Gathers everything the renderer needs for one agent.
   *
   * Steps:
   *   1. Find the agent's most-recent active WorkItem in the task pool.
   *   2. If linked, load the parent Request.
   *   3. Walk the parentWorkItemId chain (most-recent → oldest), up to
   *      UPSTREAM_CHAIN_MAX_ITEMS, and reverse for chronological order.
   *   4. Extract open-loop / constraint summaries from Request metadata.
   *
   * @param req - Caller request
   * @returns Populated WakeCardData (current may be null when nothing
   *   is awake for this agent).
   */
  private async collectWakeData(req: WakeCardRequest): Promise<WakeCardData> {
    const pool = TaskPoolService.getInstance();
    const all = await pool.getAllItems();

    const current = pickCurrentWorkItem(all, req.sessionName);
    if (!current) {
      return { current: null, parentRequest: null, upstreamChain: [], openLoops: [] };
    }

    const parentRequest = current.requestId
      ? await this.loadRequest(current.requestId, req.projectPath)
      : null;

    const upstreamChain = buildUpstreamChain(all, current, UPSTREAM_CHAIN_MAX_ITEMS);

    const openLoops = collectOpenLoops(parentRequest);

    return { current, parentRequest, upstreamChain, openLoops };
  }

  /**
   * Loads a Request by id, returning null on miss / error.
   *
   * Wraps {@link RequestService.getById} (singleton scoped to
   * `req.projectPath`) so a missing or malformed Request file is
   * downgraded to a debug-level warning rather than aborting the
   * whole wake-card build.
   */
  private async loadRequest(
    requestId: string,
    projectPath: string,
  ): Promise<Request | null> {
    try {
      const svc = RequestService.getInstance(projectPath);
      const req = await svc.getById(requestId);
      return req ?? null;
    } catch (error) {
      this.logger.debug('Wake-card: parent Request load failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Pick the most-recent active WorkItem assigned to an agent.
 *
 * "Active" = status in {@link ACTIVE_WORK_ITEM_STATUSES}. "Most recent"
 * = greatest `startedAt` (when set) else greatest `createdAt`. Ties
 * resolve to whichever item appears later in the iteration order
 * (effectively pool insertion order).
 *
 * Returns null when no item is currently active for this agent.
 *
 * @param items - All WorkItems in the pool
 * @param sessionName - The agent's session name (matched against `target`)
 */
export function pickCurrentWorkItem(
  items: readonly WorkItem[],
  sessionName: string,
): WorkItem | null {
  if (!sessionName) return null;

  let best: WorkItem | null = null;
  let bestTs = '';

  for (const item of items) {
    if (item.target !== sessionName) continue;
    if (!ACTIVE_WORK_ITEM_STATUSES.has(item.status)) continue;
    const ts = item.startedAt ?? item.createdAt ?? '';
    if (ts >= bestTs) {
      best = item;
      bestTs = ts;
    }
  }

  return best;
}

/**
 * Walk the `parentWorkItemId` chain to build the upstream task
 * sequence in chronological order (oldest → most-recent), capped at
 * `maxItems` entries. The current WorkItem itself is NOT included in
 * the result.
 *
 * Defends against cycles by tracking visited ids.
 *
 * @param items - All WorkItems in the pool
 * @param current - The wake-card's current WorkItem (chain anchor)
 * @param maxItems - Maximum number of upstream entries to surface
 */
export function buildUpstreamChain(
  items: readonly WorkItem[],
  current: WorkItem,
  maxItems: number,
): WorkItem[] {
  const byId = new Map(items.map((wi) => [wi.id, wi]));
  const seen = new Set<string>([current.id]);
  const chain: WorkItem[] = [];

  let cursorId: string | undefined = current.parentWorkItemId;
  while (cursorId && chain.length < maxItems) {
    if (seen.has(cursorId)) break; // cycle guard
    const parent = byId.get(cursorId);
    if (!parent) break;
    chain.push(parent);
    seen.add(cursorId);
    cursorId = parent.parentWorkItemId;
  }

  // chain currently runs most-recent → oldest; reverse to chronological
  return chain.reverse();
}

/**
 * Extract open-loop / constraint summaries from a parent Request.
 *
 * Today the Request type does not have a dedicated `openLoops` field,
 * so we derive one signal: the `confirmationReason` (when set —
 * indicates a pending user confirmation that the agent should be
 * aware of). When neither signal is present, returns an empty array
 * and the renderer drops the section entirely.
 *
 * Phase 2 (M5 / M6) will add richer signals (decisions, lessons,
 * outstanding sub-task statuses); this function is the extension
 * point.
 *
 * @param request - Parent Request, or null
 */
export function collectOpenLoops(request: Request | null): string[] {
  if (!request) return [];
  const loops: string[] = [];

  if (request.requiresConfirmation && request.confirmationReason) {
    loops.push(`Awaiting user confirmation: ${request.confirmationReason}`);
  }

  return loops;
}

/**
 * Render a one-line summary for a WorkItem suitable for the
 * upstream-chain bullet list. Format: `"<status> · <title>"` truncated
 * at SUMMARY_LINE_MAX_CHARS.
 */
export function summarizeWorkItem(wi: WorkItem): string {
  const title = (wi.title || '(untitled)').replace(/\s+/g, ' ').trim();
  const line = `${wi.status} · ${title}`;
  return truncate(line, SUMMARY_LINE_MAX_CHARS);
}

/**
 * Compose the full wake-card markdown from collected data.
 *
 * Sections (in order):
 *   1. Header — "## Why You Are Awake"
 *   2. WorkItem — title (always present when called)
 *   3. Parent Request — title + 1-line summary
 *   4. Upstream chain — bullet list of prior WorkItems (max 5)
 *   5. Required next action — from WorkItem description
 *   6. Known constraints / open loops — from Request metadata (if any)
 *
 * Sections 3-6 are emitted only when they have content; an absent
 * parent Request or empty chain simply drops the corresponding
 * heading.
 */
export function renderWakeCard(data: WakeCardData): string {
  const { current, parentRequest, upstreamChain, openLoops } = data;
  if (!current) return '';

  const lines: string[] = [];
  lines.push('## Why You Are Awake');
  lines.push('');

  // WorkItem (always present here)
  lines.push(`WorkItem: ${truncate((current.title || '(untitled)').replace(/\s+/g, ' ').trim(), SUMMARY_LINE_MAX_CHARS)}`);

  // Parent Request
  if (parentRequest) {
    const reqTitle = truncate(parentRequest.title.replace(/\s+/g, ' ').trim(), SUMMARY_LINE_MAX_CHARS);
    const reqSummary = parentRequest.description
      ? truncate(firstSentence(parentRequest.description), SUMMARY_LINE_MAX_CHARS)
      : '';
    lines.push(
      reqSummary
        ? `Parent Request: ${reqTitle} — ${reqSummary}`
        : `Parent Request: ${reqTitle}`,
    );
  }

  // Upstream chain
  if (upstreamChain.length > 0) {
    lines.push('Upstream chain:');
    for (const wi of upstreamChain) {
      lines.push(`- ${summarizeWorkItem(wi)}`);
    }
  }

  // Required next action — derived from WorkItem description.
  // Falls back to the title when description is absent, so the agent
  // always sees an actionable line.
  const nextAction = current.description
    ? firstSentence(current.description)
    : (current.title || '(untitled)');
  lines.push(`Required next action: ${truncate(nextAction.replace(/\s+/g, ' ').trim(), SUMMARY_LINE_MAX_CHARS)}`);

  // Known constraints / open loops
  if (openLoops.length > 0) {
    lines.push('');
    lines.push('Known constraints / open loops on this Request:');
    for (const loop of openLoops) {
      lines.push(`- ${truncate(loop, SUMMARY_LINE_MAX_CHARS)}`);
    }
  }

  return lines.join('\n').trim();
}

/**
 * Enforce the hard byte cap. Truncates the card at the last newline
 * boundary that still fits, so we never cut a markdown bullet
 * mid-line. If even the header exceeds the cap (shouldn't happen),
 * the input is hard-truncated by byte length.
 *
 * @param content - Original rendered card
 * @param capBytes - Hard cap in UTF-8 bytes
 * @returns The card, possibly truncated, never exceeding `capBytes`
 */
export function enforceHardCap(content: string, capBytes: number): string {
  if (Buffer.byteLength(content, 'utf8') <= capBytes) return content;

  const lines = content.split('\n');
  const kept: string[] = [];
  let runningBytes = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
    if (runningBytes + lineBytes > capBytes) break;
    kept.push(line);
    runningBytes += lineBytes;
  }

  if (kept.length === 0) {
    // Fallback: hard byte-truncate the first line.
    return Buffer.from(content, 'utf8').slice(0, capBytes).toString('utf8');
  }

  return kept.join('\n');
}

// ---------------------------------------------------------------------------
// Internal string utils
// ---------------------------------------------------------------------------

/** Truncate a string at `max` chars, appending `…` when shortened. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Return the first sentence (or first line) of a body of text. Used
 * to compress Request/WorkItem descriptions into a one-line summary
 * for the wake card.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  // Prefer first newline-terminated line if shorter than first
  // period-terminated sentence — keeps multi-line descriptions tidy.
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const periodMatch = trimmed.match(/^[^.!?]+[.!?]/);
  if (periodMatch && periodMatch[0].length < firstLine.length) {
    return periodMatch[0].trim();
  }
  return firstLine.trim();
}

/** Re-export for tests. */
export { ACTIVE_WORK_ITEM_STATUSES };
