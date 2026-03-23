/**
 * Relay REST Controller (Client-side only)
 *
 * Handles HTTP requests for the relay client lifecycle (connecting
 * to a remote relay server). Server-side relay management has been
 * moved to the cloud services repository.
 *
 * Client-side endpoints:
 * - POST /relay/connect    — connect to a remote relay server
 * - POST /relay/disconnect — disconnect from the relay server
 * - GET  /relay/devices    — list paired/connected devices
 * - POST /relay/send       — send a message to the paired peer
 *
 * @module controllers/cloud/relay.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { RelayClientService } from '../../services/cloud/relay-client.service.js';
import { CloudClientService } from '../../services/cloud/cloud-client.service.js';
import { CloudSyncService } from '../../services/cloud/cloud-sync.service.js';
import { LoggerService } from '../../services/core/logger.service.js';
import type {
  RelayClientConfig,
} from '../../services/cloud/relay.types.js';

const logger = LoggerService.getInstance().createComponentLogger('RelayController');

/** Valid relay node roles for request validation. */
const VALID_ROLES: ReadonlySet<string> = new Set(['orchestrator', 'agent']);

// ---------------------------------------------------------------------------
// Client-side endpoints
// ---------------------------------------------------------------------------

/** Request body for POST /relay/connect. */
interface ConnectRelayRequestBody {
  apiUrl: string;
  pairingCode: string;
  role: 'orchestrator' | 'agent';
  token: string;
  sharedSecret: string;
}

/**
 * POST /relay/connect
 *
 * Connect the local Crewly instance to the Cloud Message Queue.
 * Initiates HTTP-based connection, registration, and waits for pairing.
 *
 * @param req - Request with body: { apiUrl, pairingCode, role, token, sharedSecret }
 * @param res - Response with connection status
 * @param next - Next function for error propagation
 */
