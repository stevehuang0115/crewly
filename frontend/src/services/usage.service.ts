/**
 * Usage Service
 *
 * API client for token usage stats, daily token caps and temporary boosts
 * (`/api/system/usage*`). Uses the shared axios instance, so the API-token
 * interceptors apply. The unit is tokens: input (cached included) + output.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/usage.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';

/** Endpoints. */
export const USAGE_API = {
  STATS: '/api/system/usage',
  CAPS: '/api/system/usage/caps',
  BOOST: '/api/system/usage/boost',
} as const;

/** A grouping of the stats endpoint. */
export type UsageGroupBy = 'agent' | 'team' | 'project' | 'workItem' | 'runtime' | 'day' | 'model';

/** Token figures. */
export interface UsageTokens {
  input: number;
  cachedInput: number;
  output: number;
  total: number;
  events: number;
  /** Estimated API-equivalent cost in USD (absent from older backends) */
  costUsd?: number;
}

/** One stats row. */
export interface UsageRow extends UsageTokens {
  key: string;
  label: string;
  share: number;
  link?: string;
  meta?: Record<string, string | string[]>;
}

/** `GET /api/system/usage`. */
export interface UsageStats {
  days: number;
  since: string;
  today: string;
  totals: UsageTokens;
  todayTotals: UsageTokens;
  groupBy: UsageGroupBy[];
  rows: UsageRow[];
  groups: Partial<Record<UsageGroupBy, UsageRow[]>>;
}

/** The owner's caps (tokens per local day). */
export interface UsageCaps {
  defaultAgentCapTokens: number | null;
  totalCapTokens: number | null;
  agentCapsTokens: Record<string, number | null>;
  teamCapsTokens: Record<string, number | null>;
  updatedAt?: string;
}

/** A temporary boost. */
export interface UsageBoost {
  id: string;
  /** Agent session, `team:<id>`, or `*` */
  target: string;
  extraTokens?: number;
  unlimited?: boolean;
  until: string;
  createdAt: string;
  by?: string;
}

/** One team in the caps view. */
export interface CapTeam {
  teamId: string;
  name: string;
  members: string[];
  todayTokens: number;
  baseCapTokens: number | null;
  capTokens: number | null;
  extraTokens: number;
  unlimited: boolean;
  boosts: UsageBoost[];
  stopped: boolean;
}

/** One agent in the caps view. */
export interface CapAgent {
  session: string;
  name: string;
  teamId?: string;
  runtimes: string[];
  todayTokens: number;
  windowTokens: number;
  capTokens: number | null;
  baseCapTokens: number | null;
  capSource: 'override' | 'default' | 'none' | 'exempt';
  boosted: boolean;
  unlimited: boolean;
  stopped: boolean;
  stopReason?: string;
}

/** `GET /api/system/usage/caps`. */
export interface CapsView {
  today: string;
  todayTokens: number;
  totalTokens: number;
  agents: CapAgent[];
  teams: CapTeam[];
  caps: UsageCaps;
  boosts: UsageBoost[];
  totalCapTodayTokens: number | null;
  suggestedAgentCapTokens: number | null;
  totalStopped: boolean;
}

/** Body of `PUT /api/system/usage/caps`. */
export interface CapsPatch {
  defaultAgentCapTokens?: number | null;
  totalCapTokens?: number | null;
  agents?: Record<string, number | null | 'default'>;
  teams?: Record<string, number | null>;
}

/** Body of `POST /api/system/usage/boost`. */
export interface BoostRequest {
  scope: 'team' | 'agent' | 'all';
  id?: string;
  extraTokens?: number;
  unlimited?: boolean;
  until?: string;
}

/**
 * Run a request and unwrap `{ success, data }`, surfacing the server's error.
 *
 * @param request - Request thunk
 * @param fallback - Message when the server gave none
 * @returns The payload
 */
