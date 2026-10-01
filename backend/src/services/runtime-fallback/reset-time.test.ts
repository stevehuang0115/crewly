/**
 * Tests for usage-limit reset-time parsing.
 */

import { isValidTimeZone, parseRelativeDuration, parseResetTime, zonedWallTimeToEpoch } from './reset-time.js';

/** 2026-10-01 12:00 UTC (a Thursday; America/Los_Angeles is UTC-7 then). */
const NOW = Date.UTC(2026, 9, 1, 12, 0);

describe('parseResetTime', () => {
	it('reads a clock time in a named IANA zone (later today)', () => {
		// 3pm in Los Angeles = 22:00 UTC the same day.
		expect(parseResetTime("You've hit your limit · resets 3pm (America/Los_Angeles)", NOW)).toBe(Date.UTC(2026, 9, 1, 22, 0));
	});

	it('rolls a clock time that already passed today to tomorrow', () => {
		// 3am LA = 10:00 UTC, already past at 12:00 UTC → tomorrow.
		expect(parseResetTime('5-hour limit reached ∙ resets 3am (America/Los_Angeles)', NOW)).toBe(Date.UTC(2026, 9, 2, 10, 0));
	});

	it('reads "Your limit will reset at 5pm (Asia/Shanghai)"', () => {
		// 5pm Shanghai (UTC+8) = 09:00 UTC; past → tomorrow 09:00 UTC.
		expect(parseResetTime('Claude usage limit reached. Your limit will reset at 5pm (Asia/Shanghai).', NOW)).toBe(Date.UTC(2026, 9, 2, 9, 0));
	});

	it('reads a month and day with a clock time', () => {
		expect(parseResetTime("You've hit your weekly limit · resets Oct 6, 9am (UTC)", NOW)).toBe(Date.UTC(2026, 9, 6, 9, 0));
	});

	it('reads the old epoch-seconds form', () => {
		expect(parseResetTime('Claude AI usage limit reached|1767225600', NOW)).toBe(1767225600 * 1000);
	});

	it('reads the API ISO form', () => {
		expect(parseResetTime('spend limit reached (daily; resets 2026-10-02 00:00 UTC)', NOW)).toBe(Date.UTC(2026, 9, 2, 0, 0));
	});

	it('reads Codex "try again in 4 days 7 hours 3 minutes"', () => {
		const ms = ((4 * 24 + 7) * 60 + 3) * 60 * 1000;
		expect(parseResetTime("You've hit your usage limit. Upgrade to Pro or try again in 4 days 7 hours 3 minutes.", NOW)).toBe(NOW + ms);
	});

	it('reads Codex "try again at 4:05 PM" in the default zone', () => {
		expect(parseResetTime("You've hit your usage limit. Try again at 4:05 PM.", NOW, 'UTC')).toBe(Date.UTC(2026, 9, 1, 16, 5));
	});

	it('reads Codex "try again at Oct 3rd, 2026 4:05 PM"', () => {
		expect(parseResetTime('try again at Oct 3rd, 2026 4:05 PM.', NOW, 'UTC')).toBe(Date.UTC(2026, 9, 3, 16, 5));
	});

	it('reads "continuing automatically at 3pm"', () => {
		expect(parseResetTime('Usage limit reached · continuing automatically at 3pm · esc to cancel', NOW, 'UTC')).toBe(Date.UTC(2026, 9, 1, 15, 0));
	});

	it('reads "resets in 2h 5m"', () => {
		expect(parseResetTime('quota resets in 2h 5m', NOW)).toBe(NOW + (2 * 60 + 5) * 60 * 1000);
	});

	it('returns null when no time is named', () => {
		expect(parseResetTime('Insufficient Balance', NOW)).toBeNull();
		expect(parseResetTime('', NOW)).toBeNull();
	});

	it('does not trust a bare number with no meridiem', () => {
		expect(parseResetTime('resets 3', NOW)).toBeNull();
	});

	it('falls back to the default zone for an unknown zone name', () => {
		expect(parseResetTime('resets 3pm (Mars/Olympus)', NOW, 'UTC')).toBe(Date.UTC(2026, 9, 1, 15, 0));
	});
});

describe('helpers', () => {
	it('parseRelativeDuration sums units', () => {
		expect(parseRelativeDuration('1 day 2 hours')).toBe((24 + 2) * 3600 * 1000);
		expect(parseRelativeDuration('45s')).toBe(45000);
		expect(parseRelativeDuration('soon')).toBeNull();
	});

	it('isValidTimeZone accepts IANA names and rejects junk', () => {
		expect(isValidTimeZone('America/New_York')).toBe(true);
		expect(isValidTimeZone('UTC')).toBe(true);
		expect(isValidTimeZone('Nowhere/Land')).toBe(false);
		expect(isValidTimeZone(undefined)).toBe(false);
	});

	it('zonedWallTimeToEpoch handles a DST zone', () => {
		// 2026-07-01 09:00 in New York (EDT, UTC-4) = 13:00 UTC.
		expect(zonedWallTimeToEpoch({ year: 2026, month: 6, day: 1, hour: 9, minute: 0 }, 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 13, 0));
		// 2026-12-01 09:00 in New York (EST, UTC-5) = 14:00 UTC.
		expect(zonedWallTimeToEpoch({ year: 2026, month: 11, day: 1, hour: 9, minute: 0 }, 'America/New_York')).toBe(Date.UTC(2026, 11, 1, 14, 0));
	});
});
