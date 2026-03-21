/**
 * Cloud REST Controller
 *
 * Handles HTTP requests for CrewlyAI Cloud integration.
 * Provides endpoints for connecting, disconnecting, checking status,
 * and fetching premium templates from CrewlyAI Cloud.
 *
 * @module controllers/cloud/cloud.controller
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { CloudClientService } from '../../services/cloud/cloud-client.service.js';
import { RelayClientService } from '../../services/cloud/relay-client.service.js';
import { DeviceIdentityService } from '../../services/cloud/device-identity.service.js';
import { CloudSyncService } from '../../services/cloud/cloud-sync.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { CLOUD_CONSTANTS, CLOUD_SYNC_CONSTANTS, AUTH_CONSTANTS } from '../../constants.js';
import { verifyJwt, signJwt } from './cloud-google-auth.controller.js';

const logger = LoggerService.getInstance().createComponentLogger('CloudController');

/**
 * Cloud Message Queue API URL.
 *
 * Priority:
 * 1. CREWLY_RELAY_API_URL env var (explicit override, e.g. http://localhost:3000 for local dev)
 * 2. Default Cloud backend at https://api.crewlyai.com
 */
const RELAY_API_URL = (): string => {
  if (process.env['CREWLY_RELAY_API_URL']) {
    return process.env['CREWLY_RELAY_API_URL'];
  }
  return 'https://api.crewlyai.com';
};

/**
 * Auto-connect to the Cloud Relay after a successful cloud login.
 *
 * Derives a deterministic pairing code and shared secret from the user's ID
 * so that all devices belonging to the same user auto-pair via the relay.
 * Best-effort — failures are logged but do not affect cloud connect.
 *
 * @param token - JWT access token from cloud login
 */
/**
 * Auto-connect relay using a JWT token.
 * Exported as autoConnectRelayFromToken for use by cloud-initializer.
 *
 * @param token - JWT access token
 */
export function autoConnectRelayFromToken(token: string): void {
	autoConnectRelay(token);
}

