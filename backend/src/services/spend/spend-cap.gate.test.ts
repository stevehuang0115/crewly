import { setSpendCapGate, spendCapNameOf, spendCapReason, spendCapStopOf } from './spend-cap.gate.js';

describe('token cap gate', () => {
  afterEach(() => setSpendCapGate(null));

  it('lets every agent run when no gate is installed', () => {
    expect(spendCapStopOf('crewly-orc')).toBeNull();
    expect(spendCapNameOf('crewly-orc')).toBe('crewly-orc');
  });

  it('returns the installed gate\'s stop', () => {
    const stop = { session: 'a', scope: 'agent' as const, capTokens: 5_000_000, usedTokens: 6_000_000 };
    setSpendCapGate({ stopOf: (s) => (s === 'a' ? stop : null), displayNameOf: () => 'Ella' });
    expect(spendCapStopOf('a')).toBe(stop);
    expect(spendCapStopOf('b')).toBeNull();
    expect(spendCapNameOf('a')).toBe('Ella');
  });

  it('never throws: a broken gate lets the agent run', () => {
    setSpendCapGate({
      stopOf: () => {
        throw new Error('boom');
      },
      displayNameOf: () => {
        throw new Error('boom');
      },
    });
    expect(spendCapStopOf('a')).toBeNull();
    expect(spendCapNameOf('a')).toBe('a');
  });

  it('formats the reason in English, in tokens', () => {
    expect(spendCapReason({ session: 'crewly-orc', scope: 'agent', capTokens: 5_000_000, usedTokens: 5_000_000 }, 'Orc')).toBe('Orc hit its daily token cap (5M tokens)');
    expect(spendCapReason({ session: 'x', scope: 'total', capTokens: 20_000_000, usedTokens: 21_000_000 }, 'Ella')).toBe(
      'Ella is stopped: all agents together hit the daily token cap (20M tokens)',
    );
    expect(spendCapReason({ session: 'x', scope: 'team', capTokens: 12_400_000, usedTokens: 13_000_000, teamId: 't', teamName: 'CE' }, 'Nova')).toBe(
      'Nova is stopped: team CE hit its daily token cap (12.4M tokens)',
    );
  });
});
