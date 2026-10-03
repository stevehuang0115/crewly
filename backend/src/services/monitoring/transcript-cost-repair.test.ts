/**
 * Tests for the #990 transcript cost repair planner.
 *
 * Samples follow the shapes seen on a real machine (2026-10-02): one cursor
 * fully doubled (cursor ≈ 1.99 × ledger), some partly inflated (1.03–1.14 ×),
 * most correct (within 0.5% either way from price-table drift).
 */

import { planCostRepair, ledgerEventCost, type LedgerView } from './transcript-cost-repair.js';
import { calculateCost } from './model-pricing.js';
import { CLAUDE_TRANSCRIPT_SYNC_CONSTANTS as C } from '../../constants.js';

describe('ledgerEventCost', () => {
	it('prices an event as the transcript sync priced its turn (cache read and write apart)', () => {
		const event = { input: 12, output: 840, cachedInput: 180_000, cacheWrite: 6_000, model: 'claude-opus-4-6' };
		const expected = calculateCost({ input: 12, output: 840, cacheRead: 174_000, cacheWrite: 6_000 }, 'claude-opus-4-6').cost;
		expect(ledgerEventCost(event)).toBeCloseTo(expected, 10);
	});

	it('treats a missing cache split as no cache', () => {
		const expected = calculateCost({ input: 500, output: 20, cacheRead: 0, cacheWrite: 0 }, 'claude-sonnet-4-6').cost;
		expect(ledgerEventCost({ input: 500, output: 20, model: 'claude-sonnet-4-6' })).toBeCloseTo(expected, 10);
	});
});

describe('planCostRepair', () => {
	const ledgers: Record<string, LedgerView> = {
		'flopost-pia': { cost: 5091.2, current: true },
		'crewly-product-team-quinn': { cost: 973.1, current: true },
		'think-tank-atlas': { cost: 2339.0, current: true },
		'crewly-marketing-luna': { cost: 1293.0, current: true },
		'crewly-product-team-sam': { cost: 1727.0, current: true },
		'ce-vera': { cost: 283.0, current: true },
		'stale-ledger': { cost: 100, current: false },
		'unreadable-transcript': { cost: 100, current: undefined },
	};
	const ledgerOf = (name: string) => ledgers[name];

	it('lowers a fully doubled cursor to its ledger cost', () => {
		const plan = planCostRepair({ 'flopost-pia': { cost: 10121.53, costBasis: 2 } }, ledgerOf);
		expect(plan.changes).toEqual([
			{ sessionName: 'flopost-pia', was: 10121.53, now: 5091.2, excess: expect.closeTo(5030.33, 2) },
		]);
	});

	it('lowers partly inflated cursors (3%–14% above the ledger)', () => {
		const plan = planCostRepair(
			{ 'crewly-product-team-quinn': { cost: 1109.89, costBasis: 2 }, 'think-tank-atlas': { cost: 2410.42, costBasis: 2 } },
			ledgerOf,
		);
		expect(plan.changes.map((c) => [c.sessionName, c.now])).toEqual([
			['crewly-product-team-quinn', 973.1],
			['think-tank-atlas', 2339.0],
		]);
	});

	it('never lowers a cursor within the tolerance, and never raises one below its ledger', () => {
		const plan = planCostRepair(
			{
				'crewly-marketing-luna': { cost: 1293.0 * 1.005, costBasis: 2 }, // price drift
				'crewly-product-team-sam': { cost: 1717.53, costBasis: 2 }, // below the ledger
				'ce-vera': { cost: 283.9, costBasis: 2 }, // $0.90 above: under the USD floor
			},
			ledgerOf,
		);
		expect(plan.changes).toEqual([]);
		expect(plan.verified.sort()).toEqual(['ce-vera', 'crewly-marketing-luna', 'crewly-product-team-sam']);
	});

	it('uses both floors: a small session needs more than $1, a large one more than 2%', () => {
		expect(C.COST_REPAIR_MIN_EXCESS_USD).toBe(1);
		expect(C.COST_REPAIR_MIN_EXCESS_FRACTION).toBe(0.02);
		const big = planCostRepair({ big: { cost: 1015, costBasis: 2 } }, () => ({ cost: 1000, current: true }));
		expect(big.changes).toEqual([]); // $15 but only 1.5%
		const small = planCostRepair({ small: { cost: 2.5, costBasis: 2 } }, () => ({ cost: 1, current: true }));
		expect(small.changes).toHaveLength(1); // $1.50 and 150%
	});

	it('skips a cursor whose ledger is missing, stale or unverifiable, without marking it', () => {
		const plan = planCostRepair(
			{
				'no-ledger': { cost: 50, costBasis: 2 },
				'stale-ledger': { cost: 400, costBasis: 2 },
				'unreadable-transcript': { cost: 400, costBasis: 2 },
			},
			ledgerOf,
		);
		expect(plan.changes).toEqual([]);
		expect(plan.verified).toEqual([]);
		expect(plan.skipped).toEqual([
			{ sessionName: 'no-ledger', reason: 'no-ledger' },
			{ sessionName: 'stale-ledger', reason: 'ledger-not-current' },
			{ sessionName: 'unreadable-transcript', reason: 'ledger-not-current' },
		]);
	});

	it('leaves already repaired cursors (costBasis 3) alone', () => {
		const plan = planCostRepair({ 'flopost-pia': { cost: 10121.53, costBasis: 3 } }, ledgerOf);
		expect(plan).toEqual({ changes: [], verified: [], skipped: [] });
	});
});
