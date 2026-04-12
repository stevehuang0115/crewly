/**
 * Browser Relay Adapter Service
 *
 * Bridges BrowserBridgeService with CloudSyncService to enable browser
 * commands to flow through the Cloud relay queue when the Chrome Extension
 * is not directly connected via WebSocket.
 *
 * Flow:
 *   Agent → BrowserBridgeService → BrowserRelayAdapter → CloudSyncService
 *   → Cloud relay queue → Extension polls → executes → sends response
 *   → Cloud relay queue → Droplet polls → BrowserRelayAdapter resolves
 *
 * The Extension never sees the droplet IP — all traffic goes through
 * the Cloud relay URL (crewlyai.com).
 *
 * @module services/browser/browser-relay-adapter.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CloudSyncService } from '../cloud/cloud-sync.service.js';
import type { SyncDevice } from '../cloud/cloud-sync.types.js';
import type { BrowserCommand, BrowserCommandResponse } from './browser-bridge.service.js';
import { BROWSER_BRIDGE_CONSTANTS } from '../../constants.js';

/** Roles that identify a Chrome Extension device in the Cloud device list. */
const BROWSER_DEVICE_ROLES = ['browser', 'chrome-extension'] as const;

/**
 * Pending relay command waiting for a response via the Cloud queue.
 */
interface PendingRelayCommand {
  /** Resolve the promise with the response */
  resolve: (value: BrowserCommandResponse) => void;
  /** Reject the promise on timeout/error */
  reject: (reason: Error) => void;
  /** Timer for command timeout */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Adapter that routes browser commands through the Cloud relay queue
 * when no direct WebSocket connection exists to the Chrome Extension.
 *
 * Usage:
 * 1. Create adapter with target Extension device ID
 * 2. Register with BrowserBridgeService as relay fallback
 * 3. Handle incoming `browser_response` messages from CloudSyncService
 *
 * @example
 * ```typescript
 * const adapter = BrowserRelayAdapter.getInstance();
 * adapter.setExtensionDeviceId('ext-device-abc');
 *
 * // Send command via relay
 * const response = await adapter.sendViaRelay('navigate', { url: 'https://example.com' });
 *
 * // Handle incoming responses (called by CloudSyncService message handler)
 * adapter.handleRelayResponse({ id: 'cmd-1', success: true, result: {...} });
 * ```
 */
export class BrowserRelayAdapter {
  private static instance: BrowserRelayAdapter | null = null;
  private readonly logger: ComponentLogger;
  private pendingCommands: Map<string, PendingRelayCommand> = new Map();
  private commandCounter = 0;
  /** Device ID of the connected Chrome Extension (from Cloud device list) */
  private extensionDeviceId: string | null = null;
  /** Whether auto-discovery is currently active */
  private discoveryActive = false;
  /** Bound handler references for cleanup */
  private boundDeviceOnlineHandler: ((device: SyncDevice) => void) | null = null;
  private boundDeviceOfflineHandler: ((device: SyncDevice) => void) | null = null;
  private boundDevicesUpdatedHandler: ((devices: SyncDevice[]) => void) | null = null;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('BrowserRelayAdapter');
  }

  /**
   * Get the singleton instance.
   *
   * @returns BrowserRelayAdapter instance
   */
  static getInstance(): BrowserRelayAdapter {
    if (!BrowserRelayAdapter.instance) {
      BrowserRelayAdapter.instance = new BrowserRelayAdapter();
    }
    return BrowserRelayAdapter.instance;
  }

  /**
   * Reset singleton instance (for testing).
   */
  static resetInstance(): void {
    if (BrowserRelayAdapter.instance) {
      BrowserRelayAdapter.instance.cleanup();
    }
    BrowserRelayAdapter.instance = null;
  }

  /**
   * Set the target Chrome Extension device ID for relay routing.
   * This device ID comes from CloudSyncService device discovery.
   *
   * @param deviceId - Cloud device ID of the Extension
   */
  setExtensionDeviceId(deviceId: string): void {
    this.extensionDeviceId = deviceId;
    this.logger.info('Extension device ID set for relay', { deviceId });
  }

