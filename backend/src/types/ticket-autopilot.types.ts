/**
 * Ticket autopilot settings (specs/2026-09-30-ticket-autopilot.md §2).
 *
 * Stored on the project record (`Project.ticketAutopilot` in projects.json).
 * Absent = off. Only the owner or the orchestrator changes it.
 *
 * @module types/ticket-autopilot.types
 */

import { TICKET_AUTOPILOT_CONSTANTS, USAGE_CONSTANTS } from '../constants.js';
import { parseTokenAmount } from '../services/usage/token-format.js';

/** The per-project switch as stored. Every field but `enabled` is optional. */
export interface TicketAutopilotSettings {
  /** Master switch (default off) */
  enabled: boolean;
  /** Session that triages; absent = the lead of the project's team */
  driver?: string;
  /**
   * Daily tokens (input incl. cached + output) of the project's team agents
   * since local midnight at which the autopilot pauses for the rest of the
   * day. Absent = the default
   * ({@link TICKET_AUTOPILOT_CONSTANTS.DEFAULT_DAILY_BUDGET_TOKENS}). A usage
   * boost on the project's teams raises it for the day.
   */
  dailyBudgetTokens?: number;
  /**
   * Pre-token budget in USD. Read only to migrate it: converted with
   * {@link USAGE_CONSTANTS.TOKENS_PER_USD} (see {@link legacyBudgetTokens}).
   * @deprecated
   */
  dailyBudgetUsd?: number;
  /** In-progress tickets one member may hold at a time (default 1) */
  maxInFlightPerMember?: number;
  /**
   * Daily retro for the driver (specs/2026-10-03-autopilot-experiments.md §4).
   * Absent = on while an autopilot experiment on the project is running.
   */
  retro?: boolean;
  /**
   * Goal replans per local day (specs/2026-10-04-autopilot-goal-replan.md):
   * how often the driver may be woken to plan the next tickets toward the
   * project's goal when nothing is left to triage. 0 = off. Absent = the
   * default ({@link TICKET_AUTOPILOT_CONSTANTS.DEFAULT_REPLANS_PER_DAY}).
   */
  replansPerDay?: number;
  /**
   * Hours a goal replan may stay live before it is expired (cancelled where
   * possible, never counted as live again). Absent = the default
   * ({@link TICKET_AUTOPILOT_CONSTANTS.DEFAULT_REPLAN_TTL_HOURS}).
   */
  replanTtlHours?: number;
  /**
   * The project's engineering team (a team id). Harness-gap / engineering
   * tickets the autopilot retro files on this project are set to it, so
   * only that team can claim them (CREW-151). Absent = the retro lead's team.
   */
  engineeringTeam?: string;
}

/** Settings with every default filled in. */
export interface ResolvedTicketAutopilotSettings {
  enabled: boolean;
  /** The configured driver, or null (= the project team's lead) */
  driver: string | null;
  dailyBudgetTokens: number;
  maxInFlightPerMember: number;
  /** The retro switch as set (null = the default: on while an autopilot experiment runs) */
  retro: boolean | null;
  /** Goal replans allowed per local day (0 = off) */
  replansPerDay: number;
  /** Hours a goal replan may stay live */
  replanTtlHours: number;
  /** The configured engineering team id, or null (= the retro lead's team) */
  engineeringTeam: string | null;
}

/** A change request for the settings (API / skill body). */
export interface TicketAutopilotSettingsInput {
  enabled?: unknown;
  /** A session name; `null` or `''` resets to the team lead */
  driver?: unknown;
  /** Tokens: a positive number or text like "20M"; `null` resets to the default */
  dailyBudgetTokens?: unknown;
  /** Rejected: budgets are in tokens now */
  dailyBudgetUsd?: unknown;
  /** An integer 1..limit; `null` resets to the default */
  maxInFlightPerMember?: unknown;
  /** `true` / `false` (also "on" / "off"); `null` or "default" resets to the default */
  retro?: unknown;
  /** An integer 0..limit (0 = no goal replans); `null` resets to the default */
  replansPerDay?: unknown;
  /** An integer 1..limit (hours); `null` resets to the default */
  replanTtlHours?: unknown;
  /** A team id; `null` or `''` resets to the retro lead's team */
  engineeringTeam?: unknown;
}

