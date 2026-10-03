/**
 * Usage ledger backfill: rebuild missing days of the token ledger.
 *
 * Sources:
 * 1. Claude Code transcripts the live transcript sync already attributed to
 *    a Crewly session (its cursors map path → session). Each is read only up
 *    to the byte offset the live sync consumed, so a turn it has not reached
 *    yet stays its to count. The owner's own Claude Code sessions are never
 *    attributed to anyone, so they never enter the ledger.
 * 2. Earlier copies of `token-usage.json` (a backup, a quarantined
 *    `.corrupt-<ts>` file that still parses).
 *
 * Exactly once: transcript turns dedupe by `message.id` (the live sync's
 * parser), and every candidate is skipped when the ledger — any session —
 * already holds it (by message id, or by timestamp + tokens + model).
 *
 * Dry run by default. specs/2026-10-03-usage-ledger-durability.md §Backfill
 *
 * @module services/usage/usage-backfill.service
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { parseTranscriptTurns } from '../monitoring/claude-transcript-sync.service.js';
import { dropCrossSessionDuplicates, type SessionUsageRecord, type TokenUsageEvent, type TokenUsageService } from '../monitoring/token-usage.service.js';
import { localDateKey } from '../project-tickets/ticket-autopilot-decision.js';
import { USAGE_BACKFILL_CONSTANTS } from '../../constants.js';

/** A transcript the live sync attributed to a session, and how far it read it. */
export interface AttributedTranscript {
  sessionName: string;
  filePath: string;
  /** Bytes the live sync has consumed; the backfill reads no further */
  offset: number;
}

/** Dependencies (tests inject fakes). */
export interface UsageBackfillDeps {
  ledger: Pick<TokenUsageService, 'forEachEvent' | 'importEvents' | 'flushToDisk' | 'isBlocked'>;
  /** Transcripts attributed by the live sync (its cursors) */
  transcripts: () => Promise<AttributedTranscript[]>;
  /** Local day of a moment (default: local time) */
  dayOf?: (d: Date) => string;
}

/** What to rebuild. */
export interface UsageBackfillOptions {
  /** First local day, `YYYY-MM-DD` (inclusive) */
  from: string;
  /** Last local day, `YYYY-MM-DD` (inclusive) */
  to: string;
  /** Default true: report only, change nothing */
  dryRun?: boolean;
  /** Absolute paths of earlier `token-usage.json` copies to merge from */
  ledgerFiles?: string[];
}

/** Per-day counts in the report. */
export interface BackfillDayCount {
  transcripts: number;
  ledgerFiles: number;
}

/** What a backfill did (or would do). */
export interface UsageBackfillReport {
  dryRun: boolean;
  from: string;
  to: string;
  /** Events added (dry run: that would be added) */
  added: number;
  /** Candidates skipped because the ledger already holds them */
  alreadyPresent: number;
  /** Day → events added from each source */
  days: Record<string, BackfillDayCount>;
  /** Session → events added */
  sessions: Record<string, number>;
  transcriptsRead: number;
  /** Attributed transcripts no longer on disk (Claude Code deletes old ones) */
  missingTranscripts: string[];
  /** Transcripts attributed to more than one session; skipped */
  ambiguousTranscripts: string[];
  ledgerFiles: Array<{ path: string; events: number; error?: string }>;
}

/** Thrown for a request the backfill refuses (bad input, blocked ledger). */
export class UsageBackfillError extends Error {
  /** HTTP status for the API */
  readonly status: number;

