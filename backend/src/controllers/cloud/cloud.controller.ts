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
import { CloudClientService } from '../../services/cloud/cloud-client.service.js';
import { DeviceIdentityService } from '../../services/cloud/device-identity.service.js';
import { CloudSyncService } from '../../services/cloud/cloud-sync.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { CLOUD_CONSTANTS, CLOUD_SYNC_CONSTANTS, AUTH_CONSTANTS } from '../../constants.js';
import type { CloudTier } from '../../constants.js';
import type { MessageType } from '../../services/cloud/cloud-sync.types.js';
import { verifyJwt, signJwt } from './cloud-google-auth.controller.js';

// ---------------------------------------------------------------------------
// License Feature Mapping
// ---------------------------------------------------------------------------

/** Features available per subscription tier. */
const TIER_FEATURES: Record<string, readonly string[]> = {
  [CLOUD_CONSTANTS.TIERS.FREE]: ['basic_teams'],
  [CLOUD_CONSTANTS.TIERS.PRO]: ['basic_teams', 'premium_templates', 'cloud_relay', 'multi_device'],
  [CLOUD_CONSTANTS.TIERS.ENTERPRISE]: ['basic_teams', 'premium_templates', 'cloud_relay', 'multi_device', 'custom_templates', 'priority_support'],
} as const;

