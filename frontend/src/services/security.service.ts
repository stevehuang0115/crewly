/**
 * Security Service
 *
 * Client for the read-only approval activity
 * (`GET /api/security/approvals?days=7|30`): what agents asked the owner to
 * allow, what was held for the owner, and how each one ended.
 *
 * @module services/security.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';

/** Endpoint. */
export const SECURITY_API = {
  APPROVALS: '/api/security/approvals',
} as const;

/** How an item ended. */
export type ActivityOutcome = 'approved' | 'denied' | 'answered' | 'expired' | 'withdrawn' | 'waiting' | 'sending' | 'sent' | 'discarded';

/** What kind of thing it was. */
export type ActivityCategory = 'question' | 'sensitive' | 'browser' | 'runtime_terms' | 'spend_cap' | 'whatsapp' | 'gmail';

/** One recent item. */
export interface ActivityItem {
  id: string;
  category: ActivityCategory;
  sensitive?: string;
  title: string;
  agentSession?: string;
  agent?: string;
  outcome: ActivityOutcome;
  answer?: string;
  at: string;
  settledAt?: string;
  decisionId?: string;
  requestId?: string;
  workItemId?: string;
  ticket?: { projectId: string; id: string; title: string };
}

/** A count from a source that may keep no history. */
export interface TrackedCount<T> {
  tracked: boolean;
  note?: string;
  counts?: T;
}

/** `GET /api/security/approvals`. */
export interface ApprovalActivity {
  days: number;
  since: string;
  blocked: TrackedCount<{ total: number }> & { sources: string[] };
  asked: number;
  outcomes: { approved: number; denied: number; answered: number; expired: number; withdrawn: number; waiting: number };
  browser: TrackedCount<{ held: number; approved: number; refused: number; expired: number; waiting: number }>;
  sensitive: { total: number; publish: number; email: number; deploy: number; spend: number };
  runtimeTerms: { asked: number; accepted: number; declined: number; waiting: number };
  whatsapp: TrackedCount<{ held: number; sent: number; discarded: number; waiting: number; sending?: number }>;
  gmail: TrackedCount<{ waiting: number }>;
  items: ActivityItem[];
}

/** Client. */
export const securityService = {
  /**
   * Approval activity over the last 7 or 30 days.
   *
   * @param days - 7 or 30
   * @returns Activity
   */
  async approvals(days: 7 | 30): Promise<ApprovalActivity> {
    try {
      const { data } = await axios.get<ApiResponse<ApprovalActivity>>(SECURITY_API.APPROVALS, { params: { days } });
      if (!data?.success || !data.data) throw new Error(data?.error || 'Failed to load the approvals');
      return data.data;
    } catch (err) {
      if (isAxiosError(err)) {
        const body = err.response?.data as ApiResponse<unknown> | undefined;
        throw new Error(body?.error || err.message || 'Failed to load the approvals');
      }
      throw err instanceof Error ? err : new Error('Failed to load the approvals');
    }
  },
};
