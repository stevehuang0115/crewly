/**
 * Owner receipt (#828) — the data shape shared by the data layer and the
 * renderer. The data layer fills a {@link ReceiptData}; the renderer turns it
 * into text. Wording never lives here, so the format can change without
 * touching how the data is collected.
 *
 * @module services/v3/owner-receipt/owner-receipt.types
 */

import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';

/** What happened to one ask. */
export type ReceiptOutcome =
  /** Ticket done */
  | 'done'
  /** Answered; waiting for the owner's OK (待验收) */
  | 'to_review'
  /** Someone is on it */
  | 'in_progress'
  /** Blocked */
  | 'blocked'
  /** Nobody is on it: no assignee and no WorkItem */
  | 'unowned'
  /** The owner said 不用记 */
  | 'dismissed';

/** All outcomes, in display order. */
export const RECEIPT_OUTCOMES: readonly ReceiptOutcome[] = [
  'done',
  'to_review',
  'in_progress',
  'blocked',
  'unowned',
  'dismissed',
] as const;

/** A deliverable found in a ticket's or WorkItem's output. */
export interface ReceiptDeliverable {
  kind: 'pr' | 'issue' | 'file' | 'link';
  /** URL, or a path for files */
  ref: string;
  /** Short label (`#827`, file name, host) */
  label: string;
}

/** One ask (one ticket). */
export interface ReceiptAsk {
  ticketId: string;
  tkt: string | null;
  /** The owner's words, shortened (no LLM) and redacted */
  text: string;
  outcome: ReceiptOutcome;
  kind: string;
  /** A question ticket (#827): answered = done, no acceptance step */
  isQuestion: boolean;
  /** Split from / said under another ticket (#827) */
  parentTicketId: string | null;
  assignee: string | null;
  deliverables: ReceiptDeliverable[];
  /** Why it is blocked, when known */
  blockedReason: string | null;
  createdAt: string;
}

/** Cost for one team: a real figure, or an honest "not tracked". */
export type ReceiptCost =
  | { status: 'tracked'; usd: number; tokens?: number }
  | { status: 'not_tracked'; reason: 'cumulative_meter' | 'no_data' };

/** The asks of one team. */
export interface ReceiptTeam {
  /** Team name, or {@link OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM} */
  team: string;
  asks: ReceiptAsk[];
  cost: ReceiptCost;
}

/** One thing waiting on the owner. */
export interface ReceiptWaiting {
  source: 'ticket_review' | 'owner_escalation';
  /** Ticket or WorkItem id */
  id: string;
  tkt: string | null;
  /** What it is about, shortened */
  text: string;
  /** The answer or question he is asked to look at, shortened */
  question: string | null;
  team: string;
  /** When it started waiting */
  since: string | null;
}

/** The window the receipt covers. */
export interface ReceiptWindow {
  /** Inclusive, ISO-8601 */
  from: string;
  /** Exclusive, ISO-8601 */
  to: string;
  /** How `from` was chosen */
  basis: 'since_last_receipt' | 'local_day' | 'explicit';
  timezone: string;
}

/**
 * How much of what the owner said the receipt covers (#828 coverage): every
 * owner message in the window, and what intake did with it. `unknown` when
 * the window starts before intake began counting — never zeros.
 */
export type ReceiptCoverage =
  | { status: 'known'; messages: number; created: number; appended: number; ignored: number }
  | { status: 'unknown'; reason: 'not_recorded' | 'window_before_log' };

/**
 * An appended message that still read like a request (the ask classifier saw
 * request signals below the new-ask threshold) — maybe it deserved its own
 * ticket. The owner says 「拆出来」; the agent runs `splitCommand`.
 */
export interface ReceiptPossiblyMissed {
  /** His words, shortened and redacted */
  text: string;
  /** The ticket it went into */
  ticketId: string;
  tkt: string | null;
  /** Message ref (the discussion entry to split out) */
  ref: string;
  /** For the agent: the split-ticket skill call that splits it out */
  splitCommand: string;
  at: string;
}

/** Everything a receipt says. */
export interface ReceiptData {
  window: ReceiptWindow;
  /** Asks by team; each ticket of the window appears exactly once */
  teams: ReceiptTeam[];
  /** Count per outcome over every ask */
  outcomes: Record<ReceiptOutcome, number>;
  /** Count per deliverable kind over every ask */
  deliverables: Record<ReceiptDeliverable['kind'], number>;
  /** Everything waiting on the owner, whatever day it was asked */
  waiting: ReceiptWaiting[];
  /** Number of asks in the window */
  askCount: number;
  /** How many owner messages the window had and what became of them */
  coverage: ReceiptCoverage;
  /** Appended messages that still read like a request, oldest first (all of them) */
  possiblyMissed: ReceiptPossiblyMissed[];
  generatedAt: string;
}

/** Owner-set delivery settings. */
export interface OwnerReceiptSettings {
  /** Send the Slack DM at all */
  enabled: boolean;
  /** Local send time, HH:MM 24h */
  time: string;
  /** IANA time zone */
  timezone: string;
}

/** Persisted state: settings + when the last receipt went out. */
export interface OwnerReceiptState {
  settings: OwnerReceiptSettings;
  /** ISO time the last receipt was sent (window start of the next one) */
  lastSentAt?: string;
  /** Local date (YYYY-MM-DD) of the last send, so one day gets one receipt */
  lastSentLocalDate?: string;
}

/** HH:MM, 00:00–23:59. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whether a string is an IANA time zone this runtime knows.
 *
 * @param tz - Candidate
 * @returns True when Intl accepts it
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a settings patch against the current settings.
 *
 * @param current - Settings in force
 * @param patch - Owner's changes (unknown shape from the API)
 * @returns The new settings, or the first problem found
 *
 * @example
 * ```typescript
 * applySettingsPatch(defaults, { time: '20:30' }); // { ok: true, settings: {..., time: '20:30'} }
 * applySettingsPatch(defaults, { time: '25:00' }); // { ok: false, error: '...' }
 * ```
 */
export function applySettingsPatch(
  current: OwnerReceiptSettings,
  patch: unknown,
): { ok: true; settings: OwnerReceiptSettings } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null) return { ok: false, error: 'settings must be an object' };
  const p = patch as Record<string, unknown>;
  const next: OwnerReceiptSettings = { ...current };
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== 'boolean') return { ok: false, error: '`enabled` must be true or false' };
    next.enabled = p.enabled;
  }
  if (p.time !== undefined) {
    if (typeof p.time !== 'string' || !TIME_PATTERN.test(p.time)) return { ok: false, error: '`time` must be HH:MM (24h), e.g. 21:00' };
    next.time = p.time;
  }
  if (p.timezone !== undefined) {
    if (!isValidTimeZone(p.timezone)) return { ok: false, error: '`timezone` must be an IANA time zone, e.g. America/New_York' };
    next.timezone = p.timezone;
  }
  return { ok: true, settings: next };
}

/**
 * The settings a fresh install starts with: on, 21:00, America/New_York.
 *
 * @returns Default settings
 */
export function defaultReceiptSettings(): OwnerReceiptSettings {
  return {
    enabled: true,
    time: OWNER_RECEIPT_CONSTANTS.DEFAULT_TIME,
    timezone: OWNER_RECEIPT_CONSTANTS.DEFAULT_TIMEZONE,
  };
}
