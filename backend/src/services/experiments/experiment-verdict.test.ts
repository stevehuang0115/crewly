/**
 * Tests for experiment windows and verdict rules (issue #986).
 */
import { decideVerdict, defaultDirection, experimentWindows, formatValue } from './experiment-verdict.js';
import type { Measurement } from '../../types/experiment.types.js';

/**
 * A measurement with a daily series.
 *
 * @param values - Daily values
 * @param extra - Overrides
 * @returns Measurement
 */
function m(values: Array<number | null>, extra: Partial<Measurement> = {}): Measurement {
  const days = values.map((v, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, value: v, volume: v === null ? 0 : 50 }));
  const total = values.reduce<number>((a, v) => a + (v ?? 0), 0);
  return { start: days[0]?.date ?? '', end: days[days.length - 1]?.date ?? '', total, volume: total, days, fetchedAt: '', ...extra };
}

describe('experimentWindows', () => {
  it('uses settled days before the ship day and the window after it', () => {
    expect(experimentWindows('2026-10-10T15:00:00Z', 14, 'gsc')).toEqual({
      baseline: { start: '2026-09-24', end: '2026-10-07' },
      observation: { start: '2026-10-11', end: '2026-10-24' },
      dueAt: '2026-10-28T00:00:00.000Z',
    });
  });

  it('GA4 settles sooner', () => {
    const w = experimentWindows('2026-10-10T00:00:00Z', 7, 'ga4');
    expect(w.baseline).toEqual({ start: '2026-10-02', end: '2026-10-08' });
    expect(w.observation).toEqual({ start: '2026-10-11', end: '2026-10-17' });
    expect(w.dueAt).toBe('2026-10-20T00:00:00.000Z');
  });

  it('rejects an invalid time', () => {
    expect(() => experimentWindows('soon', 14, 'gsc')).toThrow('Invalid time');
  });
});

describe('defaultDirection / formatValue', () => {
  it('position goes down, everything else up', () => {
    expect(defaultDirection('position')).toBe('decrease');
    expect(defaultDirection('clicks')).toBe('increase');
    expect(defaultDirection('events')).toBe('increase');
  });

  it('formats per measure', () => {
    expect(formatValue(0.0345, 'ctr')).toBe('3.45%');
    expect(formatValue(7.26, 'position')).toBe('7.3');
    expect(formatValue(12, 'clicks')).toBe('12');
    expect(formatValue(null, 'clicks')).toBe('n/a');
  });
});

describe('decideVerdict: counts', () => {
  it('a clear rise is worked', () => {
    const out = decideVerdict('clicks', 'increase', m([], { total: 100 }), m([], { total: 160 }));
    expect(out.verdict).toBe('worked');
    expect(out.statistic).toBeCloseTo(60 / Math.sqrt(260));
    expect(out.reason).toBe('clicks 100 → 160 (+60%), z = 3.72: a real increase');
  });

  it('a small change is didn\'t (no real change); a fall is didn\'t (wrong way)', () => {
    expect(decideVerdict('sessions', 'increase', m([], { total: 100 }), m([], { total: 110 })).reason).toContain('no real change');
    const fall = decideVerdict('sessions', 'increase', m([], { total: 100 }), m([], { total: 60 }));
    expect(fall.verdict).toBe('didnt');
    expect(fall.reason).toContain('wrong way');
  });

  it('too few events is inconclusive (form submissions need 10)', () => {
    const out = decideVerdict('events', 'increase', m([], { total: 2 }), m([], { total: 6 }));
    expect(out.verdict).toBe('inconclusive');
    expect(out.reason).toBe('events 2 → 6: too little data (8 across both windows; need 10)');
  });

  it('a decrease hypothesis works when the count falls', () => {
    expect(decideVerdict('impressions', 'decrease', m([], { total: 1000 }), m([], { total: 700 })).verdict).toBe('worked');
  });

  it('lift is null from a zero baseline', () => {
    const out = decideVerdict('events', 'increase', m([], { total: 0 }), m([], { total: 20 }));
    expect(out.verdict).toBe('worked');
    expect(out.lift).toBeNull();
  });
});

describe('decideVerdict: ctr', () => {
  it('two-proportion test with enough impressions', () => {
    const out = decideVerdict('ctr', 'increase', m([], { impressions: 5000, clicks: 100, total: 0.02 }), m([], { impressions: 5000, clicks: 160, total: 0.032 }));
    expect(out.verdict).toBe('worked');
    expect(out.reason).toMatch(/^CTR 2\.00% → 3\.20% \(\+60%\), z = 3\.\d\d: a real increase$/);
  });

  it('too few impressions is inconclusive', () => {
    const out = decideVerdict('ctr', 'increase', m([], { impressions: 100, clicks: 5 }), m([], { impressions: 5000, clicks: 160 }));
    expect(out.verdict).toBe('inconclusive');
    expect(out.reason).toContain('need 200 impressions per window');
  });
});

describe('decideVerdict: position', () => {
  const before = [8.1, 8.4, 7.9, 8.2, 8.0, 8.3, 8.1, 7.8];
  const after = [5.1, 5.3, 4.9, 5.2, 5.0, 5.4, 5.1, 5.2];

  it('a lower daily position is worked (lower is better)', () => {
    const out = decideVerdict('position', 'decrease', m(before, { total: 8.1, impressions: 400 }), m(after, { total: 5.15, impressions: 400 }));
    expect(out.verdict).toBe('worked');
    expect(out.statistic).toBeLessThan(-1.96);
    expect(out.reason).toMatch(/^Average position 8\.1 → 5\.2, t = -\d+\.\d\d: a real decrease$/);
  });

  it('too few days with impressions is inconclusive; identical constant series is no change', () => {
    const sparse = decideVerdict('position', 'decrease', m([8, null, null, 8], { impressions: 400 }), m(after, { impressions: 400 }));
    expect(sparse.verdict).toBe('inconclusive');
    const flat = decideVerdict('position', 'decrease', m(Array(8).fill(5), { total: 5, impressions: 400 }), m(Array(8).fill(5), { total: 5, impressions: 400 }));
    expect(flat.verdict).toBe('didnt');
    expect(flat.statistic).toBe(0);
  });

  it('constant but different series is an infinite t', () => {
    const out = decideVerdict('position', 'decrease', m(Array(8).fill(8), { total: 8, impressions: 400 }), m(Array(8).fill(5), { total: 5, impressions: 400 }));
    expect(out.verdict).toBe('worked');
    expect(out.reason).toContain('t = −∞');
  });
});
