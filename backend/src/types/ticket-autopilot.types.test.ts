/**
 * Tests for the ticket autopilot settings: defaults and input validation.
 */
import { TICKET_AUTOPILOT_CONSTANTS as C } from '../constants.js';
import { applyTicketAutopilotInput, resolveTicketAutopilotSettings } from './ticket-autopilot.types.js';

describe('resolveTicketAutopilotSettings', () => {
  it('is off with defaults when nothing is stored', () => {
    expect(resolveTicketAutopilotSettings(undefined)).toEqual({
      enabled: false,
      driver: null,
      dailyBudgetUsd: C.DEFAULT_DAILY_BUDGET_USD,
      maxInFlightPerMember: 1,
    });
  });

  it('keeps valid stored values and replaces invalid ones with defaults', () => {
    expect(resolveTicketAutopilotSettings({ enabled: true, driver: ' tl-a ', dailyBudgetUsd: 7.5, maxInFlightPerMember: 2 })).toEqual({
      enabled: true,
      driver: 'tl-a',
      dailyBudgetUsd: 7.5,
      maxInFlightPerMember: 2,
    });
    expect(resolveTicketAutopilotSettings({ enabled: true, dailyBudgetUsd: -1, maxInFlightPerMember: 99 })).toMatchObject({
      dailyBudgetUsd: C.DEFAULT_DAILY_BUDGET_USD,
      maxInFlightPerMember: 1,
    });
  });
});

describe('applyTicketAutopilotInput', () => {
  it('switches on and keeps the other fields', () => {
    const r = applyTicketAutopilotInput({ enabled: false, dailyBudgetUsd: 5 }, { enabled: true });
    expect(r).toEqual({ ok: true, settings: { enabled: true, dailyBudgetUsd: 5 } });
  });

  it('null resets a field to its default', () => {
    const r = applyTicketAutopilotInput({ enabled: true, driver: 'x', dailyBudgetUsd: 5, maxInFlightPerMember: 2 }, { driver: null, dailyBudgetUsd: null, maxInFlightPerMember: null });
    expect(r).toEqual({ ok: true, settings: { enabled: true } });
  });

  it('accepts numeric strings from the CLI', () => {
    expect(applyTicketAutopilotInput(undefined, { dailyBudgetUsd: '12.5', maxInFlightPerMember: '2' })).toEqual({
      ok: true,
      settings: { enabled: false, dailyBudgetUsd: 12.5, maxInFlightPerMember: 2 },
    });
  });

  it.each([
    [{ enabled: 'yes' }, 'enabled'],
    [{ driver: 42 }, 'driver'],
    [{ dailyBudgetUsd: 0 }, 'dailyBudgetUsd'],
    [{ dailyBudgetUsd: 'lots' }, 'dailyBudgetUsd'],
    [{ maxInFlightPerMember: 0 }, 'maxInFlightPerMember'],
    [{ maxInFlightPerMember: 1.5 }, 'maxInFlightPerMember'],
    [{ maxInFlightPerMember: C.MAX_IN_FLIGHT_PER_MEMBER_LIMIT + 1 }, 'maxInFlightPerMember'],
  ])('refuses %j', (input, field) => {
    const r = applyTicketAutopilotInput(undefined, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  });
});
