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
