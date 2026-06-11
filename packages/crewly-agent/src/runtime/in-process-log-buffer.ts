/**
 * In-Process Log Buffer
 *
 * Ring buffer that captures structured output from in-process Crewly Agent
 * runtimes. Provides the same interface as PTY terminal capture so the
 * frontend Side Terminal panel can display crewly-agent activity.
 *
 * Extends EventEmitter to support real-time WebSocket streaming of log entries
 * to the frontend Side Terminal panel.
 *
 * Also persists log entries to disk at ~/.crewly/logs/sessions/{sessionName}.log,
 * matching the file-based logging that PTY-based agents get via PtySessionBackend.
 *
 * @module services/agent/crewly-agent/in-process-log-buffer
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
/**
 * Local copies of the OSS constants this module relies on — standalone
 * crewly-agent must not depend on `crewly/backend/src/constants.ts`. Keep
 * these path fragments in sync with the values OSS writes elsewhere (any
 * code that reads back the same directory tree on disk).
 */
const CREWLY_CONSTANTS = {
  PATHS: {
    CREWLY_HOME: '.crewly',
    LOGS_DIR: 'logs',
  },
} as const;

const LOG_ROTATION_CONSTANTS = {
  SESSIONS_LOG_DIR: 'sessions',
} as const;

/**
 * Single log entry from an in-process agent session.
 */
export interface LogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Log level */
  level: 'info' | 'debug' | 'warn' | 'error';
  /** Log message */
  message: string;
}

/** Maximum number of entries to keep per session */
const MAX_ENTRIES_PER_SESSION = 500;

/**
 * Singleton buffer that captures in-process agent output.
 *
 * Used by CrewlyAgentRuntimeService to log tool calls, responses,
 * and errors. The terminal controller reads from this buffer when
 * the requested session is an in-process agent (no PTY).
 *
 * Emits 'data' events with (sessionName, formattedLine) when new entries
 * are appended, enabling real-time WebSocket streaming via TerminalGateway.
 *
 * @example
 * ```typescript
 * const buffer = InProcessLogBuffer.getInstance();
 * buffer.append('crewly-assistant', 'info', 'Calling get_team_status tool...');
 * const output = buffer.capture('crewly-assistant', 50);
 *
 * // Real-time streaming
 * buffer.on('data', (sessionName, formattedLine) => {
 *   console.log(`[${sessionName}] ${formattedLine}`);
 * });
 * ```
 */
export class InProcessLogBuffer extends EventEmitter {
  private static instance: InProcessLogBuffer | null = null;
  private sessions = new Map<string, LogEntry[]>();
  /** File write streams for persisting logs to disk */
  private logStreams = new Map<string, fs.WriteStream>();
  /** Resolved path to ~/.crewly/logs/sessions/ */
  private sessionLogsDir: string;

  constructor() {
    super();
    this.sessionLogsDir = path.join(
      os.homedir(),
      CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
      CREWLY_CONSTANTS.PATHS.LOGS_DIR,
      LOG_ROTATION_CONSTANTS.SESSIONS_LOG_DIR,
    );
    // Ensure directory exists (non-fatal if it fails)
    try {
      fs.mkdirSync(this.sessionLogsDir, { recursive: true });
    } catch {
      // Directory may already exist or be uncreatable — logging will be skipped
    }
  }

  /**
   * Get the singleton instance.
   *
   * @returns The shared InProcessLogBuffer instance
   */
  static getInstance(): InProcessLogBuffer {
    if (!InProcessLogBuffer.instance) {
      InProcessLogBuffer.instance = new InProcessLogBuffer();
    }
    return InProcessLogBuffer.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    if (InProcessLogBuffer.instance) {
      // Close all open file streams
      for (const stream of InProcessLogBuffer.instance.logStreams.values()) {
        try { stream.end(); } catch { /* ignore */ }
      }
      InProcessLogBuffer.instance.logStreams.clear();
      InProcessLogBuffer.instance.removeAllListeners();
    }
    InProcessLogBuffer.instance = null;
  }

  /**
   * Format a log entry into a single display line.
   *
   * @param entry - The log entry to format
   * @returns Formatted string like "[HH:MM:SS.mmm] ERROR: message"
   */
  private formatEntry(entry: LogEntry): string {
    const ts = entry.timestamp.substring(11, 23); // HH:MM:SS.mmm
    const prefix = entry.level === 'error' ? 'ERROR' : entry.level === 'warn' ? 'WARN' : entry.level === 'debug' ? 'DEBUG' : '';
    return prefix ? `[${ts}] ${prefix}: ${entry.message}` : `[${ts}] ${entry.message}`;
  }

