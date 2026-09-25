/**
 * Cloud Device Pairing Service (frontend)
 *
 * Client for this backend's owner-only `/api/cloud/device/*` endpoints: start
 * a device-code pairing with Crewly Cloud, read its progress, cancel it. The
 * backend does the Cloud polling and connects by itself; this client never
 * sees a token or the device code. Uses the shared axios instance so the
 * API-token interceptors apply.
 *
 * @module services/cloud-device-pairing.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';
import { CLOUD_DEVICE_PAIRING_API } from '../constants/cloud.constants';

/** Where a pairing stands (mirrors the backend's CloudDevicePairingState). */
export type CloudDevicePairingState = 'idle' | 'pending' | 'connected' | 'expired' | 'denied' | 'cancelled' | 'error';

/** Pairing progress as the backend reports it (no secrets). */
export interface CloudDevicePairingStatus {
  state: CloudDevicePairingState;
  /** Code the owner checks on the approve page, e.g. `ABCD-2345` */
  userCode?: string;
  /** Approve page with the code filled in (link + QR) */
  verificationUrl?: string;
  /** Approve page without the code */
  verificationUri?: string;
  /** ISO expiry */
  expiresAt?: string;
  /** Name shown to the owner */
  deviceName?: string;
  /** Plan, once connected */
  tier?: string;
  /** Account, once connected */
  email?: string;
  /** Failure reason (`error`) */
  error?: string;
}

/**
 * Run a request and unwrap `{ success, data }`, turning failures into an
 * `Error` with the server's message.
 *
 * @param request - Request thunk
 * @param fallback - Message when the server gave none
 * @returns The `data` payload
 * @throws Error on HTTP or API failure
 */
async function call<T>(request: () => Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
  let body: ApiResponse<T> | undefined;
  try {
    body = (await request()).data;
  } catch (err) {
    if (isAxiosError(err)) {
      const errBody = err.response?.data as ApiResponse<unknown> | undefined;
      throw new Error(errBody?.error || errBody?.message || err.message || fallback);
    }
    throw err instanceof Error ? err : new Error(fallback);
  }
  if (!body?.success || !body.data) {
    throw new Error(body?.error || body?.message || fallback);
  }
  return body.data;
}

/**
 * Client for device-code Cloud pairing.
 */
class CloudDevicePairingService {
  /**
   * Start a pairing (or get the one already pending).
   *
   * @param deviceName - Optional name shown to the owner (defaults to the hostname)
   * @returns Status with the link and code
   */
  async start(deviceName?: string): Promise<CloudDevicePairingStatus> {
    return call(
      () => axios.post<ApiResponse<CloudDevicePairingStatus>>(CLOUD_DEVICE_PAIRING_API.START, deviceName ? { deviceName } : {}),
      'Could not reach Crewly Cloud',
    );
  }

  /**
   * Read the pairing's progress.
   *
   * @returns Current status
   */
  async status(): Promise<CloudDevicePairingStatus> {
    return call(() => axios.get<ApiResponse<CloudDevicePairingStatus>>(CLOUD_DEVICE_PAIRING_API.STATUS), 'Could not read pairing status');
  }

  /**
   * Stop waiting for approval.
   *
   * @returns Status after cancelling
   */
  async cancel(): Promise<CloudDevicePairingStatus> {
    return call(() => axios.post<ApiResponse<CloudDevicePairingStatus>>(CLOUD_DEVICE_PAIRING_API.CANCEL), 'Could not cancel');
  }
}

/** Singleton client. */
export const cloudDevicePairingService = new CloudDevicePairingService();
