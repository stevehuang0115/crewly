/**
 * Model tiers (crewly#1173, specs/2026-10-08-model-tiers.md).
 *
 * A member may carry a tier (`strong` | `mid` | `weak`) instead of a concrete
 * model. At launch the tier resolves to a model for the runtime that really
 * runs: the team's own map (`Team.tierModels`) first, then the global map
 * (`MODEL_TIER_CONSTANTS.DEFAULT_TIER_MODELS`). A runtime without a `weak`
 * model uses its `mid` model; any other unmapped tier resolves to nothing
 * (the runtime's own default).
 *
 * @module utils/model-tier
 */

import { MODEL_TIER_CONSTANTS } from '../constants.js';
import type { ModelTier, TeamTierModels } from '../types/index.js';
import { isSafeModelId } from './runtime-model-flags.utils.js';

/** Tiers, strongest first. */
export const MODEL_TIERS: readonly ModelTier[] = MODEL_TIER_CONSTANTS.TIERS;

/**
 * Whether a value names a tier.
 *
 * @param value - Candidate
 * @returns True for `strong`, `mid` or `weak`
 */
export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value);
}

/**
 * Rank of a tier: 2 = strong, 1 = mid, 0 = weak.
 *
 * @param tier - Tier
 * @returns Rank (higher is stronger)
 */
export function tierRank(tier: ModelTier): number {
  return MODEL_TIERS.length - 1 - MODEL_TIERS.indexOf(tier);
}

/**
 * The tier → model map for one runtime: the global map with the team's
 * overrides on top. Overrides that are not shell-safe model ids are ignored.
 *
 * @param runtime - Runtime id (`claude-code`, `codex-cli`, …)
 * @param overrides - The team's `tierModels`
 * @returns Map with only the tiers that have a model
 */
export function tierMapFor(runtime: string, overrides?: TeamTierModels): Partial<Record<ModelTier, string>> {
  const base = MODEL_TIER_CONSTANTS.DEFAULT_TIER_MODELS[runtime] ?? {};
  const own = overrides?.[runtime] ?? {};
  const out: Partial<Record<ModelTier, string>> = {};
  for (const tier of MODEL_TIERS) {
    const candidate = typeof own[tier] === 'string' && own[tier]!.trim() && isSafeModelId(own[tier]!.trim()) ? own[tier]!.trim() : base[tier];
    if (candidate) out[tier] = candidate;
  }
  return out;
}

/**
 * The model a tier runs on for a runtime.
 *
 * @param runtime - Runtime that launches
 * @param tier - The member's tier
 * @param overrides - The team's `tierModels`
 * @returns Model id, or undefined for the runtime's own default
 *
 * @example
 * ```typescript
 * resolveTierModel('claude-code', 'weak');             // 'haiku'
 * resolveTierModel('codex-cli', 'weak');               // 'gpt-5.4' (no weak model: mid)
 * resolveTierModel('crewly-agent', 'strong');          // undefined
 * ```
 */
export function resolveTierModel(runtime: string, tier: ModelTier | undefined, overrides?: TeamTierModels): string | undefined {
  if (!isModelTier(tier)) return undefined;
  const map = tierMapFor(runtime, overrides);
  if (map[tier]) return map[tier];
  if (tier === 'weak') return map.mid;
  return undefined;
}

/**
 * Validate a team's `tierModels` payload.
 *
 * @param value - Candidate (`{ runtime: { tier: model } }`)
 * @returns The cleaned map, or an error message
 */
export function parseTierModels(value: unknown): { ok: true; value: TeamTierModels } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'tierModels must be an object: { "<runtime>": { "strong"|"mid"|"weak": "<model>" } }' };
  const out: TeamTierModels = {};
  for (const [runtime, tiers] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(runtime)) return { ok: false, error: `Unknown runtime "${runtime}"` };
    if (tiers === null || typeof tiers !== 'object' || Array.isArray(tiers)) return { ok: false, error: `tierModels.${runtime} must be an object of tier → model` };
    const entry: Partial<Record<ModelTier, string>> = {};
    for (const [tier, model] of Object.entries(tiers as Record<string, unknown>)) {
      if (!isModelTier(tier)) return { ok: false, error: `Unknown tier "${tier}" (use strong, mid or weak)` };
      if (model === '' || model === null || model === undefined) continue;
      if (typeof model !== 'string' || !isSafeModelId(model.trim())) return { ok: false, error: `Invalid model for ${runtime}.${tier}: use the model name as the runtime expects it` };
      entry[tier] = model.trim();
    }
    if (Object.keys(entry).length > 0) out[runtime] = entry;
  }
  return { ok: true, value: out };
}
