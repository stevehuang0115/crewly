/**
 * Transcript cost repair (#990) — pure planning for the one-time
 * `costBasis: 3` repair of Claude transcript cursors.
 *
 * Between v1.20.89 and v1.20.192 a recounted cursor could count its
 * transcript twice (#972): the recount set `cost` to the whole transcript but
 * kept an offset that pointed past the end of the file, so the next sync took
 * it for a truncation and counted every turn again. #976 fixed the recount
 * going forward, but cursors that were already double-counted keep the
 * inflated `cost`, which the Usage dashboard shows as the agent's spend.
 *
 * The token ledger (`token-usage.json`) lists every counted turn once: it has
 * no pruning, and exact repeats are dropped on load. A cursor's `cost` is
 * only a running sum of the same turns, so it should never be above its
 * session's ledger cost. The repair lowers a cursor to the ledger cost when it
 * is clearly above it, and never raises or lowers it otherwise. It only acts
 * when the ledger is known to be current for that session (its newest
 * transcript turn is in the ledger), so a stale or restored ledger cannot pull
 * a correct cursor down.
 *
 * @module services/monitoring/transcript-cost-repair
 */

import { CLAUDE_TRANSCRIPT_SYNC_CONSTANTS } from '../../constants.js';
import { calculateCost } from './model-pricing.js';

/** The ledger fields the repair prices. */
export interface LedgerEventLike {
	input: number;
	output: number;
	model: string;
	/** Cache read + cache write tokens */
	cachedInput?: number;
	/** Of `cachedInput`, the tokens written to the cache */
	cacheWrite?: number;
}

/** The cursor fields the repair reads. */
export interface RepairCursorLike {
	cost: number;
	costBasis?: number;
}

/** What the ledger says about one session. */
export interface LedgerView {
	/** Cache-aware USD cost of all the session's ledger events */
	cost: number;
	/**
	 * Whether the session's newest transcript turn is in the ledger, i.e. the
	 * ledger is not behind the cursor. Undefined when it could not be checked.
	 */
	current: boolean | undefined;
}

/** One cursor the repair lowers. */
export interface CostRepairChange {
	sessionName: string;
	/** Cursor cost before (USD) */
	was: number;
	/** Cursor cost after (USD) = the ledger cost */
	now: number;
	/** How much was removed (USD) */
	excess: number;
}

/** What the repair would do. */
export interface CostRepairPlan {
	/** Cursors lowered to their ledger cost */
	changes: CostRepairChange[];
	/** Cursors checked and found correct (left as they are) */
	verified: string[];
	/** Cursors that could not be checked (no ledger, or the ledger is not current); retried next time */
	skipped: Array<{ sessionName: string; reason: 'no-ledger' | 'ledger-not-current' }>;
}

/**
 * Cache-aware cost of one ledger event, priced exactly as the transcript
 * sync priced the turn it records.
 *
 * @param event - Ledger event
 * @returns USD cost
 *
 * @example
 * ```typescript
 * ledgerEventCost({ input: 10, output: 200, cachedInput: 5000, cacheWrite: 1000, model: 'claude-opus-4-6' });
 * ```
 */
export function ledgerEventCost(event: LedgerEventLike): number {
	const cached = event.cachedInput ?? 0;
	const cacheWrite = Math.min(event.cacheWrite ?? 0, cached);
	return calculateCost(
		{ input: event.input, output: event.output, cacheRead: cached - cacheWrite, cacheWrite },
		event.model,
	).cost;
}

/**
 * Decide which cursors the repair lowers. Pure: changes nothing.
 *
 * A cursor is lowered only when all of these hold:
 * - it has not been repaired yet (`costBasis !== 3`);
 * - its session has ledger events and the ledger is current for it;
 * - its cost is above the ledger cost by more than COST_REPAIR_MIN_EXCESS_USD
 *   and by more than COST_REPAIR_MIN_EXCESS_FRACTION of the ledger cost.
 *
 * @param cursors - Cursors by session name
 * @param ledgerOf - Ledger view of a session, or undefined when it has no events
 * @returns The plan
 *
 * @example
 * ```typescript
 * planCostRepair({ 'agent-a': { cost: 200, costBasis: 2 } }, () => ({ cost: 100, current: true }));
 * // { changes: [{ sessionName: 'agent-a', was: 200, now: 100, excess: 100 }], verified: [], skipped: [] }
 * ```
 */
export function planCostRepair(
	cursors: Record<string, RepairCursorLike>,
	ledgerOf: (sessionName: string) => LedgerView | undefined,
): CostRepairPlan {
	const plan: CostRepairPlan = { changes: [], verified: [], skipped: [] };
	for (const [sessionName, cursor] of Object.entries(cursors)) {
		if (cursor.costBasis === 3) continue;
		const ledger = ledgerOf(sessionName);
		if (!ledger) {
			plan.skipped.push({ sessionName, reason: 'no-ledger' });
			continue;
		}
		const excess = cursor.cost - ledger.cost;
		const clearlyAbove =
			excess > CLAUDE_TRANSCRIPT_SYNC_CONSTANTS.COST_REPAIR_MIN_EXCESS_USD
			&& excess > ledger.cost * CLAUDE_TRANSCRIPT_SYNC_CONSTANTS.COST_REPAIR_MIN_EXCESS_FRACTION;
		if (!clearlyAbove) {
			plan.verified.push(sessionName);
			continue;
		}
		if (ledger.current !== true) {
			plan.skipped.push({ sessionName, reason: 'ledger-not-current' });
			continue;
		}
		plan.changes.push({ sessionName, was: cursor.cost, now: ledger.cost, excess });
	}
	return plan;
}