  /**
   * @param message - Owner-facing text
   * @param status - HTTP status
   */
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UsageBackfillError';
    this.status = status;
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dedupe key that matches the same turn across sources: older ledger events
 * may lack `cachedInput`, so it is left out.
 *
 * @param e - Event
 * @returns Key
 */
function turnKey(e: Pick<TokenUsageEvent, 'timestamp' | 'input' | 'output' | 'model'>): string {
  return `${e.timestamp}|${e.input}|${e.output}|${e.model}`;
}

/**
 * Validate the options.
 *
 * @param opts - Options
 * @throws UsageBackfillError when invalid
 */
function validate(opts: UsageBackfillOptions): void {
  if (!DAY_RE.test(opts.from ?? '') || !DAY_RE.test(opts.to ?? '')) {
    throw new UsageBackfillError('from and to must be local days, YYYY-MM-DD');
  }
  if (opts.from > opts.to) throw new UsageBackfillError('from must not be after to');
  const span = (Date.parse(`${opts.to}T00:00:00Z`) - Date.parse(`${opts.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isFinite(span) || span > USAGE_BACKFILL_CONSTANTS.MAX_DAYS) {
    throw new UsageBackfillError(`At most ${USAGE_BACKFILL_CONSTANTS.MAX_DAYS} days per backfill`);
  }
  for (const f of opts.ledgerFiles ?? []) {
    if (typeof f !== 'string' || !path.isAbsolute(f)) throw new UsageBackfillError('ledgerFiles must be absolute paths');
  }
  if ((opts.ledgerFiles ?? []).length > USAGE_BACKFILL_CONSTANTS.MAX_LEDGER_FILES) {
    throw new UsageBackfillError(`At most ${USAGE_BACKFILL_CONSTANTS.MAX_LEDGER_FILES} ledger files per backfill`);
  }
}

/**
 * Read the first `limit` bytes of a file, cut back to the last whole line.
 *
 * @param filePath - File
 * @param limit - Byte limit
 * @returns Whole lines, or null when the file is gone
 */
async function readHead(filePath: string, limit: number): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    const length = Math.max(0, Math.min(limit, size));
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    const text = buf.toString('utf-8');
    const lastNewline = text.lastIndexOf('\n');
    return lastNewline < 0 ? '' : text.slice(0, lastNewline);
  } finally {
    await handle.close();
  }
}

/**
 * Rebuild missing days of the token ledger.
 *
 * @param deps - Ledger and transcript source
 * @param opts - Range, dry run, ledger backups
 * @returns What was (or would be) added
 * @throws UsageBackfillError on bad input or while the ledger is blocked
 */
export async function runUsageBackfill(deps: UsageBackfillDeps, opts: UsageBackfillOptions): Promise<UsageBackfillReport> {
  validate(opts);
  const dryRun = opts.dryRun !== false;
  if (!dryRun && deps.ledger.isBlocked()) {
    throw new UsageBackfillError('The token ledger file is unreadable and has not been set aside yet (is the disk full?); free some space and try again', 409);
  }
  const dayOf = deps.dayOf ?? localDateKey;
  const inRange = (timestamp: string): string | null => {
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) return null;
    const day = dayOf(new Date(ms));
    return day >= opts.from && day <= opts.to ? day : null;
  };

  // What the ledger already holds, in any session.
  const presentKeys = new Set<string>();
  const presentIds = new Set<string>();
  deps.ledger.forEachEvent((_s, e) => {
    presentKeys.add(turnKey(e));
    if (e.messageId) presentIds.add(e.messageId);
  });

  const report: UsageBackfillReport = {
    dryRun, from: opts.from, to: opts.to, added: 0, alreadyPresent: 0, days: {}, sessions: {},
    transcriptsRead: 0, missingTranscripts: [], ambiguousTranscripts: [], ledgerFiles: [],
  };
  const plan = new Map<string, { agentId: string; events: TokenUsageEvent[] }>();
  const take = (sessionName: string, agentId: string, e: TokenUsageEvent, day: string, source: keyof BackfillDayCount): void => {
    const key = turnKey(e);
    if (presentKeys.has(key) || (e.messageId && presentIds.has(e.messageId))) {
      report.alreadyPresent += 1;
      return;
    }
    presentKeys.add(key);
    if (e.messageId) presentIds.add(e.messageId);
    const bucket = plan.get(sessionName) ?? { agentId, events: [] };
    bucket.events.push(e);
    plan.set(sessionName, bucket);
    const d = report.days[day] ?? { transcripts: 0, ledgerFiles: 0 };
    d[source] += 1;
    report.days[day] = d;
    report.sessions[sessionName] = (report.sessions[sessionName] ?? 0) + 1;
    report.added += 1;
  };

  // 1. Transcripts attributed by the live sync.
  const attributed = await deps.transcripts();
  const owners = new Map<string, Set<string>>();
  for (const t of attributed) owners.set(t.filePath, (owners.get(t.filePath) ?? new Set<string>()).add(t.sessionName));
  const seenIds = new Set<string>();
  const done = new Set<string>();
  for (const t of attributed) {
    if (done.has(t.filePath)) continue;
    done.add(t.filePath);
    if ((owners.get(t.filePath)?.size ?? 0) > 1) {
      report.ambiguousTranscripts.push(t.filePath);
      continue;
    }
    const text = await readHead(t.filePath, t.offset);
    if (text === null) {
      report.missingTranscripts.push(t.filePath);
      continue;
    }
    report.transcriptsRead += 1;
    for (const turn of parseTranscriptTurns(text, seenIds)) {
      const day = inRange(turn.timestamp);
      if (!day) continue;
      // The same fields the live sync records, so the event is identical.
      take(t.sessionName, t.sessionName, {
        timestamp: turn.timestamp,
        agentId: t.sessionName,
        input: turn.input,
        output: turn.output,
        model: turn.model,
        cachedInput: turn.cacheRead + turn.cacheWrite,
        ...(turn.cacheWrite ? { cacheWrite: turn.cacheWrite } : {}),
        messageId: turn.messageId,
      }, day, 'transcripts');
    }
  }

  // 2. Earlier copies of the ledger.
  for (const file of opts.ledgerFiles ?? []) {
    let records: SessionUsageRecord[];
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('not a token ledger (expected a JSON array)');
      records = parsed as SessionUsageRecord[];
    } catch (err) {
      report.ledgerFiles.push({ path: file, events: 0, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    dropCrossSessionDuplicates(records);
    let events = 0;
    for (const r of records) {
      if (!r || typeof r.sessionName !== 'string') continue;
      for (const e of r.events ?? []) {
        if (!e || typeof e.timestamp !== 'string' || typeof e.input !== 'number' || typeof e.output !== 'number') continue;
        const day = inRange(e.timestamp);
        if (!day) continue;
        const before = report.added;
        take(r.sessionName, r.agentId ?? r.sessionName, { ...e }, day, 'ledgerFiles');
        if (report.added > before) events += 1;
      }
    }
    report.ledgerFiles.push({ path: file, events });
  }

  if (dryRun || report.added === 0) return report;

  let imported = 0;
  for (const [sessionName, { agentId, events }] of plan) {
    imported += deps.ledger.importEvents(sessionName, agentId, events).added;
  }
  report.added = imported;
  await deps.ledger.flushToDisk();
  return report;
}
