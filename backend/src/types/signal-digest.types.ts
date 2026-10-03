/**
 * Daily signal digest (#987, specs/2026-10-03-signal-digest.md).
 *
 * A team lead collects a site's signals (GA4, Search Console, the site's
 * inbound mail, broken pages / JS errors), picks 3–5 actions and proposes
 * them. The owner gets ONE Slack card with Do / Skip per action. Do opens an
 * experiment ticket in the site's project; Skip keeps the action out of the
 * next digests for a while.
 *
 * @module types/signal-digest.types
 */

/** Where an action's signal came from. */
export type SignalSource = 'ga4' | 'gsc' | 'inbox' | 'errors' | 'other';

/** The owner's answer to one action. */
export type SignalChoice = 'do' | 'skip';

/**
 * State of one action:
 * - `open`: waiting for the owner;
 * - `do` / `skip`: answered;
 * - `expired`: a newer digest for the same site replaced it unanswered
 *   (it may be proposed again).
 */
export type SignalItemStatus = 'open' | SignalChoice | 'expired';

/** One proposed action as the team lead sends it. */
export interface SignalActionInput {
  /**
   * Stable identity of the action across days (`gsc:low-ctr:h1b visa fee`),
   * used to never re-propose what was tried or skipped.
   */
  key: string;
  source: SignalSource;
  /** What was seen ("'h1b fee' ranks #2 with 4% CTR on 900 impressions") */
  signal: string;
  /** What to do */
  proposal: string;
  /** What it should change, with a number when there is one */
  expectedEffect: string;
  /** How much work ("S — 1 h") */
  effort: string;
  /** The metric that tells whether it worked (experiment card), when known */
  metric?: string;
}

/** One action of a stored digest. */
export interface SignalDigestItem extends SignalActionInput {
  /** 1-based position on the card */
  n: number;
  status: SignalItemStatus;
  /** When the owner answered (or it expired) */
  answeredAt?: string;
  /** Slack user who answered; `dashboard` for the API */
  answeredBy?: string;
  /** Ticket a Do created (`CE-12`) */
  ticketId?: string;
  /** Why no ticket was created for a Do */
  ticketError?: string;
}

/** Where the card lives in Slack. */
export interface SignalDigestCardRef {
  slackChannelId: string;
  messageTs: string;
  /** Session whose bot posted it */
  postedBy: string;
  /** True when that session's own bot token was used */
  ownBot: boolean;
}

/** A stored digest. */
export interface SignalDigest {
  /** `SD-<n>` */
  id: string;
  /** Site the signals are about (`visa.careerengine.us`) */
  site: string;
  /** Team lead session that proposed it; its bot posts the card and it hears about each Do */
  asker: string;
  /** Asker's team (its channel carries the card) */
  teamId?: string;
  /** Project a Do ticket goes into (name, id or path) */
  project?: string;
  items: SignalDigestItem[];
  card?: SignalDigestCardRef;
  /** Why the card could not be posted */
  postError?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input of `POST /api/signal-digests`. */
export interface CreateSignalDigestInput {
  site?: unknown;
  project?: unknown;
  items?: unknown;
}

/** A blocked key in the site's history (`GET /api/signal-digests/history`). */
export interface SignalHistoryEntry {
  key: string;
  status: 'do' | 'skip' | 'open';
  /** When it was answered (or proposed, for `open`) */
  at: string;
  proposal: string;
  digestId: string;
  ticketId?: string;
  /** Until when it may not be proposed again (absent for `open`) */
  blockedUntil?: string;
}

/** Button `value` JSON of a digest card. */
export interface SignalButtonValue {
  /** Digest id */
  s: string;
  /** Item number */
  n: number;
  /** Choice */
  o: SignalChoice;
  /** Instance id the card belongs to (Cloud routes the click by it) */
  i: string;
}

/**
 * Whether a value is a choice the owner can make.
 *
 * @param value - Candidate
 * @returns True for `do` / `skip`
 */
export function isSignalChoice(value: unknown): value is SignalChoice {
  return value === 'do' || value === 'skip';
}