async function call<T>(request: () => Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
  try {
    const { data: body } = await request();
    if (!body?.success || body.data === undefined || body.data === null) throw new Error(body?.error || fallback);
    return body.data;
  } catch (err) {
    if (isAxiosError(err)) {
      const body = err.response?.data as ApiResponse<unknown> | undefined;
      throw new Error(body?.error || err.message || fallback);
    }
    throw err instanceof Error ? err : new Error(fallback);
  }
}

/** Client. */
export const usageService = {
  /**
   * Token stats for the last `days` local days.
   *
   * @param days - Window (1 = today)
   * @param groupBy - Groupings
   * @returns Stats
   */
  stats(days: number, groupBy: UsageGroupBy[]): Promise<UsageStats> {
    return call(() => axios.get<ApiResponse<UsageStats>>(USAGE_API.STATS, { params: { days, groupBy: groupBy.join(',') } }), 'Failed to load usage');
  },

  /**
   * Caps, boosts and today's usage per team / agent.
   *
   * @param days - Window for the per-agent figures
   * @returns View
   */
  caps(days = 7): Promise<CapsView> {
    return call(() => axios.get<ApiResponse<CapsView>>(USAGE_API.CAPS, { params: { days } }), 'Failed to load the caps');
  },

  /**
   * Change caps (owner only).
   *
   * @param patch - Changes
   * @returns The new caps
   */
  setCaps(patch: CapsPatch): Promise<UsageCaps> {
    return call(() => axios.put<ApiResponse<UsageCaps>>(USAGE_API.CAPS, patch), 'Failed to save the caps');
  },

  /**
   * Temporary boost (owner only); ends at local midnight unless `until` is given.
   *
   * @param req - Scope, id, extra tokens or unlimited
   * @returns The boost
   */
  boost(req: BoostRequest): Promise<UsageBoost> {
    return call(() => axios.post<ApiResponse<UsageBoost>>(USAGE_API.BOOST, req), 'Failed to boost');
  },

  /**
   * End a boost early (owner only).
   *
   * @param id - Boost id
   * @returns The id
   */
  endBoost(id: string): Promise<{ id: string }> {
    return call(() => axios.delete<ApiResponse<{ id: string }>>(`${USAGE_API.BOOST}/${encodeURIComponent(id)}`), 'Failed to end the boost');
  },
};

/**
 * Short token count: `950`, `12.4K`, `12.4M`, `1.2B`.
 *
 * @param n - Tokens
 * @returns Text
 */
export function compactTokens(n: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  for (const [size, suffix] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const) {
    if (v >= size) {
      const x = v / size;
      return `${x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return String(v);
}

/**
 * Estimated cost in US dollars.
 *
 * @param usd - Dollars
 * @returns e.g. `$0.42`, `$12.30`, `$1,204`, `<$0.01`
 */
export function usd(usd: number | undefined): string {
  const v = Number.isFinite(usd) ? Math.max(0, usd as number) : 0;
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/**
 * Token count with its unit.
 *
 * @param n - Tokens
 * @returns e.g. `12.4M tokens`
 */
export function tokens(n: number): string {
  return `${compactTokens(n)} tokens`;
}

/**
 * Parse a token amount typed into a field: `20M`, `500k`, `1.5B`, `2000万`, `5000000`.
 *
 * @param text - Field text (`""` = off)
 * @returns Tokens, null for off, or undefined when unreadable
 */
export function parseTokenInput(text: string): number | null | undefined {
  const t = text.trim().toLowerCase().replace(/,/g, '').replace(/\s*tokens?$/, '');
  if (t === '') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(k|m|b|万|亿)?$/u.exec(t);
  if (!m) return undefined;
  const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 亿: 1e8 };
  const n = Math.round(Number(m[1]) * (m[2] ? mult[m[2]] : 1));
  return n >= 1 ? n : undefined;
}

/**
 * The one-tap boost for a cap: the cap rounded up to a whole million (10M when there is no cap).
 *
 * @param capTokens - Cap in force, or null
 * @returns Tokens
 */
export function boostAmount(capTokens: number | null): number {
  if (capTokens === null || capTokens <= 0) return 10_000_000;
  return Math.max(1_000_000, Math.ceil(capTokens / 1_000_000) * 1_000_000);
}