/** Outcome of {@link applyTicketAutopilotInput}. */
export type TicketAutopilotInputResult =
  | { ok: true; settings: TicketAutopilotSettings }
  | { ok: false; error: string };

/**
 * Fill in the defaults of stored (possibly absent) settings.
 *
 * @param stored - `Project.ticketAutopilot` (may be undefined or partial)
 * @returns Settings with defaults
 */
/**
 * The token budget a stored pre-token USD budget converts to, or null.
 *
 * @param stored - Stored settings
 * @returns Tokens (USD × TOKENS_PER_USD), or null when there is no USD budget
 */
export function legacyBudgetTokens(stored: Partial<TicketAutopilotSettings> | undefined | null): number | null {
  const usd = stored?.dailyBudgetUsd;
  return typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? Math.round(usd * USAGE_CONSTANTS.TOKENS_PER_USD) : null;
}

/**
 * Whether a value is a valid goal-replans-per-day setting.
 *
 * @param n - Value
 * @returns True for a whole number from 0 to REPLANS_PER_DAY_LIMIT
 */
function isReplansPerDay(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= TICKET_AUTOPILOT_CONSTANTS.REPLANS_PER_DAY_LIMIT;
}

/**
 * Whether a value is a valid replan TTL.
 *
 * @param n - Value
 * @returns True for a whole number of hours from 1 to REPLAN_TTL_HOURS_LIMIT
 */
function isReplanTtlHours(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= TICKET_AUTOPILOT_CONSTANTS.REPLAN_TTL_HOURS_LIMIT;
}

export function resolveTicketAutopilotSettings(stored: Partial<TicketAutopilotSettings> | undefined | null): ResolvedTicketAutopilotSettings {
  const budget = stored?.dailyBudgetTokens ?? legacyBudgetTokens(stored) ?? undefined;
  const cap = stored?.maxInFlightPerMember;
  return {
    enabled: stored?.enabled === true,
    driver: typeof stored?.driver === 'string' && stored.driver.trim() ? stored.driver.trim() : null,
    dailyBudgetTokens: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : TICKET_AUTOPILOT_CONSTANTS.DEFAULT_DAILY_BUDGET_TOKENS,
    maxInFlightPerMember:
      typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 && cap <= TICKET_AUTOPILOT_CONSTANTS.MAX_IN_FLIGHT_PER_MEMBER_LIMIT
        ? cap
        : TICKET_AUTOPILOT_CONSTANTS.DEFAULT_MAX_IN_FLIGHT_PER_MEMBER,
    retro: typeof stored?.retro === 'boolean' ? stored.retro : null,
    replansPerDay: isReplansPerDay(stored?.replansPerDay) ? stored.replansPerDay : TICKET_AUTOPILOT_CONSTANTS.DEFAULT_REPLANS_PER_DAY,
    replanTtlHours: isReplanTtlHours(stored?.replanTtlHours) ? stored.replanTtlHours : TICKET_AUTOPILOT_CONSTANTS.DEFAULT_REPLAN_TTL_HOURS,
    engineeringTeam: typeof stored?.engineeringTeam === 'string' && stored.engineeringTeam.trim() ? stored.engineeringTeam.trim() : null,
  };
}

/**
 * Apply a change request to the stored settings, validating every field.
 * Fields not present in the input are kept; `null` resets a field to its
 * default (removes it from the stored object).
 *
 * @param current - Stored settings (may be absent)
 * @param input - Requested changes
 * @returns The new stored settings, or a validation error
 *
 * @example
 * ```typescript
 * applyTicketAutopilotInput(undefined, { enabled: true, dailyBudgetTokens: '10M' });
 * // → { ok: true, settings: { enabled: true, dailyBudgetTokens: 10000000 } }
 * ```
 */
