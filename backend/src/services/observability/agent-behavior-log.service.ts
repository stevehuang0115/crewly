/**
 * Agent Behavior Log — write/read service.
 *
 * Translates strongly-typed `BehaviorLogEvent` values into rows of the
 * `agent_behavior_log` table and reads them back as typed records.
 *
 * Design choices:
 * - One service instance owns one DB handle; tests pass `:memory:`.
 * - All writes are append-only inserts; no updates, no deletes.
 * - Best-effort logging — `record()` swallows DB errors after logging
 *   them, so observability never takes the request path down.
 * - Read APIs are minimal: this PR ships the schema + write surface.
 *   Digest/aggregation queries land in a follow-up.
 *
 * Wiring of producers (Slack-failure listener, prompt-size sampler,
 * orchestrator action logger) is intentionally out of scope for this
 * PR — see P0-5 / prompt-generator follow-ups.
 *
 * @module services/observability/agent-behavior-log.service
 */

import {
  openObservabilityDatabase,
  type ObservabilityDatabase,
  type OpenObservabilityDatabaseOptions,
} from './observability-db.js';
import {
  BEHAVIOR_LOG_EVENT_TYPES,
  type AgentActionEvent,
  type AgentEscalationEvent,
  type BehaviorLogEvent,
  type BehaviorLogEventType,
  type BehaviorLogRow,
  type PromptSizeBytesEvent,
  type SlackDeliveryFailedEvent,
} from './agent-behavior-log.types.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Read result shape
// ---------------------------------------------------------------------------

/**
 * Decoded behavior log row — `details_json` is parsed back into an
 * object, and `event_type` is narrowed to the discriminator union.
 */
export interface BehaviorLogRecord {
  id: number;
  ts: number;
  eventType: BehaviorLogEventType;
  agent: string;
  subject: string;
  taskId: string;
  reason: string;
  amount: number;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/**
 * Options for constructing an `AgentBehaviorLogService`. Either pass an
 * existing DB handle (preferred for tests) or a set of opener options
 * the service should use to open its own handle.
 */
export interface AgentBehaviorLogServiceOptions {
  /** Pre-opened database handle. Service does NOT take ownership. */
  db?: ObservabilityDatabase;
  /** Opener options used when `db` is not supplied. */
  openOptions?: OpenObservabilityDatabaseOptions;
  /** Optional time source — defaults to `Date.now`. Used in tests. */
  now?: () => number;
  /** Optional logger override. */
  logger?: ComponentLogger;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Append-only writer + minimal reader for the `agent_behavior_log`
 * table.
 *
 * @example
 * ```ts
 * const svc = new AgentBehaviorLogService();
 * svc.record({
 *   type: 'agent.action',
 *   agent: 'crewly-orc',
 *   actionType: 'delegate',
 *   taskId: 'req-123',
 *   details: { recipient: 'sam' },
 * });
 * ```
 */
export class AgentBehaviorLogService {
  private readonly db: ObservabilityDatabase;
  private readonly ownsDb: boolean;
  private readonly now: () => number;
  private readonly logger: ComponentLogger;
  private insertStmt: import('better-sqlite3').Statement | null = null;

  constructor(options: AgentBehaviorLogServiceOptions = {}) {
    this.logger =
      options.logger ??
      LoggerService.getInstance().createComponentLogger('AgentBehaviorLog');
    this.now = options.now ?? Date.now;

    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = openObservabilityDatabase(options.openOptions);
      this.ownsDb = true;
    }
  }

  /**
   * Lazily prepare and cache the insert statement. Avoids paying the
   * prepare cost for callers that only ever read.
   */
  private getInsertStmt(): import('better-sqlite3').Statement {
    if (!this.insertStmt) {
      this.insertStmt = this.db.prepare(
        `INSERT INTO agent_behavior_log
           (ts, event_type, agent, subject, task_id, reason, amount, details_json)
         VALUES
           (@ts, @event_type, @agent, @subject, @task_id, @reason, @amount, @details_json)`,
      );
    }
    return this.insertStmt;
  }