  /**
   * Append a log entry for a session.
   *
   * Emits a 'data' event with the session name and formatted line for
   * real-time WebSocket streaming.
   *
   * @param sessionName - In-process agent session name
   * @param level - Log level
   * @param message - Log message text
   */
  append(sessionName: string, level: LogEntry['level'], message: string): void {
    if (!this.sessions.has(sessionName)) {
      this.sessions.set(sessionName, []);
    }
    const entries = this.sessions.get(sessionName)!;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    entries.push(entry);
    // Ring buffer — drop oldest entries
    if (entries.length > MAX_ENTRIES_PER_SESSION) {
      entries.splice(0, entries.length - MAX_ENTRIES_PER_SESSION);
    }

    // Emit for real-time WebSocket streaming
    const formattedLine = this.formatEntry(entry);
    this.emit('data', sessionName, formattedLine);

    // Persist to disk (fire-and-forget, non-blocking)
    this.writeToFile(sessionName, entry, formattedLine);
  }

  /**
   * Check if a session has any log entries.
   *
   * @param sessionName - Session to check
   * @returns True if the session has been registered with at least one entry
   */
  hasSession(sessionName: string): boolean {
    return this.sessions.has(sessionName);
  }

  /**
   * Capture recent output from an in-process session, formatted like
   * terminal output for frontend compatibility.
   *
   * @param sessionName - Session to capture from
   * @param lines - Maximum number of lines to return
   * @returns Formatted output string (one log entry per line)
   */
  capture(sessionName: string, lines = 100): string {
    const entries = this.sessions.get(sessionName);
    if (!entries || entries.length === 0) {
      return '[crewly-agent] No output yet';
    }
    const slice = entries.slice(-lines);
    return slice.map(e => this.formatEntry(e)).join('\n');
  }

  /**
   * Register a session (creates empty entry list and opens a file log stream).
   *
   * @param sessionName - Session to register
   */
  registerSession(sessionName: string): void {
    if (!this.sessions.has(sessionName)) {
      this.sessions.set(sessionName, []);
    }
    this.openLogStream(sessionName);
  }

  /**
   * Remove a session's log buffer and close its file stream.
   * The log file is preserved on disk for post-mortem analysis.
   *
   * @param sessionName - Session to remove
   */
  removeSession(sessionName: string): void {
    this.sessions.delete(sessionName);
    this.closeLogStream(sessionName);
  }

  /**
   * Get all registered in-process session names.
   *
   * @returns Array of session names
   */
  getSessionNames(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Clear all sessions and close all file streams (for testing).
   */
  clear(): void {
    this.sessions.clear();
    for (const stream of this.logStreams.values()) {
      try { stream.end(); } catch { /* ignore */ }
    }
    this.logStreams.clear();
  }

  // ===== Private file I/O helpers =====

  /**
   * Get the file path for a session's persistent log.
   *
   * @param sessionName - Session name
   * @returns Absolute path to the log file
   */
  private getLogPath(sessionName: string): string {
    return path.join(this.sessionLogsDir, `${sessionName}.log`);
  }

  /**
   * Open a writable file stream for a session log.
   * Appends a session marker so multiple runs are distinguishable.
   *
   * @param sessionName - Session name
   */
  private openLogStream(sessionName: string): void {
    // Don't open duplicate streams
    if (this.logStreams.has(sessionName)) return;

    try {
      const logPath = this.getLogPath(sessionName);
      const fileExists = fs.existsSync(logPath);

      const stream = fs.createWriteStream(logPath, { flags: 'a' });
      stream.on('error', () => {
        // Silently remove broken streams — disk logging is best-effort
        this.logStreams.delete(sessionName);
      });

      const marker = fileExists ? 'RESTARTED' : 'STARTED';
      stream.write(`\n--- SESSION ${marker} at ${new Date().toISOString()} ---\n\n`);

      this.logStreams.set(sessionName, stream);
    } catch {
      // Non-fatal — in-memory buffer and WebSocket streaming still work
    }
  }

  /**
   * Close and remove the file stream for a session.
   *
   * @param sessionName - Session name
   */
  private closeLogStream(sessionName: string): void {
    const stream = this.logStreams.get(sessionName);
    if (stream) {
      try {
        stream.write(`\n--- SESSION ENDED at ${new Date().toISOString()} ---\n`);
        stream.end();
      } catch { /* ignore */ }
      this.logStreams.delete(sessionName);
    }
  }

  /**
   * Write a formatted log entry to the session's file stream.
   * Non-blocking, fire-and-forget — errors are silently ignored.
   *
   * @param sessionName - Session name
   * @param entry - The log entry (for full timestamp in file)
   * @param formattedLine - Pre-formatted display line
   */
  private writeToFile(sessionName: string, entry: LogEntry, formattedLine: string): void {
    const stream = this.logStreams.get(sessionName);
    if (!stream) return;

    try {
      stream.write(`${entry.timestamp} ${formattedLine}\n`);
    } catch {
      // Non-fatal — disk logging is best-effort
    }
  }
}