export function applyTicketAutopilotInput(
  current: Partial<TicketAutopilotSettings> | undefined | null,
  input: TicketAutopilotSettingsInput,
): TicketAutopilotInputResult {
  const next: TicketAutopilotSettings = { enabled: current?.enabled === true };
  if (typeof current?.driver === 'string' && current.driver.trim()) next.driver = current.driver.trim();
  if (typeof current?.dailyBudgetTokens === 'number') next.dailyBudgetTokens = current.dailyBudgetTokens;
  else if (legacyBudgetTokens(current) !== null) next.dailyBudgetTokens = legacyBudgetTokens(current) as number;
  if (typeof current?.maxInFlightPerMember === 'number') next.maxInFlightPerMember = current.maxInFlightPerMember;
  if (typeof current?.retro === 'boolean') next.retro = current.retro;
  if (isReplansPerDay(current?.replansPerDay)) next.replansPerDay = current.replansPerDay;
  if (isReplanTtlHours(current?.replanTtlHours)) next.replanTtlHours = current.replanTtlHours;
  if (typeof current?.engineeringTeam === 'string' && current.engineeringTeam.trim()) next.engineeringTeam = current.engineeringTeam.trim();

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    next.enabled = input.enabled;
  }
  if (input.driver !== undefined) {
    if (input.driver === null || input.driver === '') delete next.driver;
    else if (typeof input.driver === 'string' && input.driver.trim()) next.driver = input.driver.trim();
    else return { ok: false, error: 'driver must be a session name (or null for the team lead)' };
  }
  if (input.dailyBudgetUsd !== undefined) {
    return { ok: false, error: 'Budgets are in tokens now: send dailyBudgetTokens (e.g. 20000000 or "20M") instead of dailyBudgetUsd' };
  }
  if (input.dailyBudgetTokens !== undefined) {
    if (input.dailyBudgetTokens === null) delete next.dailyBudgetTokens;
    else {
      const n = parseTokenAmount(input.dailyBudgetTokens);
      if (n === null) return { ok: false, error: 'dailyBudgetTokens must be a positive number of tokens (e.g. 20000000 or "20M")' };
      next.dailyBudgetTokens = n;
    }
  }
  if (input.maxInFlightPerMember !== undefined) {
    if (input.maxInFlightPerMember === null) delete next.maxInFlightPerMember;
    else {
      const n = typeof input.maxInFlightPerMember === 'string' ? Number(input.maxInFlightPerMember) : input.maxInFlightPerMember;
      const limit = TICKET_AUTOPILOT_CONSTANTS.MAX_IN_FLIGHT_PER_MEMBER_LIMIT;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > limit) {
        return { ok: false, error: `maxInFlightPerMember must be a whole number from 1 to ${limit}` };
      }
      next.maxInFlightPerMember = n;
    }
  }
  if (input.retro !== undefined) {
    const r = typeof input.retro === 'string' ? input.retro.trim().toLowerCase() : input.retro;
    if (r === null || r === 'default' || r === '') delete next.retro;
    else if (r === true || r === 'on' || r === 'true') next.retro = true;
    else if (r === false || r === 'off' || r === 'false') next.retro = false;
    else return { ok: false, error: 'retro must be on, off or default' };
  }
  if (input.replansPerDay !== undefined) {
    const raw = typeof input.replansPerDay === 'string' ? input.replansPerDay.trim().toLowerCase() : input.replansPerDay;
    if (raw === null || raw === 'default' || raw === '') delete next.replansPerDay;
    else {
      const n = typeof raw === 'string' ? (raw === 'off' ? 0 : Number(raw)) : raw;
      if (!isReplansPerDay(n)) {
        return { ok: false, error: `replansPerDay must be a whole number from 0 (off) to ${TICKET_AUTOPILOT_CONSTANTS.REPLANS_PER_DAY_LIMIT}` };
      }
      next.replansPerDay = n;
    }
  }
  if (input.replanTtlHours !== undefined) {
    const raw = typeof input.replanTtlHours === 'string' ? input.replanTtlHours.trim().toLowerCase() : input.replanTtlHours;
    if (raw === null || raw === 'default' || raw === '') delete next.replanTtlHours;
    else {
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (!isReplanTtlHours(n)) {
        return { ok: false, error: `replanTtlHours must be a whole number of hours from 1 to ${TICKET_AUTOPILOT_CONSTANTS.REPLAN_TTL_HOURS_LIMIT}` };
      }
      next.replanTtlHours = n;
    }
  }
  if (input.engineeringTeam !== undefined) {
    if (input.engineeringTeam === null || input.engineeringTeam === '') delete next.engineeringTeam;
    else if (typeof input.engineeringTeam === 'string' && input.engineeringTeam.trim()) next.engineeringTeam = input.engineeringTeam.trim();
    else return { ok: false, error: 'engineeringTeam must be a team id (or null for the retro lead\'s team)' };
  }
  return { ok: true, settings: next };
}
