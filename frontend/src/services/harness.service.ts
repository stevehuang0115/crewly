/**
 * Harness Service
 *
 * API client for `/api/harness`: status, install jobs, orchestrator harness
 * choice, login-broker sessions and API-key login. Uses the shared axios
 * instance, so the API-token interceptors installed by `bootstrapApiToken()`
 * in `main.tsx` apply.
 *
 * API keys are sent once and never logged or retained here.
 *
 * @module services/harness.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';
import type {
  BrokerLoginMethodId,
  HarnessId,
  HarnessOverview,
  HarnessStatus,
  InstallJob,
  LoginSession,
} from '../types/harness.types';
import { HARNESS_API } from '../constants/harness.constants';

/**
 * Unwrap a `{ success, data }` envelope, throwing its error otherwise.
 *
 * @param body - Response body
 * @param fallback - Message used when the body carries none
 * @param allowEmpty - Accept a successful body without `data` (returns null)
 * @returns The `data` payload
 */
function unwrap<T>(body: ApiResponse<T> | undefined, fallback: string, allowEmpty: boolean): T {
  if (body?.success && allowEmpty) {
    return (body.data ?? null) as T;
  }
  if (!body || !body.success || body.data === undefined || body.data === null) {
    throw new Error(body?.error || body?.message || fallback);
  }
  return body.data;
}

/**
 * Run a request and normalise failures to an `Error` carrying the server's
 * message when present (axios rejects non-2xx responses).
 *
 * @param request - Request thunk
 * @param fallback - Message used when the server gave none
 * @param allowEmpty - Accept a successful response without `data`
 * @returns The unwrapped payload
 */
async function call<T>(
  request: () => Promise<{ data: ApiResponse<T> }>,
  fallback: string,
  allowEmpty = false,
): Promise<T> {
  try {
    const response = await request();
    return unwrap(response.data, fallback, allowEmpty);
  } catch (err) {
    if (isAxiosError(err)) {
      const body = err.response?.data as ApiResponse<unknown> | undefined;
      throw new Error(body?.error || body?.message || err.message || fallback);
    }
    throw err instanceof Error ? err : new Error(fallback);
  }
}

/**
 * Narrow an optional response payload to a login session. The contract
 * does not fix what `/input` and `/cancel` return, so callers treat a
 * missing / non-session payload as "no snapshot, keep polling".
 *
 * @param value - Response payload
 * @returns The session, or null
 */
export function asLoginSession(value: unknown): LoginSession | null {
  if (value && typeof value === 'object' && 'id' in value && 'state' in value) {
    return value as LoginSession;
  }
  return null;
}

/**
 * Client for the harness endpoints.
 */
class HarnessService {
  /**
   * Fetch harness install/login status, the orc harness and system tools.
   *
   * @returns Harness overview
   */
  async getStatus(): Promise<HarnessOverview> {
    return call(() => axios.get<ApiResponse<HarnessOverview>>(HARNESS_API.STATUS), 'Failed to load harness status');
  }

  /**
   * Start installing (or updating) a harness.
   *
   * @param harnessId - Harness to install
   * @returns Install job id
   */
  async startInstall(harnessId: HarnessId): Promise<string> {
    const data = await call(
      () => axios.post<ApiResponse<{ jobId: string }>>(HARNESS_API.install(harnessId)),
      'Failed to start install',
    );
    return data.jobId;
  }

  /**
   * Poll an install job.
   *
   * @param jobId - Install job id
   * @returns Job state, log and whether a user prefix was used
   */
  async getInstallJob(jobId: string): Promise<InstallJob> {
    return call(() => axios.get<ApiResponse<InstallJob>>(HARNESS_API.installJob(jobId)), 'Failed to read install progress');
  }

  /**
   * Choose the harness the orchestrator runs on.
   *
   * @param harnessId - Harness id
   * @returns The saved orc harness
   */
  async setOrcHarness(harnessId: HarnessId): Promise<HarnessId | null> {
    const data = await call(
      () => axios.put<ApiResponse<{ orcHarness: HarnessId | null }>>(HARNESS_API.ORC, { harnessId }),
      'Failed to save orchestrator harness',
    );
    return data.orcHarness;
  }

  /**
   * Start a broker login session.
   *
   * @param harnessId - Harness to log in to
   * @param method - Broker method
   * @returns The new session
   */
  async startLogin(harnessId: HarnessId, method: BrokerLoginMethodId): Promise<LoginSession> {
    return call(
      // The person pressed the button: re-login even if already logged in.
      () => axios.post<ApiResponse<LoginSession>>(HARNESS_API.login(harnessId), { method, force: true }),
      'Failed to start login',
    );
  }

  /**
   * Poll a login session.
   *
   * @param sessionId - Session id
   * @returns Current session
   */
  async getLoginSession(sessionId: string): Promise<LoginSession> {
    return call(() => axios.get<ApiResponse<LoginSession>>(HARNESS_API.loginSession(sessionId)), 'Failed to read login status');
  }

  /**
   * Send text (a pasted code, or raw input for an unrecognised screen) to a login session.
   *
   * @param sessionId - Session id
   * @param text - Text to send
   * @returns Updated session, or null when the response carries none
   */
  async sendLoginInput(sessionId: string, text: string): Promise<LoginSession | null> {
    const data = await call(
      () => axios.post<ApiResponse<unknown>>(HARNESS_API.loginInput(sessionId), { text }),
      'Failed to send input',
      true,
    );
    return asLoginSession(data);
  }

  /**
   * Cancel a login session.
   *
   * @param sessionId - Session id
   * @returns Updated session, or null when the response carries none
   */
  async cancelLogin(sessionId: string): Promise<LoginSession | null> {
    const data = await call(
      () => axios.post<ApiResponse<unknown>>(HARNESS_API.loginCancel(sessionId)),
      'Failed to cancel login',
      true,
    );
    return asLoginSession(data);
  }

  /**
   * Save an API key for a harness. The key is never logged or cached.
   *
   * @param harnessId - Harness id
   * @param key - API key
   * @returns Updated harness status
   */
  async setApiKey(harnessId: HarnessId, key: string): Promise<HarnessStatus> {
    return call(
      () => axios.post<ApiResponse<HarnessStatus>>(HARNESS_API.apiKey(harnessId), { key }),
      'Failed to save API key',
    );
  }
}

export const harnessService = new HarnessService();
