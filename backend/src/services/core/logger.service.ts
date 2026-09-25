import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, appendFileSync } from 'fs';
import { ConfigService } from './config.service.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, any>;
  stack?: string;
  requestId?: string;
  userId?: string;
  component?: string;
}

export interface LoggerOptions {
  component?: string;
  requestId?: string;
  userId?: string;
}

interface LoggerConfig {
  level: LogLevel;
  enableFileLogging: boolean;
  logDir: string;
  maxFiles: number;
  format: 'json' | 'simple';
}

export class LoggerService {
  private static instance: LoggerService;
  private config: ConfigService;
  private logQueue: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  private readonly LOG_LEVELS: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
  };

  private constructor() {
    this.config = ConfigService.getInstance();
    this.initializeLogDirectory();
    this.startLogFlusher();
    this.setupProcessHandlers();
  }

  public static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  private getLoggingConfig(): LoggerConfig {
    const raw = (this.config.get('logging') as Partial<LoggerConfig> | undefined) ?? {};
    return {
      level: raw.level ?? 'info',
      enableFileLogging: raw.enableFileLogging ?? false,
      logDir: raw.logDir ?? 'logs',
      maxFiles: raw.maxFiles ?? 3,
      format: raw.format ?? 'simple',
    };
  }

  private async initializeLogDirectory(): Promise<void> {
    const logConfig = this.getLoggingConfig();
    if (!logConfig.enableFileLogging) return;

    const logDir = logConfig.logDir;
    try {
      if (!existsSync(logDir)) {
        await fs.mkdir(logDir, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  private startLogFlusher(): void {
    this.flushTimer = setInterval(() => {
      this.flushLogs();
    }, 5000); // Flush every 5 seconds
    // A periodic flush must never be the thing keeping the process alive:
    // one-shot CLI commands (crewly backup create/restore, ...) import the
    // backend services, and a ref'd interval left them hanging forever after
    // their work was done. The backend server stays alive through its
    // listening sockets; the 'exit' handler still drains the queue.
    this.flushTimer.unref();
  }

  /**
   * Register process-level hooks that keep the file log complete.
   *
   * A stop signal is NOT the end of the process: since the safe-restart
   * change the backend drains in-flight agent turns for up to 120s after
   * SIGTERM, then runs its graceful shutdown. Stopping the flusher on the
   * signal (the old behaviour) dropped that whole window — "Received
   * SIGTERM", the drain, "Server shut down gracefully" — from the daily log,
   * so no restart on 2026-09-24 showed its cause there. On a signal we only
   * flush what is queued and keep the periodic flusher running; the queue is
   * drained synchronously on 'exit', where async writes never complete.
   */
  private setupProcessHandlers(): void {
    process.on('exit', () => {
      this.flushLogsSync();
    });

    process.on('SIGINT', () => {
      void this.flushLogs();
    });

    process.on('SIGTERM', () => {
      void this.flushLogs();
    });

    process.on('uncaughtException', (error) => {
      this.error('Uncaught exception', { error: error.message, stack: error.stack });
      this.flushLogs();
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.error('Unhandled promise rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        promise: String(promise)
      });
    });
  }

  private shouldLog(level: LogLevel): boolean {
    const configLevel = this.getLoggingConfig().level;
    return this.LOG_LEVELS[level] <= this.LOG_LEVELS[configLevel];
  }

  private formatLogEntry(entry: LogEntry): string {
    const logConfig = this.getLoggingConfig();
    
    if (logConfig.format === 'json') {
      return JSON.stringify(entry);
    }

    // Simple format
    const timestamp = entry.timestamp;
    const level = entry.level.toUpperCase().padEnd(5);
    const component = entry.component ? `[${entry.component}]` : '';
    const requestId = entry.requestId ? `[${entry.requestId}]` : '';
    
    let logLine = `${timestamp} ${level} ${component}${requestId} ${entry.message}`;
    
    if (entry.context && Object.keys(entry.context).length > 0) {
      try {
        logLine += ` | Context: ${JSON.stringify(entry.context)}`;
      } catch (error) {
        logLine += ` | Context: [Circular/Unserializable]`;
      }
    }
    
    if (entry.stack) {
      logLine += `\n${entry.stack}`;
    }
    
    return logLine;
  }

  private async writeToFile(entry: LogEntry): Promise<void> {
    const logConfig = this.getLoggingConfig();
    if (!logConfig.enableFileLogging) return;

    try {
      const logDir = logConfig.logDir;
      const date = new Date().toISOString().split('T')[0];
      const filename = `crewly-${date}.log`;
      const logPath = path.join(logDir, filename);

      const formattedEntry = this.formatLogEntry(entry) + '\n';
      await fs.appendFile(logPath, formattedEntry, 'utf-8');

      // Check if we need to rotate logs
      await this.rotateLogs();
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  private async rotateLogs(): Promise<void> {
    const logConfig = this.getLoggingConfig();
    const logDir = logConfig.logDir;
    
    try {
      const files = await fs.readdir(logDir);
      if (!Array.isArray(files)) {
        return;
      }
      const logFiles = files
        .filter(file => file.startsWith('crewly-') && file.endsWith('.log'))
        .sort()
        .reverse();

      if (logFiles.length > logConfig.maxFiles) {
        const filesToDelete = logFiles.slice(logConfig.maxFiles);
        for (const file of filesToDelete) {
          await fs.unlink(path.join(logDir, file));
        }
      }
    } catch (error) {
      console.error('Failed to rotate logs:', error);
    }
  }

  private log(level: LogLevel, message: string, context?: Record<string, any>, options?: LoggerOptions): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
      component: options?.component,
      requestId: options?.requestId,
      userId: options?.userId
    };

    // Add stack trace for errors
    if (level === 'error' && context?.error instanceof Error) {
      entry.stack = context.error.stack;
    }

    // Console output (always enabled)
    this.writeToConsole(entry);

    // Queue for file logging
    if (this.getLoggingConfig().enableFileLogging) {
      this.logQueue.push(entry);
    }
  }

  private writeToConsole(entry: LogEntry): void {
    const formatted = this.formatLogEntry(entry);
    
    switch (entry.level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'debug':
        console.debug(formatted);
        break;
    }
  }

  private async flushLogs(): Promise<void> {
    if (this.logQueue.length === 0) return;

    const logsToFlush = [...this.logQueue];
    this.logQueue = [];

    for (const entry of logsToFlush) {
      await this.writeToFile(entry);
    }
  }

  /**
   * Write every queued entry to today's log file synchronously.
   *
   * Used from the process 'exit' handler, where the event loop no longer runs
   * and an async append would be abandoned. Rotation is skipped here; the next
   * boot's first async write rotates as usual. Errors are reported to stderr
   * and never thrown, since throwing inside 'exit' would mask the exit code.
   */
  private flushLogsSync(): void {
    if (this.logQueue.length === 0) return;
    const logConfig = this.getLoggingConfig();
    const entries = this.logQueue;
    this.logQueue = [];
    if (!logConfig.enableFileLogging) return;

    try {
      const date = new Date().toISOString().split('T')[0];
      const logPath = path.join(logConfig.logDir, `crewly-${date}.log`);
      const text = entries.map((entry) => this.formatLogEntry(entry) + '\n').join('');
      appendFileSync(logPath, text, 'utf-8');
    } catch (error) {
      console.error('Failed to write to log file on exit:', error);
    }
  }

  // Public logging methods
  public error(message: string, context?: Record<string, any>, options?: LoggerOptions): void {
    this.log('error', message, context, options);
  }

  public warn(message: string, context?: Record<string, any>, options?: LoggerOptions): void {
    this.log('warn', message, context, options);
  }

  public info(message: string, context?: Record<string, any>, options?: LoggerOptions): void {
    this.log('info', message, context, options);
  }

  public debug(message: string, context?: Record<string, any>, options?: LoggerOptions): void {
    this.log('debug', message, context, options);
  }

  // Convenience methods for common scenarios
  public logHttpRequest(method: string, url: string, statusCode: number, duration: number, options?: LoggerOptions): void {
    this.info('HTTP Request', {
      method,
      url,
      statusCode,
      duration,
      type: 'http_request'
    }, options);
  }

  public logHttpError(method: string, url: string, statusCode: number, error: string, options?: LoggerOptions): void {
    this.error('HTTP Error', {
      method,
      url,
      statusCode,
      error,
      type: 'http_error'
    }, options);
  }

  public logAgentAction(agentId: string, action: string, success: boolean, details?: Record<string, any>, options?: LoggerOptions): void {
    const level = success ? 'info' : 'warn';
    this.log(level, `Agent Action: ${action}`, {
      agentId,
      action,
      success,
      ...details,
      type: 'agent_action'
    }, options);
  }

  public logSystemMetric(metric: string, value: number, unit: string, options?: LoggerOptions): void {
    this.info('System Metric', {
      metric,
      value,
      unit,
      type: 'system_metric'
    }, options);
  }

  public logSecurityEvent(event: string, details: Record<string, any>, options?: LoggerOptions): void {
    this.warn('Security Event', {
      event,
      ...details,
      type: 'security_event'
    }, options);
  }

  public logDatabaseOperation(operation: string, table: string, duration: number, success: boolean, options?: LoggerOptions): void {
    const level = success ? 'debug' : 'error';
    this.log(level, 'Database Operation', {
      operation,
      table,
      duration,
      success,
      type: 'database_operation'
    }, options);
  }

  // Create scoped logger for a specific component
  public createComponentLogger(component: string): ComponentLogger {
    return new ComponentLogger(this, component);
  }

  // Create scoped logger for a specific request
  public createRequestLogger(requestId: string, userId?: string): RequestLogger {
    return new RequestLogger(this, requestId, userId);
  }

  // Get recent logs
  public async getRecentLogs(level?: LogLevel, limit: number = 100): Promise<LogEntry[]> {
    const logConfig = this.getLoggingConfig();
    if (!logConfig.enableFileLogging) {
      return [];
    }

    try {
      const logDir = logConfig.logDir;
      const today = new Date().toISOString().split('T')[0];
      const logPath = path.join(logDir, `crewly-${today}.log`);

      if (!existsSync(logPath)) {
        return [];
      }

      const content = await fs.readFile(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      
      const entries: LogEntry[] = [];
      for (const line of lines.slice(-limit)) {
        try {
          if (logConfig.format === 'json') {
            const entry = JSON.parse(line);
            if (!level || entry.level === level) {
              entries.push(entry);
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      return entries;
    } catch (error) {
      this.error('Failed to read recent logs', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /**
   * Stop the periodic flusher and drain queued file logs.
   *
   * Returns the flush promise so callers that can wait (CLI commands) get
   * their last lines on disk; the process 'exit' handler calls it without
   * awaiting, which is unchanged behaviour.
   *
   * @returns Resolves once the queued entries are written
   */
  public shutdown(): Promise<void> {
    if (this.isShuttingDown) return Promise.resolve();

    this.isShuttingDown = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    // Flush any remaining logs
    return this.flushLogs();
  }
}

// Component-scoped logger
export class ComponentLogger {
  constructor(private logger: LoggerService, private component: string) {}

  error(message: string, context?: Record<string, any>, options?: Omit<LoggerOptions, 'component'>): void {
    this.logger.error(message, context, { ...options, component: this.component });
  }

  warn(message: string, context?: Record<string, any>, options?: Omit<LoggerOptions, 'component'>): void {
    this.logger.warn(message, context, { ...options, component: this.component });
  }

  info(message: string, context?: Record<string, any>, options?: Omit<LoggerOptions, 'component'>): void {
    this.logger.info(message, context, { ...options, component: this.component });
  }

  debug(message: string, context?: Record<string, any>, options?: Omit<LoggerOptions, 'component'>): void {
    this.logger.debug(message, context, { ...options, component: this.component });
  }
}

// Request-scoped logger
export class RequestLogger {
  constructor(private logger: LoggerService, private requestId: string, private userId?: string) {}

  error(message: string, context?: Record<string, any>, options?: Omit<LoggerOptions, 'requestId' | 'userId'>): void {
    this.logger.error(message, context, { ...options, requestId: this.requestId, userId: this.userId });
  }

  warn(message: string, context?: Record<string, any>, options?: Omit<LoggerOptions, 'requestId' | 'userId'>): void {
    this.logger.warn(message, context, { ...options, requestId: this.requestId, userId: this.userId });
  }

  info(message: string, context?: Record<string, any>, options?: Omit<LoggerOptions, 'requestId' | 'userId'>): void {
    this.logger.info(message, context, { ...options, requestId: this.requestId, userId: this.userId });
  }

  debug(message: string, context?: Record<string, any>, options?: Omit<LoggerOptions, 'requestId' | 'userId'>): void {
    this.logger.debug(message, context, { ...options, requestId: this.requestId, userId: this.userId });
  }
}
