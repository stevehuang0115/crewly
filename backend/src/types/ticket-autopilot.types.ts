/**
 * Ticket autopilot settings (specs/2026-09-30-ticket-autopilot.md §2).
 *
 * Stored on the project record (`Project.ticketAutopilot` in projects.json).
 * Absent = off. Only the owner or the orchestrator changes it.
 *
 * @module types/ticket-autopilot.types
 */

import { TICKET_AUTOPILOT_CONSTANTS } from '../constants.js';

/** The per-project switch as stored. Every field but `enabled` is optional. */
export interface TicketAutopilotSettings {
  /** Master switch (default off) */
  enabled: boolean;
  /** Session that triages; absent = the lead of the project's team */
  driver?: string;
  /**
   * Daily spend (USD) of the project's team agents since local midnight at
   * which the autopilot pauses for the rest of the day. Absent = the default
   * ({@link TICKET_AUTOPILOT_CONSTANTS.DEFAULT_DAILY_BUDGET_USD}).
   */
  dailyBudgetUsd?: number;
  /** In-progress tickets one member may hold at a time (default 1) */
  maxInFlightPerMember?: number;
}

/** Settings with every default filled in. */
export interface ResolvedTicketAutopilotSettings {
  enabled: boolean;
  /** The configured driver, or null (= the project team's lead) */
  driver: string | null;
  dailyBudgetUsd: number;
  maxInFlightPerMember: number;
}

/** A change request for the settings (API / skill body). */
export interface TicketAutopilotSettingsInput {
  enabled?: unknown;
  /** A session name; `null` or `''` resets to the team lead */
  driver?: unknown;
  /** A positive number; `null` resets to the default */
  dailyBudgetUsd?: unknown;
  /** An integer 1..limit; `null` resets to the default */
  maxInFlightPerMember?: unknown;
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
export function resolveTicketAutopilotSettings(stored: Partial<TicketAutopilotSettings> | undefined | null): ResolvedTicketAutopilotSettings {
  const budget = stored?.dailyBudgetUsd;
  const cap = stored?.maxInFlightPerMember;
  return {
    enabled: stored?.enabled === true,
    driver: typeof stored?.driver === 'string' && stored.driver.trim() ? stored.driver.trim() : null,
    dailyBudgetUsd: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : TICKET_AUTOPILOT_CONSTANTS.DEFAULT_DAILY_BUDGET_USD,
    maxInFlightPerMember:
      typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 && cap <= TICKET_AUTOPILOT_CONSTANTS.MAX_IN_FLIGHT_PER_MEMBER_LIMIT
        ? cap
        : TICKET_AUTOPILOT_CONSTANTS.DEFAULT_MAX_IN_FLIGHT_PER_MEMBER,
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
 * applyTicketAutopilotInput(undefined, { enabled: true, dailyBudgetUsd: 10 });
 * // → { ok: true, settings: { enabled: true, dailyBudgetUsd: 10 } }
 * ```
 */
export function applyTicketAutopilotInput(
  current: Partial<TicketAutopilotSettings> | undefined | null,
  input: TicketAutopilotSettingsInput,
): TicketAutopilotInputResult {
  const next: TicketAutopilotSettings = { enabled: current?.enabled === true };
  if (typeof current?.driver === 'string' && current.driver.trim()) next.driver = current.driver.trim();
  if (typeof current?.dailyBudgetUsd === 'number') next.dailyBudgetUsd = current.dailyBudgetUsd;
  if (typeof current?.maxInFlightPerMember === 'number') next.maxInFlightPerMember = current.maxInFlightPerMember;

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
    if (input.dailyBudgetUsd === null) delete next.dailyBudgetUsd;
    else {
      const n = typeof input.dailyBudgetUsd === 'string' ? Number(input.dailyBudgetUsd) : input.dailyBudgetUsd;
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return { ok: false, error: 'dailyBudgetUsd must be a positive number of US dollars' };
      next.dailyBudgetUsd = n;
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
  return { ok: true, settings: next };
}
