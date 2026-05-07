/**
 * Active Work Briefing Service
 *
 * Generates an authoritative-state briefing for an agent at session startup
 * (and on-demand mid-session via the `core/get-my-active-work` skill).
 *
 * Today the agent recovery prompt is memory-only — `SessionMemoryService`
 * dumps the last session summary, agent/project knowledge, daily logs, and
 * recent learning files. That is supplementary; it does NOT capture
 * authoritative runtime state. Symptom: an agent restarts amnesiac about
 * Requests it owes a reply on, queued WorkItems that survived the restart,
 * and in-flight delegations.
 *
 * This service mirrors `SessionMemoryService` (`generate*` + `format*`
 * methods, singleton, soft-fail wrapping at the call site) and produces a
 * per-agent slice of the live Request + WorkItem state. The briefing is
 * prepended ABOVE the memory briefing in the agent's startup prompt so the
 * first thing the agent reads is "what am I on the hook for RIGHT NOW".
 *
 * Sources:
 * - {@link RequestService.listAll} — all Requests on disk
 * - {@link TaskPoolService.getAllItems} — all WorkItems in the pool
 *
 * Design doc: `/tmp/agent-state-recovery-design.md` (architect output)
 * GitHub issue: stevehuang0115/crewly#395
 *
 * @module services/agent/active-work-briefing.service
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { LoggerService } from '../core/logger.service.js';
import type { ComponentLogger } from '../core/logger.service.js';
import { ORCHESTRATOR_ROLE, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Request, RequestStatus } from '../../types/v2/request.types.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';

// NOTE: We deliberately avoid statically importing `RequestService` and
// `TaskPoolService` so that consumers of this module — most notably the
// AgentRegistrationService test suite — do not transitively pull in
// `v3/v3-data.service.ts` and `v3/project-task-watcher.service.ts`
// (which loads `chokidar`, which fails to parse as ESM under ts-jest's
// CommonJS transform). The runtime singletons are loaded LAZILY through
// `nodeRequire` (defined just below) inside
// {@link ActiveWorkBriefingService.getInstance}.

/**
 * CJS-style `require` for the lazy load inside `getInstance`. This file
 * compiles to ESM (root package has `"type": "module"`) where the bare
 * `require` global is undefined — which is exactly the bug fixed here:
 * the previous bare `require(...)` calls threw `require is not defined`
 * for every agent registration that flowed through
 * `ActiveWorkBriefingService.getInstance()` (the active-work-briefing
 * controller and `AgentRegistrationService.activeWorkBriefing` path),
 * breaking the get-my-active-work skill at session startup.
 *
 * Pattern matches the canonical fix established by commit 070cd3e5
 * (`fix(esm): anchor createRequire to process.argv[1]`):
 * - Under ts-jest's CJS transpile, the global `require` is real, so we
 *   reuse it (cheaper, plays well with jest module mocking).
 * - Under ESM (production), we `createRequire` anchored to the entry
 *   script via `pathToFileURL(process.argv[1])` so Node's resolver walks
 *   up to find `node_modules`. We do NOT use
 *   `new Function('return import.meta.url')()` because that body
 *   evaluates in non-module scope and fails at runtime
 *   (`Cannot use 'import.meta' outside a module`).
 */
const nodeRequire: NodeRequire =
  typeof require === 'function'
    ? require
    : createRequire(pathToFileURL(process.argv[1] || process.cwd()).href);

/**
 * Narrow projection of `RequestService` used by the briefing — only
 * `listAll` is needed. Defining the contract here lets the test inject a
 * fake without dragging in the full RequestService surface.
 */
interface RequestProvider {
  listAll(): Promise<Request[]>;
}

/**
 * Narrow projection of `TaskPoolService` used by the briefing — only
 * `getAllItems` is needed.
 */
interface TaskPoolProvider {
  getAllItems(): Promise<WorkItem[]>;
}

// ---------------------------------------------------------------------------
// Constants — token budget caps (per design Q4)
// ---------------------------------------------------------------------------

/**
 * Per-section item cap shape used both for {@link DEFAULT_CAPS} and for
 * {@link GenerateOptions.caps} overrides. Kept as a plain `number` so the
 * orchestrator multiplier path can return the multiplied value without
 * confusing TypeScript with literal types.
 */
export interface BriefingCaps {
  openRequests: number;
  activeWorkItems: number;
  pendingReviews: number;
  outboundDelegations: number;
  recentlyAutoResolved: number;
}

/**
 * Default per-section item caps for non-orchestrator agents.
 * Total cap = 45 items, ~6,300 chars (~1,500 tokens).
 */
const DEFAULT_CAPS: BriefingCaps = {
  openRequests: 10,
  activeWorkItems: 15,
  pendingReviews: 5,
  outboundDelegations: 10,
  recentlyAutoResolved: 5,
};

/** Orchestrator gets system-wide visibility — caps × 3. */
const ORCHESTRATOR_CAP_MULTIPLIER = 3;

