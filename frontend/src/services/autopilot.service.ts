/**
 * Ticket autopilot API client: stats / runs
 * (specs/2026-10-03-autopilot-experiments.md §2), and the status + speed mode
 * (specs/2026-10-04-autopilot-speed-modes.md). Unwraps `{ success, data }`.
 *
 * @module services/autopilot.service
 */

/** Base path of the autopilot API. */
export const AUTOPILOT_API_BASE = '/api/project-ticket-autopilot';

/** Stall causes (as the run timeline names them). */
export type AutopilotStallCause = 'runtime_quota' | 'delivery_failure' | 'waiting_on_owner' | 'waiting_on_agent' | 'nobody_pushing';

/** Median / mean of durations. */
export interface AutopilotCycleStat {
  count: number;
  medianMs: number | null;
  meanMs: number | null;
}

/** Numbers of a day or of the range. */
export interface AutopilotPeriodStats {
  triaged: number;
  /** Goal replans (the driver woken to open the next tickets; absent on older servers) */
  replans?: number;
  started: number;
  done: number;
  verified: number;
  sentBack: number;
  stalled: number;
  cycleTime: { toDone: AutopilotCycleStat; toVerified: AutopilotCycleStat };
  ownerTouches: { answered: number; approved: number; sentBack: number; corrected: number; total: number };
  stalls: { count: number; totalMs: number; byCause: Record<AutopilotStallCause, { count: number; ms: number }> };
  interventions: { nudges: number; redeliveries: number; wakes: number; corrections: number; guardBlocks: number; misroutes: number; total: number };
  tokens: number;
  costUsd: number;
  budget: { dailyBudgetTokens: number; ledgerTokens: number; ledgerCostUsd: number; pct: number };
  pausedMs: number;
}

/** One day. */
export interface AutopilotDayStats extends AutopilotPeriodStats {
  day: string;
  runTraceId: string | null;
  ticketTraceIds: string[];
}

/** `GET …/stats`. */
export interface AutopilotStats {
  project: { id: string; name: string };
  settings: { enabled: boolean; dailyBudgetTokens: number; retro: boolean | null };
  pausedForToday: boolean;
  label: string | null;
  range: { start: string; end: string };
  days: AutopilotDayStats[];
  total: AutopilotPeriodStats;
  labels: string[];
}

/** `GET …/runs` day. */
export interface AutopilotRunDay {
  day: string;
  runTraceId: string | null;
  traces: Array<{ traceId: string; kind: string; summary: string; ticketId?: string; labels: string[]; updatedAt: string }>;
}

/** Autopilot speed. */
export type AutopilotSpeedMode = 'rush' | 'normal' | 'chill';

/** Why the autopilot stopped producing work. */
export type AutopilotStopReason = 'paused' | 'budget_reached' | 'system_error' | 'waiting_on_owner' | 'no_ideas' | 'daily_replan_cap' | 'waiting_for_replan';

/** The driver's self-review. */
export interface AutopilotSelfReview {
  at: string;
  by: string;
  gap: string;
  moved: string;
  nextBet: string;
}

/** `GET /api/project-ticket-autopilot/:project` (the parts the page shows). */
export interface AutopilotStatus {
  project: { id: string; name: string };
  settings: {
    enabled: boolean;
    dailyBudgetTokens: number;
    speedMode: AutopilotSpeedMode;
    budgetSource: 'explicit' | 'mode';
    replansPerDay: number;
    replansPerDaySource: 'explicit' | 'mode';
  };
  speedMode: AutopilotSpeedMode;
  stopReason: AutopilotStopReason | null;
  stopReasonText: string | null;
  stoppedSince: string | null;
  lastSelfReview: AutopilotSelfReview | null;
  nextSelfReviewAt: string | null;
  replansToday: number;
}

/** A failed call with its HTTP status. */
export class AutopilotApiError extends Error {
  /**
   * @param message - Server error
   * @param status - HTTP status
   */
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AutopilotApiError';
  }
}

/**
 * GET and unwrap.
 *
 * @param url - URL
 * @returns `data`
 * @throws AutopilotApiError
 */
async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url);
  let body: { success?: boolean; data?: T; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!res.ok || body.success === false) throw new AutopilotApiError(body.error || `HTTP ${res.status}`, res.status);
  return body.data as T;
}

/**
 * Query string of the range and label.
 *
 * @param days - Days
 * @param label - Label or null
 * @returns `?days=…&label=…`
 */
function query(days: number, label: string | null): string {
  const q = new URLSearchParams({ days: String(days) });
  if (label) q.set('label', label);
  return `?${q.toString()}`;
}

/**
 * Stats of a project's autopilot.
 *
 * @param projectId - Project id
 * @param days - Days (today included)
 * @param label - Only tickets with this label
 * @returns Stats
 */
export function getAutopilotStats(projectId: string, days: number, label: string | null = null): Promise<AutopilotStats> {
  return get<AutopilotStats>(`${AUTOPILOT_API_BASE}/${encodeURIComponent(projectId)}/stats${query(days, label)}`);
}

/**
 * Run traces and ticket traces per day.
 *
 * @param projectId - Project id
 * @param days - Days
 * @param label - Label or null
 * @returns Days, newest first
 */
export async function getAutopilotRuns(projectId: string, days: number, label: string | null = null): Promise<AutopilotRunDay[]> {
  return (await get<{ days: AutopilotRunDay[] }>(`${AUTOPILOT_API_BASE}/${encodeURIComponent(projectId)}/runs${query(days, label)}`)).days;
}

/**
 * The project's autopilot settings and status (owner only).
 *
 * @param projectId - Project id
 * @returns Status
 */
export function getAutopilotStatus(projectId: string): Promise<AutopilotStatus> {
  return get<AutopilotStatus>(`${AUTOPILOT_API_BASE}/${encodeURIComponent(projectId)}`);
}

/**
 * Switch the project's autopilot speed (owner only).
 *
 * @param projectId - Project id
 * @param mode - rush / normal / chill
 * @returns The new status
 */
export function setAutopilotSpeedMode(projectId: string, mode: AutopilotSpeedMode): Promise<AutopilotStatus> {
  return get<AutopilotStatus>(`${AUTOPILOT_API_BASE}/${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speedMode: mode }),
  });
}
