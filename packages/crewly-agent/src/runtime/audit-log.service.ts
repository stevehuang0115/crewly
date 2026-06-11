/**
 * Persistent Audit Log Service (SQLite)
 *
 * Provides durable, queryable audit logging using better-sqlite3.
 * Replaces the append-only JSONL approach with a proper relational store
 * that supports efficient filtering, pagination, and aggregation.
 *
 * Single WAL-mode database shared across all sessions. Thread-safe for
 * the single-threaded Node.js event loop (better-sqlite3 is synchronous).
 *
 * @module services/agent/crewly-agent/audit-log.service
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { AuditEntry, AuditLogFilters, ToolSensitivity } from './types.js';

/** Default database filename */
const DB_FILENAME = 'audit-log.sqlite';

/** Default directory under .crewly */
const AUDIT_DIR = 'audit-logs';

/** Maximum rows returned by a single query */
const MAX_QUERY_LIMIT = 10000;

/**
 * Extended audit entry stored in the database.
 * Adds an auto-incremented row ID and an action field for approval events.
 */
export interface AuditLogRow extends AuditEntry {
  /** Auto-incremented row ID */
  id: number;
  /** Action type: 'tool_call' | 'approval_granted' | 'approval_rejected' | 'approval_expired' */
  action: string;
  /** Who resolved an approval (e.g. 'api', 'auditor', 'auto-expire') */
  resolvedBy?: string;
  /** Approval ID if this entry relates to an approval event */
  approvalId?: string;
}

/**
 * Query filters for the audit log, extending the base AuditLogFilters.
 */
export interface AuditLogQueryFilters extends AuditLogFilters {
  /** Filter by session name */
  sessionName?: string;
  /** Filter by action type */
  action?: string;
  /** Filter entries after this ISO timestamp */
  since?: string;
  /** Filter entries before this ISO timestamp */
  until?: string;
  /** Offset for pagination */
  offset?: number;
}

/**
 * SQLite-backed persistent audit log service.
 *
 * @example
 * ```typescript
 * const log = new AuditLogService('/path/to/.crewly');
 * log.initialize();
 * log.append(auditEntry);
 * log.logApprovalEvent('approval-123', 'session-1', 'edit_file', 'destructive', 'approved', 'api');
 * const entries = log.query({ limit: 50, sessionName: 'session-1' });
 * log.close();
 * ```
 */
export class AuditLogService {
  private db: Database.Database | null = null;
  private dbPath: string;
  private initialized = false;

  /** Prepared statements for performance */
  private stmtInsert: Database.Statement | null = null;
  private stmtInsertApproval: Database.Statement | null = null;

  /**
   * Create a new AuditLogService.
   *
   * @param crewlyHome - Path to the .crewly directory
   * @param dbFilename - Database filename (default: audit-log.sqlite)
   */
  constructor(crewlyHome: string, dbFilename: string = DB_FILENAME) {
    const dir = join(crewlyHome, AUDIT_DIR);
    this.dbPath = join(dir, dbFilename);
  }

  /**
   * Initialize the database, creating tables if needed.
   * Enables WAL mode for better concurrent read performance.
   */
  initialize(): void {
    if (this.initialized) return;

    // Ensure directory exists
    const dir = join(this.dbPath, '..');
    mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT    NOT NULL,
        session_name  TEXT,
        tool_name     TEXT    NOT NULL,
        sensitivity   TEXT    NOT NULL,
        args          TEXT    NOT NULL DEFAULT '{}',
        success       INTEGER NOT NULL DEFAULT 1,
        error         TEXT,
        duration_ms   REAL    NOT NULL DEFAULT 0,
        action        TEXT    NOT NULL DEFAULT 'tool_call',
        resolved_by   TEXT,
        approval_id   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_session   ON audit_log(session_name);
      CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_tool      ON audit_log(tool_name);
    `);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO audit_log (timestamp, session_name, tool_name, sensitivity, args, success, error, duration_ms, action)
      VALUES (@timestamp, @sessionName, @toolName, @sensitivity, @args, @success, @error, @durationMs, 'tool_call')
    `);

    this.stmtInsertApproval = this.db.prepare(`
      INSERT INTO audit_log (timestamp, session_name, tool_name, sensitivity, args, success, duration_ms, action, resolved_by, approval_id)
      VALUES (@timestamp, @sessionName, @toolName, @sensitivity, @args, 1, 0, @action, @resolvedBy, @approvalId)
    `);