/**
 * Hard ceiling on the orchestrator's formatted briefing (chars). If the
 * formatted markdown crosses this threshold, the formatter drops description
 * fields to keep the prompt tractable. Bounded — does not truncate items.
 */
const ORCHESTRATOR_OVERFLOW_CHARS = 25_000;

/** Default recently-resolved window: 30 minutes. */
const DEFAULT_RECENTLY_RESOLVED_WINDOW_MS = 30 * 60 * 1000;

/** Per-item title cap to prevent unbounded growth. */
const MAX_TITLE_CHARS = 80;

/** Per-item description cap. */
const MAX_DESCRIPTION_CHARS = 120;

/**
 * Request statuses that count as "open / on the hook" for briefing
 * inclusion. Terminal statuses (`done`, `cancelled`) are excluded —
 * memory recall handles "what did I close last week".
 */
const ACTIVE_REQUEST_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  'open',
  'ready',
  'running',
  'blocked',
  'waiting_confirmation',
]);

/**
 * WorkItem statuses that are still "in-flight" for the agent (target of a
 * claim or work). Terminal statuses (`done`, `verified`, `cancelled`,
 * `failed`, `rejected`) are excluded — they are recovered via memory.
 */
const ACTIVE_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
  'queued',
  'scheduled',
  'proposed',
  'accepted',
  'running',
  'blocked',
  'escalated',
]);

/** Status indicating a WorkItem is awaiting verifier review. */
const PENDING_REVIEW_STATUS: WorkItemStatus = 'done_by_worker';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Priority value used for sorting briefing rows. */
export type BriefingPriority = 'high' | 'normal' | 'low';

/**
 * One Request row in the briefing.
 */
export interface OpenRequestRow {
  id: string;
  title: string;
  status: RequestStatus;
  priority: BriefingPriority;
  ageHours: number;
  source?: string;
}

/**
 * One WorkItem row in the briefing.
 */
export interface ActiveWorkItemRow {
  id: string;
  title: string;
  status: WorkItemStatus;
  ageHours: number;
  priority: BriefingPriority;
  requestId?: string;
  description?: string;
}

/**
 * Pending review row — a WorkItem in `done_by_worker` awaiting this agent's
 * verification.
 */
export interface PendingReviewRow {
  id: string;
  title: string;
  ageHours: number;
  claimedBy?: string;
}

/**
 * Outbound delegation row — a WorkItem this agent delegated, still in-flight.
 */
export interface OutboundDelegationRow {
  id: string;
  title: string;
  status: WorkItemStatus;
  ageHours: number;
  target?: string;
}

/**
 * Recently auto-resolved row — closed by an SLA / system action within the
 * configured window. Surfaces "this just closed while you were down".
 */
export interface RecentlyResolvedRow {
  id: string;
  title: string;
  resolvedAt: string;
  resolvedReason?: string;
}

/**
 * Per-section truncation marker. When a section exceeds its cap, the
 * service emits the top N rows + a marker telling the agent how many were
 * dropped and how to fetch the rest.
 */
export interface SectionTruncation {
  /** Total candidate items before the cap was applied. */
  totalCandidates: number;
  /** Per-section cap that was applied. */
  cap: number;
  /** True if any rows were dropped. */
  truncated: boolean;
}

/**
 * Briefing payload. Pure state, no formatting.
 */
export interface ActiveWorkBriefing {
  openRequests: OpenRequestRow[];
  activeWorkItems: ActiveWorkItemRow[];
  pendingReviews: PendingReviewRow[];
  outboundDelegations: OutboundDelegationRow[];
  recentlyAutoResolved: RecentlyResolvedRow[];
  /** Per-section truncation metadata. */
  truncation: {
    openRequests: SectionTruncation;
    activeWorkItems: SectionTruncation;
    pendingReviews: SectionTruncation;
    outboundDelegations: SectionTruncation;
    recentlyAutoResolved: SectionTruncation;
  };
  /** Aggregate truncation flag (any section truncated). */
  truncated: boolean;
  /** Snapshot timestamp. */
  generatedAt: string;
  /**
   * Raw counts before per-section caps. Useful for the agent to know
   * the system-wide load.
   */
  totalCounts: {
    requests: number;
    workItems: number;
  };
}

/**
 * Optional generation overrides — used by tests and by the skill endpoint
 * for fine-grained control.
 */
export interface GenerateOptions {
  /** Override the per-section caps. Useful for tests. */
  caps?: Partial<BriefingCaps>;
  /** Override the recently-resolved window in milliseconds. */
  recentlyResolvedWindowMs?: number;
  /** Override "now" for deterministic tests. */
  nowMs?: number;
}

/**
 * Memory hints map — caller passes keys like `wi:<id>` or `req:<id>`
 * mapped to a short note string. The formatter cross-references this map
 * when emitting each row and appends `(memory: <note>)` to the row line.
 *
 * Keys are namespaced so `req:` and `wi:` cannot collide.
 */