  /**
   * Get the current Extension device ID.
   *
   * @returns Device ID or null if not set
   */
  getExtensionDeviceId(): string | null {
    return this.extensionDeviceId;
  }

  /**
   * Whether the relay adapter is ready to send commands.
   * Requires an Extension device ID and an active CloudSyncService.
   *
   * @returns True if relay is available
   */
  isAvailable(): boolean {
    if (!this.extensionDeviceId) return false;
    try {
      const sync = CloudSyncService.getInstance();
      return sync.getState() === 'syncing';
    } catch {
      return false;
    }
  }

  /**
   * Send a browser command to the Chrome Extension via the Cloud relay queue.
   *
   * @param tool - Tool name to execute (e.g., 'navigate', 'screenshot')
   * @param params - Tool parameters
   * @param timeoutMs - Command timeout in milliseconds
   * @param agentName - Optional agent name for display in Extension
   * @returns Response from the Chrome Extension
   * @throws Error if relay is not available or command times out
   */
  async sendViaRelay(
    tool: string,
    params?: Record<string, unknown>,
    timeoutMs: number = BROWSER_BRIDGE_CONSTANTS.COMMAND_TIMEOUT_MS,
    agentName?: string,
  ): Promise<BrowserCommandResponse> {
    if (!this.extensionDeviceId) {
      throw new Error('No Extension device ID set — cannot send via relay');
    }

    const sync = CloudSyncService.getInstance();
    if (sync.getState() !== 'syncing') {
      throw new Error('CloudSyncService not active — cannot send via relay');
    }

    const id = `relay-cmd-${++this.commandCounter}-${Date.now()}`;
    const command: BrowserCommand = { id, tool, params };
    if (agentName) {
      command.agentName = agentName;
    }

    return new Promise<BrowserCommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Relay command '${tool}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCommands.set(id, { resolve, reject, timer });

      // Send via Cloud relay queue
      sync.sendMessage(this.extensionDeviceId!, 'browser_command', command)
        .catch((err) => {
          clearTimeout(timer);
          this.pendingCommands.delete(id);
          reject(new Error(`Failed to send relay command: ${err instanceof Error ? err.message : String(err)}`));
        });
    });
  }

  /**
   * Handle an incoming browser_response message from the Cloud relay queue.
   * Called by CloudSyncService message handler when a browser_response arrives.
   *
   * @param response - The browser command response from the Extension
   */
  handleRelayResponse(response: BrowserCommandResponse): void {
    if (!response.id) {
      this.logger.warn('Received relay response without command ID', { response });
      return;
    }

    const pending = this.pendingCommands.get(response.id);
    if (!pending) {
      this.logger.debug('Received relay response for unknown command', { id: response.id });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingCommands.delete(response.id);
    pending.resolve(response);

    this.logger.debug('Relay command resolved', {
      id: response.id,
      success: response.success,
    });
  }

  /**
   * Get the number of pending relay commands.
   *
   * @returns Number of commands awaiting response
   */
  getPendingCount(): number {
    return this.pendingCommands.size;
  }

  // -------------------------------------------------------------------------
  // Auto-Discovery: Listen for browser extension devices on CloudSync
  // -------------------------------------------------------------------------

  /**
   * Start listening for CloudSync device events to auto-discover Chrome
   * Extension devices. When a device with role 'browser' or 'chrome-extension'
   * comes online, automatically sets it as the relay target.
   *
   * Also scans the current device list on startup for already-online extensions.
   */
  startAutoDiscovery(): void {
    if (this.discoveryActive) return;

    try {
      const sync = CloudSyncService.getInstance();
      if (!sync.isStarted()) {
        this.logger.debug('CloudSync not started — deferring auto-discovery');
        return;
      }

      // Bind event handlers
      this.boundDeviceOnlineHandler = (device: SyncDevice) => {
        this.onDeviceOnline(device);
      };
      this.boundDeviceOfflineHandler = (device: SyncDevice) => {
        this.onDeviceOffline(device);
      };
      this.boundDevicesUpdatedHandler = (devices: SyncDevice[]) => {
        this.onDevicesUpdated(devices);
      };

      sync.on('device_online', this.boundDeviceOnlineHandler);
      sync.on('device_offline', this.boundDeviceOfflineHandler);
      sync.on('devices_updated', this.boundDevicesUpdatedHandler);
      this.discoveryActive = true;

      // Scan existing device list for already-online browser extensions
      const existingDevices = sync.getDevices();
      this.scanForBrowserDevice(existingDevices);

      this.logger.info('Browser extension auto-discovery started');
    } catch (err) {
      this.logger.warn('Failed to start auto-discovery', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stop listening for device events.
   */
  stopAutoDiscovery(): void {
    if (!this.discoveryActive) return;

    try {
      const sync = CloudSyncService.getInstance();
      if (this.boundDeviceOnlineHandler) {
        sync.removeListener('device_online', this.boundDeviceOnlineHandler);
      }
      if (this.boundDeviceOfflineHandler) {
        sync.removeListener('device_offline', this.boundDeviceOfflineHandler);
      }
      if (this.boundDevicesUpdatedHandler) {
        sync.removeListener('devices_updated', this.boundDevicesUpdatedHandler);
      }
    } catch {
      // CloudSync may already be destroyed
    }

    this.boundDeviceOnlineHandler = null;
    this.boundDeviceOfflineHandler = null;
    this.boundDevicesUpdatedHandler = null;
    this.discoveryActive = false;
    this.logger.info('Browser extension auto-discovery stopped');
  }

  /**
   * Whether auto-discovery is active.
   *
   * @returns True if listening for device events
   */
  isDiscoveryActive(): boolean {
    return this.discoveryActive;
  }

  /**
   * Check if a SyncDevice represents a Chrome Extension (browser role).
   *
   * @param device - Device to check
   * @returns True if the device has a browser/chrome-extension role
   */
  private isBrowserDevice(device: SyncDevice): boolean {
    if (!device.role) return false;
    const role = device.role.toLowerCase();
    return BROWSER_DEVICE_ROLES.some((r) => role === r);
  }

  /**
   * Handle a device coming online — if it's a browser extension, set it as relay target.
   *
   * @param device - The device that came online
   */
  private onDeviceOnline(device: SyncDevice): void {
    if (this.isBrowserDevice(device)) {
      this.extensionDeviceId = device.deviceId;
      this.logger.info('Browser extension auto-discovered (device_online)', {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        role: device.role,
      });
    }
  }

  /**
   * Handle a device going offline — if it's our current extension, clear the target.
   *
   * @param device - The device that went offline
   */
  private onDeviceOffline(device: SyncDevice): void {
    if (device.deviceId === this.extensionDeviceId) {
      this.logger.info('Browser extension went offline, clearing relay target', {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      });
      this.extensionDeviceId = null;
    }
  }

  /**
   * Handle devices_updated — scan for browser extensions in the full list.
   *
   * @param devices - Current device list
   */
  private onDevicesUpdated(devices: SyncDevice[]): void {
    this.scanForBrowserDevice(devices);
  }

  /**
   * Scan a device list for browser extensions and set the first online one as relay target.
   *
   * @param devices - Device list to scan
   */
  private scanForBrowserDevice(devices: SyncDevice[]): void {
    const browserDevice = devices.find(
      (d) => d.status === 'online' && this.isBrowserDevice(d),
    );

    if (browserDevice && browserDevice.deviceId !== this.extensionDeviceId) {
      this.extensionDeviceId = browserDevice.deviceId;
      this.logger.info('Browser extension found in device list', {
        deviceId: browserDevice.deviceId,
        deviceName: browserDevice.deviceName,
        role: browserDevice.role,
      });
    } else if (!browserDevice && this.extensionDeviceId) {
      // No browser device found — check if our current target is still valid
      const stillExists = devices.some(
        (d) => d.deviceId === this.extensionDeviceId && d.status === 'online',
      );
      if (!stillExists) {
        this.logger.info('Browser extension no longer in device list, clearing relay target');
        this.extensionDeviceId = null;
      }
    }
  }

  /**
   * Clean up pending commands and timers.
   */
  cleanup(): void {
    this.stopAutoDiscovery();
    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser relay adapter shutting down'));
    }
    this.pendingCommands.clear();
    this.extensionDeviceId = null;
  }
}
