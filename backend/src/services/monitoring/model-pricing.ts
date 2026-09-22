/**
 * Model Pricing Table
 *
 * List prices for the runtimes Crewly drives, used to turn raw token counts
 * into a cost figure for the Usage dashboard.
 *
 * Two things to keep in mind when reading a cost produced from this table:
 *
 * 1. These are pay-as-you-go API list prices. An agent running under a Max
 *    subscription does not generate a bill at these rates — the number is an
 *    API-equivalent, useful for comparing agents against each other and for
 *    spotting runaway context, not for reconciling an invoice.
 * 2. Cache reads are far cheaper than fresh input and cache writes are dearer,
 *    so a cost computed without splitting them out is wrong by an order of
 *    magnitude for a long-lived agent. Every rate here is cache-aware and
 *    {@link calculateCost} requires the split.
 *
 * When a model is not listed by name we fall back to its family (the `opus` /
 * `sonnet` / `haiku` substring) and finally to the sonnet tier. The resolved
 * rate carries a `source` so callers can mark an estimated cost as estimated
 * rather than presenting a guess as a measurement.
 *
 * @module services/monitoring/model-pricing
 */

/** Per-token USD rates for one model, split by how the tokens were billed. */
export interface ModelRate {
	/** USD per fresh (uncached) input token */
	input: number;
	/** USD per output token */
	output: number;
	/** USD per token read from the prompt cache */
	cacheRead: number;
	/** USD per token written to the prompt cache */
	cacheWrite: number;
}

/** A {@link ModelRate} plus how confidently it was matched to the model. */
export interface ResolvedModelRate extends ModelRate {
	/**
	 * `exact` — the model id is listed by name.
	 * `family` — matched on an `opus`/`sonnet`/`haiku`/`fable` substring.
	 * `default` — nothing matched; the sonnet tier was assumed.
	 *
	 * Anything other than `exact` means the cost is an estimate.
	 */
	source: 'exact' | 'family' | 'default';
}

/** Builds a per-token rate from the per-million-token list prices. */
function perMillion(input: number, output: number, cacheRead: number, cacheWrite: number): ModelRate {
	return {
		input: input / 1_000_000,
		output: output / 1_000_000,
		cacheRead: cacheRead / 1_000_000,
		cacheWrite: cacheWrite / 1_000_000,
	};
}

/** Opus-class list price (USD per 1M tokens). */
export const OPUS_TIER = perMillion(15, 75, 1.5, 18.75);
/** Sonnet-class list price (USD per 1M tokens). */
export const SONNET_TIER = perMillion(3, 15, 0.3, 3.75);
/** Haiku-class list price (USD per 1M tokens), 4.5 generation. */
export const HAIKU_TIER = perMillion(1, 5, 0.1, 1.25);

/**
 * Per-model rates, keyed by the exact model id the runtime reports.
 *
 * `fable` models are priced at the opus tier. That is an assumption, not a
 * published figure — it is the closest tier by capability, and pricing a
 * frontier model at the sonnet default understates it roughly fivefold, which
 * is the more damaging error for a dashboard whose job is to surface runaway
 * spend. Costs for these models resolve with `source: 'family'` so the UI can
 * label them estimated.
 */
const EXACT_RATES: Record<string, ModelRate> = {
	'claude-opus-5': OPUS_TIER,
	'claude-opus-4-8': OPUS_TIER,
	'claude-opus-4-6': OPUS_TIER,
	'claude-opus-4-20250514': OPUS_TIER,
	'claude-sonnet-5': SONNET_TIER,
	'claude-sonnet-4-6': SONNET_TIER,
	'claude-sonnet-4-20250514': SONNET_TIER,
	'claude-haiku-4-5-20251001': HAIKU_TIER,
	'claude-haiku-4-5': HAIKU_TIER,
	// The 4.0 generation of Haiku was a quarter of the 4.5 price.
	'claude-haiku-4-20250506': perMillion(0.25, 1.25, 0.025, 0.3125),
	// DeepSeek, used by the in-process crewly-agent runtime.
	'deepseek/deepseek-chat': perMillion(0.27, 1.1, 0.07, 0.27),
	'deepseek-chat': perMillion(0.27, 1.1, 0.07, 0.27),
};

/** Substring → tier, tried in order when no exact id matches. */
const FAMILY_RATES: ReadonlyArray<readonly [string, ModelRate]> = [
	['opus', OPUS_TIER],
	['fable', OPUS_TIER],
	['sonnet', SONNET_TIER],
	['haiku', HAIKU_TIER],
	['deepseek', perMillion(0.27, 1.1, 0.07, 0.27)],
];

/**
 * Resolves the billing rate for a model id.
 *
 * @param model - Model id as the runtime reported it (e.g. `claude-opus-5`)
 * @returns The rate plus how it was matched; never throws, never returns null
 *
 * @example
 * ```typescript
 * const rate = resolveRate('claude-opus-5');   // source: 'exact'
 * const guess = resolveRate('claude-fable-5-1'); // source: 'family'
 * ```
 */
export function resolveRate(model: string): ResolvedModelRate {
	const id = (model || '').toLowerCase();

	const exact = EXACT_RATES[id];
	if (exact) return { ...exact, source: 'exact' };

	for (const [needle, rate] of FAMILY_RATES) {
		if (id.includes(needle)) return { ...rate, source: 'family' };
	}

	return { ...SONNET_TIER, source: 'default' };
}

/** The four token counts that make up one model round-trip. */
export interface TokenSplit {
	/** Fresh input tokens (not served from cache) */
	input: number;
	/** Output tokens */
	output: number;
	/** Input tokens served from the prompt cache */
	cacheRead: number;
	/** Input tokens written into the prompt cache */
	cacheWrite: number;
}

/**
 * Computes the cache-aware cost of one or more model round-trips.
 *
 * @param split - The four token counts; pass 0 for any the runtime omits
 * @param model - Model id as the runtime reported it
 * @returns Cost in USD, and whether the rate was an exact match
 *
 * @example
 * ```typescript
 * const { cost, estimated } = calculateCost(
 *   { input: 500, output: 200, cacheRead: 690_000, cacheWrite: 0 },
 *   'claude-opus-5',
 * );
 * ```
 */
export function calculateCost(
	split: TokenSplit,
	model: string,
): { cost: number; estimated: boolean; rateSource: ResolvedModelRate['source'] } {
	const rate = resolveRate(model);
	const cost =
		split.input * rate.input +
		split.output * rate.output +
		split.cacheRead * rate.cacheRead +
		split.cacheWrite * rate.cacheWrite;
	return { cost, estimated: rate.source !== 'exact', rateSource: rate.source };
}
