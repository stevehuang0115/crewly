/**
 * Tests for Relay Client Service
 *
 * Unit tests for the relay client singleton, state management,
 * connection lifecycle, error handling, and send validation.
 *
 * @module services/cloud/relay-client.service.test
 */

import { RelayClientService } from './relay-client.service.js';
import type { RelayClientConfig } from './relay.types.js';

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

// Mock ws to avoid real WebSocket connections
jest.mock('ws', () => {
  const EventEmitter = require('events');
  class MockWS extends EventEmitter {
    constructor() {
      super();
      const mod = require('ws');
      mod.__mockInstance = this;
    }
  }
  MockWS.OPEN = 1;
  MockWS.CONNECTING = 0;
  MockWS.CLOSED = 3;
  MockWS.prototype.readyState = 3;
  MockWS.prototype.send = jest.fn();
  MockWS.prototype.close = jest.fn(function() {
    this.readyState = 3;
  });
  return { __esModule: true, default: MockWS, WebSocket: MockWS, __mockInstance: null };
});

// Mock crypto service
jest.mock('./relay-crypto.service.js', () => ({
  generateSalt: () => Buffer.from('test-salt'),
  deriveKey: () => Buffer.from('test-key-32-bytes-long-enough!!!'),
  encrypt: jest.fn(() => ({ iv: Buffer.alloc(12), ciphertext: Buffer.alloc(16), tag: Buffer.alloc(16) })),
  decrypt: jest.fn(() => 'decrypted-plaintext'),
  serializeEnvelope: jest.fn(() => 'serialized-envelope'),
  deserializeEnvelope: jest.fn(() => ({ iv: Buffer.alloc(12), ciphertext: Buffer.alloc(16), tag: Buffer.alloc(16) })),
}));

/**
 * Get the most recently created mock WebSocket instance.
 *
 * @returns The mock WS instance or null
 */
function getMockWs() {
  return require('ws').__mockInstance;
}

/**
 * Helper to create a valid relay client config for testing.
 *
 * @returns RelayClientConfig object
 */
function makeConfig(): RelayClientConfig {
  return {
    wsUrl: 'ws://localhost:8787/relay',
    pairingCode: 'test-pair-123',
    role: 'agent',
    token: 'test-token',
    sharedSecret: 'test-secret',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RelayClientService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    RelayClientService.resetInstance();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  it('should return the same instance via getInstance', () => {
    const a = RelayClientService.getInstance();
    const b = RelayClientService.getInstance();
    expect(a).toBe(b);
  });

  it('should create a fresh instance after resetInstance', () => {
    const a = RelayClientService.getInstance();
    RelayClientService.resetInstance();
    const b = RelayClientService.getInstance();
    expect(a).not.toBe(b);
  });

  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  it('should start in disconnected state', () => {
    const client = RelayClientService.getInstance();
    expect(client.getState()).toBe('disconnected');
    expect(client.getSessionId()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Send validation
  // -----------------------------------------------------------------------

  it('should throw when sending while disconnected', () => {
    const client = RelayClientService.getInstance();
    expect(() => client.send('hello')).toThrow('Cannot send');
  });

  // -----------------------------------------------------------------------
  // Disconnect
  // -----------------------------------------------------------------------

  it('should handle disconnect when not connected', () => {
    const client = RelayClientService.getInstance();
    client.disconnect();
    expect(client.getState()).toBe('disconnected');
  });

  // -----------------------------------------------------------------------
  // WebSocket error handling (crash prevention)
  // -----------------------------------------------------------------------

  describe('WebSocket error handling', () => {
    it('should not crash when ws emits error with no error listener', () => {
      const client = RelayClientService.getInstance();
      client.connect(makeConfig());

      const ws = getMockWs();
      expect(ws).not.toBeNull();

      // Simulate WebSocket error — should NOT throw uncaught exception
      expect(() => {
        ws.emit('error', new Error('Connection refused'));
      }).not.toThrow();
    });

    it('should transition to error state on WebSocket error', () => {
      const client = RelayClientService.getInstance();
      const stateChanges: string[] = [];
      client.on('stateChange', (s) => stateChanges.push(s));

      client.connect(makeConfig());
      const ws = getMockWs();

      ws.emit('error', new Error('502 Bad Gateway'));

      expect(client.getState()).toBe('error');
      expect(stateChanges).toContain('error');
    });

    it('should schedule reconnect after WebSocket error', () => {
      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      const ws = getMockWs();

      ws.emit('error', new Error('ECONNREFUSED'));

      // Advance timers — should attempt reconnect without crashing
      expect(() => {
        jest.advanceTimersByTime(10000);
      }).not.toThrow();
    });

    it('should not emit error event on relay server error message', () => {
      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      const ws = getMockWs();

      // Simulate open + registration
      ws.readyState = 1; // OPEN
      ws.emit('open');

      const errorSpy = jest.fn();
      client.on('error', errorSpy);

      // Simulate relay server error message
      const errorMsg = JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'Invalid token' });
      ws.emit('message', Buffer.from(errorMsg));

      // Should NOT have emitted error event — instead transitions state
      expect(errorSpy).not.toHaveBeenCalled();
      expect(client.getState()).toBe('error');
    });

    it('should not emit error event on decryption failure', () => {
      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      const ws = getMockWs();

      ws.readyState = 1;
      ws.emit('open');

      // Simulate registered + paired state
      const regMsg = JSON.stringify({ type: 'registered', sessionId: 'sess-1' });
      ws.emit('message', Buffer.from(regMsg));
      const pairMsg = JSON.stringify({ type: 'paired', peerSessionId: 'peer-1', peerRole: 'orchestrator' });
      ws.emit('message', Buffer.from(pairMsg));

      // Make decrypt throw
      const cryptoMod = require('./relay-crypto.service.js');
      cryptoMod.deserializeEnvelope.mockImplementationOnce(() => { throw new Error('bad ciphertext'); });

      const errorSpy = jest.fn();
      client.on('error', errorSpy);

      const relayMsg = JSON.stringify({ type: 'relay', payload: 'corrupted-data' });
      expect(() => {
        ws.emit('message', Buffer.from(relayMsg));
      }).not.toThrow();

      // Should NOT have emitted error event
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should handle close event without crashing', () => {
      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      const ws = getMockWs();

      expect(() => {
        ws.emit('close', 1006, Buffer.from('abnormal closure'));
      }).not.toThrow();

      expect(client.getState()).toBe('disconnected');
    });
  });
});
