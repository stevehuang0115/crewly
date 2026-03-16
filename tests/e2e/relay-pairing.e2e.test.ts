/**
 * Cloud Relay E2E Pairing Tests
 *
 * End-to-end tests for the full Cloud Relay pairing flow, covering:
 * - Connection initiation (generate code → connect orchestrator → connect agent)
 * - Device listing
 * - Disconnect flow
 * - State validation at each step
 *
 * These tests mock the RelayClientService singleton to avoid requiring
 * a live WebSocket relay server, while exercising the full controller
 * and route stack with real HTTP calls via supertest.
 *
 * @module tests/e2e/relay-pairing.e2e.test
 */

import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mock cloud-auth middleware (relay routes require cloud connection + pro tier)
// ---------------------------------------------------------------------------
jest.mock('../../backend/src/services/cloud/cloud-auth.middleware.js', () => ({
  requireCloudConnection: (_req: any, _res: any, next: any) => next(),
  requireTier: () => (_req: any, _res: any, next: any) => next(),
  isCloudConnected: () => true,
}));

// ---------------------------------------------------------------------------
// Mock RelayClientService singleton
// ---------------------------------------------------------------------------
let mockState: string = 'disconnected';
let mockSessionId: string | null = null;

const mockRelayClient = {
  getState: jest.fn<any>(() => mockState),
  getSessionId: jest.fn<any>(() => mockSessionId),
  connect: jest.fn<any>((config: any) => {
    mockState = 'connecting';
    mockSessionId = `session-${Date.now()}`;
  }),
  disconnect: jest.fn<any>(() => {
    mockState = 'disconnected';
    mockSessionId = null;
  }),
  send: jest.fn<any>(),
};

jest.mock('../../backend/src/services/cloud/relay-client.service.js', () => ({
  RelayClientService: {
    getInstance: () => mockRelayClient,
  },
}));

// Mock LoggerService
jest.mock('../../backend/src/services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import relay routes after mocks are set up
// ---------------------------------------------------------------------------
import { createRelayRouter } from '../../backend/src/controllers/cloud/relay.routes';

// ---------------------------------------------------------------------------
// Test App Setup
// ---------------------------------------------------------------------------

/**
 * Create a minimal Express app with relay routes mounted for testing.
 *
 * @returns Express application configured with relay routes
 */
function createTestApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/relay', createRelayRouter());
  return app;
}

// ---------------------------------------------------------------------------
// Valid request payloads
// ---------------------------------------------------------------------------

/** Valid connect payload for an orchestrator node */
const ORCHESTRATOR_CONNECT_PAYLOAD = {
  wsUrl: 'wss://relay.crewlyai.com/ws',
  pairingCode: 'ABC123',
  role: 'orchestrator',
  token: 'cloud-auth-token-123',
  sharedSecret: 'e2e-shared-secret-456',
};