export async function connectToRelay(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { apiUrl, pairingCode, role, token, sharedSecret } = req.body as Partial<ConnectRelayRequestBody>;

    if (!apiUrl || !pairingCode || !role || !token || !sharedSecret) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: apiUrl, pairingCode, role, token, sharedSecret',
      });
      return;
    }

    if (!VALID_ROLES.has(role)) {
      res.status(400).json({
        success: false,
        error: `Invalid role: "${role}". Must be "orchestrator" or "agent".`,
      });
      return;
    }

    const client = RelayClientService.getInstance();
    const currentState = client.getState();

    if (currentState !== 'disconnected' && currentState !== 'error') {
      res.status(409).json({
        success: false,
        error: `Relay client is already in "${currentState}" state. Disconnect first.`,
      });
      return;
    }

    const config: RelayClientConfig = { apiUrl, pairingCode, role, token, sharedSecret };
    client.connect(config);

    logger.info('Relay client connecting', { apiUrl, pairingCode, role });

    res.json({
      success: true,
      data: {
        state: client.getState(),
        message: 'Relay client connection initiated',
      },
    });
  } catch (error) {
    logger.error('Failed to connect relay client', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /relay/disconnect
 *
 * Disconnect the local relay client from the remote relay server.
 * Closes the WebSocket cleanly and stops heartbeats and reconnection.
 *
 * @param req - Express request (no body required)
 * @param res - Response with disconnection confirmation
 * @param next - Next function for error propagation
 */
export async function disconnectFromRelay(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = RelayClientService.getInstance();
    const previousState = client.getState();

    client.disconnect();

    logger.info('Relay client disconnected', { previousState });

    res.json({
      success: true,
      data: {
        previousState,
        state: client.getState(),
        message: 'Relay client disconnected',
      },
    });
  } catch (error) {
    logger.error('Failed to disconnect relay client', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /relay/devices
 *
 * List connected devices visible through the relay. Returns the local
 * relay client state.
 *
 * @param req - Express request (no params required)
 * @param res - Response with device list
 * @param next - Next function for error propagation
 */
export async function getRelayDevices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = RelayClientService.getInstance();

    const clientInfo = {
      state: client.getState(),
      sessionId: client.getSessionId(),
    };

    res.json({
      success: true,
      data: {
        client: clientInfo,
      },
    });
  } catch (error) {
    logger.error('Failed to get relay devices', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /relay/send
 *
 * Send an encrypted message to the paired peer via the relay.
 * The message is encrypted locally using the shared secret before
 * being forwarded through the relay server.
 *
 * @param req - Request with body: { message }
 * @param res - Response with send confirmation
 * @param next - Next function for error propagation
 */
export async function sendRelayMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { message } = req.body as { message?: string };

    if (typeof message !== 'string' || message.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing or empty required parameter: message',
      });
      return;
    }

    const client = RelayClientService.getInstance();

    if (client.getState() !== 'paired') {
      res.status(409).json({
        success: false,
        error: `Cannot send — relay client is in "${client.getState()}" state, must be "paired".`,
      });
      return;
    }

    client.send(message);

    logger.info('Relay message sent', { messageLength: message.length });

    res.json({
      success: true,
      data: {
        sent: true,
        messageLength: message.length,
      },
    });
  } catch (error) {
    logger.error('Failed to send relay message', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /relay/cloud-devices
 *
 * Proxy endpoint that fetches the authenticated user's device list
 * from CrewlyAI Cloud (/api/v1/relay/devices). Used by the Settings
 * Cloud tab to display device discovery information.
 *
 * @param req - Express request (no params required)
 * @param res - Response with cloud device list
 * @param next - Next function for error propagation
 */
export async function getCloudDevices(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const cloudClient = CloudClientService.getInstance();

    // Check connection before attempting fetch
    if (!cloudClient.isConnected()) {
      // If token expired, return a user-friendly hint instead of empty list
      if (cloudClient.isTokenExpired()) {
        res.json({
          success: true,
          data: { devices: [], localSessionId: null, tokenExpired: true },
        });
        return;
      }
      res.json({
        success: true,
        data: { devices: [], localSessionId: null },
      });
      return;
    }

    const devices = await cloudClient.fetchCloudDevices();

    // If the fetch triggered token expiry detection, return the hint
    if (cloudClient.isTokenExpired()) {
      res.json({
        success: true,
        data: { devices: [], localSessionId: null, tokenExpired: true },
      });
      return;
    }

    // Mark the current device (this OSS instance)
    // Compare by both relay sessionId (legacy) and device UUID (Cloud Sync)
    const relayClient = RelayClientService.getInstance();
    const localSessionId = relayClient.getSessionId();

    let localDeviceId: string | null = null;
    try {
      const { DeviceIdentityService: DevIdService } = await import('../../services/cloud/device-identity.service.js');
      const identity = await DevIdService.getInstance().getOrCreateIdentity();
      localDeviceId = identity.deviceId;
    } catch {
      logger.debug('Could not resolve local device ID for legacy isLocal check');
    }

    const devicesWithLocal = devices.map((device) => ({
      ...device,
      // Cloud API returns `deviceName` but frontend expects `name` — normalize
      name: (device as any).deviceName || device.name,
      isLocal:
        (localSessionId ? device.sessionId === localSessionId : false) ||
        (localDeviceId ? (device as any).deviceId === localDeviceId : false),
    }));

    res.json({
      success: true,
      data: {
        devices: devicesWithLocal,
        localSessionId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to fetch cloud devices', { error: message });
    res.status(502).json({
      success: false,
      error: `Cloud device fetch failed: ${message}`,
    });
  }
}

/**
 * GET /cloud/devices
 *
 * Fetch device list from CloudSyncService when it is active, or fall back
 * to the legacy getCloudDevices proxy when Cloud Sync is not started.
 *
 * Response shape:
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "devices": [...],
 *     "localSessionId": "device-uuid",
 *     "syncState": "syncing" | "stopped" | "error"
 *   }
 * }
 * ```
 *
 * @param req - Express request (no params required)
 * @param res - Response with device list and sync state
 * @param next - Next function for error propagation
 */
export async function getDevicesFromSync(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const syncService = CloudSyncService.getInstance();
    const syncState = syncService.getState();

    // When CloudSync is active, read from its local cache
    if (syncService.isStarted()) {
      const devices = syncService.getDevices();

      // Determine local device ID from DeviceIdentityService (lazy import to avoid circular deps)
      let localDeviceId: string | null = null;
      try {
        const { DeviceIdentityService } = await import('../../services/cloud/device-identity.service.js');
        const identity = await DeviceIdentityService.getInstance().getOrCreateIdentity();
        localDeviceId = identity.deviceId;
      } catch {
        logger.debug('Could not resolve local device ID for isLocal flag');
      }

      const devicesWithLocal = devices.map((device) => ({
        ...device,
        isLocal: localDeviceId ? device.deviceId === localDeviceId : false,
      }));

      res.json({
        success: true,
        data: {
          devices: devicesWithLocal,
          localSessionId: localDeviceId,
          syncState,
        },
      });
      return;
    }

    // Fallback: CloudSync not started — delegate to legacy cloud-devices endpoint logic
    logger.debug('CloudSync not started, falling back to legacy fetchCloudDevices');
    await getCloudDevices(req, res, next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get devices from sync', { error: message });
    res.status(500).json({
      success: false,
      error: `Device fetch failed: ${message}`,
    });
  }
}
