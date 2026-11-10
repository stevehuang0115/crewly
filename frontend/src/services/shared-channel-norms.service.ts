/**
 * Shared-channel norms service (crewly#1543 slice 6)
 *
 * API client for the owner's per-link norm of a channel with another
 * company's Crewly account: free text ("what this partner may be told") and
 * the kinds of content agents may send there without his approval.
 * `GET/PUT /api/shared-channels/:linkId/norms` (owner only). Uses the shared
 * axios instance, so the owner-session interceptors apply.
 *
 * specs/2026-11-10-shared-channel-send.md
 *
 * @module services/shared-channel-norms.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';

/** Team Chat id prefix of a shared channel (`external-<linkId>`). */
export const EXTERNAL_CHANNEL_PREFIX = 'external-';

/** One allowance the owner can tick. */
export interface SharedNormAllowanceInfo {
  key: string;
  label: string;
  detail: string;
}

/** A link's norm, with the allowance catalogue for the editor. */
export interface SharedChannelNorms {
  linkId: string;
  /** The owner's own words ('' when unset) */
  norm: string;
  /** Allowance keys that are on */
  allow: string[];
  /** ISO time of the last change, null when never set */
  updatedAt: string | null;
  allowances: SharedNormAllowanceInfo[];
}

/** Endpoints. */
export const SHARED_CHANNEL_NORMS_API = {
  norms: (linkId: string) => `/api/shared-channels/${encodeURIComponent(linkId)}/norms`,
} as const;

/**
 * The link id of a shared channel's Team Chat id.
 *
 * @param channelId - Conversation id (`external-<linkId>`)
 * @returns The link id, or null for any other channel
 */
export function linkIdOfExternalChannel(channelId: string): string | null {
  if (!channelId.startsWith(EXTERNAL_CHANNEL_PREFIX)) return null;
  const id = channelId.slice(EXTERNAL_CHANNEL_PREFIX.length);
  return id ? id : null;
}

/**
 * Run a request and unwrap `{ success, data }`, surfacing the server's message.
 *
 * @param request - Request thunk
 * @param fallback - Message when the server gave none
 * @returns The payload
 * @throws Error with the server's message
 */
async function call<T>(request: () => Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
  try {
    const { data: body } = await request();
    if (!body?.success || body.data === undefined || body.data === null) throw new Error(body?.error || fallback);
    return body.data;
  } catch (err) {
    if (isAxiosError(err)) {
      const body = err.response?.data as (ApiResponse<unknown> & { message?: string }) | undefined;
      throw new Error(body?.error || body?.message || err.message || fallback);
    }
    throw err instanceof Error ? err : new Error(fallback);
  }
}

/** Shared-channel norms API. */
export const sharedChannelNormsService = {
  /**
   * A link's norm.
   *
   * @param linkId - Link id
   * @returns The norm and the allowance catalogue
   */
  get(linkId: string): Promise<SharedChannelNorms> {
    return call(() => axios.get(SHARED_CHANNEL_NORMS_API.norms(linkId)), 'Could not load the norm');
  },

  /**
   * Save a link's norm.
   *
   * @param linkId - Link id
   * @param change - New text and/or allowance keys
   * @returns The saved norm
   */
  save(linkId: string, change: { norm?: string; allow?: string[] }): Promise<SharedChannelNorms> {
    return call(() => axios.put(SHARED_CHANNEL_NORMS_API.norms(linkId), change), 'Could not save the norm');
  },
};

/** The part of {@link sharedChannelNormsService} the norms panel uses (injectable in tests). */
export type SharedChannelNormsApi = Pick<typeof sharedChannelNormsService, 'get' | 'save'>;
