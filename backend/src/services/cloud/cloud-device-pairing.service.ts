/**
 * Cloud device pairing (backend side).
 *
 * Lets the web UI (`/setup`'s Cloud step, Settings → Cloud) — often opened on
 * the owner's phone over the LAN or the relay — connect this machine to
 * Crewly Cloud with no token handling at all:
 *
 * 1. `start()` asks crewly-auth for a pairing and returns the link + short
 *    code to show (as a QR code too).
 * 2. The service polls crewly-auth in the background. When the owner taps
 *    Approve on crewlyai.com/cloud/pair, it receives the token pair and
 *    connects by itself through the same path as `POST /api/cloud/connect`
 *    (injected as `connect`).
 * 3. The UI polls `status()` until it reads `connected`.
 *
 * One pairing at a time; `start()` while one is pending returns the same
 * code, so reloading the page does not spawn new codes. The device code and
 * the tokens never appear in `status()`.
 *
 * @module services/cloud/cloud-device-pairing.service
 */

import { CLOUD_DEVICE_PAIRING_CONSTANTS } from '../../../../config/constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
  startCloudDevicePairing,
  waitForCloudDeviceApproval,
  type DevicePairingCredentials,
  type DevicePairingOutcome,
  type DevicePairingStartResult,
  type WaitForApprovalOptions,
} from './cloud-device-pairing.client.js';

/** Milliseconds per second. */
const MS_PER_S = 1000;

/** Where a pairing stands. */
export type CloudDevicePairingState = 'idle' | 'pending' | 'connected' | 'expired' | 'denied' | 'cancelled' | 'error';

/** What the UI sees (no secrets). */
export interface CloudDevicePairingStatus {
  state: CloudDevicePairingState;
  /** Code the owner checks on the approve page */
  userCode?: string;
  /** Approve page with the code (show + QR) */
  verificationUrl?: string;
  /** Approve page without the code */
  verificationUri?: string;
  /** ISO expiry of the pending pairing */
  expiresAt?: string;
  /** Name shown to the owner on the approve page */
  deviceName?: string;
  /** Plan, once connected */
  tier?: string;
  /** Account, once connected */
  email?: string;
  /** Why it failed (`error`) */
  error?: string;
}

/** Dependencies (injectable for tests). */
export interface CloudDevicePairingDeps {
  /** Cloud API base URL */
  cloudUrl: () => string;
  /** How this machine introduces itself */
  identity: () => Promise<{ deviceId: string; deviceName: string }>;
  /** Connect with the approved token pair (performCloudConnect) */
  connect: (credentials: DevicePairingCredentials) => Promise<{ tier: string }>;
  start?: typeof startCloudDevicePairing;
  wait?: (options: WaitForApprovalOptions) => Promise<DevicePairingOutcome>;
  now?: () => number;
  logger?: ComponentLogger;
}

/**
 * Runs one device pairing at a time in the background.
 */
export class CloudDevicePairingService {
  private readonly deps: Required<Omit<CloudDevicePairingDeps, 'logger'>>;
  private readonly logger: ComponentLogger;
  private status: CloudDevicePairingStatus = { state: 'idle' };
  private controller: AbortController | null = null;
  /** Settles when the current background run ends (tests await it). */
  private running: Promise<void> | null = null;

  /**
   * @param deps - Cloud URL, identity, connect and the pairing client
   */
  constructor(deps: CloudDevicePairingDeps) {
    this.deps = {
      cloudUrl: deps.cloudUrl,
      identity: deps.identity,
      connect: deps.connect,
      start: deps.start ?? startCloudDevicePairing,
      wait: deps.wait ?? waitForCloudDeviceApproval,
      now: deps.now ?? (() => Date.now()),
    };
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('CloudDevicePairing');
  }

  /**
   * Current status (never contains the device code or tokens).
   *
   * @returns A copy of the status
   */
  getStatus(): CloudDevicePairingStatus {
    if (this.status.state === 'pending' && this.status.expiresAt && Date.parse(this.status.expiresAt) <= this.deps.now()) {
      return { ...this.status, state: 'expired' };
    }
    return { ...this.status };
  }

  /**
   * Start a pairing, or return the one already pending.
   *
   * @param options - Optional device name override (defaults to the hostname)
   * @returns Status with the link and code to show
   * @throws Error when crewly-auth refuses or cannot be reached
   */
  async start(options: { deviceName?: string } = {}): Promise<CloudDevicePairingStatus> {
    const current = this.getStatus();
    if (current.state === 'pending') return current;

    const identity = await this.deps.identity();
    const deviceName = options.deviceName?.trim() || identity.deviceName;
    const cloudUrl = this.deps.cloudUrl();
    const started = await this.deps.start(cloudUrl, {
      deviceName,
      deviceId: identity.deviceId,
      purpose: CLOUD_DEVICE_PAIRING_CONSTANTS.PURPOSES.SETUP,
    });

    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.status = {
      state: 'pending',
      userCode: started.userCode,
      verificationUrl: started.verificationUrl,
      ...(started.verificationUri ? { verificationUri: started.verificationUri } : {}),
      expiresAt: new Date(this.deps.now() + started.expiresIn * MS_PER_S).toISOString(),
      deviceName,
    };
    this.logger.info('Cloud device pairing started', { userCode: started.userCode, deviceName });
    this.running = this.run(cloudUrl, started, controller);
    return this.getStatus();
  }

  /**
   * Stop waiting for the current pairing.
   *
   * @returns The status after cancelling
   */
  cancel(): CloudDevicePairingStatus {
    if (this.status.state === 'pending') {
      this.controller?.abort();
      this.controller = null;
      this.status = { state: 'cancelled' };
      this.logger.info('Cloud device pairing cancelled');
    }
    return this.getStatus();
  }

  /**
   * Wait for the current background run to end (tests).
   *
   * @returns Resolves when no run is in flight
   */
  async settled(): Promise<void> {
    await this.running;
  }

  /**
   * Background: wait for the owner, then connect.
   *
   * @param cloudUrl - Cloud API base URL
   * @param started - The pairing
   * @param controller - Aborts this run
   */
  private async run(cloudUrl: string, started: DevicePairingStartResult, controller: AbortController): Promise<void> {
    const isCurrent = (): boolean => this.controller === controller && !controller.signal.aborted;
    try {
      const outcome = await this.deps.wait({ cloudUrl, start: started, signal: controller.signal });
      if (!isCurrent()) return;
      if (outcome.status !== 'approved') {
        this.status = { ...this.status, state: outcome.status };
        this.logger.info('Cloud device pairing ended', { state: outcome.status });
        return;
      }
      const { tier } = await this.deps.connect(outcome.credentials);
      if (!isCurrent()) return;
      this.status = {
        state: 'connected',
        deviceName: this.status.deviceName,
        tier,
        ...(outcome.credentials.email ? { email: outcome.credentials.email } : {}),
      };
      this.logger.info('Connected to Crewly Cloud via device pairing', { tier });
    } catch (err) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : String(err);
      this.status = { state: 'error', error: message, deviceName: this.status.deviceName };
      this.logger.warn('Cloud device pairing failed', { error: message });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
