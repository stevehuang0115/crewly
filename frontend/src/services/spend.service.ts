/**
 * Spend Service
 *
 * API client for spend per agent and the daily spend caps
 * (`/api/system/spend`). Uses the shared axios instance, so the API-token
 * interceptors apply.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';

/** Endpoints. */
export const SPEND_API = {
  SPEND: '/api/system/spend',
  CAPS: '/api/system/spend/caps',
  RAISE: '/api/system/spend/raise',
} as const;

/** Target key of the all-agents total cap. */
export const TOTAL_TARGET = '*';

/** The owner's caps (USD per local day). */
export interface SpendCaps {
  defaultAgentCapUsd: number | null;
  totalCapUsd: number | null;
  agentCapsUsd: Record<string, number | null>;
  updatedAt?: string;
}

/** One local day. */
export interface SpendDay {
  date: string;
  totalUsd: number;
  byAgent: Record<string, number>;
  byRuntime: Record<string, number>;
}

/** One agent. */
export interface SpendAgent {
  session: string;
  name: string;
  runtimes: string[];
  todayUsd: number;
  windowUsd: number;
  daily: number[];
  capUsd: number | null;
  capSource: 'override' | 'default' | 'raised' | 'none' | 'exempt';
  stopped: boolean;
  stopReason?: string;
}

/** `GET /api/system/spend`. */
export interface SpendView {
  today: string;
  days: SpendDay[];
  agents: SpendAgent[];
  byRuntime: Record<string, number>;
  totalUsd: number;
  todayUsd: number;
  p90AgentDayUsd: number;
  caps: SpendCaps;
  raisedToday: Record<string, number>;
  totalCapTodayUsd: number | null;
  suggestedAgentCapUsd: number | null;
  totalStopped: boolean;
}

/** Body of `PUT /api/system/spend/caps`. */
export interface SpendCapPatch {
  defaultAgentCapUsd?: number | null;
  totalCapUsd?: number | null;
  agents?: Record<string, number | null | 'default'>;
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
export const spendService = {
  /**
   * Spend for the last `days` local days plus the caps.
   *
   * @param days - Window (default 7)
   * @returns View
   */
  get(days = 7): Promise<SpendView> {
    return call(() => axios.get<ApiResponse<SpendView>>(SPEND_API.SPEND, { params: { days } }), 'Failed to load spend');
  },

  /**
   * Change caps (owner only).
   *
   * @param patch - Changes
   * @returns The new caps
   */
  setCaps(patch: SpendCapPatch): Promise<SpendCaps> {
    return call(() => axios.put<ApiResponse<SpendCaps>>(SPEND_API.CAPS, patch), 'Failed to save the caps');
  },

  /**
   * Lift a cap for today (owner only).
   *
   * @param session - Agent session, or {@link TOTAL_TARGET}
   * @param capUsd - New cap for today
   * @returns The cap for today
   */
  raise(session: string, capUsd: number): Promise<{ session: string; capUsd: number }> {
    return call(() => axios.post<ApiResponse<{ session: string; capUsd: number }>>(SPEND_API.RAISE, { session, capUsd }), 'Failed to raise the cap');
  },
};

/**
 * USD for display.
 *
 * @param usd - Amount
 * @returns e.g. `$5.00`
 */
export function usd(usd: number): string {
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
}

/**
 * Parse a cap typed into a field.
 *
 * @param text - Field text (`""` = off)
 * @returns The cap, null for off, or undefined when unreadable
 */
export function parseCapInput(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$/, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}