function autoConnectRelay(token: string): void {
  try {
    const relay = RelayClientService.getInstance();
    if (relay.getState() !== 'disconnected' && relay.getState() !== 'error') {
      logger.info('Relay already connected or connecting, skipping auto-connect');
      return;
    }

    const payload = verifyJwt(token);
    if (!payload || !payload.sub) {
      logger.warn('Cannot auto-connect relay: invalid token payload');
      return;
    }

    const userId = String(payload.sub);
    // Deterministic pairing code from user ID — both devices of the same user get the same code
    const pairingCode = crypto.createHash('sha256').update(`crewly-pair-${userId}`).digest('hex').slice(0, 12);
    // Shared secret incorporates the JWT secret so it can't be derived from user ID alone
    const jwtSecret = AUTH_CONSTANTS.JWT.DEFAULT_SECRET;
    const sharedSecret = crypto.createHash('sha256').update(`crewly-e2ee-${userId}-${jwtSecret}`).digest('hex');

    // Defensive: attach error listener to prevent uncaught exception
    // if any code path still emits 'error' on the EventEmitter
    if (relay.listenerCount('error') === 0) {
      relay.on('error', (err: Error) => {
        logger.warn('Relay error (caught by autoConnectRelay fallback)', { error: err.message });
      });
    }

    relay.connect({
      apiUrl: RELAY_API_URL(),
      pairingCode,
      role: 'orchestrator',
      token,
      sharedSecret,
    });

    logger.info('Relay auto-connect initiated', { pairingCode: pairingCode.slice(0, 4) + '...' });
  } catch (err) {
    logger.warn('Relay auto-connect failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Payload sent to the Cloud during the handshake after connect. */
export interface CloudHandshakePayload {
  /** Unique device ID from ~/.crewly/device.json */
  deviceId: string;
  /** Human-readable device name (hostname) */
  deviceName: string;
  /** Active teams on this OSS instance */
  teams: Array<{
    id: string;
    name: string;
    memberCount: number;
    activeAgents: number;
  }>;
  /** Crewly version (from package.json) */
  version: string;
  /** ISO timestamp of this handshake */
  timestamp: string;
}

/**
 * Send device metadata and active team lists to the Cloud server.
 *
 * This runs as a best-effort POST after a successful cloud connect.
 * Failures are logged but do not affect the cloud connection.
 *
 * @param cloudUrl - Cloud API base URL
 * @param token - Bearer token for authentication
 */
async function sendCloudHandshake(cloudUrl: string, token: string): Promise<void> {
  try {
    // Gather device identity
    const identityService = DeviceIdentityService.getInstance();
    const identity = await identityService.getOrCreateIdentity();

    // Gather active teams
    const storage = StorageService.getInstance();
    const allTeams = await storage.getTeams();
    const teamSummaries = allTeams.map((team) => ({
      id: team.id,
      name: team.name,
      memberCount: team.members?.length ?? 0,
      activeAgents: team.members?.filter((m) => m.agentStatus === 'active').length ?? 0,
    }));

    // Read version from package root (best-effort)
    let version = 'unknown';
    try {
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8'));
      version = pkg.version || 'unknown';
    } catch {
      // Non-critical — version is informational only
    }

    const payload: CloudHandshakePayload = {
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      teams: teamSummaries,
      version,
      timestamp: new Date().toISOString(),
    };

    const url = `${cloudUrl}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.HEARTBEAT}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.CONNECT),
    });

    if (response.ok) {
      logger.info('Cloud handshake sent successfully', {
        deviceId: identity.deviceId,
        teamCount: teamSummaries.length,
      });
    } else {
      // 404 is expected when the Cloud endpoint is not yet deployed
      const status = response.status;
      if (status === 404) {
        logger.debug('Cloud handshake endpoint not yet available (404)');
      } else {
        logger.warn('Cloud handshake failed', { status });
      }
    }
  } catch (err) {
    logger.warn('Cloud handshake failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * POST /api/cloud/connect
 *
 * Connect to CrewlyAI Cloud with the provided URL and authentication token.
 * After a successful connect, sends device metadata and active team lists
 * to the Cloud via the handshake endpoint.
 *
 * @param req - Request with body: { cloudUrl?, token, refreshToken? }
 * @param res - Response returning { success, data: { tier } }
 * @param next - Next function for error propagation
 */
export async function connectToCloud(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { cloudUrl, token, refreshToken } = req.body;

    if (!token) {
      res.status(400).json({ success: false, error: 'Missing required parameter: token' });
      return;
    }

    const resolvedUrl = cloudUrl || CLOUD_CONSTANTS.DEFAULT_CLOUD_URL;
    const client = CloudClientService.getInstance();

    // Try local JWT verification first — this works when OSS and Cloud share
    // the same JWT secret (CREWLY_JWT_SECRET), or when the token was issued
    // by this same instance (e.g. local Google OAuth flow).
    const localPayload = verifyJwt(token);
    let result: { success: boolean; tier: string };

    if (localPayload) {
      // JWT verified locally — connect without calling cloud API
      const tier = (localPayload.plan as string) || 'free';
      client.connectLocal(resolvedUrl, token, tier as import('../../constants.js').CloudTier, refreshToken);
      result = { success: true, tier };
      logger.info('Connected to CrewlyAI Cloud (local JWT verification)', { tier });
    } else {
      // Local verification failed (different JWT secret) — call cloud API
      result = await client.connect(resolvedUrl, token, refreshToken);
      logger.info('Connected to CrewlyAI Cloud (remote verification)', { tier: result.tier });
    }

    // Store refresh token if provided separately
    if (refreshToken && !client.getToken()) {
      client.setRefreshToken(refreshToken);
    }

    // Send device metadata + active teams to Cloud (best-effort, non-blocking)
    sendCloudHandshake(resolvedUrl, token).catch(() => {/* already logged inside */});

    // Auto-initiate relay connection (best-effort, non-blocking)
    autoConnectRelay(token);

    // Start Cloud Sync for device discovery and message polling (best-effort)
    try {
      const identityService = DeviceIdentityService.getInstance();
      const identity = await identityService.getOrCreateIdentity();
      CloudSyncService.getInstance().start({
        cloudUrl: resolvedUrl,
        token,
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
      });
      logger.info('CloudSyncService started after cloud connect', { deviceId: identity.deviceId });
    } catch (syncErr) {
      logger.warn('CloudSyncService start failed (non-fatal)', {
        error: syncErr instanceof Error ? syncErr.message : String(syncErr),
      });
    }

    res.json({ success: true, data: { tier: result.tier } });
  } catch (error) {
    logger.error('Failed to connect to cloud', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error && error.message.includes('authentication failed')) {
      res.status(401).json({ success: false, error: error.message });
      return;
    }
    next(error);
  }
}

/**
 * POST /api/cloud/disconnect
 *
 * Disconnect from CrewlyAI Cloud and clear stored credentials.
 *
 * @param req - Express request (no body required)
 * @param res - Response returning { success: true }
 * @param next - Next function for error propagation
 */
export async function disconnectFromCloud(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = CloudClientService.getInstance();
    client.disconnect();

    // Stop Cloud Sync service
    try {
      CloudSyncService.getInstance().stop();
      logger.info('CloudSyncService stopped as part of cloud disconnect');
    } catch (syncErr) {
      logger.warn('CloudSyncService stop failed (non-fatal)', {
        error: syncErr instanceof Error ? syncErr.message : String(syncErr),
      });
    }

    // Also disconnect relay
    try {
      const relay = RelayClientService.getInstance();
      if (relay.getState() !== 'disconnected') {
        relay.disconnect();
        logger.info('Relay disconnected as part of cloud disconnect');
      }
    } catch (err) {
      logger.warn('Relay disconnect failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('Disconnected from CrewlyAI Cloud');
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to disconnect from cloud', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /api/cloud/status
 *
 * Get the current CrewlyAI Cloud connection status and subscription tier.
 *
 * @param req - Express request (no params required)
 * @param res - Response returning { success, data: CloudStatus }
 * @param next - Next function for error propagation
 */
export async function getCloudStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = CloudClientService.getInstance();
    const status = client.getStatus();

    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get cloud status', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/cloud/validate
 *
 * Validate a JWT access token locally by verifying its HMAC signature
 * and expiry. Returns user profile from the token payload.
 *
 * Falls back to proxying to the Cloud API if CREWLY_CLOUD_API_BASE
 * is explicitly set (for OSS→Cloud validation).
 *
 * @param req - Request with Authorization: Bearer <token> header
 * @param res - Response returning { success, data: { id, email, displayName, plan } }
 * @param next - Next function for error propagation
 */
export async function validateCloudToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ success: false, error: 'Missing Authorization header' });
      return;
    }

    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      res.status(401).json({ success: false, error: 'Missing token' });
      return;
    }

    // Try local JWT verification first
    const payload = verifyJwt(token);
    if (payload) {
      res.json({
        success: true,
        data: {
          id: payload.sub as string,
          email: payload.email as string,
          displayName: (payload.name as string) || '',
          plan: (payload.plan as string) || 'free',
        },
      });
      return;
    }

    // If local verification fails, proxy to the remote cloud API.
    // Use explicit CREWLY_CLOUD_API_BASE env, or fall back to
    // CloudClientService's stored cloudUrl (set during connect).
    const cloudApiBase = process.env['CREWLY_CLOUD_API_BASE']
      || CloudClientService.getInstance().getCloudUrl();
    if (cloudApiBase) {
      const response = await fetch(`${cloudApiBase}${CLOUD_CONSTANTS.ENDPOINTS.AUTH_TOKEN}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        signal: AbortSignal.timeout(CLOUD_CONSTANTS.TIMEOUTS.CONNECT),
      });

      const data = await response.json();
      res.status(response.status).json(data);
      return;
    }

    // Token invalid and no cloud connection established
    res.status(401).json({ success: false, error: 'Invalid or expired token. Connect to CrewlyAI Cloud first.' });
  } catch (error) {
    logger.error('Failed to validate cloud token', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(502).json({
      success: false,
      error: 'Could not validate token. Check your internet connection.',
    });
  }
}

/**
 * POST /api/cloud/refresh
 *
 * Exchange a valid refresh token for a new access token.
 *
 * @param req - Request with body: { refreshToken }
 * @param res - Response returning { success, data: { accessToken, expiresIn } }
 * @param next - Next function for error propagation
 */
export async function refreshCloudToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ success: false, error: 'Missing refreshToken' });
      return;
    }

    const payload = verifyJwt(refreshToken);
    if (!payload || payload.type !== 'refresh') {
      res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const accessToken = signJwt({
      sub: payload.sub,
      email: payload.email || '',
      name: payload.name || '',
      plan: payload.plan || 'free',
      iat: now,
      exp: now + AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S,
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'access',
    });

    res.json({
      success: true,
      data: {
        accessToken,
        expiresIn: AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S,
      },
    });
  } catch (error) {
    logger.error('Failed to refresh token', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /api/cloud/templates
 *
 * Fetch available premium templates from CrewlyAI Cloud.
 * Requires an active cloud connection.
 *
 * @param req - Express request (no params required)
 * @param res - Response returning { success, data: CloudTemplateSummary[] }
 * @param next - Next function for error propagation
 */
export async function getCloudTemplates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = CloudClientService.getInstance();

    if (!client.isConnected()) {
      res.status(403).json({
        success: false,
        error: 'Not connected to CrewlyAI Cloud. Connect via POST /api/cloud/connect first.',
      });
      return;
    }

    const templates = await client.getTemplates();
    res.json({ success: true, data: templates });
  } catch (error) {
    logger.error('Failed to fetch cloud templates', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/cloud/send
 *
 * Send a message to another device via the Cloud Sync message queue.
 * Requires an active CloudSyncService (i.e. connected to Cloud).
 *
 * @param req - Request with body: { toDeviceId, type, payload }
 * @param res - Response returning { success, message }
 * @param next - Next function for error propagation
 */
export async function sendCloudMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { toDeviceId, type, payload } = req.body as {
      toDeviceId?: string;
      type?: string;
      payload?: unknown;
    };

    if (!toDeviceId || typeof toDeviceId !== 'string') {
      res.status(400).json({ success: false, error: 'Missing required parameter: toDeviceId' });
      return;
    }

    if (!type || typeof type !== 'string') {
      res.status(400).json({ success: false, error: 'Missing required parameter: type' });
      return;
    }

    const syncService = CloudSyncService.getInstance();

    if (!syncService.isStarted()) {
      res.status(409).json({
        success: false,
        error: 'CloudSyncService not started. Connect to Cloud first via POST /api/cloud/connect.',
      });
      return;
    }

    await syncService.sendMessage(toDeviceId, type as import('../../services/cloud/cloud-sync.types.js').MessageType, payload);

    logger.info('Cloud message sent', { toDeviceId, type });

    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    logger.error('Failed to send cloud message', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error && error.message.includes('not started')) {
      res.status(409).json({ success: false, error: error.message });
      return;
    }
    next(error);
  }
}
