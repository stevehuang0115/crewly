/**
 * Tests for owner receipt settings validation (#828).
 */

import { applySettingsPatch, defaultReceiptSettings, isValidTimeZone, RECEIPT_OUTCOMES } from './owner-receipt.types.js';

describe('owner receipt settings', () => {
  const base = defaultReceiptSettings();

  it('defaults to on, 21:00, America/New_York', () => {
    expect(base).toEqual({ enabled: true, time: '21:00', timezone: 'America/New_York' });
  });

  it('accepts a new time, zone and the off switch', () => {
    expect(applySettingsPatch(base, { time: '20:30', timezone: 'Asia/Shanghai', enabled: false })).toEqual({
      ok: true,
      settings: { enabled: false, time: '20:30', timezone: 'Asia/Shanghai' },
    });
  });

  it.each([
    [{ time: '25:00' }, 'time'],
    [{ time: '9:00' }, 'time'],
    [{ timezone: 'Mars/Olympus' }, 'timezone'],
    [{ enabled: 'yes' }, 'enabled'],
    [null, 'object'],
  ])('rejects %j', (patch, field) => {
    const r = applySettingsPatch(base, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  });

  it('an empty patch changes nothing', () => {
    expect(applySettingsPatch(base, {})).toEqual({ ok: true, settings: base });
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('lists every outcome once', () => {
    expect(new Set(RECEIPT_OUTCOMES).size).toBe(RECEIPT_OUTCOMES.length);
    expect(RECEIPT_OUTCOMES).toHaveLength(6);
  });
});