export type MemoryHints = ReadonlyMap<string, string>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Singleton service producing per-agent active-work briefings.
 *
 * Mirrors the `SessionMemoryService.generate* + format*` shape so the
 * `agent-registration.service.ts` glue can call them in parallel and
 * concatenate the markdown.
 *
 * Stateless beyond singleton bookkeeping — every call hits the live
 * `RequestService` + `TaskPoolService` instances.
 */
export class ActiveWorkBriefingService {
  private static instance: ActiveWorkBriefingService | null = null;

  private readonly logger: ComponentLogger;

  /**
   * Private constructor — use {@link getInstance}. The `requestServiceFactory`
   * and `taskPoolFactory` are dependency seams for tests; production code
   * lets {@link getInstance} provide the live singletons.
   */
  private constructor(
    private readonly requestServiceFactory: () => RequestProvider,
    private readonly taskPoolFactory: () => TaskPoolProvider,
  ) {
    this.logger = LoggerService.getInstance().createComponentLogger('ActiveWorkBriefingService');
  }

  /**
   * Returns the singleton instance.
   *
   * The `RequestService` and `TaskPoolService` modules are loaded LAZILY here
   * (CommonJS `require` rather than top-of-file `import`) so that consumers
   * of this module do not pay the import cost — and more importantly, do not
   * transitively load `chokidar` via `v3-data.service.ts` — until they
   * actually call `getInstance()`. This keeps the agent-registration test
   * suite mockable without forcing every caller to mock the v3 pipeline.
   */
  public static getInstance(): ActiveWorkBriefingService {
    if (!ActiveWorkBriefingService.instance) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { RequestService } = nodeRequire('../v3/request.service.js');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { TaskPoolService } = nodeRequire('../task-pool/task-pool.service.js');
      ActiveWorkBriefingService.instance = new ActiveWorkBriefingService(
        () => RequestService.getInstance(),
        () => TaskPoolService.getInstance(),
      );
    }
    return ActiveWorkBriefingService.instance;
  }

  /**
   * Resets the singleton — for tests only.
   */
  public static resetInstance(): void {
    ActiveWorkBriefingService.instance = null;
  }

  /**
   * Test-only escape hatch to swap the underlying service factories.
   * Production code never calls this; the public surface is the singleton.
   *
   * @param requestServiceFactory - Returns a `listAll` provider
   * @param taskPoolFactory - Returns a `getAllItems` provider
   */
  public static createForTest(
    requestServiceFactory: () => RequestProvider,
    taskPoolFactory: () => TaskPoolProvider,
  ): ActiveWorkBriefingService {
    return new ActiveWorkBriefingService(requestServiceFactory, taskPoolFactory);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Compute the effective per-section caps for the requested role. Orchestrator
   * gets caps × 3 for system-wide visibility; everyone else uses the defaults
   * (with optional overrides from {@link GenerateOptions.caps}).
   *
   * @param role - Agent role (orchestrator gets the multiplier)
   * @param overrides - Optional explicit caps that win over both defaults and
   *   the role multiplier.
   * @returns Effective caps for each section
   */
  private resolveCaps(
    role: string,
    overrides?: Partial<BriefingCaps>,
  ): BriefingCaps {
    const isOrchestrator = role === ORCHESTRATOR_ROLE;
    const multiplier = isOrchestrator ? ORCHESTRATOR_CAP_MULTIPLIER : 1;
    return {
      openRequests: overrides?.openRequests ?? DEFAULT_CAPS.openRequests * multiplier,
      activeWorkItems: overrides?.activeWorkItems ?? DEFAULT_CAPS.activeWorkItems * multiplier,
      pendingReviews: overrides?.pendingReviews ?? DEFAULT_CAPS.pendingReviews * multiplier,
      outboundDelegations:
        overrides?.outboundDelegations ?? DEFAULT_CAPS.outboundDelegations * multiplier,
      recentlyAutoResolved:
        overrides?.recentlyAutoResolved ?? DEFAULT_CAPS.recentlyAutoResolved * multiplier,
    };
  }

  /**
   * Convert a 'low' | 'normal' | 'high' priority to a sort key.
   * Higher number = higher priority (sorted DESC).
   *
   * @param p - Priority value
   * @returns Numeric sort key
   */
  private priorityRank(p: BriefingPriority | undefined): number {
    switch (p) {
      case 'high':
        return 3;
      case 'normal':
        return 2;
      case 'low':
        return 1;
      default:
        return 0;
    }
  }

  /**
   * Compute age in hours since `createdAt`. Negative or NaN inputs are
   * coerced to 0 — defensive against malformed timestamps.
   *
   * @param createdAt - ISO8601 timestamp
   * @param nowMs - Current time in milliseconds
   * @returns Age in hours (>= 0)
   */
  private ageHours(createdAt: string, nowMs: number): number {
    const created = new Date(createdAt).getTime();
    if (!Number.isFinite(created)) return 0;
    const diff = nowMs - created;
    return diff > 0 ? diff / (60 * 60 * 1000) : 0;
  }

  /**
   * Read a string-typed field from a `metadata` blob, or null if missing /
   * not a string. WorkItem.metadata is typed as `Record<string, unknown>` so
   * every read needs this guard.
   *
   * @param metadata - WorkItem.metadata or undefined
   * @param key - Field name to read
   * @returns Trimmed string value or null
   */
  private readMetadataString(
    metadata: Record<string, unknown> | undefined,
    key: string,
  ): string | null {
    if (!metadata) return null;
    const value = metadata[key];
    if (typeof value !== 'string' || value.length === 0) return null;
    return value;
  }

  /**
   * Apply the per-section cap. Returns the slice + a {@link SectionTruncation}
   * object that the formatter renders as a "... and X more" marker.
   *
   * @param items - Sorted candidate rows
   * @param cap - Per-section cap
   * @returns Truncation metadata + the kept rows
   */
  private applyCap<T>(items: T[], cap: number): { rows: T[]; truncation: SectionTruncation } {
    const rows = items.slice(0, cap);
    return {
      rows,
      truncation: {
        totalCandidates: items.length,
        cap,
        truncated: items.length > cap,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Filter / project — Request rows
  // -------------------------------------------------------------------------

  /**
   * Project Requests visible to this agent. Non-orchestrator agents only see
   * Requests where they are the `ownerAgent`; the orchestrator sees all open
   * Requests system-wide.
   *
   * @param requests - All Requests from {@link RequestService.listAll}
   * @param sessionName - Agent session name
   * @param role - Agent role
   * @param nowMs - "Now" for age computation
   * @returns Sorted candidate rows (priority DESC, then age DESC — older first)
   */
  private projectRequests(
    requests: Request[],
    sessionName: string,
    role: string,
    nowMs: number,
  ): OpenRequestRow[] {
    const isOrchestrator = role === ORCHESTRATOR_ROLE || sessionName === ORCHESTRATOR_SESSION_NAME;

    const filtered = requests.filter((r) => {
      if (!ACTIVE_REQUEST_STATUSES.has(r.status)) return false;
      if (isOrchestrator) return true;
      // Non-orchestrator agents: must be on the hook (ownerAgent === sessionName).
      return r.ownerAgent === sessionName;
    });

    const rows: OpenRequestRow[] = filtered.map((r) => ({
      id: r.id,
      title: this.truncateTitle(r.title),
      status: r.status,
      priority: r.priority,
      ageHours: this.ageHours(r.createdAt, nowMs),
      source: r.sourceConversationItemId,
    }));

    rows.sort(
      (a, b) =>
        this.priorityRank(b.priority) - this.priorityRank(a.priority) ||
        b.ageHours - a.ageHours,
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // Filter / project — WorkItem rows
  // -------------------------------------------------------------------------

  /**
   * Project active WorkItems for this agent: items the agent is on the hook
   * to execute (target=me) OR items the agent has actively claimed
   * (claimedBy=me, surfaced via `metadata.claimedBy`). Items targeted at this
   * agent but already claimed by *another* agent are excluded — they are
   * not actionable for the current session.
   *
   * Orchestrator override: include ALL active work items.
   *
   * @param items - All WorkItems from {@link TaskPoolService.getAllItems}
   * @param sessionName - Agent session name
   * @param role - Agent role
   * @param nowMs - "Now" for age computation
   * @returns Sorted candidate rows
   */
  private projectActiveWorkItems(
    items: WorkItem[],
    sessionName: string,
    role: string,
    nowMs: number,
  ): ActiveWorkItemRow[] {
    const isOrchestrator = role === ORCHESTRATOR_ROLE || sessionName === ORCHESTRATOR_SESSION_NAME;

    const filtered = items.filter((wi) => {
      if (!ACTIVE_WORK_ITEM_STATUSES.has(wi.status)) return false;
      if (isOrchestrator) return true;

      const claimedBy = this.readMetadataString(wi.metadata, 'claimedBy');
      const isTargetMe = wi.target === sessionName;
      const isClaimedByMe = claimedBy === sessionName;

      if (!isTargetMe && !isClaimedByMe) return false;
      // Excluded: target is me but another agent already claimed it.
      if (isTargetMe && claimedBy && claimedBy !== sessionName) return false;
      return true;
    });

    const rows: ActiveWorkItemRow[] = filtered.map((wi) => ({
      id: wi.id,
      title: this.truncateTitle(wi.title),
      status: wi.status,
      ageHours: this.ageHours(wi.createdAt, nowMs),
      priority: this.readPriorityFromMetadata(wi.metadata),
      requestId: wi.requestId,
      description: wi.description ? this.truncateDescription(wi.description) : undefined,
    }));

    rows.sort(
      (a, b) =>
        this.priorityRank(b.priority) - this.priorityRank(a.priority) ||
        b.ageHours - a.ageHours,
    );
    return rows;
  }

  /**
   * Pending review rows — WorkItems in `done_by_worker` where this agent
   * is the verifier. Verifier signal = `metadata.verifier === sessionName`
   * (TL/orchestrator pattern). For the orchestrator role we surface ALL
   * `done_by_worker` items system-wide.
   *
   * @param items - All WorkItems from the pool
   * @param sessionName - Agent session name
   * @param role - Agent role
   * @param nowMs - "Now" for age computation
   * @returns Sorted candidate rows (oldest first — review backlog)
   */
  private projectPendingReviews(
    items: WorkItem[],
    sessionName: string,
    role: string,
    nowMs: number,
  ): PendingReviewRow[] {
    const isOrchestrator = role === ORCHESTRATOR_ROLE || sessionName === ORCHESTRATOR_SESSION_NAME;

    const filtered = items.filter((wi) => {
      if (wi.status !== PENDING_REVIEW_STATUS) return false;
      if (isOrchestrator) return true;
      const verifier = this.readMetadataString(wi.metadata, 'verifier');
      return verifier === sessionName;
    });

    const rows: PendingReviewRow[] = filtered.map((wi) => ({
      id: wi.id,
      title: this.truncateTitle(wi.title),
      ageHours: this.ageHours(wi.createdAt, nowMs),
      claimedBy: this.readMetadataString(wi.metadata, 'claimedBy') ?? undefined,
    }));

    // Oldest first — review backlog should be drained FIFO.
    rows.sort((a, b) => b.ageHours - a.ageHours);
    return rows;
  }

  /**
   * Outbound delegations — WorkItems this agent delegated and that haven't
   * resolved yet. Identified by `metadata.delegatedBy === sessionName`.
   * Forward-compatible: if upstream code does not yet populate
   * `metadata.delegatedBy`, this section is empty.
   *
   * @param items - All WorkItems from the pool
   * @param sessionName - Agent session name
   * @param nowMs - "Now" for age computation
   * @returns Sorted candidate rows
   */
  private projectOutboundDelegations(
    items: WorkItem[],
    sessionName: string,
    nowMs: number,
  ): OutboundDelegationRow[] {
    const filtered = items.filter((wi) => {
      if (!ACTIVE_WORK_ITEM_STATUSES.has(wi.status)) return false;
      const delegatedBy = this.readMetadataString(wi.metadata, 'delegatedBy');
      return delegatedBy === sessionName;
    });

    const rows: OutboundDelegationRow[] = filtered.map((wi) => ({
      id: wi.id,
      title: this.truncateTitle(wi.title),
      status: wi.status,
      ageHours: this.ageHours(wi.createdAt, nowMs),
      target: wi.target,
    }));

    rows.sort((a, b) => b.ageHours - a.ageHours);
    return rows;
  }

  /**
   * Recently auto-resolved WorkItems within the configured window
   * (default 30 minutes). Surfaced so the agent knows what closed
   * automatically while it was down. Identified by
   * `metadata.slaResolvedAt` falling inside the window.
   *
   * @param items - All WorkItems from the pool
   * @param sessionName - Agent session name (filters to items relevant to this agent)
   * @param role - Agent role
   * @param nowMs - "Now" for age computation
   * @param windowMs - Window size in milliseconds
   * @returns Sorted candidate rows (most recent first)
   */
  private projectRecentlyResolved(
    items: WorkItem[],
    sessionName: string,
    role: string,
    nowMs: number,
    windowMs: number,
  ): RecentlyResolvedRow[] {
    const isOrchestrator = role === ORCHESTRATOR_ROLE || sessionName === ORCHESTRATOR_SESSION_NAME;
    const cutoff = nowMs - windowMs;

    const filtered = items.filter((wi) => {
      const resolvedAt = this.readMetadataString(wi.metadata, 'slaResolvedAt');
      if (!resolvedAt) return false;
      const ts = new Date(resolvedAt).getTime();
      if (!Number.isFinite(ts)) return false;
      if (ts < cutoff) return false;

      if (isOrchestrator) return true;
      const claimedBy = this.readMetadataString(wi.metadata, 'claimedBy');
      const delegatedBy = this.readMetadataString(wi.metadata, 'delegatedBy');
      return (
        wi.target === sessionName ||
        claimedBy === sessionName ||
        delegatedBy === sessionName
      );
    });

    const rows: RecentlyResolvedRow[] = filtered.map((wi) => ({
      id: wi.id,
      title: this.truncateTitle(wi.title),
      resolvedAt: this.readMetadataString(wi.metadata, 'slaResolvedAt') ?? '',
      resolvedReason: this.readMetadataString(wi.metadata, 'slaResolvedReason') ?? undefined,
    }));

    rows.sort((a, b) => new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime());
    return rows;
  }

  /**
   * Read a priority hint from WorkItem.metadata. Falls back to `'normal'`.
   *
   * @param metadata - WorkItem metadata blob
   * @returns Briefing priority
   */
  private readPriorityFromMetadata(
    metadata: Record<string, unknown> | undefined,
  ): BriefingPriority {
    const raw = this.readMetadataString(metadata, 'priority');
    if (raw === 'high' || raw === 'normal' || raw === 'low') return raw;
    return 'normal';
  }

  /**
   * Truncate a row title to {@link MAX_TITLE_CHARS}.
   *
   * @param title - Raw title
   * @returns Truncated title (with ellipsis suffix if cut)
   */
  private truncateTitle(title: string): string {
    if (title.length <= MAX_TITLE_CHARS) return title;
    return title.slice(0, MAX_TITLE_CHARS - 1) + '…';
  }

  /**
   * Truncate a row description to {@link MAX_DESCRIPTION_CHARS}. Replaces
   * newlines with spaces so a description never wraps the briefing layout.
   *
   * @param desc - Raw description
   * @returns Truncated description
   */
  private truncateDescription(desc: string): string {
    const oneLine = desc.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= MAX_DESCRIPTION_CHARS) return oneLine;
    return oneLine.slice(0, MAX_DESCRIPTION_CHARS - 1) + '…';
  }

  // -------------------------------------------------------------------------
  // Public API — generate
  // -------------------------------------------------------------------------

  /**
   * Generates an active-work briefing for the given agent.
   *
   * Pulls from {@link RequestService} + {@link TaskPoolService}, filters
   * to the agent's slice (orchestrator gets system-wide), applies per-section
   * caps, and returns the structured payload. The caller renders it via
   * {@link formatBriefingAsMarkdown}.
   *
   * Soft-fail policy: any error from the underlying services bubbles up.
   * The CALL SITE in `agent-registration.service.ts` wraps this in a try/catch
   * with WARN-level logging — we deliberately do NOT swallow errors here so
   * test scenarios can assert that the rejection occurs, and so the optional
   * skill endpoint can return a structured 500 response.
   *
   * @param sessionName - Agent session name (e.g. `crewly-product-sam-dd2b46f7`)
   * @param role - Agent role (`developer`, `orchestrator`, etc.)
   * @param options - Optional caps + window overrides for testing
   * @returns The structured briefing
   *
   * @throws Rethrows any error from {@link RequestService.listAll} or
   *   {@link TaskPoolService.getAllItems}.
   *
   * @example
   * ```typescript
   * const briefing = await ActiveWorkBriefingService.getInstance()
   *   .generateActiveWorkBriefing('dev-001', 'developer');
   * const md = ActiveWorkBriefingService.getInstance()
   *   .formatBriefingAsMarkdown(briefing);
   * ```
   */
  public async generateActiveWorkBriefing(
    sessionName: string,
    role: string,
    options: GenerateOptions = {},
  ): Promise<ActiveWorkBriefing> {
    const nowMs = options.nowMs ?? Date.now();
    const windowMs = options.recentlyResolvedWindowMs ?? DEFAULT_RECENTLY_RESOLVED_WINDOW_MS;
    const caps = this.resolveCaps(role, options.caps);

    // Fetch in parallel — both services are independent.
    const [requests, workItems] = await Promise.all([
      this.requestServiceFactory().listAll(),
      this.taskPoolFactory().getAllItems(),
    ]);

    const openRequestsAll = this.projectRequests(requests, sessionName, role, nowMs);
    const activeWorkItemsAll = this.projectActiveWorkItems(workItems, sessionName, role, nowMs);
    const pendingReviewsAll = this.projectPendingReviews(workItems, sessionName, role, nowMs);
    const outboundDelegationsAll = this.projectOutboundDelegations(workItems, sessionName, nowMs);
    const recentlyAutoResolvedAll = this.projectRecentlyResolved(
      workItems,
      sessionName,
      role,
      nowMs,
      windowMs,
    );

    const openRequests = this.applyCap(openRequestsAll, caps.openRequests);
    const activeWorkItems = this.applyCap(activeWorkItemsAll, caps.activeWorkItems);
    const pendingReviews = this.applyCap(pendingReviewsAll, caps.pendingReviews);
    const outboundDelegations = this.applyCap(outboundDelegationsAll, caps.outboundDelegations);
    const recentlyAutoResolved = this.applyCap(
      recentlyAutoResolvedAll,
      caps.recentlyAutoResolved,
    );

    const truncated =
      openRequests.truncation.truncated ||
      activeWorkItems.truncation.truncated ||
      pendingReviews.truncation.truncated ||
      outboundDelegations.truncation.truncated ||
      recentlyAutoResolved.truncation.truncated;

    return {
      openRequests: openRequests.rows,
      activeWorkItems: activeWorkItems.rows,
      pendingReviews: pendingReviews.rows,
      outboundDelegations: outboundDelegations.rows,
      recentlyAutoResolved: recentlyAutoResolved.rows,
      truncation: {
        openRequests: openRequests.truncation,
        activeWorkItems: activeWorkItems.truncation,
        pendingReviews: pendingReviews.truncation,
        outboundDelegations: outboundDelegations.truncation,
        recentlyAutoResolved: recentlyAutoResolved.truncation,
      },
      truncated,
      generatedAt: new Date(nowMs).toISOString(),
      totalCounts: {
        requests: requests.length,
        workItems: workItems.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Public API — format
  // -------------------------------------------------------------------------

  /**
   * Format a briefing as markdown suitable for prompt injection.
   *
   * Output structure:
   *
   * ```
   * ## Your Active Work
   *
   * ### Open Requests
   * - **request-abc** — Slack inbound — _open · 2h_ *(memory: marked done — verify)*
   * ...
   * ### Active WorkItems
   * - **wi-123** — Implement feature X — _running · 1h_
   *   - desc here
   * ...
   * ```
   *
   * If a {@link MemoryHints} map is provided, contradicting memory notes are
   * appended INLINE on each row, per design Q5/decision #2.
   *
   * Soft-formatting policy: empty briefing collapses to "(No active work —
   * fresh start)". Sections with zero rows are omitted (no empty headings).
   *
   * @param briefing - Structured briefing payload
   * @param memoryHints - Optional namespaced map of `req:<id>` / `wi:<id>` →
   *   short note string
   * @returns Markdown string
   */
  public formatBriefingAsMarkdown(
    briefing: ActiveWorkBriefing,
    memoryHints?: MemoryHints,
  ): string {
    const totalRows =
      briefing.openRequests.length +
      briefing.activeWorkItems.length +
      briefing.pendingReviews.length +
      briefing.outboundDelegations.length +
      briefing.recentlyAutoResolved.length;

    if (totalRows === 0) {
      return '## Your Active Work\n\n(No active work — fresh start)';
    }

    const sections: string[] = ['## Your Active Work'];

    // First pass — full description rendering. We may re-render in compact
    // mode below if the orchestrator's briefing crosses the overflow ceiling.
    sections.push(...this.renderSections(briefing, memoryHints, /* compact */ false));

    let md = sections.join('\n\n').trim();
    if (md.length > ORCHESTRATOR_OVERFLOW_CHARS) {
      this.logger.debug('Active-work briefing exceeded overflow ceiling — re-rendering compact', {
        chars: md.length,
        ceiling: ORCHESTRATOR_OVERFLOW_CHARS,
      });
      const compact: string[] = ['## Your Active Work'];
      compact.push(...this.renderSections(briefing, memoryHints, /* compact */ true));
      md = compact.join('\n\n').trim();
    }

    return md;
  }

  /**
   * Render the five briefing sub-sections to markdown lines. Pulled out of
   * {@link formatBriefingAsMarkdown} so the overflow-recover path can reuse
   * the same renderer with `compact=true` (drops descriptions to bound
   * the orchestrator briefing).
   *
   * @param briefing - Briefing payload
   * @param memoryHints - Optional contradiction notes
   * @param compact - If true, drop description lines under WorkItem rows
   * @returns Array of markdown blocks (joined by blank lines by caller)
   */
  private renderSections(
    briefing: ActiveWorkBriefing,
    memoryHints: MemoryHints | undefined,
    compact: boolean,
  ): string[] {
    const out: string[] = [];

    if (briefing.openRequests.length > 0) {
      out.push(this.renderOpenRequests(briefing.openRequests, briefing.truncation.openRequests, memoryHints));
    }
    if (briefing.activeWorkItems.length > 0) {
      out.push(
        this.renderActiveWorkItems(
          briefing.activeWorkItems,
          briefing.truncation.activeWorkItems,
          memoryHints,
          compact,
        ),
      );
    }
    if (briefing.pendingReviews.length > 0) {
      out.push(
        this.renderPendingReviews(
          briefing.pendingReviews,
          briefing.truncation.pendingReviews,
          memoryHints,
        ),
      );
    }
    if (briefing.outboundDelegations.length > 0) {
      out.push(
        this.renderOutboundDelegations(
          briefing.outboundDelegations,
          briefing.truncation.outboundDelegations,
          memoryHints,
        ),
      );
    }
    if (briefing.recentlyAutoResolved.length > 0) {
      out.push(
        this.renderRecentlyResolved(
          briefing.recentlyAutoResolved,
          briefing.truncation.recentlyAutoResolved,
          memoryHints,
        ),
      );
    }

    return out;
  }

  /**
   * Render the truncation marker line for a section. No-op when the section
   * was not truncated.
   *
   * @param truncation - Section truncation metadata
   * @returns Marker line (empty string if not truncated)
   */
  private renderTruncationMarker(truncation: SectionTruncation): string {
    if (!truncation.truncated) return '';
    const more = truncation.totalCandidates - truncation.cap;
    return `\n_… and ${more} more (call \`get-my-active-work\` for full list)_`;
  }

  /**
   * Append a memory-hint annotation to a row line, if a hint exists for the
   * given key. Renders the annotation italicized so it visually subordinates
   * to the actionable state row.
   *
   * @param line - Row line so far
   * @param key - Hint lookup key (e.g. `req:abc-123`)
   * @param hints - Memory hints map (optional)
   * @returns The line with annotation appended, or unchanged
   */
  private appendMemoryHint(line: string, key: string, hints: MemoryHints | undefined): string {
    if (!hints) return line;
    const note = hints.get(key);
    if (!note) return line;
    return `${line} *(memory: ${note})*`;
  }

  /** Format hours into a compact "Nh" / "Nm" string for row metadata. */
  private formatAge(ageHours: number): string {
    if (ageHours < 1) return `${Math.max(1, Math.round(ageHours * 60))}m`;
    return `${Math.round(ageHours)}h`;
  }

  /**
   * Render the Open Requests section.
   *
   * @param rows - Capped rows
   * @param truncation - Section truncation metadata
   * @param hints - Memory hints
   * @returns Markdown block
   */
  private renderOpenRequests(
    rows: OpenRequestRow[],
    truncation: SectionTruncation,
    hints: MemoryHints | undefined,
  ): string {
    const lines = ['### Open Requests'];
    for (const row of rows) {
      const base = `- **${row.id}** — ${row.title} — _${row.status} · ${row.priority} · ${this.formatAge(row.ageHours)}_`;
      lines.push(this.appendMemoryHint(base, `req:${row.id}`, hints));
    }
    const marker = this.renderTruncationMarker(truncation);
    return lines.join('\n') + marker;
  }

  /**
   * Render the Active WorkItems section.
   *
   * @param rows - Capped rows
   * @param truncation - Section truncation metadata
   * @param hints - Memory hints
   * @param compact - If true, drop description lines (orchestrator overflow)
   * @returns Markdown block
   */
  private renderActiveWorkItems(
    rows: ActiveWorkItemRow[],
    truncation: SectionTruncation,
    hints: MemoryHints | undefined,
    compact: boolean,
  ): string {
    const lines = ['### Active WorkItems'];
    for (const row of rows) {
      const reqRef = row.requestId ? ` · req=${row.requestId}` : '';
      const base = `- **${row.id}** — ${row.title} — _${row.status} · ${row.priority} · ${this.formatAge(row.ageHours)}${reqRef}_`;
      lines.push(this.appendMemoryHint(base, `wi:${row.id}`, hints));
      if (!compact && row.description) {
        lines.push(`  - ${row.description}`);
      }
    }
    const marker = this.renderTruncationMarker(truncation);
    return lines.join('\n') + marker;
  }

  /**
   * Render the Pending Reviews section.
   *
   * @param rows - Capped rows
   * @param truncation - Section truncation metadata
   * @param hints - Memory hints
   * @returns Markdown block
   */
  private renderPendingReviews(
    rows: PendingReviewRow[],
    truncation: SectionTruncation,
    hints: MemoryHints | undefined,
  ): string {
    const lines = ['### Pending Reviews'];
    for (const row of rows) {
      const claimedBy = row.claimedBy ? ` · by ${row.claimedBy}` : '';
      const base = `- **${row.id}** — ${row.title} — _${this.formatAge(row.ageHours)}${claimedBy}_`;
      lines.push(this.appendMemoryHint(base, `wi:${row.id}`, hints));
    }
    const marker = this.renderTruncationMarker(truncation);
    return lines.join('\n') + marker;
  }

  /**
   * Render the Outbound Delegations section.
   *
   * @param rows - Capped rows
   * @param truncation - Section truncation metadata
   * @param hints - Memory hints
   * @returns Markdown block
   */
  private renderOutboundDelegations(
    rows: OutboundDelegationRow[],
    truncation: SectionTruncation,
    hints: MemoryHints | undefined,
  ): string {
    const lines = ['### Outbound Delegations'];
    for (const row of rows) {
      const target = row.target ? ` → ${row.target}` : '';
      const base = `- **${row.id}** — ${row.title} — _${row.status} · ${this.formatAge(row.ageHours)}${target}_`;
      lines.push(this.appendMemoryHint(base, `wi:${row.id}`, hints));
    }
    const marker = this.renderTruncationMarker(truncation);
    return lines.join('\n') + marker;
  }

  /**
   * Render the Recently Auto-Resolved section.
   *
   * @param rows - Capped rows
   * @param truncation - Section truncation metadata
   * @param hints - Memory hints
   * @returns Markdown block
   */
  private renderRecentlyResolved(
    rows: RecentlyResolvedRow[],
    truncation: SectionTruncation,
    hints: MemoryHints | undefined,
  ): string {
    const lines = ['### Recently Auto-Resolved (last 30min)'];
    for (const row of rows) {
      const reason = row.resolvedReason ? ` — ${row.resolvedReason}` : '';
      const base = `- **${row.id}** — ${row.title}${reason}`;
      lines.push(this.appendMemoryHint(base, `wi:${row.id}`, hints));
    }
    const marker = this.renderTruncationMarker(truncation);
    return lines.join('\n') + marker;
  }
}