    this.initialized = true;
  }

  /**
   * Append a tool-call audit entry.
   *
   * @param entry - The AuditEntry from the agent runtime
   */
  append(entry: AuditEntry): void {
    this.ensureInitialized();
    this.stmtInsert!.run({
      timestamp: entry.timestamp,
      sessionName: entry.sessionName ?? null,
      toolName: entry.toolName,
      sensitivity: entry.sensitivity,
      args: JSON.stringify(entry.args),
      success: entry.success ? 1 : 0,
      error: entry.error ?? null,
      durationMs: entry.durationMs,
    });
  }

  /**
   * Log an approval lifecycle event (granted, rejected, expired).
   *
   * @param approvalId - The approval request ID
   * @param sessionName - Agent session name
   * @param toolName - Tool that was approved/rejected
   * @param sensitivity - Sensitivity classification
   * @param action - 'approval_granted' | 'approval_rejected' | 'approval_expired'
   * @param resolvedBy - Who resolved it
   */
  logApprovalEvent(
    approvalId: string,
    sessionName: string,
    toolName: string,
    sensitivity: ToolSensitivity,
    action: 'approval_granted' | 'approval_rejected' | 'approval_expired',
    resolvedBy: string,
  ): void {
    this.ensureInitialized();
    this.stmtInsertApproval!.run({
      timestamp: new Date().toISOString(),
      sessionName,
      toolName,
      sensitivity,
      args: '{}',
      action,
      resolvedBy,
      approvalId,
    });
  }

  /**
   * Query audit log entries with filters and pagination.
   *
   * @param filters - Query filters
   * @returns Array of audit log rows, most recent first
   */
  query(filters: AuditLogQueryFilters): AuditLogRow[] {
    this.ensureInitialized();

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.sessionName) {
      conditions.push('session_name = @sessionName');
      params.sessionName = filters.sessionName;
    }
    if (filters.sensitivity) {
      conditions.push('sensitivity = @sensitivity');
      params.sensitivity = filters.sensitivity;
    }
    if (filters.toolName) {
      conditions.push('tool_name = @toolName');
      params.toolName = filters.toolName;
    }
    if (filters.action) {
      conditions.push('action = @action');
      params.action = filters.action;
    }
    if (filters.since) {
      conditions.push('timestamp >= @since');
      params.since = filters.since;
    }
    if (filters.until) {
      conditions.push('timestamp <= @until');
      params.until = filters.until;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit || 100, MAX_QUERY_LIMIT);
    const offset = filters.offset || 0;

    const sql = `
      SELECT id, timestamp, session_name, tool_name, sensitivity, args,
             success, error, duration_ms, action, resolved_by, approval_id
      FROM audit_log
      ${where}
      ORDER BY id DESC
      LIMIT @limit OFFSET @offset
    `;

    params.limit = limit;
    params.offset = offset;

    const rows = this.db!.prepare(sql).all(params) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as number,
      timestamp: row.timestamp as string,
      sessionName: row.session_name as string | undefined,
      toolName: row.tool_name as string,
      sensitivity: row.sensitivity as ToolSensitivity,
      args: JSON.parse((row.args as string) || '{}'),
      success: (row.success as number) === 1,
      error: row.error as string | undefined,
      durationMs: row.duration_ms as number,
      action: row.action as string,
      resolvedBy: row.resolved_by as string | undefined,
      approvalId: row.approval_id as string | undefined,
    }));
  }

  /**
   * Get total count of entries matching filters (for pagination).
   *
   * @param filters - Same filters as query (limit/offset ignored)
   * @returns Total matching row count
   */
  count(filters: Partial<AuditLogQueryFilters> = {}): number {
    this.ensureInitialized();

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.sessionName) {
      conditions.push('session_name = @sessionName');
      params.sessionName = filters.sessionName;
    }
    if (filters.action) {
      conditions.push('action = @action');
      params.action = filters.action;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as cnt FROM audit_log ${where}`;
    const row = this.db!.prepare(sql).get(params) as { cnt: number };
    return row.cnt;
  }

  /**
   * Get the database file path.
   *
   * @returns Absolute path to the SQLite database
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Check if the service is initialized.
   *
   * @returns True if initialize() has been called
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Close the database connection.
   * Safe to call multiple times.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.stmtInsert = null;
      this.stmtInsertApproval = null;
      this.initialized = false;
    }
  }

  /**
   * Ensure the service is initialized before operations.
   *
   * @throws Error if not initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('AuditLogService not initialized. Call initialize() first.');
    }
  }
}
