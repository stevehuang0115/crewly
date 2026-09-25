/**
 * Cloud device-code pairing client.
 *
 * Talks to crewly-auth's `/api/cloud/device/*` endpoints so this machine can
 * sign in to the owner's Crewly account without anyone at it:
 *
 * 1. {@link startCloudDevicePairing} — get a secret `deviceCode`, a short
 *    `userCode` (`ABCD-2345`) and the link the owner opens
 *    (`crewlyai.com/cloud/pair?code=ABCD-2345`).
 * 2. {@link waitForCloudDeviceApproval} — poll at the Cloud's interval
 *    (backing off on `slow_down` and rate limits) until the owner approves,
 *    denies, or the pairing expires. On approval the Cloud hands over the
 *    token pair exactly once.
 *
 * Shared by `crewly cloud login` (CLI) and {@link CloudDevicePairingService}
 * (backend, for `/setup` and Settings → Cloud). No state; the device code
 * never leaves the caller's memory.
 *
 * @module services/cloud/cloud-device-pairing.client
 */

import { CLOUD_DEVICE_PAIRING_CONSTANTS } from '../../../../config/constants.js';

const C = CLOUD_DEVICE_PAIRING_CONSTANTS;

/** Milliseconds per second. */
const MS_PER_S = 1000;

/** HTTP 429. */
const HTTP_TOO_MANY_REQUESTS = 429;

/** Lowest HTTP status treated as a server-side (retryable) failure. */
const HTTP_SERVER_ERROR_MIN = 500;

/** `fetch` signature (injectable for tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What `start` returns. */
export interface DevicePairingStartResult {
  /** Secret the machine polls with — never show or log it */
  deviceCode: string;
  /** Short code the owner checks on the approve page */
  userCode: string;
  /** Approve page with the code filled in (show / encode as QR) */
  verificationUrl: string;
  /** Approve page without the code (for typing it by hand) */
  verificationUri?: string;
  /** Pairing lifetime (seconds) */
  expiresIn: number;
  /** Minimum seconds between polls */
  interval: number;
}

/** The token pair handed over on approval. */
export interface DevicePairingCredentials {
  token: string;
  refreshToken: string;
  tier: string;
  email?: string;
}

/** One poll's answer. */
export type DevicePairingPollResult =
  | { status: 'authorization_pending' | 'slow_down'; interval?: number }
  | { status: 'expired' | 'denied' }
  | { status: 'approved'; credentials: DevicePairingCredentials };

/** How waiting ended. */
export type DevicePairingOutcome =
  | { status: 'approved'; credentials: DevicePairingCredentials }
  | { status: 'expired' | 'denied' | 'cancelled' };

/** A request the Cloud refused (or could not answer). */
export class DevicePairingError extends Error {
  /**
   * @param message - Human-readable reason (never contains a secret)
   * @param status - HTTP status, 0 when the Cloud was unreachable
   * @param retryable - True for network errors, 5xx and 429
   */
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'DevicePairingError';
  }
}

/**
 * POST JSON to crewly-auth and unwrap `{ success, data }`.
 *
 * @param fetchImpl - fetch
 * @param url - Absolute URL
 * @param body - JSON body
 * @returns `data`
 * @throws DevicePairingError on transport errors and non-success replies
 */
async function postJson<T>(fetchImpl: FetchLike, url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DevicePairingError(`Crewly Cloud unreachable: ${err instanceof Error ? err.message : String(err)}`, 0, true);
  }
  let parsed: { success?: boolean; data?: T; error?: string } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    // handled below
  }
  if (!response.ok || !parsed.success || parsed.data === undefined) {
    const retryable = response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR_MIN;
    throw new DevicePairingError(parsed.error || `Crewly Cloud returned HTTP ${response.status}`, response.status, retryable);
  }
  return parsed.data;
}

/**
 * Join the Cloud base URL and an endpoint path.
 *
 * @param cloudUrl - Cloud API base URL
 * @param path - Endpoint path
 * @returns Absolute URL
 */
