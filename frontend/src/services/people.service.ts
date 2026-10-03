/**
 * People Service
 *
 * API client for the people directory (`/api/people`) and for changing who
 * owns a connector grant and who it is shared with (`POST /api/<connector>/sharing`).
 * Uses the shared axios instance, so the API-token interceptors apply.
 *
 * specs/per-person-access.md (issue #968)
 *
 * @module services/people.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';

/** A person's role on this instance. */
export type PersonRole = 'owner' | 'member' | 'guest';

/** One person in the directory. */
export interface Person {
  /** Slack user id, or `owner` for the instance owner */
  id: string;
  /** The owner's known Slack user ids (owner row only) */
  slackUserIds?: string[];
  name?: string;
  role: PersonRole;
  /** `auto`: added when they first messaged an agent */
  source: 'auto' | 'owner';
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/people`. */
export interface PeopleDirectory {
  people: Person[];
  ownerId: string;
}

/** Who besides the person who connected it may use a grant. */
export interface GrantSharing {
  mode: 'owner' | 'people' | 'members';
  people?: string[];
}

/** A grant's owner and sharing (missing = the owner's alone). */
export interface GrantOwnership {
  authorizedBy?: string;
  sharing?: GrantSharing;
}

/** Connectors whose grants can be shared, and their API prefix. */
export const SHARING_ENDPOINTS = {
  'google-workspace': '/api/google/sharing',
  canva: '/api/canva/sharing',
  'microsoft-todo': '/api/microsoft-todo/sharing',
} as const;

/** A connector whose grants can be shared. */
export type SharableConnector = keyof typeof SHARING_ENDPOINTS;

/** Error code when Crewly Cloud is too old for per-person access. */
export const CLOUD_UPDATE_REQUIRED_CODE = 'cloud_update_required';

/** What to show for it. */
export const CLOUD_UPDATE_REQUIRED_MESSAGE = 'Requires a Cloud update';

/** A failed request, with the server's error code when it sent one. */
export class PeopleApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PeopleApiError';
  }
}

/**
 * Whether Cloud reported a connection's owner and sharing. Crewly Cloud from
 * before per-person access sends neither.
 *
 * @param ownership - The connection's ownership fields
 * @returns True when Cloud supports sharing
 */
export function cloudSupportsSharing(ownership: GrantOwnership): boolean {
  return ownership.authorizedBy !== undefined || ownership.sharing !== undefined;
}

/** Endpoints. */
export const PEOPLE_API = {
  LIST: '/api/people',
  person: (id: string) => `/api/people/${encodeURIComponent(id)}`,
} as const;

/**
 * Run a request and unwrap `{ success, data }`, surfacing the server's message.
 *
 * @param request - Request thunk
 * @param fallback - Message when the server gave none
 * @returns The payload
 * @throws PeopleApiError with the server's message and error code
 */
async function call<T>(request: () => Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
  try {
    const { data: body } = await request();
    if (!body?.success || body.data === undefined || body.data === null) throw new PeopleApiError(body?.error || fallback);
    return body.data;
  } catch (err) {
    if (isAxiosError(err)) {
      const body = err.response?.data as (ApiResponse<unknown> & { message?: string }) | undefined;
      throw new PeopleApiError(body?.message || body?.error || err.message || fallback, typeof body?.error === 'string' ? body.error : undefined);
    }
    throw err instanceof Error ? err : new Error(fallback);
  }
}

/**
 * How to name a person.
 *
 * @param id - Person id
 * @param people - Directory
 * @returns Their name, "Owner" for the owner without one, else the id
 */
export function personName(id: string | undefined, people: readonly Person[]): string {
  id = id ? canonicalPersonId(id, people) : id;
  if (!id || id === 'owner') {
    const owner = people.find((p) => p.role === 'owner');
    return owner?.name ?? 'Owner';
  }
  const person = people.find((p) => p.id === id);
  return person?.name ?? id;
}

/**
 * `owner` for any of the owner's Slack ids (a grant the owner connected from
 * Slack may name them that way), else the id.
 *
 * @param id - Person id
 * @param people - Directory
 * @returns Canonical person id
 */
export function canonicalPersonId(id: string, people: readonly Person[]): string {
  return people.some((p) => p.role === 'owner' && p.slackUserIds?.includes(id)) ? 'owner' : id;
}

/** Client. */
export const peopleService = {
  /**
   * Everyone, owner first.
   *
   * @returns The directory
   */
  list(): Promise<PeopleDirectory> {
    return call(() => axios.get<ApiResponse<PeopleDirectory>>(PEOPLE_API.LIST), 'Failed to load people');
  },

  /**
   * Add or edit a person.
   *
   * @param id - Slack user id
   * @param patch - Name and/or role
   * @returns The person
   */
  upsert(id: string, patch: { name?: string | null; role?: PersonRole }): Promise<Person> {
    return call(() => axios.put<ApiResponse<Person>>(PEOPLE_API.person(id), patch), 'Failed to save the person');
  },

  /**
   * Remove a person.
   *
   * @param id - Person id
   * @returns `{ removed }`
   */
  remove(id: string): Promise<{ removed: boolean }> {
    return call(() => axios.delete<ApiResponse<{ removed: boolean }>>(PEOPLE_API.person(id)), 'Failed to remove the person');
  },

  /**
   * Change who owns a grant and who it is shared with.
   *
   * @param connector - Connector
   * @param change - New owner and/or sharing (plus `email` for a Google account)
   * @returns Ownership as Cloud now reports it
   */
  setGrantSharing(connector: SharableConnector, change: GrantOwnership & { email?: string }): Promise<Required<GrantOwnership>> {
    return call(() => axios.post<ApiResponse<Required<GrantOwnership>>>(SHARING_ENDPOINTS[connector], change), 'Failed to change sharing');
  },
};
