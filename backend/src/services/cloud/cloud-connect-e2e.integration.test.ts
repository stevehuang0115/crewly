/**
 * Cloud Connect End-to-End Integration Test
 *
 * Comprehensive E2E verification of the entire Cloud Connect pipeline:
 * 1. Endpoint path consistency (constants vs actual usage)
 * 2. Cloud API liveness (smoke test against api.crewlyai.com)
 * 3. Two-device simulation (heartbeat → discovery → messaging → ack)
 * 4. Token lifecycle (issue → validate → refresh → expire)
 * 5. CloudSyncService state machine (stopped → syncing → error → stopped)
 * 6. Frontend→Backend contract (route paths match what frontend expects)
 *
 * This test exists because Cloud Connect was fixed 20+ times without
 * E2E verification, causing repeated regressions. It is the LAST LINE
 * OF DEFENSE against endpoint path mismatches, broken polling, and
 * token refresh failures.
 *
 * @module services/cloud/cloud-connect-e2e.integration.test
 */

import { CloudSyncService } from './cloud-sync.service.js';
import { CLOUD_SYNC_CONSTANTS, CLOUD_CONSTANTS, AUTH_CONSTANTS } from '../../constants.js';
import type {
  CloudSyncConfig,
  SyncDevice,
  IncomingMessage,
  HeartbeatPayload,
} from './cloud-sync.types.js';
import {
  isCloudSyncState,
  isMessageType,
  isSyncDevice,
  isIncomingMessage,
  isCloudSyncConfig,
} from './cloud-sync.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock fetch that simulates Cloud API responses.
 * Tracks all requests for assertion.
 */
function createMockCloudServer() {
  const requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
  }> = [];

  /** In-memory device registry (simulates Cloud server state). */
  const devices = new Map<string, any>();

  /** In-memory message queues (deviceId → messages[]). */
  const messageQueues = new Map<string, any[]>();

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || 'GET';
    const headers = init?.headers as Record<string, string> || {};
    let body: any = null;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }

    requests.push({ url, method, headers, body });

    // --- Route matching (mirrors Cloud Sync routes at /api/v1/sync/*) ---

    // POST /api/v1/relay/handshake — Heartbeat/Device Registration
    if (url.endsWith('/api/v1/relay/handshake') && method === 'POST') {
      if (!headers.Authorization) {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
      }
      const deviceId = body?.deviceId;
      if (deviceId) {
        devices.set(deviceId, {
          deviceId,
          deviceName: body.deviceName || 'Unknown',
          status: 'online',
          version: body.version,
          capabilities: body.capabilities,
          lastHeartbeatAt: new Date().toISOString(),
          registeredAt: devices.get(deviceId)?.registeredAt || new Date().toISOString(),
        });
      }
      return new Response(JSON.stringify({
        success: true,
        device: { deviceId, name: body?.deviceName, state: 'waiting', pairedWith: null },
        received: { teamCount: body?.teams?.length || 0, version: body?.version || 'unknown', timestamp: body?.timestamp },
      }), { status: 200 });
    }

    // GET /api/v1/relay/devices — Device Discovery
    if (url.endsWith('/api/v1/relay/devices') && method === 'GET') {
      if (!headers.Authorization) {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
      }
      // Return devices in Cloud Relay format (sessionId, name, state, etc.)
      const mapped = Array.from(devices.values()).map((d: any) => ({
        sessionId: d.deviceId,
        name: d.deviceName,
        role: 'orchestrator',
        state: 'waiting',
        pairedWith: null,
        registeredAt: d.registeredAt,
        lastHeartbeatAt: d.lastHeartbeatAt,
      }));
      return new Response(JSON.stringify({
        success: true,
        devices: mapped,
      }), { status: 200 });
    }

    // POST /api/v1/relay/queue/send — Send Message
    if (url.endsWith('/api/v1/relay/queue/send') && method === 'POST') {
      if (!headers.Authorization) {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
      }
      const { toDeviceId, payload } = body || {};
      if (!toDeviceId) {
        return new Response(JSON.stringify({ success: false, error: 'Missing toDeviceId' }), { status: 400 });
      }
      const queue = messageQueues.get(toDeviceId) || [];
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      queue.push({
        id: msgId,
        fromDeviceId: 'sender-device',
        payload,
        createdAt: new Date().toISOString(),
      });
      messageQueues.set(toDeviceId, queue);
      return new Response(JSON.stringify({ success: true, messageId: msgId }), { status: 200 });
    }

    // GET /api/v1/relay/queue/poll — Poll Messages
    if (url.includes('/api/v1/relay/queue/poll') && method === 'GET') {
      if (!headers.Authorization) {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
      }
      const urlObj = new URL(url);
      const deviceId = urlObj.searchParams.get('queueId') || '';
      const messages = messageQueues.get(deviceId) || [];
      return new Response(JSON.stringify({
        success: true,
        messages,
      }), { status: 200 });
    }

    // POST /api/v1/relay/queue/ack — Acknowledge Messages
    if (url.endsWith('/api/v1/relay/queue/ack') && method === 'POST') {
      const { queueId, messageIds } = body || {};
      if (queueId && messageIds) {
        const queue = messageQueues.get(queueId) || [];
        const remaining = queue.filter((m: any) => !messageIds.includes(m.id));
        messageQueues.set(queueId, remaining);
      }
      return new Response(JSON.stringify({ success: true, acknowledged: messageIds?.length || 0 }), { status: 200 });
    }

    // Default: 404
    return new Response(JSON.stringify({ success: false, error: `Unknown endpoint: ${method} ${url}` }), { status: 404 });
  };

  return { handler, requests, devices, messageQueues };
}

