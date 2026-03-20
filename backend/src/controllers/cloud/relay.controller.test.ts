/**
 * Tests for Relay Controller (Client-side only)
 *
 * Tests client-side relay endpoints: connect, disconnect, devices, send.
 *
 * @module controllers/cloud/relay.controller.test
 */

import type { Request, Response, NextFunction } from 'express';
import {
  connectToRelay,
  disconnectFromRelay,
  getRelayDevices,
  getCloudDevices,
  sendRelayMessage,
} from './relay.controller.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockClientConnect = jest.fn();
const mockClientDisconnect = jest.fn();
const mockClientSend = jest.fn();
const mockClientGetState = jest.fn();
const mockClientGetSessionId = jest.fn();

jest.mock('../../services/cloud/relay-client.service.js', () => ({
  RelayClientService: {
    getInstance: () => ({
      connect: mockClientConnect,
      disconnect: mockClientDisconnect,
      send: mockClientSend,
      getState: mockClientGetState,
      getSessionId: mockClientGetSessionId,
    }),
  },
}));

const mockFetchCloudDevices = jest.fn();
const mockIsConnected = jest.fn();
const mockIsTokenExpired = jest.fn().mockReturnValue(false);

jest.mock('../../services/cloud/cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      fetchCloudDevices: mockFetchCloudDevices,
      isConnected: mockIsConnected,
      isTokenExpired: mockIsTokenExpired,
    }),
  },
}));

