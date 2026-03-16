/**
 * Tests for Relay Server Service
 *
 * Tests WebSocket relay server lifecycle, registration, pairing,
 * message forwarding, heartbeat, and disconnection handling.
 *
 * @module services/cloud/relay-server.service.test
 */

import WebSocket from 'ws';
import { createServer, type Server as HttpServer } from 'http';
import { RelayServerService } from './relay-server.service.js';
import type {
  RelayRegisteredMessage,
  RelayPairedMessage,
  RelayErrorMessage,
  RelayHeartbeatAckMessage,
  RelayDataMessage,
  RelayPeerDisconnectedMessage,
  RelayMessage,
} from './relay.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../core/logger.service.js', () => ({
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

/** Wait for a WebSocket message of a specific type. */
function waitForMessage<T extends RelayMessage>(
  ws: WebSocket,
  expectedType: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for "${expectedType}" message`)),
      timeoutMs,
    );

    const handler = (data: WebSocket.RawData): void => {
      const msg = JSON.parse(data.toString()) as RelayMessage;
      if (msg.type === expectedType) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg as T);
      }
    };

    ws.on('message', handler);
  });
}

/** Create a WebSocket client connected to the test relay server. */
function createClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Send a typed message over a WebSocket. */
function sendMsg(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RelayServerService', () => {
  let server: RelayServerService;
  let httpServer: HttpServer;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach((done) => {
    RelayServerService.resetInstance();
    server = RelayServerService.getInstance();

    // Create an HTTP server on a random port
    httpServer = createServer();
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.start({ httpServer, path: '/relay' });
      done();
    });
  });

  afterEach(async () => {
    // Close all test clients
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    clients.length = 0;

    await server.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  it('should report running state after start', () => {
    expect(server.isRunning()).toBe(true);
  });

  it('should report not running after stop', async () => {
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('should handle double start gracefully', () => {
    // Second start should be a no-op
    server.start({ port: port + 1 });
    expect(server.isRunning()).toBe(true);
  });

  it('should handle stop when not running', async () => {
    await server.stop();
    await server.stop(); // Should not throw
    expect(server.isRunning()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  it('should register a client and return a sessionId', async () => {
    const ws = await createClient(port);
    clients.push(ws);

    sendMsg(ws, {
      type: 'register',
      role: 'agent',
      pairingCode: 'test-pair',
      token: 'tok-1',
    });

    const msg = await waitForMessage<RelayRegisteredMessage>(ws, 'registered');
    expect(msg.sessionId).toBeDefined();
    expect(typeof msg.sessionId).toBe('string');
    expect(server.getClientCount()).toBe(1);
  });

  it('should reject invalid JSON messages', async () => {
    const ws = await createClient(port);
    clients.push(ws);

    ws.send('not json');
    const msg = await waitForMessage<RelayErrorMessage>(ws, 'error');
    expect(msg.code).toBe('INVALID_JSON');
  });

  it('should reject messages with unknown type', async () => {
    const ws = await createClient(port);
    clients.push(ws);

    sendMsg(ws, { type: 'unknown_type' });
    const msg = await waitForMessage<RelayErrorMessage>(ws, 'error');
    expect(msg.code).toBe('INVALID_MESSAGE');
  });

  it('should reject relay messages before registration', async () => {
    const ws = await createClient(port);
    clients.push(ws);

    sendMsg(ws, { type: 'relay', payload: 'data' });
    const msg = await waitForMessage<RelayErrorMessage>(ws, 'error');
    expect(msg.code).toBe('NOT_REGISTERED');
  });

  // -----------------------------------------------------------------------
  // Pairing
  // -----------------------------------------------------------------------

  it('should pair two clients with the same pairing code and different roles', async () => {
    const ws1 = await createClient(port);
    const ws2 = await createClient(port);
    clients.push(ws1, ws2);

    // Register agent
    sendMsg(ws1, {
      type: 'register',
      role: 'agent',
      pairingCode: 'pair-1',
      token: 'tok-1',
    });
    await waitForMessage<RelayRegisteredMessage>(ws1, 'registered');

    // Set up ALL paired listeners BEFORE triggering pairing via ws2 registration
    const paired1Promise = waitForMessage<RelayPairedMessage>(ws1, 'paired');
    const paired2Promise = waitForMessage<RelayPairedMessage>(ws2, 'paired');

    // Register orchestrator — this triggers pairing immediately
    sendMsg(ws2, {
      type: 'register',
      role: 'orchestrator',
      pairingCode: 'pair-1',
      token: 'tok-2',
    });

    // Both should receive paired messages
    const [paired1, paired2] = await Promise.all([paired1Promise, paired2Promise]);

    expect(paired1.peerRole).toBe('orchestrator');
    expect(paired2.peerRole).toBe('agent');
  });

  it('should not pair two clients with the same role', async () => {
    const ws1 = await createClient(port);
    const ws2 = await createClient(port);
    clients.push(ws1, ws2);

    sendMsg(ws1, { type: 'register', role: 'agent', pairingCode: 'same-role', token: 'tok-1' });
    await waitForMessage<RelayRegisteredMessage>(ws1, 'registered');

    sendMsg(ws2, { type: 'register', role: 'agent', pairingCode: 'same-role', token: 'tok-2' });
    await waitForMessage<RelayRegisteredMessage>(ws2, 'registered');

    // Neither should receive a paired message
    const sessions = server.getSessions();
    const paired = sessions.filter((s) => s.state === 'paired');
    expect(paired.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Message relay
  // -----------------------------------------------------------------------

  it('should forward relay messages between paired clients', async () => {
    const ws1 = await createClient(port);
    const ws2 = await createClient(port);
    clients.push(ws1, ws2);

    // Register agent first
    sendMsg(ws1, { type: 'register', role: 'agent', pairingCode: 'relay-test', token: 'tok-1' });
    await waitForMessage<RelayRegisteredMessage>(ws1, 'registered');

    // Set up ALL paired listeners BEFORE triggering pairing
    const paired1Promise = waitForMessage<RelayPairedMessage>(ws1, 'paired');
    const paired2Promise = waitForMessage<RelayPairedMessage>(ws2, 'paired');

    sendMsg(ws2, { type: 'register', role: 'orchestrator', pairingCode: 'relay-test', token: 'tok-2' });
    await Promise.all([paired1Promise, paired2Promise]);

    // Send from agent → orchestrator
    const testPayload = 'encrypted-blob-base64';
    sendMsg(ws1, { type: 'relay', payload: testPayload });

    const received = await waitForMessage<RelayDataMessage>(ws2, 'relay');
    expect(received.payload).toBe(testPayload);
  });

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  it('should respond to heartbeat with heartbeat_ack', async () => {
    const ws = await createClient(port);
    clients.push(ws);

    sendMsg(ws, { type: 'register', role: 'agent', pairingCode: 'hb-test', token: 'tok-1' });
    await waitForMessage<RelayRegisteredMessage>(ws, 'registered');

    sendMsg(ws, { type: 'heartbeat' });
    const ack = await waitForMessage<RelayHeartbeatAckMessage>(ws, 'heartbeat_ack');
    expect(ack.type).toBe('heartbeat_ack');
  });

  // -----------------------------------------------------------------------
  // Disconnection
  // -----------------------------------------------------------------------

  it('should notify peer when client disconnects', async () => {
    const ws1 = await createClient(port);
    const ws2 = await createClient(port);
    clients.push(ws1, ws2);

    // Register agent first
    sendMsg(ws1, { type: 'register', role: 'agent', pairingCode: 'dc-test', token: 'tok-1' });
    await waitForMessage<RelayRegisteredMessage>(ws1, 'registered');

    // Set up ALL paired listeners BEFORE triggering pairing
    const paired1Promise = waitForMessage<RelayPairedMessage>(ws1, 'paired');
    const paired2Promise = waitForMessage<RelayPairedMessage>(ws2, 'paired');

    sendMsg(ws2, { type: 'register', role: 'orchestrator', pairingCode: 'dc-test', token: 'tok-2' });
    await Promise.all([paired1Promise, paired2Promise]);

    // Disconnect agent
    ws1.close();

    const disconnected = await waitForMessage<RelayPeerDisconnectedMessage>(ws2, 'peer_disconnected');
    expect(disconnected.peerSessionId).toBeDefined();
  });

  it('should clean up client on disconnect', async () => {
    const ws = await createClient(port);
    clients.push(ws);

    sendMsg(ws, { type: 'register', role: 'agent', pairingCode: 'cleanup', token: 'tok-1' });
    await waitForMessage<RelayRegisteredMessage>(ws, 'registered');
    expect(server.getClientCount()).toBe(1);

    ws.close();

    // Wait briefly for cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.getClientCount()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // getSessions
  // -----------------------------------------------------------------------

  it('should return session snapshots via getSessions', async () => {
    const ws = await createClient(port);
    clients.push(ws);

    sendMsg(ws, { type: 'register', role: 'orchestrator', pairingCode: 'snap', token: 'tok-1' });
    await waitForMessage<RelayRegisteredMessage>(ws, 'registered');

    const sessions = server.getSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].role).toBe('orchestrator');
    expect(sessions[0].state).toBe('waiting');
    expect(sessions[0].pairingCode).toBe('snap');
  });
});
