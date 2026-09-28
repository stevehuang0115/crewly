/**
 * Ticket intake outcome log (#828 coverage).
 *
 * One JSON line per owner message intake handled — created, appended to an
 * existing ticket, or ignored (with the reason) — so a receipt can say how
 * much of what the owner said it covers, instead of looking complete while
 * showing half (team norm: a check reports what it examined).
 *
 * The first line of the file is a `start` marker. A window that begins before
 * it cannot be counted, and the reader says so (`startedAt` later than the
 * window) rather than returning zeros.
 *
 * Append-only, best effort: a failed write is logged and never blocks intake.
 *
 * @module services/v3/ticket-intake-log
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { TICKET_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

/** What intake did with one owner message. */
export type IntakeLoggedAction = 'created' | 'appended' | 'ignored';

/** One logged owner message. */
export interface IntakeLogEvent {
  /** When intake handled it (ISO) */
  at: string;
  /** Message ref (dedupe key) */
  ref: string;
  action: IntakeLoggedAction;
  /** Why it was ignored (`trivial_or_short`, `status_ping`, …) */
  reason?: string;
  /** The ticket it created or went into */
  ticketId?: string;
  /** That ticket's number, for display */
  ticketNumber?: number;
  /**
   * Appended messages only: the ask classifier saw request signals in it
   * (ask score > 0) even though it stayed under the new-ask threshold.
   */
  askSignal?: boolean;
  /** Appended with askSignal only: the owner's words, shortened and redacted */
  text?: string;
}

/** What {@link IntakeOutcomeLog.read} returns. */
export interface IntakeLogReading {
  /** When counting started, or null when the log does not exist yet */
  startedAt: string | null;
  events: IntakeLogEvent[];
}

/** Records and reads intake outcomes. */
export interface IntakeOutcomeRecorder {
  record(event: IntakeLogEvent): Promise<void>;
  read(): Promise<IntakeLogReading>;
}

/** File-backed log (JSON lines). */
export class IntakeOutcomeLog implements IntakeOutcomeRecorder {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param dir - Directory (the Request files' directory)
   * @param now - Clock, for the start marker
   */
  constructor(dir: string, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(dir, TICKET_CONSTANTS.INTAKE_LOG_FILENAME);
  }

  /**
   * Append one event (serialised; the start marker is written first on a new file).
   *
   * @param event - The event
   */
  record(event: IntakeLogEvent): Promise<void> {
    const run = this.chain.then(async () => {
      try {
        let exists = true;
        try {
          await fs.access(this.file);
        } catch {
          exists = false;
        }
        const lines = exists ? '' : `${JSON.stringify({ type: 'start', at: this.now().toISOString() })}\n`;
        await fs.appendFile(this.file, `${lines}${JSON.stringify({ type: 'event', ...event })}\n`, 'utf8');
      } catch (err) {
        LoggerService.getInstance()
          .createComponentLogger('TicketIntakeLog')
          .warn('Intake outcome could not be logged (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Read the log. Malformed lines are skipped.
   *
   * @returns Start time and events
   */
  async read(): Promise<IntakeLogReading> {
    await this.chain;
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return { startedAt: null, events: [] };
    }
    let startedAt: string | null = null;
    const events: IntakeLogEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; at?: string } & IntakeLogEvent;
        if (obj.type === 'start' && typeof obj.at === 'string') startedAt ??= obj.at;
        else if (obj.type === 'event' && typeof obj.at === 'string' && typeof obj.action === 'string') {
          const event: Record<string, unknown> = { ...obj };
          delete event.type;
          events.push(event as unknown as IntakeLogEvent);
        }
      } catch {
        /* skip a torn line */
      }
    }
    return { startedAt, events };
  }
}

/** In-memory recorder (tests, replays). */
export class MemoryIntakeOutcomeLog implements IntakeOutcomeRecorder {
  readonly events: IntakeLogEvent[] = [];
  /**
   * @param startedAt - When counting started (null = never)
   */
  constructor(public startedAt: string | null) {}
  /** @param event - The event */
  async record(event: IntakeLogEvent): Promise<void> {
    this.events.push(event);
  }
  /** @returns Start time and events */
  async read(): Promise<IntakeLogReading> {
    return { startedAt: this.startedAt, events: [...this.events] };
  }
}