function endpoint(cloudUrl: string, path: string): string {
  return `${cloudUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Ask the Cloud for a pairing.
 *
 * @param cloudUrl - Cloud API base URL (e.g. https://api.crewlyai.com)
 * @param input - How the device introduces itself on the approve page
 * @param fetchImpl - fetch (tests)
 * @returns Device code, user code, link, lifetime and interval
 * @throws DevicePairingError when the Cloud refuses or is unreachable
 */
export async function startCloudDevicePairing(
  cloudUrl: string,
  input: { deviceName: string; deviceId?: string; purpose?: string },
  fetchImpl: FetchLike = fetch,
): Promise<DevicePairingStartResult> {
  const data = await postJson<Partial<DevicePairingStartResult>>(fetchImpl, endpoint(cloudUrl, C.CLOUD_ENDPOINTS.START), input);
  if (!data.deviceCode || !data.userCode || !data.verificationUrl) {
    throw new DevicePairingError('Crewly Cloud returned an incomplete pairing', 0, false);
  }
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUrl: data.verificationUrl,
    ...(data.verificationUri ? { verificationUri: data.verificationUri } : {}),
    expiresIn: typeof data.expiresIn === 'number' ? data.expiresIn : C.DEFAULT_EXPIRES_IN_S,
    interval: typeof data.interval === 'number' ? data.interval : C.DEFAULT_INTERVAL_S,
  };
}

/**
 * Poll a pairing once.
 *
 * @param cloudUrl - Cloud API base URL
 * @param deviceCode - Secret from {@link startCloudDevicePairing}
 * @param fetchImpl - fetch (tests)
 * @returns The Cloud's answer
 * @throws DevicePairingError when the request fails (see `retryable`)
 */
export async function pollCloudDevicePairing(
  cloudUrl: string,
  deviceCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<DevicePairingPollResult> {
  const data = await postJson<{
    status?: string;
    interval?: number;
    token?: string;
    refreshToken?: string;
    tier?: string;
    email?: string;
  }>(fetchImpl, endpoint(cloudUrl, C.CLOUD_ENDPOINTS.POLL), { deviceCode });

  switch (data.status) {
    case C.POLL_STATUS.APPROVED:
      if (!data.token || !data.refreshToken) {
        throw new DevicePairingError('Crewly Cloud approved the device but sent no tokens', 0, false);
      }
      return {
        status: 'approved',
        credentials: { token: data.token, refreshToken: data.refreshToken, tier: data.tier || 'free', ...(data.email ? { email: data.email } : {}) },
      };
    case C.POLL_STATUS.PENDING:
    case C.POLL_STATUS.SLOW_DOWN:
      return { status: data.status, ...(typeof data.interval === 'number' ? { interval: data.interval } : {}) };
    case C.POLL_STATUS.DENIED:
      return { status: 'denied' };
    case C.POLL_STATUS.EXPIRED:
      return { status: 'expired' };
    default:
      throw new DevicePairingError(`Unexpected pairing status: ${String(data.status)}`, 0, false);
  }
}

/**
 * Wait `ms`, resolving early when `signal` aborts.
 *
 * @param ms - Milliseconds
 * @param signal - Optional abort signal
 * @returns Resolves after the delay or on abort
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Options for {@link waitForCloudDeviceApproval}. */
export interface WaitForApprovalOptions {
  cloudUrl: string;
  start: DevicePairingStartResult;
  fetchImpl?: FetchLike;
  /** Sleep (tests pass an instant one) */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Clock (tests) */
  now?: () => number;
  /** Stop waiting (returns `cancelled`) */
  signal?: AbortSignal;
  /** Called after every poll with the status seen (progress display) */
  onPoll?: (status: DevicePairingPollResult['status'], intervalS: number) => void;
}

/**
 * Poll until the owner approves or denies, or the pairing expires.
 *
 * Honours the Cloud's interval, adds {@link CLOUD_DEVICE_PAIRING_CONSTANTS.SLOW_DOWN_INCREMENT_S}
 * on `slow_down` / HTTP 429 (capped), and rides out up to
 * {@link CLOUD_DEVICE_PAIRING_CONSTANTS.MAX_CONSECUTIVE_POLL_ERRORS} network
 * or server errors in a row (a laptop changing Wi-Fi mid-login).
 *
 * @param options - Cloud URL, the started pairing and hooks
 * @returns How it ended; `approved` carries the token pair
 * @throws DevicePairingError on a non-retryable refusal or too many errors in a row
 */
export async function waitForCloudDeviceApproval(options: WaitForApprovalOptions): Promise<DevicePairingOutcome> {
  const { cloudUrl, start, signal, onPoll } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? (() => Date.now());

  const deadline = now() + start.expiresIn * MS_PER_S;
  let intervalS = Math.max(1, start.interval || C.DEFAULT_INTERVAL_S);
  let consecutiveErrors = 0;

  for (;;) {
    await sleep(intervalS * MS_PER_S, signal);
    if (signal?.aborted) return { status: 'cancelled' };
    if (now() >= deadline) return { status: 'expired' };

    let result: DevicePairingPollResult;
    try {
      result = await pollCloudDevicePairing(cloudUrl, start.deviceCode, fetchImpl);
      consecutiveErrors = 0;
    } catch (err) {
      if (!(err instanceof DevicePairingError) || !err.retryable) throw err;
      consecutiveErrors++;
      if (consecutiveErrors > C.MAX_CONSECUTIVE_POLL_ERRORS) throw err;
      if (err.status === HTTP_TOO_MANY_REQUESTS) {
        intervalS = Math.min(C.MAX_INTERVAL_S, intervalS + C.SLOW_DOWN_INCREMENT_S);
      }
      continue;
    }
    if (signal?.aborted) return { status: 'cancelled' };

    onPoll?.(result.status, intervalS);
    switch (result.status) {
      case 'approved':
        return result;
      case 'expired':
      case 'denied':
        return { status: result.status };
      case 'slow_down':
        intervalS = Math.min(C.MAX_INTERVAL_S, result.interval ?? intervalS + C.SLOW_DOWN_INCREMENT_S);
        break;
      default:
        if (typeof result.interval === 'number') intervalS = Math.min(C.MAX_INTERVAL_S, Math.max(1, result.interval));
    }
  }
}
