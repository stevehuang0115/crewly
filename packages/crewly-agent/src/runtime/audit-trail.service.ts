/**
 * Audit Trail Service
 *
 * Provides file-based persistence for the security audit trail.
 * Writes audit entries as append-only JSONL (one JSON object per line)
 * for structured, queryable audit logging.
 *
 * @module services/agent/crewly-agent/audit-trail.service
 */

import { promises as fsPromises } from 'fs';
import { join } from 'path';
import type { AuditEntry, AuditLogFilters } from './types.js';

/** Default directory name for audit logs under .crewly */
const AUDIT_DIR = 'audit-logs';

/** Maximum lines to read when querying the log file */
const MAX_QUERY_LINES = 10000;

/**
 * File-based audit trail service.
 *
 * Persists audit entries as append-only JSONL files organized by session.
 * Each session gets its own log file for easy per-agent auditing.
 *
 * @example
 * ```typescript
 * const trail = new AuditTrailService('/path/to/.crewly', 'agent-session-1');
 * await trail.initialize();
 * await trail.append(auditEntry);
 * const entries = await trail.query({ limit: 50 });
 * ```
 */
export class AuditTrailService {
  private crewlyHome: string;
  private sessionName: string;
  private logDir: string;
  private logFile: string;
  private initialized = false;

  /**
   * Create a new AuditTrailService.
   *
   * @param crewlyHome - Path to the .crewly directory
   * @param sessionName - Agent session name for log file naming
   */
  constructor(crewlyHome: string, sessionName: string) {
    this.crewlyHome = crewlyHome;
    this.sessionName = sessionName;
    this.logDir = join(crewlyHome, AUDIT_DIR);
    this.logFile = join(this.logDir, `${sanitizeFilename(sessionName)}.jsonl`);
  }

  /**
   * Initialize the audit trail by ensuring the log directory exists.
   *
   * @throws Error if directory creation fails
   */
  async initialize(): Promise<void> {
    await fsPromises.mkdir(this.logDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Append an audit entry to the log file.
   *
   * @param entry - Audit entry to persist
   * @throws Error if not initialized or write fails
   */
  async append(entry: AuditEntry): Promise<void> {
    if (!this.initialized) {
      throw new Error('AuditTrailService not initialized. Call initialize() first.');
    }
    const line = JSON.stringify(entry) + '\n';
    await fsPromises.appendFile(this.logFile, line, 'utf8');
  }

  /**
   * Query persisted audit entries with optional filters.
   *
   * Reads the log file and returns matching entries in reverse
   * chronological order (most recent first).
   *
   * @param filters - Query filters for limit, sensitivity, and toolName
   * @returns Filtered audit entries
   */
  async query(filters: AuditLogFilters): Promise<AuditEntry[]> {
    if (!this.initialized) {
      throw new Error('AuditTrailService not initialized. Call initialize() first.');
    }

    let content: string;
    try {
      content = await fsPromises.readFile(this.logFile, 'utf8');
    } catch (err) {
      // File doesn't exist yet — no entries
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const lines = content.trim().split('\n').filter(Boolean);

    // Parse from end (most recent first), apply filters
    let entries: AuditEntry[] = [];
    const startIdx = Math.max(0, lines.length - MAX_QUERY_LINES);
    for (let i = lines.length - 1; i >= startIdx && entries.length < filters.limit; i--) {
      try {
        const entry: AuditEntry = JSON.parse(lines[i]);
        if (filters.sensitivity && entry.sensitivity !== filters.sensitivity) continue;
        if (filters.toolName && entry.toolName !== filters.toolName) continue;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Get the path to the audit log file.
   *
   * @returns Absolute path to the JSONL log file
   */
  getLogFilePath(): string {
    return this.logFile;
  }

  /**
   * Check if the service has been initialized.
   *
   * @returns True if initialize() has been called successfully
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Sanitize a session name for use as a filename.
 * Replaces non-alphanumeric characters (except hyphens and underscores) with hyphens.
 *
 * @param name - Raw session name
 * @returns Sanitized filename-safe string
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}