const logger = LoggerService.getInstance().createComponentLogger('CloudController');


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

    // Safety net: ensure refreshToken is persisted even if connect/connectLocal
    // did not receive it (e.g. race condition or future refactor).
    // Both connect() and connectLocal() already store refreshToken, but
    // setRefreshToken() also re-persists config to disk as an extra guarantee.
    if (refreshToken) {
      client.setRefreshToken(refreshToken);
    }

    // Send device metadata + active teams to Cloud (best-effort, non-blocking)
    sendCloudHandshake(resolvedUrl, token).catch(() => {/* already logged inside */});

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

      // Start MessageRouterService for cross-device agent communication
      try {
        const { startMessageRouter } = await import('../../services/cloud/cloud-initializer.js');
        startMessageRouter();
      } catch {
        logger.debug('MessageRouterService start deferred (non-fatal)');
      }
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

    // STATUS-DISTINCTION invariant: tag this as the CONFIG socket transport so
    // a caller can never read "cloud connected" as "a browser is drivable".
    // Browser drivability is reported separately by GET /api/browser/status
    // (transport: 'cloud-relay-ws', drivable: proxy.isAvailable()).
    res.json({
      success: true,
      data: { ...status, transport: 'config-socket' },
    });
  } catch (error) {
    logger.error('Failed to get cloud status', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /api/cloud/license/verify
 *
 * Verify the current user's license tier and return the list of features
 * their subscription entitles them to. Used by the CLI license interceptor
 * and any client that needs to gate premium functionality.
 *
 * Returns `valid: true` when connected to Cloud with an active subscription,
 * or `valid: false` with free-tier features when disconnected.
 *
 * @param req - Express request (no params required)
 * @param res - Response returning { success, data: { valid, tier, features } }
 * @param next - Next function for error propagation
 */
export async function verifyLicense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = CloudClientService.getInstance();
    const connected = client.isConnected();
    const tier: CloudTier = connected ? client.getTier() : CLOUD_CONSTANTS.TIERS.FREE;
    const features = TIER_FEATURES[tier] ?? TIER_FEATURES[CLOUD_CONSTANTS.TIERS.FREE];

    res.json({
      success: true,
      data: {
        valid: connected,
        tier,
        features: [...features],
      },
    });
  } catch (error) {
    logger.error('Failed to verify license', {
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
 * GET /api/cloud/device-id
 *
 * Return the persistent device identity (UUID + hostname) from
 * DeviceIdentityService. The frontend uses this to include the
 * correct deviceId in heartbeats to the Cloud API, preventing
 * duplicate device registrations.
 *
 * @param req - Express request (no params required)
 * @param res - Response returning { success, data: { deviceId, deviceName } }
 * @param next - Next function for error propagation
 */
export async function getDeviceId(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const identityService = DeviceIdentityService.getInstance();
    const identity = await identityService.getOrCreateIdentity();

    res.json({
      success: true,
      data: {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
      },
    });
  } catch (error) {
    logger.error('Failed to get device identity', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
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

    // Carry forward deviceId from refresh token, or resolve from DeviceIdentityService
    let deviceId: string | undefined = payload.deviceId as string | undefined;
    if (!deviceId) {
      try {
        const identity = await DeviceIdentityService.getInstance().getOrCreateIdentity();
        deviceId = identity.deviceId;
      } catch {
        // Non-fatal — token still works without deviceId
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const accessToken = signJwt({
      sub: payload.sub,
      email: payload.email || '',
      name: payload.name || '',
      plan: payload.plan || 'free',
      ...(deviceId && { deviceId }),
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

    await syncService.sendMessage(toDeviceId, type as MessageType, payload);

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

/**
 * GET /api/cloud/devices
 *
 * List devices from CloudSyncService. Returns all devices visible to
 * the current user's Cloud account with an `isLocal` flag for the
 * current machine.
 *
 * @param req - Express request
 * @param res - Response with device list
 * @param _next - Express next function
 */
export async function getDevicesFromSync(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const syncService = CloudSyncService.getInstance();
    const syncState = syncService.getState();

    if (!syncService.isStarted()) {
      res.json({
        success: true,
        data: { devices: [], localDeviceId: null, syncState },
      });
      return;
    }

    const devices = syncService.getDevices();

    let localDeviceId: string | null = null;
    try {
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
        localDeviceId: localDeviceId,
        syncState,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get devices from sync', { error: message });
    res.status(500).json({
      success: false,
      error: `Device fetch failed: ${message}`,
    });
  }
}

/**
 * POST /api/cloud/mobile-pair
 *
 * LAN pairing bootstrap for the Crewly mobile app. The phone, on the SAME
 * network as this OSS, calls this once to ADOPT the OSS's cloud session:
 * it receives the cloud URL + the access token + this device's identity, and
 * can then register on the Cloud relay under the same account (pairing code =
 * sha256("crewly-pair-" + userId) — same derivation as the web Portal) so the
 * app keeps working OFF the LAN via the relay.
 *
 * Trust model: single-user OSS — anyone who can reach this HTTP port already
 * has unauthenticated access to the full REST API (requireAuth dev-fallback),
 * so returning the cloud token to a LAN caller does not widen the boundary.
 * When the OSS is not logged into Cloud, returns `cloud: null` — the app then
 * runs in LAN-only mode against this host.
 *
 * @param _req - Request (no body).
 * @param res - JSON: `{ success, data: { deviceId, deviceName, cloud } }`
 *   where `cloud` is `{ cloudUrl, accessToken, userId }` or null.
 * @param next - Error handler.
 */
export async function mobilePair(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const identityService = DeviceIdentityService.getInstance();
    const identity = await identityService.getOrCreateIdentity();

    const client = CloudClientService.getInstance();
    const token = client.getToken();
    const cloudUrl = client.getCloudUrl();

    let cloud: { cloudUrl: string; accessToken: string; userId: string | null } | null = null;
    if (token && cloudUrl) {
      // Best-effort sub extraction (the relay pairing code derives from it).
      let userId: string | null = null;
      try {
        const mid = token.split('.')[1];
        const claims = JSON.parse(Buffer.from(mid, 'base64url').toString('utf8')) as { sub?: string };
        userId = typeof claims.sub === 'string' ? claims.sub : null;
      } catch {
        userId = null;
      }
      cloud = { cloudUrl, accessToken: token, userId };
    }

    res.json({
      success: true,
      data: {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        cloud,
      },
    });
  } catch (error) {
    logger.error('mobile-pair failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}
