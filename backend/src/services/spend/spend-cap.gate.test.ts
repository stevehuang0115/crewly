import { formatUsd, setSpendCapGate, spendCapNameOf, spendCapReason, spendCapStopOf } from './spend-cap.gate.js';

describe('spend cap gate', () => {
  afterEach(() => setSpendCapGate(null));

  it('lets every agent run when no gate is installed', () => {
    expect(spendCapStopOf('crewly-orc')).toBeNull();
    expect(spendCapNameOf('crewly-orc')).toBe('crewly-orc');
  });

  it('returns the installed gate\'s stop', () => {
    const stop = { session: 'a', scope: 'agent' as const, capUsd: 5, spentUsd: 6 };
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

  it('formats the reason in English', () => {
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(4.999)).toBe('$5.00');
    expect(spendCapReason({ session: 'crewly-orc', scope: 'agent', capUsd: 5, spentUsd: 5 }, 'Orc')).toBe('Orc hit its daily spend cap ($5.00)');
    expect(spendCapReason({ session: 'x', scope: 'total', capUsd: 20, spentUsd: 21 }, 'Ella')).toBe(
      'Ella is stopped: all agents together hit the daily total spend cap ($20.00)',
    );
  });
});
