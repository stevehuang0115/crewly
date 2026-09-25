/**
 * Cloud device pairing controller — `/api/cloud/device/*` on this backend.
 *
 * The web UI (`/setup` Cloud step, Settings → Cloud) and the phone app (over
 * the relay allowlist) connect this machine to Crewly Cloud without handling
 * tokens:
 *
 * - `POST /api/cloud/device/start`  → `{ state: 'pending', userCode, verificationUrl, expiresAt, … }`
 *   (starts a pairing with crewly-auth, or returns the pending one).
 * - `GET  /api/cloud/device/status` → the same shape; `state` moves to
 *   `connected` once the owner approves and the backend has connected itself.
 * - `POST /api/cloud/device/cancel` → stop waiting.
 *
 * Owner-only: every route refuses a request carrying `X-Agent-Session` (403)
 * — an agent must not sign the machine in to an account, same rule as
 * `/api/harness`. Responses never contain the device code or tokens.
 *
 * @module controllers/cloud/cloud-device-pairing.controller
 */

import type { Request, Response } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { CLOUD_CONSTANTS } from '../../constants.js';
import { DeviceIdentityService } from '../../services/cloud/device-identity.service.js';
import { CloudDevicePairingService } from '../../services/cloud/cloud-device-pairing.service.js';
import { performCloudConnect } from './cloud.controller.js';

/** HTTP 403. */
const HTTP_FORBIDDEN = 403;

/** HTTP 502 — crewly-auth refused or was unreachable. */
const HTTP_BAD_GATEWAY = 502;

/** Longest device name accepted from the UI. */
const MAX_DEVICE_NAME_LENGTH = 80;

let service: CloudDevicePairingService | null = null;

/**
 * The process-wide pairing service, wired to the real Cloud URL, device
 * identity and connect path.
 *
 * @returns CloudDevicePairingService
 */
export function getCloudDevicePairingService(): CloudDevicePairingService {
  if (!service) {
    service = new CloudDevicePairingService({
      cloudUrl: () => CLOUD_CONSTANTS.DEFAULT_CLOUD_URL,
      identity: () => DeviceIdentityService.getInstance().getOrCreateIdentity(),
      connect: (credentials) =>
        performCloudConnect({ token: credentials.token, refreshToken: credentials.refreshToken }),
    });
  }
  return service;
}

/**
 * Replace the service (tests).
 *
 * @param next - Service to use, or null to rebuild the real one
 */
export function setCloudDevicePairingServiceForTests(next: CloudDevicePairingService | null): void {
  service = next;
}

/**
 * Refuse a request made by an agent session.
 *
 * @param req - Express request
 * @param res - Express response
 * @returns True when refused (response sent)
 */
function refuseAgent(req: Request, res: Response): boolean {
  if (!readAgentSessionHeader(req)) return false;
  res.status(HTTP_FORBIDDEN).json({ success: false, error: 'Only the owner can connect this machine to Crewly Cloud' });
  return true;
}

/**
 * POST /api/cloud/device/start — begin (or resume) a pairing.
 *
 * @param req - Body `{ deviceName? }`
 * @param res - `{ success, data: CloudDevicePairingStatus }`
 */
export async function startCloudDevicePairing(req: Request, res: Response): Promise<void> {
  if (refuseAgent(req, res)) return;
  const raw = (req.body as { deviceName?: unknown } | undefined)?.deviceName;
  const deviceName = typeof raw === 'string' ? raw.slice(0, MAX_DEVICE_NAME_LENGTH) : undefined;
  try {
    const status = await getCloudDevicePairingService().start({ deviceName });
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(HTTP_BAD_GATEWAY).json({
      success: false,
      error: error instanceof Error ? error.message : 'Could not reach Crewly Cloud',
    });
  }
}

/**
 * GET /api/cloud/device/status — where the pairing stands.
 *
 * @param req - Express request
 * @param res - `{ success, data: CloudDevicePairingStatus }`
 */
export function getCloudDevicePairingStatus(req: Request, res: Response): void {
  if (refuseAgent(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: getCloudDevicePairingService().getStatus() });
}

/**
 * POST /api/cloud/device/cancel — stop waiting for the owner.
 *
 * @param req - Express request
 * @param res - `{ success, data: CloudDevicePairingStatus }`
 */
export function cancelCloudDevicePairing(req: Request, res: Response): void {
  if (refuseAgent(req, res)) return;
  res.json({ success: true, data: getCloudDevicePairingService().cancel() });
}
