/**
 * AppsCloudClient — this instance's calls to the Crewly Apps agent API
 * (`<cloudUrl>/api/apps/v1`, crewly-services apps/SPEC.md §3.1).
 *
 * Authenticates with the Cloud access token the {@link CloudClientService}
 * holds and refreshes, bound to this instance (`X-Crewly-Instance`) and
 * attributed to the calling agent (`X-Crewly-Agent`). Agents never see the
 * token: they reach this through `/api/apps` (specs/2026-10-04-crewly-apps-p2.md).
 *
 * @module services/apps/apps-cloud.client
 */

import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { CloudClientService } from '../cloud/cloud-client.service.js';

const C = CREWLY_APPS_CONSTANTS;

/** The slice of the Cloud client used here (injectable for tests). */
export interface AppsCloudSession {
  isConnected(): boolean;
  getToken(): string | null;
  getCloudUrl(): string | null;
  tryRefreshToken(): Promise<boolean>;
}

/** Constructor dependencies. */
export interface AppsCloudClientDeps {
  cloud?: AppsCloudSession;
  /** This instance's Cloud device id (the Slack instance registry's id) */
  instanceId: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/** A failed Apps call: HTTP status and a stable code for the controller and skills. */
export class AppsCloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppsCloudError';
  }
}

/** Options of one request. */
export interface AppsRequestOptions {
  /** JSON body */
  body?: unknown;
  /** Raw bytes instead of JSON (the thumbnail upload); wins over `body` */
  raw?: { data: Buffer; contentType: string };
  /** Query parameters (undefined values are dropped) */
  query?: Record<string, string | number | undefined>;
  /** Agent session to attribute the call to; omitted for the owner */
  agent?: string;
  /** Request timeout (default REQUEST_TIMEOUT_MS) */
  timeoutMs?: number;
}

/**
 * Typed wrapper over the Apps agent API.
 */
export class AppsCloudClient {
  private readonly cloud: AppsCloudSession;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: AppsCloudClientDeps) {
    this.cloud = deps.cloud ?? CloudClientService.getInstance();
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /**
   * Whether a Cloud login is present (a call can be attempted).
   *
   * @returns True when connected with a token and URL
   */
  isAvailable(): boolean {
    return this.cloud.isConnected() && !!this.cloud.getToken() && !!this.cloud.getCloudUrl();
  }

  /**
   * Call the Apps API and return its `data`.
   *
   * A 401 refreshes the Cloud token once and retries. Cloud's
   * `{ success:false, error, code }` becomes an {@link AppsCloudError} with
   * Cloud's status and code. The token is never part of an error.
   *
   * @param method - HTTP method
   * @param path - Path under `/api/apps/v1` (starts with `/`)
   * @param opts - Body, query, agent attribution
   * @returns The response `data`
   * @throws AppsCloudError not_logged_in / instance_unknown / network / Cloud's code
   */
  async request<T>(method: string, path: string, opts: AppsRequestOptions = {}): Promise<T> {
    if (!this.isAvailable()) {
      throw new AppsCloudError(409, C.ERROR_CODES.NOT_LOGGED_IN, 'This machine is not signed in to Crewly Cloud. Run `crewly cloud login`.');
    }
    const instanceId = await this.deps.instanceId();
    if (!instanceId) {
      throw new AppsCloudError(409, C.ERROR_CODES.NO_INSTANCE, 'This machine has no Crewly Cloud instance id yet. Sign in to Crewly Cloud and try again in a minute.');
    }
    let res = await this.send(method, path, opts, instanceId);
    if (res.status === 401 && (await this.cloud.tryRefreshToken().catch(() => false))) {
      res = await this.send(method, path, opts, instanceId);
    }
    const json = await AppsCloudClient.readJson(res);
    if (res.ok && json && json.success !== false) return json.data as T;
    const code = typeof json?.code === 'string' ? json.code : res.status === 401 ? C.ERROR_CODES.NOT_LOGGED_IN : `http_${res.status}`;
    const message =
      typeof json?.error === 'string'
        ? json.error
        : res.status === 401
          ? 'Crewly Cloud rejected the session. Run `crewly cloud login` again.'
          : `Crewly Apps request failed (${res.status}).`;
    throw new AppsCloudError(res.status === 401 ? 409 : res.status, code, message);
  }

  private static async readJson(res: Response): Promise<{ success?: boolean; data?: unknown; error?: unknown; code?: unknown } | null> {
    try {
      const parsed: unknown = await res.json();
      return parsed && typeof parsed === 'object' ? (parsed as { success?: boolean; data?: unknown; error?: unknown; code?: unknown }) : null;
    } catch {
      return null;
    }
  }

  private async send(method: string, path: string, opts: AppsRequestOptions, instanceId: string): Promise<Response> {
    const base = `${(this.cloud.getCloudUrl() ?? '').replace(/\/+$/, '')}${C.CLOUD_PATH}`;
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cloud.getToken() ?? ''}`,
      'X-Crewly-Instance': instanceId,
    };
    if (opts.agent) headers['X-Crewly-Agent'] = opts.agent;
    if (opts.raw) headers['Content-Type'] = opts.raw.contentType;
    else if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(opts.raw ? { body: new Uint8Array(opts.raw.data) } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? C.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const why = err instanceof Error ? err.name : 'error';
      throw new AppsCloudError(502, C.ERROR_CODES.NETWORK, `Could not reach Crewly Apps (${why}). Try again shortly.`);
    }
  }
}
