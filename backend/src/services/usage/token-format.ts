/**
 * Token amounts for owners: "12.4M tokens" out, "20M" / "500k" / "2000万" in.
 *
 * specs/2026-10-02-spend-cap.md §Token unit
 *
 * @module services/usage/token-format
 */

import { USAGE_CONSTANTS } from '../../constants.js';

/**
 * Short token count: `950`, `12.4K`, `12.4M`, `1.2B`.
 *
 * @param tokens - Token count
 * @returns Compact text (no unit)
 *
 * @example
 * compactTokens(12_400_000) // '12.4M'
 */
export function compactTokens(tokens: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size;
      const text = v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
      return `${text}${suffix}`;
    }
  }
  return String(n);
}

/**
 * Token count for owner text.
 *
 * @param tokens - Token count
 * @returns e.g. `12.4M tokens`
 */
export function formatTokens(tokens: number): string {
  return `${compactTokens(tokens)} tokens`;
}

/**
 * Parse a token amount the owner typed.
 *
 * Accepts a plain number, `K`/`M`/`B` suffixes (any case, `mil`/`million`
 * too), Chinese `万` (10k) / `亿` (100M), commas, and an optional trailing
 * `tokens` / `token`.
 *
 * @param text - Amount text
 * @returns Whole tokens, or null when it is not a positive amount
 *
 * @example
 * parseTokenAmount('20M') // 20_000_000
 * parseTokenAmount('2000万') // 20_000_000
 * parseTokenAmount('1.5b tokens') // 1_500_000_000
 */
export function parseTokenAmount(text: unknown): number | null {
  if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? Math.round(text) : null;
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase().replace(/,/g, '').replace(/\s*(?:tokens?|个)?\s*$/u, '');
  const m = /^(\d+(?:\.\d+)?)\s*(k|m|mil|million|b|bn|billion|万|亿)?$/u.exec(t);
  if (!m) return null;
  const mult: Record<string, number> = { k: 1e3, m: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, 万: 1e4, 亿: 1e8 };
  const n = Number(m[1]) * (m[2] ? mult[m[2]] : 1);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}

/**
 * Convert a USD setting to tokens with the documented migration rate
 * ({@link USAGE_CONSTANTS.TOKENS_PER_USD}), rounded to a whole thousand.
 *
 * @param usd - Dollars
 * @returns Tokens
 */
export function usdToTokens(usd: number): number {
  return Math.max(1000, Math.round((usd * USAGE_CONSTANTS.TOKENS_PER_USD) / 1000) * 1000);
}
