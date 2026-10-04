/**
 * Tests for the ticket autopilot settings: defaults, input validation and
 * the USD → token budget migration.
 */
import { TICKET_AUTOPILOT_CONSTANTS as C } from '../constants.js';
import { applyTicketAutopilotInput, legacyBudgetTokens, resolveTicketAutopilotSettings } from './ticket-autopilot.types.js';

describe('resolveTicketAutopilotSettings', () => {
  it('is off with defaults when nothing is stored', () => {
    expect(resolveTicketAutopilotSettings(undefined)).toEqual({
      enabled: false,
      driver: null,
      dailyBudgetTokens: C.DEFAULT_DAILY_BUDGET_TOKENS,
      maxInFlightPerMember: 1,
      retro: null,
      engineeringTeam: null,
      replansPerDay: C.DEFAULT_REPLANS_PER_DAY,
      replanTtlHours: C.DEFAULT_REPLAN_TTL_HOURS,
    });
    expect(C.DEFAULT_DAILY_BUDGET_TOKENS).toBe(20_000_000);
  });

  it('keeps valid stored values and replaces invalid ones with defaults', () => {
    expect(resolveTicketAutopilotSettings({ enabled: true, driver: ' tl-a ', dailyBudgetTokens: 7_500_000, maxInFlightPerMember: 2 })).toEqual({
      enabled: true,
      driver: 'tl-a',
      dailyBudgetTokens: 7_500_000,
      maxInFlightPerMember: 2,
      retro: null,
      engineeringTeam: null,
      replansPerDay: C.DEFAULT_REPLANS_PER_DAY,
      replanTtlHours: C.DEFAULT_REPLAN_TTL_HOURS,
    });
    expect(resolveTicketAutopilotSettings({ enabled: true, retro: false }).retro).toBe(false);
    expect(resolveTicketAutopilotSettings({ enabled: true, dailyBudgetTokens: -1, maxInFlightPerMember: 99 })).toMatchObject({
      dailyBudgetTokens: C.DEFAULT_DAILY_BUDGET_TOKENS,
      maxInFlightPerMember: 1,
    });
  });

  it('reads a stored pre-token USD budget at the documented rate (1M tokens per $1)', () => {
    expect(resolveTicketAutopilotSettings({ enabled: true, dailyBudgetUsd: 7.5 }).dailyBudgetTokens).toBe(7_500_000);
    expect(legacyBudgetTokens({ enabled: true, dailyBudgetUsd: 10 })).toBe(10_000_000);
    expect(legacyBudgetTokens({ enabled: true })).toBeNull();
    // A token budget wins over a leftover USD one.
    expect(resolveTicketAutopilotSettings({ enabled: true, dailyBudgetUsd: 7.5, dailyBudgetTokens: 3_000_000 }).dailyBudgetTokens).toBe(3_000_000);
  });
});

