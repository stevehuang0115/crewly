/**
 * Tests for the model pricing table.
 *
 * @module services/monitoring/model-pricing.test
 */

import { resolveRate, calculateCost, OPUS_TIER, OPUS_5_5_TIER, SONNET_TIER, HAIKU_TIER, FABLE_TIER } from './model-pricing.js';

describe('resolveRate', () => {
	it('matches a listed model id exactly', () => {
		const rate = resolveRate('claude-opus-5');
		expect(rate.source).toBe('exact');
		expect(rate.input).toBe(OPUS_TIER.input);
	});

	it('is case-insensitive about the model id', () => {
		expect(resolveRate('Claude-Sonnet-5').source).toBe('exact');
	});

	it('falls back to the family tier for an unlisted model of a known family', () => {
		const rate = resolveRate('claude-opus-9-future');
		expect(rate.source).toBe('family');
		expect(rate.output).toBe(OPUS_TIER.output);
	});

	it('prices the current generation at its published list prices', () => {
		const m = (r: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
			[r.input, r.output, r.cacheRead, r.cacheWrite].map((v) => Math.round(v * 1e8) / 100);
		expect(m(resolveRate('claude-fable-5-1'))).toEqual([10, 50, 0.25, 12.5]);
		expect(m(resolveRate('claude-opus-5-5'))).toEqual([4, 20, 0.2, 5]);
		expect(m(resolveRate('claude-opus-5'))).toEqual([5, 25, 0.5, 6.25]);
		expect(m(resolveRate('claude-sonnet-5-5'))).toEqual([2, 10, 0.2, 2.5]);
		expect(m(resolveRate('claude-sonnet-4-6'))).toEqual([3, 15, 0.3, 3.75]);
		expect(m(resolveRate('claude-haiku-5-5'))).toEqual([0.1, 0.5, 0.01, 0.13]);
		expect(m(resolveRate('claude-opus-4-20250514'))).toEqual([15, 75, 1.5, 18.75]);
		for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
			expect(resolveRate(id).source).toBe('exact');
		}
	});

	it('prices an unlisted fable model at the fable tier', () => {
		expect(resolveRate('claude-fable-6')).toMatchObject({ source: 'family', input: FABLE_TIER.input });
	});

	it('falls back to the sonnet tier for a completely unknown model', () => {
		const rate = resolveRate('some-other-vendor-model');
		expect(rate.source).toBe('default');
		expect(rate.input).toBe(SONNET_TIER.input);
	});

	it('prices Codex (GPT-5) and Gemini 2.5 models at their own list prices, most specific first', () => {
		expect(resolveRate('gpt-5-codex')).toMatchObject({ source: 'family', input: 1.25 / 1e6, output: 10 / 1e6, cacheRead: 0.125 / 1e6 });
		expect(resolveRate('gpt-5-mini').input).toBe(0.25 / 1e6);
		// Codex mini matches before the broader gpt-5 entry.
		expect(resolveRate('gpt-5.1-codex-mini')).toMatchObject({ source: 'family', input: 0.25 / 1e6, output: 2 / 1e6, cacheRead: 0.025 / 1e6 });
		expect(resolveRate('gpt-5.1-codex').input).toBe(1.25 / 1e6);
		expect(resolveRate('gemini-2.5-pro').output).toBe(10 / 1e6);
		expect(resolveRate('gemini-2.5-flash').input).toBe(0.3 / 1e6);
		// A placeholder for an unknown Codex model stays on the default.
		expect(resolveRate('codex-cli-default').source).toBe('default');
	});

	it('handles an empty model id without throwing', () => {
		expect(resolveRate('').source).toBe('default');
	});

	it('prices the 4.5 generation of haiku above the 4.0 and 5.5 generations', () => {
		expect(resolveRate('claude-haiku-4-5').input).toBe(1 / 1e6);
		expect(resolveRate('claude-haiku-4-20250506').input).toBeLessThan(1 / 1e6);
		expect(resolveRate('claude-haiku-5-5').input).toBe(HAIKU_TIER.input);
	});
});

describe('calculateCost', () => {
	it('charges cache reads far below fresh input', () => {
		const fresh = calculateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5');
		const cached = calculateCost({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, 'claude-opus-5');
		expect(fresh.cost).toBeCloseTo(5, 6);
		expect(cached.cost).toBeCloseTo(0.5, 6);
	});

	it('charges cache writes above fresh input', () => {
		const written = calculateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, 'claude-opus-5');
		expect(written.cost).toBeCloseTo(6.25, 6);
	});

	it('reports a non-exact rate as estimated', () => {
		expect(calculateCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5').estimated).toBe(false);
		expect(calculateCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-9').estimated).toBe(true);
	});

	it('sums all four token kinds', () => {
		const { cost } = calculateCost(
			{ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
			'claude-opus-5',
		);
		expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6);
	});

	it('bills a Haiku 5.5 round-trip above 100K prompt tokens at the long-prompt rate', () => {
		const short = calculateCost({ input: 1_000, output: 1_000_000, cacheRead: 99_000, cacheWrite: 0 }, 'claude-haiku-5-5');
		const long = calculateCost({ input: 1_000, output: 1_000_000, cacheRead: 100_000, cacheWrite: 0 }, 'claude-haiku-5-5');
		expect(short.cost).toBeCloseTo(0.0001 + 0.5 + 0.00099, 9);
		expect(long.cost).toBeCloseTo(0.0005 + 2.5 + 0.005, 9);
		expect(long.estimated).toBe(false);
	});

	it('uses the cheaper Opus 5.5 cache reads', () => {
		expect(calculateCost({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, 'claude-opus-5-5').cost).toBeCloseTo(OPUS_5_5_TIER.cacheRead * 1e6, 9);
	});

	it('costs nothing for an empty split', () => {
		expect(calculateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5').cost).toBe(0);
	});
});
