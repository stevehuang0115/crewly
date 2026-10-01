/**
 * Reset-time parsing for usage-limit messages.
 *
 * Runtimes say when a usage limit lifts in many shapes:
 *
 * - Claude Code: `You've hit your limit · resets 3pm (America/Los_Angeles)`,
 *   `resets Oct 6, 9am`, `Your limit will reset at 5pm (Asia/Shanghai).`,
 *   `continuing automatically at 3pm`, the old `usage limit reached|1767225600`
 *   (epoch seconds) and the API's `resets 2026-08-08 00:00 UTC`.
 * - Codex: `try again at 4:05 PM`, `try again at Oct 3rd, 2026 4:05 PM`,
 *   `try again in 4 days 7 hours 3 minutes`.
 * - Others: `retry in 45s`, `resets in 2h 5m`.
 *
 * A clock time without a date is the next time that clock time comes round
 * (in the named IANA time zone, else this machine's). Unparseable text
 * gives null — the caller then relies on the switch-back probe.
 *
 * @module services/runtime-fallback/reset-time
 */

/** Month names → 0-based month. */
const MONTHS: Readonly<Record<string, number>> = {
	jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** One day in ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Wall-clock parts in a time zone. */
interface WallParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

/**
 * Whether a string is a time zone `Intl` accepts.
 *
 * @param tz - Candidate (IANA name or `UTC`)
 * @returns True when usable
 */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
	if (!tz) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * Wall-clock parts of an instant in a time zone.
 *
 * @param epochMs - Instant
 * @param tz - Time zone (undefined = this machine's)
 * @returns Parts
 */
function wallPartsAt(epochMs: number, tz: string | undefined): WallParts {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
	});
	const parts: Record<string, number> = {};
	for (const p of fmt.formatToParts(new Date(epochMs))) {
		if (p.type !== 'literal') parts[p.type] = Number(p.value);
	}
	return { year: parts.year, month: parts.month - 1, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

/**
 * The instant at which a wall-clock time occurs in a time zone.
 *
 * @param wall - Wall-clock parts
 * @param tz - Time zone (undefined = this machine's)
 * @returns Epoch ms
 */
export function zonedWallTimeToEpoch(wall: WallParts, tz: string | undefined): number {
	const target = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
	let guess = target;
	// Two passes settle the offset, also across a DST change.
	for (let i = 0; i < 2; i += 1) {
		const seen = wallPartsAt(guess, tz);
		const seenAsUtc = Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
		guess += target - seenAsUtc;
	}
	return guess;
}

/**
 * Convert a 12/24-hour clock reading to 24-hour.
 *
 * @param hour - Hour as written
 * @param meridiem - `am` / `pm` / undefined
 * @returns Hour 0–23, or null when invalid
 */
function to24h(hour: number, meridiem: string | undefined): number | null {
	if (!Number.isFinite(hour)) return null;
	const m = meridiem?.toLowerCase().replace(/\./g, '');
	if (m === 'am' || m === 'pm') {
		if (hour < 1 || hour > 12) return null;
		return (hour % 12) + (m === 'pm' ? 12 : 0);
	}
	return hour >= 0 && hour <= 23 ? hour : null;
}

/** A clock reading: `3pm`, `4:05 PM`, `15:00`, `9am`. */
const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`;
/** An optional date before the clock: `Oct 6,`, `Oct 3rd, 2026`, `on Oct 6 at`. */
const DATE = String.raw`(?:(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s*(?:at\s+)?)?`;
/** A trailing time zone: `(America/Los_Angeles)`, `(UTC)`, ` UTC`. */
const ZONE = String.raw`(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*)\)|\s+(UTC|GMT)\b)?`;

/** What introduces an absolute reset time. */
const ABSOLUTE_LEAD = String.raw`(?:resets?|reset\s+at|resets?\s+at|try\s+again\s+(?:at|after)|available\s+again\s+at|continuing\s+automatically(?:\s+at)?|until)`;

/** Absolute: lead + optional date + clock + optional zone. */
const ABSOLUTE_RE = new RegExp(String.raw`${ABSOLUTE_LEAD}\s+(?:at\s+)?${DATE}${CLOCK}${ZONE}`, 'i');
/** ISO-ish: `resets 2026-08-08 00:00 UTC`. */
const ISO_RE = /(?:resets?|try\s+again\s+at|until)\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?\s*(Z|UTC|GMT)?/i;
/** Epoch seconds after a pipe: `usage limit reached|1767225600`. */
const EPOCH_RE = /limit\s*reached\s*\|\s*(\d{10})\b/i;
/** Relative: `try again in 4 days 7 hours 3 minutes`, `resets in 2h 5m`, `retry in 45s`. */
const RELATIVE_RE = /(?:try\s+again|resets?|retry|available\s+again)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i;

/**
 * Parse a relative duration like `4 days 7 hours 3 minutes` / `2h 5m`.
 *
 * @param text - Duration text
 * @returns Milliseconds, or null
 */
export function parseRelativeDuration(text: string): number | null {
	const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
	let total = 0;
	let found = false;
	for (const m of text.matchAll(re)) {
		const n = Number(m[1]);
		const unit = m[2].toLowerCase();
		found = true;
		if (unit.startsWith('d')) total += n * DAY_MS;
		else if (unit.startsWith('h')) total += n * 60 * 60 * 1000;
		else if (unit.startsWith('m')) total += n * 60 * 1000;
		else total += n * 1000;
	}
	return found && total > 0 ? total : null;
}

/**
 * Find when a usage limit resets, from the text of the limit message.
 *
 * @param text - Normalized terminal / error text
 * @param now - Current time (ms)
 * @param defaultTimeZone - Zone for clock times that name none (default: this machine's)
 * @returns Epoch ms of the reset, or null when the text names none
 *
 * @example
 * ```ts
 * parseResetTime("You've hit your limit · resets 3pm (UTC)", Date.UTC(2026, 9, 1, 12));
 * // Date.UTC(2026, 9, 1, 15)
 * ```
 */
export function parseResetTime(text: string, now: number, defaultTimeZone?: string): number | null {
	if (!text) return null;

	const epoch = EPOCH_RE.exec(text);
	if (epoch) return Number(epoch[1]) * 1000;

	const iso = ISO_RE.exec(text);
	if (iso) {
		const [, y, mo, d, h, mi, zone] = iso;
		const wall = { year: Number(y), month: Number(mo) - 1, day: Number(d), hour: Number(h), minute: Number(mi) };
		return zone ? Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute) : zonedWallTimeToEpoch(wall, defaultTimeZone);
	}

	const rel = RELATIVE_RE.exec(text);
	if (rel) {
		const ms = parseRelativeDuration(rel[1]);
		if (ms !== null) return now + ms;
	}

	const abs = ABSOLUTE_RE.exec(text);
	if (abs) {
		const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zoneName, zoneAbbrev] = abs;
		const hour = to24h(Number(hourText), meridiem);
		const minute = minuteText ? Number(minuteText) : 0;
		// A bare number with no meridiem, no minutes and no date ("resets 3")
		// is too ambiguous to trust.
		if (hour === null || minute > 59 || (!meridiem && !minuteText && !monthName)) return null;
		const zoneCandidate = zoneName ?? zoneAbbrev;
		const tz = isValidTimeZone(zoneCandidate) ? zoneCandidate : isValidTimeZone(defaultTimeZone) ? defaultTimeZone : undefined;

		const today = wallPartsAt(now, tz);
		if (monthName) {
			const month = MONTHS[monthName.slice(0, 4).toLowerCase()] ?? MONTHS[monthName.slice(0, 3).toLowerCase()];
			const day = Number(dayText);
			if (month === undefined || !(day >= 1 && day <= 31)) return null;
			let year = yearText ? Number(yearText) : today.year;
			let at = zonedWallTimeToEpoch({ year, month, day, hour, minute }, tz);
			// "Jan 2" written in late December means next year.
			if (!yearText && at < now - DAY_MS) {
				year += 1;
				at = zonedWallTimeToEpoch({ year, month, day, hour, minute }, tz);
			}
			return at;
		}
		let at = zonedWallTimeToEpoch({ year: today.year, month: today.month, day: today.day, hour, minute }, tz);
		if (at <= now) {
			const tomorrow = wallPartsAt(now + DAY_MS, tz);
			at = zonedWallTimeToEpoch({ year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour, minute }, tz);
		}
		return at;
	}

	return null;
}