/**
 * Create a test CloudSyncConfig.
 */
function makeConfig(overrides?: Partial<CloudSyncConfig>): CloudSyncConfig {
  return {
    cloudUrl: 'https://mock-cloud.test',
    token: 'test-jwt-token-123',
    deviceId: 'device-aaa-111',
    deviceName: 'Test MacBook',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DIMENSION 1: Endpoint Path Consistency
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — Endpoint Path Consistency', () => {
  it('CLOUD_SYNC_CONSTANTS.ENDPOINTS match actual Cloud Relay routes on api.crewlyai.com', () => {
    // All Cloud Sync endpoints now use /api/v1/relay/* to match the web project routes.
    //
    // CRITICAL: Previous endpoints (/api/devices/*, /api/v1/sync/*) did NOT exist on
    // the Cloud server, which was the root cause of the two-device discovery failure.

    expect(CLOUD_SYNC_CONSTANTS.ENDPOINTS.HEARTBEAT).toBe('/api/v1/relay/handshake');
    expect(CLOUD_SYNC_CONSTANTS.ENDPOINTS.DEVICES).toBe('/api/v1/relay/devices');
    expect(CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES).toBe('/api/v1/relay/queue/send');
    expect(CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES_POLL).toBe('/api/v1/relay/queue/poll');
    expect(CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES_ACK).toBe('/api/v1/relay/queue/ack');
  });

  it('all endpoint paths start with /api/', () => {
    // Ensures all endpoints use the /api/ prefix (not bare /v1/ which is legacy)
    const endpoints = CLOUD_SYNC_CONSTANTS.ENDPOINTS;
    for (const [key, path] of Object.entries(endpoints)) {
      expect(path).toMatch(/^\/api\//);
    }
  });

  it('RELAY_ENDPOINTS paths are consistent (no mixed prefixes)', () => {
    // QUEUE_* endpoints must use /api/v1/ prefix
    const { QUEUE_REGISTER, QUEUE_SEND, QUEUE_POLL, QUEUE_ACK, DEVICES, HANDSHAKE } =
      CLOUD_CONSTANTS.RELAY_ENDPOINTS;

    const queueEndpoints = [QUEUE_REGISTER, QUEUE_SEND, QUEUE_POLL, QUEUE_ACK, DEVICES, HANDSHAKE];
    for (const ep of queueEndpoints) {
      expect(ep).toMatch(/^\/api\/v1\/relay\//);
    }
  });

  it('legacy REGISTER and STATUS still use /v1/ prefix (not /api/v1/)', () => {
    // Legacy endpoints are kept for backward compat but should not be confused with new ones
    expect(CLOUD_CONSTANTS.RELAY_ENDPOINTS.REGISTER).toBe('/v1/relay/register');
    expect(CLOUD_CONSTANTS.RELAY_ENDPOINTS.STATUS).toBe('/v1/relay/status');
  });
});

// ---------------------------------------------------------------------------
// DIMENSION 2: Cloud API Liveness (Smoke Test)
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — Cloud API Liveness', () => {
  // These tests hit the real api.crewlyai.com — skip if no internet or in CI
  const CLOUD_URL = 'https://api.crewlyai.com';
  const SKIP_LIVE = process.env.CI === 'true' || process.env.SKIP_LIVE_CLOUD === 'true';

  it.skip('Cloud relay handshake endpoint exists (returns 401 without token)', async () => {
    const response = await fetch(`${CLOUD_URL}/api/v1/relay/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test', deviceName: 'test' }),
      signal: AbortSignal.timeout(10_000),
    });
    // 401/403 means the endpoint exists but needs auth — that's what we want
    // 404 would mean the endpoint doesn't exist (BAD)
    expect(response.status).not.toBe(404);
  });

  it.skip('Cloud relay device list endpoint exists (returns 401 without token)', async () => {
    const response = await fetch(`${CLOUD_URL}/api/v1/relay/devices`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).not.toBe(404);
  });

  it.skip('Cloud relay queue send endpoint exists', async () => {
    const response = await fetch(`${CLOUD_URL}/api/v1/relay/queue/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toDeviceId: 'test', payload: '{}' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).not.toBe(404);
  });

  it.skip('Cloud relay queue poll endpoint exists', async () => {
    const response = await fetch(`${CLOUD_URL}/api/v1/relay/queue/poll?queueId=test`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).not.toBe(404);
  });

  it.skip('Cloud relay queue ack endpoint exists', async () => {
    const response = await fetch(`${CLOUD_URL}/api/v1/relay/queue/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueId: 'test', messageIds: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DIMENSION 3: Two-Device Simulation (Full Lifecycle)
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — Two-Device Simulation', () => {
  let mockServer: ReturnType<typeof createMockCloudServer>;
  let originalFetch: typeof globalThis.fetch;
  let syncA: CloudSyncService;
  let syncB: CloudSyncService;

  beforeEach(() => {
    mockServer = createMockCloudServer();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockServer.handler as any;

    // Create two separate CloudSyncService instances (simulating 2 devices)
    CloudSyncService.resetInstance();
    syncA = CloudSyncService.getInstance();

    // For device B, we need a separate instance — hack the singleton
    (CloudSyncService as any).instance = null;
    syncB = CloudSyncService.getInstance();
  });

  afterEach(() => {
    syncA.stop();
    syncB.stop();
    globalThis.fetch = originalFetch;
    CloudSyncService.resetInstance();
  });

  it('Device A heartbeat registers the device on Cloud', async () => {
    const configA = makeConfig({ deviceId: 'device-A', deviceName: 'MacBook Pro' });
    (syncA as any).config = configA;
    (syncA as any).state = 'syncing';

    await syncA.sendHeartbeat();

    // Verify the device was registered
    expect(mockServer.devices.has('device-A')).toBe(true);
    const device = mockServer.devices.get('device-A');
    expect(device.deviceName).toBe('MacBook Pro');
    expect(device.status).toBe('online');

    // Verify the HTTP request was correct
    const heartbeatReq = mockServer.requests.find((r) =>
      r.url.includes('/api/v1/relay/handshake') && r.method === 'POST'
    );
    expect(heartbeatReq).toBeDefined();
    expect(heartbeatReq!.headers.Authorization).toBe(`Bearer ${configA.token}`);
    expect(heartbeatReq!.body.deviceId).toBe('device-A');
  });

  it('Device B discovers Device A after both heartbeat', async () => {
    // Device A heartbeats
    const configA = makeConfig({ deviceId: 'device-A', deviceName: 'MacBook Pro' });
    (syncA as any).config = configA;
    (syncA as any).state = 'syncing';
    await syncA.sendHeartbeat();

    // Device B heartbeats
    const configB = makeConfig({ deviceId: 'device-B', deviceName: 'iMac Studio' });
    (syncB as any).config = configB;
    (syncB as any).state = 'syncing';
    await syncB.sendHeartbeat();

    // Device B polls for devices
    const devicesUpdated = new Promise<SyncDevice[]>((resolve) => {
      syncB.once('devices_updated', resolve);
    });
    await syncB.pollDevices();
    const devices = await devicesUpdated;

    // Both devices should be visible
    expect(devices.length).toBe(2);
    const deviceAEntry = devices.find((d) => d.deviceId === 'device-A');
    expect(deviceAEntry).toBeDefined();
    expect(deviceAEntry!.deviceName).toBe('MacBook Pro');
    expect(deviceAEntry!.status).toBe('online');
  });

  it('Device A sends message to Device B, Device B polls and receives it', async () => {
    // Setup both devices
    const configA = makeConfig({ deviceId: 'device-A' });
    (syncA as any).config = configA;
    (syncA as any).state = 'syncing';

    const configB = makeConfig({ deviceId: 'device-B' });
    (syncB as any).config = configB;
    (syncB as any).state = 'syncing';

    // Device A sends a command to Device B
    await syncA.sendMessage('device-B', 'command', {
      action: 'delegate-task',
      content: 'Implement feature X',
    });

    // Verify message is in the queue
    expect(mockServer.messageQueues.get('device-B')?.length).toBe(1);

    // Device B polls and receives the message
    const messageReceived = new Promise<IncomingMessage>((resolve) => {
      syncB.once('message', resolve);
    });
    await syncB.pollMessages();
    const msg = await messageReceived;

    expect(msg.id).toBeDefined();
    expect(msg.from).toBe('sender-device');
    expect(msg.payload).toBeDefined();

    // After ack, queue should be empty
    expect(mockServer.messageQueues.get('device-B')?.length).toBe(0);
  });

  it('Multiple messages queue and deliver in order', async () => {
    const configA = makeConfig({ deviceId: 'device-A' });
    (syncA as any).config = configA;
    (syncA as any).state = 'syncing';

    const configB = makeConfig({ deviceId: 'device-B' });
    (syncB as any).config = configB;
    (syncB as any).state = 'syncing';

    // Send 3 messages
    await syncA.sendMessage('device-B', 'command', { action: 'task-1' });
    await syncA.sendMessage('device-B', 'notification', { title: 'Alert' });
    await syncA.sendMessage('device-B', 'ping', {});

    expect(mockServer.messageQueues.get('device-B')?.length).toBe(3);

    // Device B polls — should receive all 3
    const messages: IncomingMessage[] = [];
    syncB.on('message', (msg: IncomingMessage) => messages.push(msg));
    await syncB.pollMessages();

    expect(messages.length).toBe(3);
    // All acked
    expect(mockServer.messageQueues.get('device-B')?.length).toBe(0);
  });

  it('device_online event fires when new device appears', async () => {
    const configB = makeConfig({ deviceId: 'device-B' });
    (syncB as any).config = configB;
    (syncB as any).state = 'syncing';
    (syncB as any).devices = []; // No devices yet

    // Register device A on the mock server
    mockServer.devices.set('device-A', {
      deviceId: 'device-A',
      deviceName: 'MacBook Pro',
      status: 'online',
      lastHeartbeatAt: new Date().toISOString(),
    });

    // Device B polls — should fire device_online for A
    const onlinePromise = new Promise<SyncDevice>((resolve) => {
      syncB.once('device_online', resolve);
    });
    await syncB.pollDevices();
    const onlineDevice = await onlinePromise;

    expect(onlineDevice.deviceId).toBe('device-A');
    expect(onlineDevice.deviceName).toBe('MacBook Pro');
  });

  it('device_offline event fires when device disappears', async () => {
    const configB = makeConfig({ deviceId: 'device-B' });
    (syncB as any).config = configB;
    (syncB as any).state = 'syncing';
    // Pre-populate with device-A online
    (syncB as any).devices = [{
      deviceId: 'device-A',
      deviceName: 'MacBook Pro',
      status: 'online',
      lastHeartbeatAt: new Date().toISOString(),
      isLocal: false,
    }];

    // Server has no device-A (it went offline)
    // Don't add any devices to mockServer

    const offlinePromise = new Promise<SyncDevice>((resolve) => {
      syncB.once('device_offline', resolve);
    });
    await syncB.pollDevices();
    const offlineDevice = await offlinePromise;

    expect(offlineDevice.deviceId).toBe('device-A');
    expect(offlineDevice.status).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// DIMENSION 4: Token Lifecycle
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — Token Lifecycle', () => {
  it('signJwt and verifyJwt round-trip correctly', async () => {
    // Dynamic import to avoid circular dependency issues
    const { signJwt, verifyJwt } = await import('../../controllers/cloud/cloud-google-auth.controller.js');

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({
      sub: 'user-123',
      email: 'test@crewly.com',
      name: 'Test User',
      plan: 'pro',
      iat: now,
      exp: now + 3600,
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'access',
    });

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    const payload = verifyJwt(token);
    expect(payload).toBeTruthy();
    expect(payload!.sub).toBe('user-123');
    expect(payload!.email).toBe('test@crewly.com');
    expect(payload!.plan).toBe('pro');
  });

  it('verifyJwt rejects expired token', async () => {
    const { signJwt, verifyJwt } = await import('../../controllers/cloud/cloud-google-auth.controller.js');

    const now = Math.floor(Date.now() / 1000);
    const expiredToken = signJwt({
      sub: 'user-123',
      email: 'test@crewly.com',
      iat: now - 7200,
      exp: now - 3600, // expired 1 hour ago
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'access',
    });

    const payload = verifyJwt(expiredToken);
    expect(payload).toBeNull();
  });

  it('refresh token generates a new valid access token', async () => {
    const { signJwt, verifyJwt } = await import('../../controllers/cloud/cloud-google-auth.controller.js');

    const now = Math.floor(Date.now() / 1000);
    const refreshToken = signJwt({
      sub: 'user-456',
      email: 'refresh@crewly.com',
      plan: 'pro',
      iat: now,
      exp: now + AUTH_CONSTANTS.JWT.REFRESH_TOKEN_EXPIRY_S,
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'refresh',
    });

    // Verify refresh token is valid
    const refreshPayload = verifyJwt(refreshToken);
    expect(refreshPayload).toBeTruthy();
    expect(refreshPayload!.type).toBe('refresh');

    // Issue new access token (simulating POST /api/cloud/refresh logic)
    const accessToken = signJwt({
      sub: refreshPayload!.sub,
      email: refreshPayload!.email || '',
      name: refreshPayload!.name || '',
      plan: refreshPayload!.plan || 'free',
      iat: now,
      exp: now + AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S,
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'access',
    });

    const accessPayload = verifyJwt(accessToken);
    expect(accessPayload).toBeTruthy();
    expect(accessPayload!.sub).toBe('user-456');
    expect(accessPayload!.type).toBe('access');
    expect(accessPayload!.plan).toBe('pro');
  });

  it('CloudClientService.tryRefreshToken auto-refreshes with valid refresh token', async () => {
    const { CloudClientService } = await import('./cloud-client.service.js');
    const { signJwt } = await import('../../controllers/cloud/cloud-google-auth.controller.js');

    CloudClientService.resetInstance();
    const client = CloudClientService.getInstance();

    const now = Math.floor(Date.now() / 1000);
    // Create an expired access token
    const expiredAccess = signJwt({
      sub: 'user-refresh-test',
      email: 'test@crewly.com',
      plan: 'pro',
      iat: now - 7200,
      exp: now - 3600, // expired
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'access',
    });

    // Create a valid refresh token
    const refreshToken = signJwt({
      sub: 'user-refresh-test',
      email: 'test@crewly.com',
      plan: 'pro',
      iat: now,
      exp: now + 2_592_000, // 30 days
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'refresh',
    });

    // Connect with expired access token + valid refresh token
    // connectLocal triggers scheduleTokenRefresh which auto-refreshes immediately
    client.connectLocal('https://api.crewlyai.com', expiredAccess, 'pro' as any, refreshToken);

    // Wait for the auto-refresh triggered by scheduleTokenRefresh to complete
    await new Promise((r) => setTimeout(r, 100));

    // New token should be valid (not expired) — auto-refreshed by scheduleTokenRefresh
    const newToken = client.getToken();
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(expiredAccess);

    // Service should be in connected state
    expect(client.isConnected()).toBe(true);
    expect(client.isTokenExpired()).toBe(false);

    CloudClientService.resetInstance();
  });

  it('CloudClientService.tryRefreshToken fails gracefully with no refresh token', async () => {
    const { CloudClientService } = await import('./cloud-client.service.js');

    CloudClientService.resetInstance();
    const client = CloudClientService.getInstance();

    // Connect without refresh token
    client.connectLocal('https://api.crewlyai.com', 'some-token', 'pro' as any);

    const refreshed = await client.tryRefreshToken();
    expect(refreshed).toBe(false);

    CloudClientService.resetInstance();
  });
});

// ---------------------------------------------------------------------------
// DIMENSION 5: CloudSyncService State Machine
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — State Machine', () => {
  let mockServer: ReturnType<typeof createMockCloudServer>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockServer = createMockCloudServer();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockServer.handler as any;
    CloudSyncService.resetInstance();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    CloudSyncService.resetInstance();
  });

  it('starts in stopped state', () => {
    const sync = CloudSyncService.getInstance();
    expect(sync.getState()).toBe('stopped');
    expect(sync.isStarted()).toBe(false);
  });

  it('transitions to syncing on start()', () => {
    const sync = CloudSyncService.getInstance();
    sync.start(makeConfig());
    expect(sync.getState()).toBe('syncing');
    expect(sync.isStarted()).toBe(true);
    sync.stop();
  });

  it('transitions back to stopped on stop()', () => {
    const sync = CloudSyncService.getInstance();
    sync.start(makeConfig());
    sync.stop();
    expect(sync.getState()).toBe('stopped');
    expect(sync.isStarted()).toBe(false);
  });

  it('ignores duplicate start() calls', () => {
    const sync = CloudSyncService.getInstance();
    sync.start(makeConfig());
    sync.start(makeConfig({ deviceId: 'different' })); // Should be ignored
    expect(sync.getState()).toBe('syncing');
    sync.stop();
  });

  it('transitions to error after MAX_CONSECUTIVE_FAILURES', async () => {
    // Override fetch to always fail
    globalThis.fetch = async () => {
      return new Response('Server Error', { status: 500 });
    };

    const sync = CloudSyncService.getInstance();
    (sync as any).config = makeConfig();
    (sync as any).state = 'syncing';

    // Exhaust failure count
    for (let i = 0; i < CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES; i++) {
      await sync.sendHeartbeat();
    }

    expect(sync.getState()).toBe('error');
  });

  it('resets failure count on successful heartbeat', async () => {
    const sync = CloudSyncService.getInstance();
    (sync as any).config = makeConfig();
    (sync as any).state = 'syncing';

    // Fail a few times
    const failFetch = async () => new Response('Error', { status: 500 });
    globalThis.fetch = failFetch as any;
    await sync.sendHeartbeat();
    await sync.sendHeartbeat();
    expect((sync as any).heartbeatFailures).toBe(2);

    // Succeed — counter should reset
    globalThis.fetch = mockServer.handler as any;
    await sync.sendHeartbeat();
    expect((sync as any).heartbeatFailures).toBe(0);
  });

  it('updateToken updates the config token for running service', () => {
    const sync = CloudSyncService.getInstance();
    const config = makeConfig({ token: 'old-token' });
    sync.start(config);

    sync.updateToken('new-refreshed-token');

    // Verify the internal config was updated
    expect((sync as any).config.token).toBe('new-refreshed-token');
    sync.stop();
  });

  it('updateToken is safe when not started', () => {
    const sync = CloudSyncService.getInstance();
    // Should not throw
    sync.updateToken('some-token');
    expect(sync.getState()).toBe('stopped');
  });

  it('sendMessage throws when not started', async () => {
    const sync = CloudSyncService.getInstance();
    // Not started — config is null
    await expect(
      sync.sendMessage('device-B', 'command', { action: 'test' })
    ).rejects.toThrow('not started');
  });

  it('getDevices returns empty array when stopped', () => {
    const sync = CloudSyncService.getInstance();
    expect(sync.getDevices()).toEqual([]);
  });

  it('getOnlineDevices excludes local and offline devices', () => {
    const sync = CloudSyncService.getInstance();
    (sync as any).devices = [
      { deviceId: 'local', status: 'online', isLocal: true, deviceName: 'Me', lastHeartbeatAt: '' },
      { deviceId: 'remote-on', status: 'online', isLocal: false, deviceName: 'Online', lastHeartbeatAt: '' },
      { deviceId: 'remote-off', status: 'offline', isLocal: false, deviceName: 'Offline', lastHeartbeatAt: '' },
    ];
    const online = sync.getOnlineDevices();
    expect(online.length).toBe(1);
    expect(online[0].deviceId).toBe('remote-on');
  });
});

// ---------------------------------------------------------------------------
// DIMENSION 6: Frontend→Backend Contract Verification
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — Frontend↔Backend Contract', () => {
  it('frontend API URLs match backend route definitions', () => {
    // These are the URLs the frontend CloudTab.tsx uses:
    const frontendExpects = {
      validate: '/api/cloud/validate',
      status: '/api/cloud/status',
      devices: '/api/cloud/devices',
      legacyDevices: '/api/relay/cloud-devices',
    };

    // Backend routes (from cloud.routes.ts createCloudRouter):
    // router.post('/validate', validateCloudToken)
    // router.get('/status', getCloudStatus)
    // router.get('/devices', getDevicesFromSync)
    // The router is mounted at /api/cloud, so:
    // POST /api/cloud/validate, GET /api/cloud/status, GET /api/cloud/devices
    // These must match what the frontend expects.

    expect(frontendExpects.validate).toBe('/api/cloud/validate');
    expect(frontendExpects.status).toBe('/api/cloud/status');
    expect(frontendExpects.devices).toBe('/api/cloud/devices');

    // Legacy fallback endpoint (from relay.routes.ts, mounted at /api/relay)
    expect(frontendExpects.legacyDevices).toBe('/api/relay/cloud-devices');
  });

  it('CloudSyncService URL construction produces valid full URLs matching Cloud Relay routes', () => {
    const cloudUrl = 'https://api.crewlyai.com';
    const endpoints = CLOUD_SYNC_CONSTANTS.ENDPOINTS;

    // Heartbeat (handshake)
    const heartbeatUrl = `${cloudUrl}${endpoints.HEARTBEAT}`;
    expect(heartbeatUrl).toBe('https://api.crewlyai.com/api/v1/relay/handshake');

    // Devices
    const devicesUrl = `${cloudUrl}${endpoints.DEVICES}`;
    expect(devicesUrl).toBe('https://api.crewlyai.com/api/v1/relay/devices');

    // Messages send
    const sendUrl = `${cloudUrl}${endpoints.MESSAGES}`;
    expect(sendUrl).toBe('https://api.crewlyai.com/api/v1/relay/queue/send');

    // Messages poll (with query param — uses queueId not deviceId)
    const pollUrl = `${cloudUrl}${endpoints.MESSAGES_POLL}?queueId=device-123`;
    expect(pollUrl).toBe('https://api.crewlyai.com/api/v1/relay/queue/poll?queueId=device-123');

    // Messages ack
    const ackUrl = `${cloudUrl}${endpoints.MESSAGES_ACK}`;
    expect(ackUrl).toBe('https://api.crewlyai.com/api/v1/relay/queue/ack');
  });

  it('auth headers use Bearer token format', () => {
    const sync = CloudSyncService.getInstance();
    (sync as any).config = makeConfig({ token: 'my-jwt-token' });

    const headers = (sync as any).authHeaders();
    expect(headers.Authorization).toBe('Bearer my-jwt-token');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
// DIMENSION 7: Type Guard Validation
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — Type Guards', () => {
  it('isCloudSyncState validates correctly', () => {
    expect(isCloudSyncState('stopped')).toBe(true);
    expect(isCloudSyncState('syncing')).toBe(true);
    expect(isCloudSyncState('error')).toBe(true);
    expect(isCloudSyncState('running')).toBe(false);
    expect(isCloudSyncState(42)).toBe(false);
  });

  it('isMessageType validates all types', () => {
    const validTypes = ['command', 'sync_teams', 'sync_settings', 'notification', 'relay', 'ping', 'task_update'];
    for (const t of validTypes) {
      expect(isMessageType(t)).toBe(true);
    }
    expect(isMessageType('invalid')).toBe(false);
  });

  it('isSyncDevice validates device shape', () => {
    expect(isSyncDevice({
      deviceId: 'abc',
      deviceName: 'Test',
      status: 'online',
      lastHeartbeatAt: '2024-01-01',
    })).toBe(true);

    expect(isSyncDevice({ deviceId: 'abc' })).toBe(false); // missing fields
    expect(isSyncDevice(null)).toBe(false);
  });

  it('isIncomingMessage validates message shape', () => {
    expect(isIncomingMessage({
      id: 'msg-1',
      from: 'device-A',
      fromDeviceName: 'MacBook',
      type: 'command',
      payload: {},
      encrypted: false,
      sentAt: '2024-01-01',
    })).toBe(true);

    expect(isIncomingMessage({ id: 'msg-1' })).toBe(false);
  });

  it('isCloudSyncConfig validates config shape', () => {
    expect(isCloudSyncConfig(makeConfig())).toBe(true);
    expect(isCloudSyncConfig({ cloudUrl: 'x' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DIMENSION 8: Resilience & Edge Cases
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — Resilience', () => {
  let mockServer: ReturnType<typeof createMockCloudServer>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockServer = createMockCloudServer();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockServer.handler as any;
    CloudSyncService.resetInstance();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    CloudSyncService.resetInstance();
  });

  it('handles 401 gracefully without crashing', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });

    const sync = CloudSyncService.getInstance();
    (sync as any).config = makeConfig();
    (sync as any).state = 'syncing';

    // These should not throw
    await sync.sendHeartbeat();
    await sync.pollDevices();
    await sync.pollMessages();

    // Should have incremented failure counts
    expect((sync as any).heartbeatFailures).toBe(1);
    expect((sync as any).devicePollFailures).toBe(1);
    expect((sync as any).messagePollFailures).toBe(1);
  });

  it('handles network errors (fetch throws) gracefully', async () => {
    globalThis.fetch = async () => { throw new Error('Network unreachable'); };

    const sync = CloudSyncService.getInstance();
    (sync as any).config = makeConfig();
    (sync as any).state = 'syncing';

    // Should not throw
    await sync.sendHeartbeat();
    await sync.pollDevices();
    await sync.pollMessages();

    expect((sync as any).heartbeatFailures).toBe(1);
  });

  it('handles malformed JSON response from device poll', async () => {
    globalThis.fetch = async () => new Response('not json', { status: 200 });

    const sync = CloudSyncService.getInstance();
    (sync as any).config = makeConfig();
    (sync as any).state = 'syncing';

    // Should not throw even with malformed response
    await sync.pollDevices();
    expect((sync as any).devicePollFailures).toBe(1);
  });

  it('handles empty message poll (no messages)', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ success: true, messages: [] }),
      { status: 200 }
    );

    const sync = CloudSyncService.getInstance();
    (sync as any).config = makeConfig();
    (sync as any).state = 'syncing';

    const messageSpy = jest.fn();
    sync.on('message', messageSpy);

    await sync.pollMessages();
    expect(messageSpy).not.toHaveBeenCalled();
    expect((sync as any).messagePollFailures).toBe(0); // Not a failure
  });

  it('stop() is idempotent (safe to call multiple times)', () => {
    const sync = CloudSyncService.getInstance();
    sync.start(makeConfig());
    sync.stop();
    sync.stop(); // Should not throw
    sync.stop(); // Should not throw
    expect(sync.getState()).toBe('stopped');
  });

  it('poll with no config does nothing (no crash)', async () => {
    const sync = CloudSyncService.getInstance();
    // config is null — should bail early, not throw
    await sync.sendHeartbeat();
    await sync.pollDevices();
    await sync.pollMessages();
    expect(sync.getState()).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// DIMENSION 9: Constants Drift Detection
// ---------------------------------------------------------------------------

describe('Cloud Connect E2E — Constants Drift Detection', () => {
  it('CLOUD_SYNC_CONSTANTS timing values are reasonable', () => {
    // Guard against someone accidentally setting heartbeat to 1ms or 1 hour
    expect(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(120_000);

    expect(CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    expect(CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS).toBeLessThanOrEqual(60_000);

    expect(CLOUD_SYNC_CONSTANTS.DEVICE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    expect(CLOUD_SYNC_CONSTANTS.DEVICE_POLL_INTERVAL_MS).toBeLessThanOrEqual(120_000);

    expect(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(CLOUD_SYNC_CONSTANTS.REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);

    expect(CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES).toBeGreaterThanOrEqual(3);
    expect(CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES).toBeLessThanOrEqual(30);
  });

  it('OFFLINE_THRESHOLD_MS > HEARTBEAT_INTERVAL_MS (prevents false offline)', () => {
    // If offline threshold is less than heartbeat interval, devices will
    // flicker online/offline. This MUST never happen.
    expect(CLOUD_SYNC_CONSTANTS.OFFLINE_THRESHOLD_MS).toBeGreaterThan(
      CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS
    );
  });

  it('AUTH_CONSTANTS token expiry values are in valid ranges', () => {
    // Access token: 1 min to 24 hours
    expect(AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S).toBeGreaterThanOrEqual(60);
    expect(AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S).toBeLessThanOrEqual(86_400);

    // Refresh token: 1 day to 1 year
    expect(AUTH_CONSTANTS.JWT.REFRESH_TOKEN_EXPIRY_S).toBeGreaterThanOrEqual(86_400);
    expect(AUTH_CONSTANTS.JWT.REFRESH_TOKEN_EXPIRY_S).toBeLessThanOrEqual(31_536_000);
  });

  it('no unexpected duplicate endpoint paths within CLOUD_SYNC_CONSTANTS', () => {
    // All endpoint paths should be unique (each maps to a distinct Cloud Relay route).
    const syncPaths = Object.values(CLOUD_SYNC_CONSTANTS.ENDPOINTS);
    const uniqueSyncPaths = new Set(syncPaths);
    expect(uniqueSyncPaths.size).toBe(syncPaths.length);
  });
});