  /**
   * Record one behavior event.
   *
   * Translates the discriminated `BehaviorLogEvent` into a
   * `BehaviorLogRow`-compatible parameter object and inserts. Errors
   * are caught and logged — observability writes must NEVER throw into
   * the calling code path.
   *
   * @param event - The strongly-typed event to record
   * @returns The newly inserted row id, or `null` if the write failed
   */
  public record(event: BehaviorLogEvent): number | null {
    const params = this.toRowParams(event);
    try {
      const result = this.getInsertStmt().run(params);
      return Number(result.lastInsertRowid);
    } catch (err) {
      this.logger.warn('Failed to record behavior log event', {
        event_type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Translate a `BehaviorLogEvent` into the parameter object expected
   * by the prepared insert statement.
   *
   * The discriminator branch is exhaustive — adding a new event type
   * forces a TypeScript error here until the new branch is added.
   */
  private toRowParams(event: BehaviorLogEvent): {
    ts: number;
    event_type: BehaviorLogEventType;
    agent: string;
    subject: string;
    task_id: string;
    reason: string;
    amount: number;
    details_json: string;
  } {
    const ts = this.now();

    switch (event.type) {
      case BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION:
        return this.buildAgentActionParams(event, ts);
      case BEHAVIOR_LOG_EVENT_TYPES.AGENT_ESCALATION:
        return this.buildEscalationParams(event, ts);
      case BEHAVIOR_LOG_EVENT_TYPES.SLACK_DELIVERY_FAILED:
        return this.buildSlackFailureParams(event, ts);
      case BEHAVIOR_LOG_EVENT_TYPES.PROMPT_SIZE_BYTES:
        return this.buildPromptSizeParams(event, ts);
      default: {
        // Exhaustiveness guard — `_never` is `never` if the union is
        // covered; if a new variant lands and isn't handled above, this
        // line becomes a TypeScript error.
        const _never: never = event;
        throw new Error(
          `Unhandled behavior log event variant: ${JSON.stringify(_never)}`,
        );
      }
    }
  }

  /** Build params for an `agent.action` event. */
  private buildAgentActionParams(
    event: AgentActionEvent,
    ts: number,
  ): ReturnType<AgentBehaviorLogService['toRowParams']> {
    return {
      ts,
      event_type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
      agent: event.agent,
      subject: '',
      task_id: event.taskId ?? '',
      reason: event.actionType,
      amount: 0,
      details_json: stringifyDetails(event.details),
    };
  }

  /** Build params for an `agent.escalation` event. */
  private buildEscalationParams(
    event: AgentEscalationEvent,
    ts: number,
  ): ReturnType<AgentBehaviorLogService['toRowParams']> {
    return {
      ts,
      event_type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ESCALATION,
      agent: event.escalatingAgent,
      subject: event.escalatedTo,
      task_id: event.taskId ?? '',
      reason: event.reason,
      amount: 0,
      details_json: stringifyDetails(event.details),
    };
  }

  /** Build params for a `slack.delivery.failed` event. */
  private buildSlackFailureParams(
    event: SlackDeliveryFailedEvent,
    ts: number,
  ): ReturnType<AgentBehaviorLogService['toRowParams']> {
    return {
      ts,
      event_type: BEHAVIOR_LOG_EVENT_TYPES.SLACK_DELIVERY_FAILED,
      agent: event.agent,
      subject: event.thread,
      task_id: '',
      reason: event.reason,
      amount: 0,
      details_json: stringifyDetails(event.details),
    };
  }

  /** Build params for a `prompt.size.bytes` event. */
  private buildPromptSizeParams(
    event: PromptSizeBytesEvent,
    ts: number,
  ): ReturnType<AgentBehaviorLogService['toRowParams']> {
    return {
      ts,
      event_type: BEHAVIOR_LOG_EVENT_TYPES.PROMPT_SIZE_BYTES,
      agent: event.agent,
      subject: event.sessionId ?? '',
      task_id: '',
      reason: '',
      amount: Math.max(0, Math.floor(event.bytes)),
      details_json: stringifyDetails(event.details),
    };
  }

  // -------------------------------------------------------------------------
  // Read API (minimal — digest queries arrive in follow-up)
  // -------------------------------------------------------------------------

  /**
   * Return the most recent N rows, newest first. Optionally filter by
   * event type. Intended for diagnostics and tests; production digest
   * code should use a dedicated aggregation query.
   *
   * @param limit - Max rows to return (capped at 1000)
   * @param eventType - Optional event-type filter
   */
  public listRecent(
    limit = 100,
    eventType?: BehaviorLogEventType,
  ): BehaviorLogRecord[] {
    const cappedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const stmt = eventType
      ? this.db.prepare(
          `SELECT * FROM agent_behavior_log
             WHERE event_type = ?
             ORDER BY id DESC
             LIMIT ?`,
        )
      : this.db.prepare(
          `SELECT * FROM agent_behavior_log
             ORDER BY id DESC
             LIMIT ?`,
        );
    const rows = (
      eventType ? stmt.all(eventType, cappedLimit) : stmt.all(cappedLimit)
    ) as BehaviorLogRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Count rows by event type since a given timestamp. Useful for the
   * weekly digest's per-event totals.
   *
   * @param sinceTs - Inclusive ms-since-epoch lower bound (default 0 = all time)
   */
  public countByEvent(sinceTs = 0): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT event_type AS et, COUNT(*) AS n
           FROM agent_behavior_log
           WHERE ts >= ?
           GROUP BY event_type`,
      )
      .all(sinceTs) as Array<{ et: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) {
      out[r.et] = Number(r.n);
    }
    return out;
  }

  /**
   * Close the underlying DB handle if this service opened it. Safe to
   * call multiple times.
   */
  public close(): void {
    if (this.ownsDb) {
      try {
        this.db.close();
      } catch (err) {
        this.logger.warn('Error closing observability DB', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stringify a details payload to JSON, defaulting to '{}' when no
 * payload is supplied or the value is not serialisable. Never throws.
 */
function stringifyDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return '{}';
  try {
    return JSON.stringify(details);
  } catch {
    return '{}';
  }
}

/**
 * Decode a raw `BehaviorLogRow` (as returned by SQLite) into a
 * domain-friendly `BehaviorLogRecord` with `details_json` parsed.
 */
function rowToRecord(row: BehaviorLogRow): BehaviorLogRecord {
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.details_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to empty object */
  }
  return {
    id: row.id,
    ts: row.ts,
    eventType: row.event_type,
    agent: row.agent,
    subject: row.subject,
    taskId: row.task_id,
    reason: row.reason,
    amount: row.amount,
    details,
  };
}
