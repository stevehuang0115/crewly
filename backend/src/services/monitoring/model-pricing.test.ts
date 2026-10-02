/**
 * Tests for the model pricing table.
 *
 * @module services/monitoring/model-pricing.test
 */

import { resolveRate, calculateCost, OPUS_TIER, SONNET_TIER, HAIKU_TIER } from './model-pricing.js';

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

	it('prices fable at the opus tier and flags it as an estimate', () => {
		// We do not have a published fable rate. Pricing it at the sonnet
		// default would understate a frontier model ~5x, which is the wrong
		// direction of error for a dashboard meant to catch runaway spend.
		const rate = resolveRate('claude-fable-5-1');
		expect(rate.source).toBe('family');
		expect(rate.input).toBe(OPUS_TIER.input);
	});

	it('falls back to the sonnet tier for a completely unknown model', () => {
		const rate = resolveRate('some-other-vendor-model');
		expect(rate.source).toBe('default');
		expect(rate.input).toBe(SONNET_TIER.input);
	});

	it('prices Codex (GPT-5) and Gemini 2.5 models at their own list prices, most specific first', () => {
		expect(resolveRate('gpt-5-codex')).toMatchObject({ source: 'family', input: 1.25 / 1e6, output: 10 / 1e6, cacheRead: 0.125 / 1e6 });
		expect(resolveRate('gpt-5-mini').input).toBe(0.25 / 1e6);
		expect(resolveRate('gemini-2.5-pro').output).toBe(10 / 1e6);
		expect(resolveRate('gemini-2.5-flash').input).toBe(0.3 / 1e6);
		// A placeholder for an unknown Codex model stays on the default.
		expect(resolveRate('codex-cli-default').source).toBe('default');
	});

	it('handles an empty model id without throwing', () => {
		expect(resolveRate('').source).toBe('default');
	});

	it('prices the 4.5 generation of haiku above the 4.0 generation', () => {
		expect(resolveRate('claude-haiku-4-5').input).toBe(HAIKU_TIER.input);
		expect(resolveRate('claude-haiku-4-20250506').input).toBeLessThan(HAIKU_TIER.input);
	});
});

describe('calculateCost', () => {
	it('charges cache reads far below fresh input', () => {
		const fresh = calculateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5');
		const cached = calculateCost({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, 'claude-opus-5');
		expect(fresh.cost).toBeCloseTo(15, 6);
		expect(cached.cost).toBeCloseTo(1.5, 6);
	});

	it('charges cache writes above fresh input', () => {
		const written = calculateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, 'claude-opus-5');
		expect(written.cost).toBeCloseTo(18.75, 6);
	});

	it('reports a non-exact rate as estimated', () => {
		expect(calculateCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5').estimated).toBe(false);
		expect(calculateCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 'claude-fable-5-1').estimated).toBe(true);
	});

	it('sums all four token kinds', () => {
		const { cost } = calculateCost(
			{ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
			'claude-opus-5',
		);
		expect(cost).toBeCloseTo(15 + 75 + 1.5 + 18.75, 6);
	});

	it('costs nothing for an empty split', () => {
		expect(calculateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5').cost).toBe(0);
	});
});
