/**
 * Owner decisions API client (`/api/decisions`,
 * specs/2026-10-01-decision-cards.md §8).
 *
 * Calls from the dashboard carry no agent session, so the backend treats
 * them as the owner. Every call unwraps `{ success, data }` and throws a
 * {@link DecisionApiError}.
 *
 * @module services/decisions.service
 */

import { DecisionApiError, type OwnerDecision, type SkipAllInput, type SkipAllResult } from '../types/decision.types';

/** Base path of the decisions API. */
export const DECISIONS_API_BASE = '/api/decisions';

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

/**
 * Run a request and unwrap the envelope.
 *
 * @param url - URL
 * @param init - fetch options
 * @returns `data`
 * @throws DecisionApiError on a non-2xx status or `success: false`
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: Envelope<T> = {};
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = {};
  }
  if (!res.ok || body.success === false) throw new DecisionApiError(body.error || `HTTP ${res.status}`, res.status);
  return body.data as T;
}

/**
 * POST a JSON body.
 *
 * @param body - Body
 * @returns fetch options
 */
function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * Decisions waiting on the owner (open and parked, newest first).
 *
 * @returns Decisions
 */
export async function listOpenDecisions(): Promise<OwnerDecision[]> {
  const data = await request<OwnerDecision[]>(`${DECISIONS_API_BASE}?status=open`);
  return Array.isArray(data) ? data : [];
}

/**
 * Answer a decision with one of its options.
 *
 * @param id - Decision id (`D-7`)
 * @param option - Option key
 * @returns The settled decision
 */
export function chooseDecision(id: string, option: string): Promise<OwnerDecision> {
  return request<OwnerDecision>(`${DECISIONS_API_BASE}/${encodeURIComponent(id)}/choose`, post({ option }));
}

/**
 * "Remind me tomorrow".
 *
 * @param id - Decision id
 * @returns The snoozed decision
 */
export function remindDecisionTomorrow(id: string): Promise<OwnerDecision> {
  return request<OwnerDecision>(`${DECISIONS_API_BASE}/${encodeURIComponent(id)}/remind`, post({}));
}

/**
 * "Skip" ("I don't care about this anymore"). Sensitive / system cards get
 * their safe "No" instead.
 *
 * @param id - Decision id
 * @returns The settled decision
 */
export function skipDecision(id: string): Promise<OwnerDecision> {
  return request<OwnerDecision>(`${DECISIONS_API_BASE}/${encodeURIComponent(id)}/skip`, post({}));
}

/**
 * Skip every matching open decision at once.
 *
 * @param input - `olderThan` (ISO), `source`, `dryRun`
 * @returns What matched and what was settled
 */
export function skipAllDecisions(input: SkipAllInput): Promise<SkipAllResult> {
  return request<SkipAllResult>(`${DECISIONS_API_BASE}/skip-all`, post(input));
}

/**
 * The owner skips an open item of a request (a promise's follow-up is
 * cancelled; a question's card is skipped).
 *
 * @param requestId - Request id
 * @param itemId - Open item id
 * @returns The closed item
 */
export function skipOpenItem<T = unknown>(requestId: string, itemId: string): Promise<T> {
  return request<T>(`/api/requests/${encodeURIComponent(requestId)}/open-items/${encodeURIComponent(itemId)}/skip`, post({}));
}
