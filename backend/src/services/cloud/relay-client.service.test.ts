/**
 * Tests for Relay Client Service (HTTP polling-based)
 *
 * Unit tests for the relay client singleton, state management,
 * HTTP registration, polling, ack, send, E2EE integration,
 * token refresh, pairing detection, and failure tracking.
 *
 * @module services/cloud/relay-client.service.test
 */


// ---------------------------------------------------------------------------
// Hoisted mocks — vi.mock factories are hoisted above imports, so any
// variables they reference must also be hoisted via jest.fn().
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();

// Assign mockFetch to global.fetch before any imports use it
global.fetch = mockFetch as any;

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

// Mock crypto service
jest.mock('./relay-crypto.service.js', () => ({
  generateSalt: () => Buffer.from('test-salt'),
  deriveKey: () => Buffer.from('test-key-32-bytes-long-enough!!!'),
  encrypt: jest.fn(() => ({ iv: 'aXY=', ciphertext: 'Y2lwaGVy', authTag: 'dGFn' })),
  decrypt: jest.fn(() => 'decrypted-plaintext'),
  serializeEnvelope: jest.fn(() => 'serialized-envelope'),
  deserializeEnvelope: jest.fn(() => ({ iv: 'aXY=', ciphertext: 'Y2lwaGVy', authTag: 'dGFn' })),
}));

// Note: CloudClientService is loaded via require() inside getAuthToken().
// In vitest ESM mode, require() is not intercepted by vi.mock, so
// getAuthToken() always falls back to the config token. The token refresh
// tests below verify this fallback path.
jest.mock('./cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      isConnected: jest.fn().mockReturnValue(false),
      getToken: jest.fn().mockReturnValue(null),
    }),
  },
}));

/**
 * Helper to create a valid relay client config for testing.
 *
 * @returns RelayClientConfig object
 */
function makeConfig(): RelayClientConfig {
  return {
    apiUrl: 'https://api.crewly.test',
    pairingCode: 'test-pair-123',
    role: 'agent',
    token: 'test-token',
    sharedSecret: 'test-secret',
  };
}

/**
 * Create a mock Response object for fetch.
 *
 * @param data - JSON body
 * @param ok - Whether response is ok
 * @param status - HTTP status code
 * @returns Mock Response
 */
function mockResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(data),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Helper to flush pending microtasks without advancing fake timers.
 * Allows async operations (fetch → json() → process → ack) to resolve
 * without triggering the polling interval.
 *
 * Uses enough rounds to cover multi-step promise chains (register, poll, ack).
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('RelayClientService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    RelayClientService.resetInstance();
    mockFetch.mockReset();
  });

  afterEach(() => {
    // Clean up: disconnect to stop polling before restoring real timers
    try { RelayClientService.getInstance().disconnect(); } catch { /* ignore */ }
    RelayClientService.resetInstance();
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

  it('should start with zero poll count and zero failures', () => {
    const client = RelayClientService.getInstance();
    expect(client.getPollCount()).toBe(0);
    expect(client.getConsecutivePollFailures()).toBe(0);
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

  it('should reset poll count and failures on disconnect', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
    );

    const client = RelayClientService.getInstance();
    client.connect(makeConfig());
    await flushMicrotasks();

    // Trigger a poll to increment pollCount
    mockFetch.mockResolvedValueOnce(mockResponse({ messages: [] }));
    jest.advanceTimersByTime(5000);
    await flushMicrotasks();

    expect(client.getPollCount()).toBe(1);

    client.disconnect();
    expect(client.getPollCount()).toBe(0);
    expect(client.getConsecutivePollFailures()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Connect → Register → Poll cycle
  // -----------------------------------------------------------------------

  describe('connect and register', () => {
    it('should POST to register endpoint using RELAY_ENDPOINTS constant', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());

      // Allow the async doRegister to run
      await flushMicrotasks();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.crewly.test/api/v1/relay/queue/register',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          }),
          body: expect.stringContaining('"role":"agent"'),
        }),
      );
    });

    it('should set state to registered when no peerQueueId', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      const stateChanges: string[] = [];
      client.on('stateChange', (s) => stateChanges.push(s));

      client.connect(makeConfig());
      await flushMicrotasks();

      expect(client.getState()).toBe('registered');
      expect(client.getSessionId()).toBe('q-1');
      expect(stateChanges).toContain('connecting');
      expect(stateChanges).toContain('registered');
    });

    it('should set state to paired and emit paired event when peerQueueId returned', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: 'q-peer' }),
      );

      const client = RelayClientService.getInstance();
      const pairedSpy = jest.fn();
      client.on('paired', pairedSpy);

      client.connect(makeConfig());
      await flushMicrotasks();

      expect(client.getState()).toBe('paired');
      expect(pairedSpy).toHaveBeenCalledWith('q-peer', 'peer');
    });

    it('should not connect when already in connecting state', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      // Now in registered state — calling connect again should be ignored
      client.connect(makeConfig());
      // Only one fetch call for the first register
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  describe('polling', () => {
    it('should poll for messages after registration', async () => {
      // Register response
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      // Set up poll response with no messages
      mockFetch.mockResolvedValueOnce(
        mockResponse({ messages: [] }),
      );

      // Advance by poll interval
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      // Should have made a GET poll request
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const pollCall = mockFetch.mock.calls[1];
      expect(pollCall[0]).toContain('/api/v1/relay/queue/poll?queueId=q-1');
      expect(pollCall[1]).toEqual(expect.objectContaining({ method: 'GET' }));
    });

    it('should increment pollCount on each poll cycle', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      expect(client.getPollCount()).toBe(0);

      // First poll
      mockFetch.mockResolvedValueOnce(mockResponse({ messages: [] }));
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();
      expect(client.getPollCount()).toBe(1);

      // Second poll
      mockFetch.mockResolvedValueOnce(mockResponse({ messages: [] }));
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();
      expect(client.getPollCount()).toBe(2);
    });

    it('should decrypt and emit messages from poll response', async () => {
      // Register
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: 'q-peer' }),
      );

      const client = RelayClientService.getInstance();
      const messageSpy = jest.fn();
      client.on('message', messageSpy);

      client.connect(makeConfig());
      await flushMicrotasks();

      // Poll response with messages
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          messages: [
            { id: 'msg-1', payload: 'encrypted-data-1', createdAt: '2026-01-01T00:00:01Z' },
            { id: 'msg-2', payload: 'encrypted-data-2', createdAt: '2026-01-01T00:00:02Z' },
          ],
        }),
      );
      // Ack response
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      expect(messageSpy).toHaveBeenCalledTimes(2);
      expect(messageSpy).toHaveBeenCalledWith('decrypted-plaintext');
    });

    it('should acknowledge messages after processing', async () => {
      // Register
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: 'q-peer' }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      // Poll with messages
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          messages: [
            { id: 'msg-1', payload: 'data', createdAt: '2026-01-01T00:00:01Z' },
          ],
        }),
      );
      // Ack response
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      // Check ack call uses RELAY_ENDPOINTS.QUEUE_ACK constant path
      const ackCall = mockFetch.mock.calls[2];
      expect(ackCall[0]).toBe('https://api.crewly.test/api/v1/relay/queue/ack');
      expect(JSON.parse(ackCall[1].body)).toEqual({
        queueId: 'q-1',
        messageIds: ['msg-1'],
      });
    });

    it('should include since parameter after first batch', async () => {
      // Register
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      // First poll with messages
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          messages: [
            { id: 'msg-1', payload: 'data', createdAt: '2026-01-01T00:00:05Z' },
          ],
        }),
      );
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true })); // ack

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      // Second poll should include since parameter
      mockFetch.mockResolvedValueOnce(mockResponse({ messages: [] }));

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      const secondPoll = mockFetch.mock.calls[3];
      expect(secondPoll[0]).toContain('since=2026-01-01T00%3A00%3A05Z');
    });

    it('should stop polling on disconnect', async () => {
      // Register
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      const callCountAfterRegister = mockFetch.mock.calls.length;

      client.disconnect();
      expect(client.getState()).toBe('disconnected');

      // Advance by multiple poll intervals — no new fetch calls
      jest.advanceTimersByTime(20000);
      await flushMicrotasks();

      expect(mockFetch.mock.calls.length).toBe(callCountAfterRegister);
    });
  });

  // -----------------------------------------------------------------------
  // Pairing detection during poll
  // -----------------------------------------------------------------------

  describe('pairing detection during poll', () => {
    it('should transition to paired state when poll returns peerQueueId', async () => {
      // Register without peer
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      const pairedSpy = jest.fn();
      client.on('paired', pairedSpy);

      client.connect(makeConfig());
      await flushMicrotasks();

      expect(client.getState()).toBe('registered');

      // Poll returns peerQueueId (peer just registered)
      mockFetch.mockResolvedValueOnce(
        mockResponse({ messages: [], peerQueueId: 'q-peer-late' }),
      );

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      expect(client.getState()).toBe('paired');
      expect(pairedSpy).toHaveBeenCalledWith('q-peer-late', 'peer');
    });

    it('should not re-emit paired if already paired', async () => {
      // Register with peer (already paired)
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: 'q-peer' }),
      );

      const client = RelayClientService.getInstance();
      const pairedSpy = jest.fn();
      client.on('paired', pairedSpy);

      client.connect(makeConfig());
      await flushMicrotasks();

      expect(pairedSpy).toHaveBeenCalledTimes(1);

      // Poll also returns peerQueueId — should NOT trigger second paired event
      mockFetch.mockResolvedValueOnce(
        mockResponse({ messages: [], peerQueueId: 'q-peer' }),
      );

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      // Still only one paired call (from registration)
      expect(pairedSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Consecutive poll failure tracking
  // -----------------------------------------------------------------------

  describe('consecutive poll failure tracking', () => {
    it('should track consecutive poll failures', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      expect(client.getConsecutivePollFailures()).toBe(0);

      // Fail 3 polls
      for (let i = 0; i < 3; i++) {
        mockFetch.mockRejectedValueOnce(new Error('network error'));
        jest.advanceTimersByTime(5000);
        await flushMicrotasks();
      }

      expect(client.getConsecutivePollFailures()).toBe(3);
    });

    it('should reset failure count on successful poll', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      // Fail 2 polls
      mockFetch.mockRejectedValueOnce(new Error('fail'));
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      mockFetch.mockRejectedValueOnce(new Error('fail'));
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      expect(client.getConsecutivePollFailures()).toBe(2);

      // Successful poll
      mockFetch.mockResolvedValueOnce(mockResponse({ messages: [] }));
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      expect(client.getConsecutivePollFailures()).toBe(0);
    });

    it('should emit error event and trigger re-registration after MAX_CONSECUTIVE_POLL_FAILURES', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      const errorSpy = jest.fn();
      client.on('error', errorSpy);

      client.connect(makeConfig());
      await flushMicrotasks();

      // Fail 5 polls (MAX_CONSECUTIVE_POLL_FAILURES)
      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(new Error('network error'));
        jest.advanceTimersByTime(5000);
        await flushMicrotasks();
      }

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('5 times consecutively'),
        }),
      );
      // After re-registration trigger, sessionId is reset and state is error
      expect(client.getSessionId()).toBeNull();
      expect(client.getState()).toBe('error');
      // consecutivePollFailures is reset to 0 after triggering re-registration
      expect(client.getConsecutivePollFailures()).toBe(0);
    });

    it('should handle non-ok poll responses as failures', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      // Non-ok poll response (500)
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: 'server error' }, false, 500),
      );

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      expect(client.getConsecutivePollFailures()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Token fallback behavior
  // -----------------------------------------------------------------------

  describe('token refresh integration', () => {
    // Note: getAuthToken() uses a dynamic require() to load CloudClientService,
    // which avoids circular dependencies at module load time. In vitest's ESM
    // environment, require() is not intercepted by jest.mock(), so getAuthToken()
    // always falls back to the config token. These tests verify the fallback path.

    it('should use config token for register requests', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      const registerCall = mockFetch.mock.calls[0];
      expect(registerCall[1].headers['Authorization']).toBe('Bearer test-token');
    });

    it('should fall back to config token when CloudClientService is not available', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      const registerCall = mockFetch.mock.calls[0];
      expect(registerCall[1].headers['Authorization']).toBe('Bearer test-token');
    });

    it('should use config token for poll requests', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      mockFetch.mockResolvedValueOnce(mockResponse({ messages: [] }));
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      const pollCall = mockFetch.mock.calls[1];
      expect(pollCall[1].headers['Authorization']).toBe('Bearer test-token');
    });
  });

  // -----------------------------------------------------------------------
  // Send via HTTP
  // -----------------------------------------------------------------------

  describe('send', () => {
    it('should POST encrypted payload to queue send endpoint', async () => {
      // Register with peer
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: 'q-peer' }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      // Send message
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      client.send('hello relay!');
      await flushMicrotasks();

      const sendCall = mockFetch.mock.calls[1];
      expect(sendCall[0]).toBe('https://api.crewly.test/api/v1/relay/queue/send');
      expect(sendCall[1]).toEqual(expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': expect.stringContaining('Bearer'),
        }),
      }));
      expect(JSON.parse(sendCall[1].body)).toEqual({
        peerQueueId: 'q-peer',
        payload: 'serialized-envelope',
      });
    });

    it('should throw when sending while not paired', () => {
      const client = RelayClientService.getInstance();
      expect(() => client.send('hello')).toThrow('Cannot send');
    });
  });

  // -----------------------------------------------------------------------
  // Exponential backoff on register failure
  // -----------------------------------------------------------------------

  describe('exponential backoff', () => {
    it('should retry registration with increasing delay on failure', async () => {
      // First register fails
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const client = RelayClientService.getInstance();
      const stateChanges: string[] = [];
      client.on('stateChange', (s) => stateChanges.push(s));

      client.connect(makeConfig());
      await flushMicrotasks();

      expect(client.getState()).toBe('error');

      // Second attempt after base delay (1000ms)
      mockFetch.mockRejectedValueOnce(new Error('Still down'));
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Third attempt after 2000ms (2^1 * 1000)
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );
      jest.advanceTimersByTime(2000);
      await flushMicrotasks();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(client.getState()).toBe('registered');
    });

    it('should give up after max reconnection attempts', async () => {
      const client = RelayClientService.getInstance();

      // Fail MAX_RECONNECT_ATTEMPTS + 1 times (initial + retries)
      for (let i = 0; i <= 10; i++) {
        mockFetch.mockRejectedValueOnce(new Error('down'));
      }

      client.connect(makeConfig());

      // Run through all 10 retry attempts
      for (let i = 0; i < 12; i++) {
        jest.advanceTimersByTime(30000);
        await flushMicrotasks();
      }

      expect(client.getState()).toBe('error');
    });

    it('should not reconnect after intentional disconnect', async () => {
      // First register fails
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      client.disconnect();

      // Advance past reconnect delay — no new fetch calls
      const callCount = mockFetch.mock.calls.length;
      jest.advanceTimersByTime(30000);
      await flushMicrotasks();

      expect(mockFetch.mock.calls.length).toBe(callCount);
    });
  });

  // -----------------------------------------------------------------------
  // E2EE integration
  // -----------------------------------------------------------------------

  describe('E2EE', () => {
    it('should use encrypt/serializeEnvelope when sending', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: 'q-peer' }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));
      client.send('secret message');
      await flushMicrotasks();

      const { encrypt, serializeEnvelope } = await import('./relay-crypto.service.js');
      expect(encrypt).toHaveBeenCalledWith(
        'secret message',
        Buffer.from('test-key-32-bytes-long-enough!!!'),
      );
      expect(serializeEnvelope).toHaveBeenCalled();
    });

    it('should use deserializeEnvelope/decrypt when receiving', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: 'q-peer' }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      mockFetch.mockResolvedValueOnce(
        mockResponse({
          messages: [{ id: 'm-1', payload: 'enc-payload', createdAt: '2026-01-01T00:00:00Z' }],
        }),
      );
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true })); // ack

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      const { deserializeEnvelope, decrypt } = await import('./relay-crypto.service.js');
      expect(deserializeEnvelope).toHaveBeenCalledWith('enc-payload');
      expect(decrypt).toHaveBeenCalled();
    });

    it('should not crash on decryption failure', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: 'q-peer' }),
      );

      const client = RelayClientService.getInstance();
      const errorSpy = jest.fn();
      client.on('error', errorSpy);

      client.connect(makeConfig());
      await flushMicrotasks();

      const { deserializeEnvelope } = await import('./relay-crypto.service.js');
      (deserializeEnvelope as any).mockImplementationOnce(() => {
        throw new Error('bad ciphertext');
      });

      mockFetch.mockResolvedValueOnce(
        mockResponse({
          messages: [{ id: 'm-1', payload: 'corrupted', createdAt: '2026-01-01T00:00:00Z' }],
        }),
      );
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true })); // ack

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      // Should NOT have emitted error event — logged only
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // HTTP error handling
  // -----------------------------------------------------------------------

  describe('HTTP error handling', () => {
    it('should handle non-ok register response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: 'Unauthorized' }, false, 401),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      expect(client.getState()).toBe('error');
    });

    it('should handle poll failure gracefully', async () => {
      // Register ok
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true, queueId: 'q-1', peerQueueId: null }),
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      // Poll fails
      mockFetch.mockRejectedValueOnce(new Error('timeout'));

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      // Client should still be in registered state (poll failure doesn't change state)
      expect(client.getState()).toBe('registered');
    });

    it('should handle register response with missing fields', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true }), // missing queueId
      );

      const client = RelayClientService.getInstance();
      client.connect(makeConfig());
      await flushMicrotasks();

      expect(client.getState()).toBe('error');
    });
  });
});