describe('applyTicketAutopilotInput', () => {
  it('switches on and keeps the other fields', () => {
    const r = applyTicketAutopilotInput({ enabled: false, dailyBudgetTokens: 5_000_000 }, { enabled: true });
    expect(r).toEqual({ ok: true, settings: { enabled: true, dailyBudgetTokens: 5_000_000 } });
  });

  it('converts a stored USD budget on the next change', () => {
    const r = applyTicketAutopilotInput({ enabled: false, dailyBudgetUsd: 5 }, { enabled: true });
    expect(r).toEqual({ ok: true, settings: { enabled: true, dailyBudgetTokens: 5_000_000 } });
  });

  it('null resets a field to its default', () => {
    const r = applyTicketAutopilotInput({ enabled: true, driver: 'x', dailyBudgetTokens: 5, maxInFlightPerMember: 2 }, { driver: null, dailyBudgetTokens: null, maxInFlightPerMember: null });
    expect(r).toEqual({ ok: true, settings: { enabled: true } });
  });

  it('accepts token amounts and numeric strings from the CLI', () => {
    expect(applyTicketAutopilotInput(undefined, { dailyBudgetTokens: '12.5M', maxInFlightPerMember: '2' })).toEqual({
      ok: true,
      settings: { enabled: false, dailyBudgetTokens: 12_500_000, maxInFlightPerMember: 2 },
    });
    expect(applyTicketAutopilotInput(undefined, { dailyBudgetTokens: 3000000 })).toMatchObject({ ok: true, settings: { dailyBudgetTokens: 3_000_000 } });
  });

  it.each([
    [{ enabled: 'yes' }, 'enabled'],
    [{ driver: 42 }, 'driver'],
    [{ dailyBudgetTokens: 0 }, 'dailyBudgetTokens'],
    [{ dailyBudgetTokens: 'lots' }, 'dailyBudgetTokens'],
    [{ dailyBudgetUsd: 5 }, 'tokens now'],
    [{ maxInFlightPerMember: 0 }, 'maxInFlightPerMember'],
    [{ maxInFlightPerMember: 1.5 }, 'maxInFlightPerMember'],
    [{ maxInFlightPerMember: C.MAX_IN_FLIGHT_PER_MEMBER_LIMIT + 1 }, 'maxInFlightPerMember'],
  ])('refuses %j', (input, field) => {
    const r = applyTicketAutopilotInput(undefined, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  });
});

describe('the daily retro switch (specs/2026-10-03-autopilot-experiments.md §4)', () => {
  it('accepts on / off / default and keeps it across other changes', () => {
    const on = applyTicketAutopilotInput({ enabled: true }, { retro: 'on' });
    expect(on).toEqual({ ok: true, settings: { enabled: true, retro: true } });
    const kept = applyTicketAutopilotInput({ enabled: true, retro: true }, { maxInFlightPerMember: 2 });
    expect(kept).toEqual({ ok: true, settings: { enabled: true, retro: true, maxInFlightPerMember: 2 } });
    expect(applyTicketAutopilotInput({ enabled: true, retro: true }, { retro: false })).toEqual({ ok: true, settings: { enabled: true, retro: false } });
    expect(applyTicketAutopilotInput({ enabled: true, retro: true }, { retro: 'default' })).toEqual({ ok: true, settings: { enabled: true } });
    expect(applyTicketAutopilotInput({ enabled: true, retro: false }, { retro: null })).toEqual({ ok: true, settings: { enabled: true } });
    expect(applyTicketAutopilotInput({ enabled: true }, { retro: 'maybe' })).toEqual({ ok: false, error: 'retro must be on, off or default' });
  });
});

describe('goal replans per day (specs/2026-10-04-autopilot-goal-replan.md)', () => {
  it('defaults to 1, keeps a stored 0..limit and falls back on anything else', () => {
    expect(C.DEFAULT_REPLANS_PER_DAY).toBe(1);
    expect(resolveTicketAutopilotSettings({ enabled: true }).replansPerDay).toBe(1);
    expect(resolveTicketAutopilotSettings({ enabled: true, replansPerDay: 0 }).replansPerDay).toBe(0);
    expect(resolveTicketAutopilotSettings({ enabled: true, replansPerDay: 3 }).replansPerDay).toBe(3);
    expect(resolveTicketAutopilotSettings({ enabled: true, replansPerDay: C.REPLANS_PER_DAY_LIMIT + 1 }).replansPerDay).toBe(1);
    expect(resolveTicketAutopilotSettings({ enabled: true, replansPerDay: 1.5 }).replansPerDay).toBe(1);
  });

  it('accepts 0..limit (numbers, digits or "off"), resets with null / default, and keeps it across other changes', () => {
    expect(applyTicketAutopilotInput({ enabled: true }, { replansPerDay: 2 })).toEqual({ ok: true, settings: { enabled: true, replansPerDay: 2 } });
    expect(applyTicketAutopilotInput({ enabled: true }, { replansPerDay: '3' })).toEqual({ ok: true, settings: { enabled: true, replansPerDay: 3 } });
    expect(applyTicketAutopilotInput({ enabled: true }, { replansPerDay: 'off' })).toEqual({ ok: true, settings: { enabled: true, replansPerDay: 0 } });
    expect(applyTicketAutopilotInput({ enabled: true, replansPerDay: 2 }, { retro: 'on' })).toEqual({ ok: true, settings: { enabled: true, retro: true, replansPerDay: 2 } });
    expect(applyTicketAutopilotInput({ enabled: true, replansPerDay: 2 }, { replansPerDay: null })).toEqual({ ok: true, settings: { enabled: true } });
    expect(applyTicketAutopilotInput({ enabled: true, replansPerDay: 0 }, { replansPerDay: 'default' })).toEqual({ ok: true, settings: { enabled: true } });
    for (const bad of [-1, C.REPLANS_PER_DAY_LIMIT + 1, 1.5, 'lots', true]) {
      const r = applyTicketAutopilotInput({ enabled: true }, { replansPerDay: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('replansPerDay');
    }
  });
});

describe('replan TTL (review fix: a live replan cannot hold triage forever)', () => {
  it('defaults to 4 hours, accepts 1..limit, resets with null / default', () => {
    expect(C.DEFAULT_REPLAN_TTL_HOURS).toBe(4);
    expect(resolveTicketAutopilotSettings({ enabled: true }).replanTtlHours).toBe(4);
    expect(resolveTicketAutopilotSettings({ enabled: true, replanTtlHours: 0 }).replanTtlHours).toBe(4);
    expect(applyTicketAutopilotInput({ enabled: true }, { replanTtlHours: '2' })).toEqual({ ok: true, settings: { enabled: true, replanTtlHours: 2 } });
    expect(applyTicketAutopilotInput({ enabled: true, replanTtlHours: 2 }, { replansPerDay: 1 })).toEqual({ ok: true, settings: { enabled: true, replansPerDay: 1, replanTtlHours: 2 } });
    expect(applyTicketAutopilotInput({ enabled: true, replanTtlHours: 2 }, { replanTtlHours: null })).toEqual({ ok: true, settings: { enabled: true } });
    for (const bad of [0, C.REPLAN_TTL_HOURS_LIMIT + 1, 1.5, 'x']) {
      const r = applyTicketAutopilotInput({ enabled: true }, { replanTtlHours: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('replanTtlHours');
    }
  });
});

describe('engineeringTeam setting (CREW-151)', () => {
  it('defaults to null and keeps a stored team id', () => {
    expect(resolveTicketAutopilotSettings({ enabled: true }).engineeringTeam).toBeNull();
    expect(resolveTicketAutopilotSettings({ enabled: true, engineeringTeam: ' t-eng ' }).engineeringTeam).toBe('t-eng');
  });
  it('sets, keeps, resets and rejects it', () => {
    expect(applyTicketAutopilotInput({ enabled: true }, { engineeringTeam: ' t-eng ' })).toEqual({ ok: true, settings: { enabled: true, engineeringTeam: 't-eng' } });
    expect(applyTicketAutopilotInput({ enabled: true, engineeringTeam: 't-eng' }, { retro: true })).toEqual({ ok: true, settings: { enabled: true, engineeringTeam: 't-eng', retro: true } });
    expect(applyTicketAutopilotInput({ enabled: true, engineeringTeam: 't-eng' }, { engineeringTeam: null })).toEqual({ ok: true, settings: { enabled: true } });
    const bad = applyTicketAutopilotInput({ enabled: true }, { engineeringTeam: 5 });
    expect(bad.ok).toBe(false);
  });
});