jest.mock('../../services/core/logger.service.js', () => ({
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
// Helpers
// ---------------------------------------------------------------------------

function mockReq(body: Record<string, unknown> = {}): Request {
  return {
    body,
    secure: false,
    get: jest.fn().mockReturnValue('localhost:3000'),
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Relay Controller', () => {
  const next: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTokenExpired.mockReturnValue(false);
  });

  // -----------------------------------------------------------------------
  // POST /relay/connect
  // -----------------------------------------------------------------------

  describe('connectToRelay', () => {
    const validBody = {
      apiUrl: 'https://relay.example.com',
      pairingCode: 'test-pair',
      role: 'agent',
      token: 'tok-123',
      sharedSecret: 'my-secret',
    };

    it('should return 400 when apiUrl is missing', async () => {
      const req = mockReq({ ...validBody, apiUrl: undefined });
      const res = mockRes();

      await connectToRelay(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('apiUrl') }),
      );
    });

    it('should return 400 when pairingCode is missing', async () => {
      const req = mockReq({ ...validBody, pairingCode: undefined });
      const res = mockRes();

      await connectToRelay(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when token is missing', async () => {
      const req = mockReq({ ...validBody, token: undefined });
      const res = mockRes();

      await connectToRelay(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when sharedSecret is missing', async () => {
      const req = mockReq({ ...validBody, sharedSecret: undefined });
      const res = mockRes();

      await connectToRelay(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for invalid role', async () => {
      const req = mockReq({ ...validBody, role: 'invalid-role' });
      const res = mockRes();

      await connectToRelay(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Invalid role') }),
      );
    });

    it('should return 409 when client is already connected', async () => {
      const req = mockReq(validBody);
      const res = mockRes();
      mockClientGetState.mockReturnValue('registered');

      await connectToRelay(req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('registered') }),
      );
    });

    it('should return 409 when client is paired', async () => {
      const req = mockReq(validBody);
      const res = mockRes();
      mockClientGetState.mockReturnValue('paired');

      await connectToRelay(req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('should connect successfully from disconnected state', async () => {
      const req = mockReq(validBody);
      const res = mockRes();
      mockClientGetState.mockReturnValue('disconnected');

      await connectToRelay(req, res, next);
      expect(mockClientConnect).toHaveBeenCalledWith({
        apiUrl: validBody.apiUrl,
        pairingCode: validBody.pairingCode,
        role: validBody.role,
        token: validBody.token,
        sharedSecret: validBody.sharedSecret,
      });
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ message: expect.stringContaining('initiated') }),
        }),
      );
    });

    it('should connect successfully from error state', async () => {
      const req = mockReq(validBody);
      const res = mockRes();
      mockClientGetState.mockReturnValue('error');

      await connectToRelay(req, res, next);
      expect(mockClientConnect).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // POST /relay/disconnect
  // -----------------------------------------------------------------------

  describe('disconnectFromRelay', () => {
    it('should disconnect and return previous state', async () => {
      const req = mockReq();
      const res = mockRes();
      mockClientGetState
        .mockReturnValueOnce('paired')     // previousState
        .mockReturnValueOnce('disconnected'); // after disconnect

      await disconnectFromRelay(req, res, next);
      expect(mockClientDisconnect).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          previousState: 'paired',
          state: 'disconnected',
          message: 'Relay client disconnected',
        },
      });
    });

    it('should handle disconnecting when already disconnected', async () => {
      const req = mockReq();
      const res = mockRes();
      mockClientGetState.mockReturnValue('disconnected');

      await disconnectFromRelay(req, res, next);
      expect(mockClientDisconnect).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // GET /relay/devices
  // -----------------------------------------------------------------------

  describe('getRelayDevices', () => {
    it('should return client info', async () => {
      const req = mockReq();
      const res = mockRes();
      mockClientGetState.mockReturnValue('paired');
      mockClientGetSessionId.mockReturnValue('client-sess-1');

      await getRelayDevices(req, res, next);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            client: { state: 'paired', sessionId: 'client-sess-1' },
          }),
        }),
      );
    });

    it('should return client info when disconnected', async () => {
      const req = mockReq();
      const res = mockRes();
      mockClientGetState.mockReturnValue('disconnected');
      mockClientGetSessionId.mockReturnValue(null);

      await getRelayDevices(req, res, next);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            client: { state: 'disconnected', sessionId: null },
          }),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // POST /relay/send
  // -----------------------------------------------------------------------

  describe('sendRelayMessage', () => {
    it('should return 400 when message is missing', async () => {
      const req = mockReq({});
      const res = mockRes();

      await sendRelayMessage(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('message') }),
      );
    });

    it('should return 400 when message is empty string', async () => {
      const req = mockReq({ message: '' });
      const res = mockRes();

      await sendRelayMessage(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when message is not a string', async () => {
      const req = mockReq({ message: 123 });
      const res = mockRes();

      await sendRelayMessage(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 409 when client is not paired', async () => {
      const req = mockReq({ message: 'hello' });
      const res = mockRes();
      mockClientGetState.mockReturnValue('registered');

      await sendRelayMessage(req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('registered') }),
      );
    });

    it('should return 409 when client is disconnected', async () => {
      const req = mockReq({ message: 'hello' });
      const res = mockRes();
      mockClientGetState.mockReturnValue('disconnected');

      await sendRelayMessage(req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('should send message successfully when paired', async () => {
      const req = mockReq({ message: 'hello relay!' });
      const res = mockRes();
      mockClientGetState.mockReturnValue('paired');

      await sendRelayMessage(req, res, next);
      expect(mockClientSend).toHaveBeenCalledWith('hello relay!');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          sent: true,
          messageLength: 12,
        },
      });
    });

    it('should call next on unexpected errors', async () => {
      const req = mockReq({ message: 'hello' });
      const res = mockRes();
      mockClientGetState.mockReturnValue('paired');
      mockClientSend.mockImplementation(() => {
        throw new Error('Encryption key not derived');
      });

      await sendRelayMessage(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  // -----------------------------------------------------------------------
  // GET /relay/cloud-devices
  // -----------------------------------------------------------------------

  describe('getCloudDevices', () => {
    it('should return device list from cloud', async () => {
      const req = mockReq();
      const res = mockRes();
      const devices = [
        { sessionId: 'dev-1', role: 'orchestrator', state: 'paired', pairedWith: 'dev-2', registeredAt: '2026-01-01', lastHeartbeatAt: '2026-01-01', name: 'MacBook' },
        { sessionId: 'dev-2', role: 'agent', state: 'paired', pairedWith: 'dev-1', registeredAt: '2026-01-01', lastHeartbeatAt: '2026-01-01', name: 'Server' },
      ];
      mockIsConnected.mockReturnValue(true);
      mockFetchCloudDevices.mockResolvedValue(devices);
      mockClientGetSessionId.mockReturnValue('dev-1');

      await getCloudDevices(req, res, next);

      expect(mockFetchCloudDevices).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          devices: [
            { ...devices[0], isLocal: true },
            { ...devices[1], isLocal: false },
          ],
          localSessionId: 'dev-1',
        },
      });
    });

    it('should mark no device as local when relay client has no session', async () => {
      const req = mockReq();
      const res = mockRes();
      const devices = [
        { sessionId: 'dev-1', role: 'agent', state: 'waiting', pairedWith: null, registeredAt: '2026-01-01', lastHeartbeatAt: '2026-01-01' },
      ];
      mockIsConnected.mockReturnValue(true);
      mockFetchCloudDevices.mockResolvedValue(devices);
      mockClientGetSessionId.mockReturnValue(null);

      await getCloudDevices(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          devices: [{ ...devices[0], isLocal: false }],
          localSessionId: null,
        },
      });
    });

    it('should return empty list when not connected to cloud', async () => {
      const req = mockReq();
      const res = mockRes();
      mockIsConnected.mockReturnValue(false);

      await getCloudDevices(req, res, next);

      expect(mockFetchCloudDevices).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { devices: [], localSessionId: null },
      });
    });

    it('should return empty list when no devices', async () => {
      const req = mockReq();
      const res = mockRes();
      mockIsConnected.mockReturnValue(true);
      mockFetchCloudDevices.mockResolvedValue([]);
      mockClientGetSessionId.mockReturnValue(null);

      await getCloudDevices(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { devices: [], localSessionId: null },
      });
    });

    it('should return 502 on cloud fetch error', async () => {
      const req = mockReq();
      const res = mockRes();
      mockIsConnected.mockReturnValue(true);
      mockFetchCloudDevices.mockRejectedValue(new Error('Cloud unreachable'));

      await getCloudDevices(req, res, next);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Cloud unreachable'),
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return tokenExpired flag when not connected due to expired token', async () => {
      const req = mockReq();
      const res = mockRes();
      mockIsConnected.mockReturnValue(false);
      mockIsTokenExpired.mockReturnValue(true);

      await getCloudDevices(req, res, next);

      expect(mockFetchCloudDevices).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { devices: [], localSessionId: null, tokenExpired: true },
      });
    });

    it('should return tokenExpired flag when fetch triggers token expiry', async () => {
      const req = mockReq();
      const res = mockRes();
      mockIsConnected.mockReturnValue(true);
      mockFetchCloudDevices.mockResolvedValue([]);
      mockClientGetSessionId.mockReturnValue(null);
      // fetchCloudDevices internally sets token_expired; post-fetch check detects it
      mockIsTokenExpired.mockReturnValue(true);

      await getCloudDevices(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { devices: [], localSessionId: null, tokenExpired: true },
      });
    });
  });
});