/** Valid connect payload for an agent node */
const AGENT_CONNECT_PAYLOAD = {
  wsUrl: 'wss://relay.crewlyai.com/ws',
  pairingCode: 'ABC123',
  role: 'agent',
  token: 'cloud-auth-token-789',
  sharedSecret: 'e2e-shared-secret-456',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cloud Relay E2E Pairing Flow', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockState = 'disconnected';
    mockSessionId = null;
    app = createTestApp();
  });

  describe('Full Pairing Lifecycle', () => {
    it('should complete the full connect → pair → disconnect lifecycle', async () => {
      // Step 1: Verify initial state — disconnected
      const devicesBeforeConnect = await request(app)
        .get('/api/relay/devices')
        .expect(200);

      expect(devicesBeforeConnect.body.success).toBe(true);
      expect(devicesBeforeConnect.body.data.client.state).toBe('disconnected');
      expect(devicesBeforeConnect.body.data.client.sessionId).toBeNull();

      // Step 2: Connect as orchestrator
      const connectRes = await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      expect(connectRes.body.success).toBe(true);
      expect(connectRes.body.data.message).toBe('Relay client connection initiated');
      expect(mockRelayClient.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          wsUrl: ORCHESTRATOR_CONNECT_PAYLOAD.wsUrl,
          pairingCode: ORCHESTRATOR_CONNECT_PAYLOAD.pairingCode,
          role: 'orchestrator',
        }),
      );

      // Step 3: Verify connected state via devices
      const devicesAfterConnect = await request(app)
        .get('/api/relay/devices')
        .expect(200);

      expect(devicesAfterConnect.body.success).toBe(true);
      expect(devicesAfterConnect.body.data.client.state).toBe('connecting');
      expect(devicesAfterConnect.body.data.client.sessionId).toBeTruthy();

      // Step 4: Simulate server pairing (set state to paired)
      mockState = 'paired';

      const devicesAfterPair = await request(app)
        .get('/api/relay/devices')
        .expect(200);

      expect(devicesAfterPair.body.data.client.state).toBe('paired');

      // Step 5: Disconnect
      const disconnectRes = await request(app)
        .post('/api/relay/disconnect')
        .expect(200);

      expect(disconnectRes.body.success).toBe(true);
      expect(disconnectRes.body.data.previousState).toBe('paired');
      expect(disconnectRes.body.data.state).toBe('disconnected');
      expect(mockRelayClient.disconnect).toHaveBeenCalled();

      // Step 6: Verify disconnected state
      const devicesAfterDisconnect = await request(app)
        .get('/api/relay/devices')
        .expect(200);

      expect(devicesAfterDisconnect.body.data.client.state).toBe('disconnected');
    });
  });

  describe('Connect Endpoint', () => {
    it('should reject connection with missing parameters', async () => {
      const res = await request(app)
        .post('/api/relay/connect')
        .send({ wsUrl: 'wss://relay.test/ws' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required parameters');
    });

    it('should reject connection with invalid role', async () => {
      const res = await request(app)
        .post('/api/relay/connect')
        .send({ ...ORCHESTRATOR_CONNECT_PAYLOAD, role: 'invalid' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid role');
    });

    it('should reject double connection (already connected)', async () => {
      // First connect
      await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      // Second connect should fail with 409
      const res = await request(app)
        .post('/api/relay/connect')
        .send(AGENT_CONNECT_PAYLOAD)
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('already in');
    });

    it('should accept agent role connection', async () => {
      const res = await request(app)
        .post('/api/relay/connect')
        .send(AGENT_CONNECT_PAYLOAD)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockRelayClient.connect).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'agent' }),
      );
    });

    it('should allow reconnection after disconnect', async () => {
      // Connect
      await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      // Disconnect
      await request(app)
        .post('/api/relay/disconnect')
        .expect(200);

      // Reconnect should succeed
      const res = await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should allow connection from error state', async () => {
      mockState = 'error';

      const res = await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  describe('Disconnect Endpoint', () => {
    it('should disconnect cleanly when connected', async () => {
      // Connect first
      await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      const res = await request(app)
        .post('/api/relay/disconnect')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.state).toBe('disconnected');
      expect(res.body.data.message).toBe('Relay client disconnected');
    });

    it('should handle disconnect when already disconnected', async () => {
      const res = await request(app)
        .post('/api/relay/disconnect')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.previousState).toBe('disconnected');
    });
  });

  describe('Devices Endpoint', () => {
    it('should return client state and session info', async () => {
      const res = await request(app)
        .get('/api/relay/devices')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('client');
      expect(res.body.data.client).toHaveProperty('state');
      expect(res.body.data.client).toHaveProperty('sessionId');
    });

    it('should reflect state changes after connect', async () => {
      // Initially disconnected
      let res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('disconnected');

      // After connect
      await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('connecting');
      expect(res.body.data.client.sessionId).toBeTruthy();
    });
  });

  describe('Send Endpoint', () => {
    it('should send a message when paired', async () => {
      // Simulate paired state
      mockState = 'paired';
      mockSessionId = 'session-paired';

      const res = await request(app)
        .post('/api/relay/send')
        .send({ message: 'Hello from orchestrator' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.sent).toBe(true);
      expect(res.body.data.messageLength).toBe('Hello from orchestrator'.length);
      expect(mockRelayClient.send).toHaveBeenCalledWith('Hello from orchestrator');
    });

    it('should reject send when not paired', async () => {
      mockState = 'connecting';

      const res = await request(app)
        .post('/api/relay/send')
        .send({ message: 'Test' })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('must be "paired"');
    });

    it('should reject send with empty message', async () => {
      mockState = 'paired';

      const res = await request(app)
        .post('/api/relay/send')
        .send({ message: '' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing or empty');
    });

    it('should reject send with no message field', async () => {
      mockState = 'paired';

      const res = await request(app)
        .post('/api/relay/send')
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });

  describe('State Transitions', () => {
    it('should track the full state machine: disconnected → connecting → registered → paired → disconnected', async () => {
      // disconnected
      let res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('disconnected');

      // → connecting
      await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('connecting');

      // → registered (simulated)
      mockState = 'registered';
      res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('registered');

      // → paired (simulated)
      mockState = 'paired';
      res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('paired');

      // → disconnected
      await request(app).post('/api/relay/disconnect').expect(200);

      res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('disconnected');
    });

    it('should handle error state recovery', async () => {
      // Simulate error state
      mockState = 'error';

      let res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('error');

      // Should be able to connect from error state
      await request(app)
        .post('/api/relay/connect')
        .send(ORCHESTRATOR_CONNECT_PAYLOAD)
        .expect(200);

      res = await request(app).get('/api/relay/devices').expect(200);
      expect(res.body.data.client.state).toBe('connecting');
    });
  });
});
