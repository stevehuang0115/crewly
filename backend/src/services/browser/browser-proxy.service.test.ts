/**
 * Tests for BrowserProxyService
 *
 * @module services/browser/browser-proxy.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { BrowserProxyService } from './browser-proxy.service.js';

// Capture event handlers registered on mock WebSocket instances
type WsHandler = (...args: unknown[]) => void;
interface MockWsInstance {
  on: Mock;
  send: Mock;
  close: Mock;
  removeAllListeners: Mock;
  readyState: number;
  _handlers: Record<string, WsHandler>;
  _trigger: (event: string, ...args: unknown[]) => void;
}

/**
 * Create a mock WebSocket instance that captures event handlers.
 *
 * @returns MockWsInstance with helpers to trigger events
 */
function createMockWs(): MockWsInstance {
  const handlers: Record<string, WsHandler> = {};
  const ws: MockWsInstance = {
    on: vi.fn((event: string, handler: WsHandler) => {
      handlers[event] = handler;
    }),
    send: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn(),
    readyState: 1, // OPEN
    _handlers: handlers,
    _trigger: (event: string, ...args: unknown[]) => {
      if (handlers[event]) handlers[event](...args);
    },
  };
  return ws;
}

let latestMockWs: MockWsInstance | null = null;

// Mock ws module
vi.mock('ws', () => {
  const MockWebSocket = vi.fn().mockImplementation(() => {
    const ws = createMockWs();
    latestMockWs = ws;
    return ws;
  });
  (MockWebSocket as Record<string, unknown>).OPEN = 1;
  return {
    default: MockWebSocket,
    WebSocket: MockWebSocket,
  };
});

// Mock logger
vi.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  },
}));

describe('BrowserProxyService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    BrowserProxyService.resetInstance();
    latestMockWs = null;
  });

  afterEach(() => {
    // Disconnect to clear any timers
    try {
      BrowserProxyService.getInstance().disconnect();
    } catch {
      // ignore
    }
    BrowserProxyService.resetInstance();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('singleton pattern', () => {
    it('should return the same instance on repeated calls', () => {
      const a = BrowserProxyService.getInstance();
      const b = BrowserProxyService.getInstance();
      expect(a).toBe(b);
    });

    it('should return a new instance after resetInstance', () => {
      const a = BrowserProxyService.getInstance();
      BrowserProxyService.resetInstance();
      const b = BrowserProxyService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('connect', () => {
    it('should create a WebSocket and send register message on open', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');

      expect(latestMockWs).not.toBeNull();
      expect(proxy.getState()).toBe('connecting');

      // Simulate WS open
      latestMockWs!._trigger('open');

      // Should have sent a register message with role=agent
      expect(latestMockWs!.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(latestMockWs!.send.mock.calls[0][0] as string);
      expect(sent.type).toBe('register');
      expect(sent.role).toBe('agent');
      expect(sent.token).toBe('test-token');
    });

    it('should not reconnect if already connecting', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      const firstWs = latestMockWs;

      // Try to connect again — should be a no-op
      proxy.connect('test-token-2');
      expect(latestMockWs).toBe(firstWs);
    });
  });

  describe('handleMessage routing', () => {
    /**
     * Helper: connect proxy and simulate successful registration.
     *
     * @returns The mock WebSocket instance
     */
    function connectAndRegister(): MockWsInstance {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      // Simulate registered response
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-123' }),
      );
      return latestMockWs!;
    }

    it('should transition to connected on registered message', () => {
      connectAndRegister();
      const proxy = BrowserProxyService.getInstance();
      expect(proxy.getState()).toBe('connected');
    });

    it('should handle browser_list and populate instances', () => {
      connectAndRegister();
      const proxy = BrowserProxyService.getInstance();

      // Simulate browser_list
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'browser_list',
          instances: [
            { instanceId: 'id-1', instanceName: 'My Chrome', sessionId: 'bs-1' },
            { instanceId: 'id-2', instanceName: 'Work Chrome', sessionId: 'bs-2' },
          ],
        }),
      );

      const instances = proxy.getInstances();
      expect(instances).toHaveLength(2);
      expect(instances[0].instanceName).toBe('My Chrome');
      expect(instances[1].instanceName).toBe('Work Chrome');
    });

    it('should handle browser_event connected/disconnected', () => {
      connectAndRegister();
      const proxy = BrowserProxyService.getInstance();

      // browser connected event
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'browser_event',
          event: 'connected',
          instanceId: 'id-3',
          instanceName: 'New Chrome',
        }),
      );
      expect(proxy.getInstances().find((i) => i.instanceId === 'id-3')).toBeTruthy();

      // browser disconnected event
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'browser_event',
          event: 'disconnected',
          instanceId: 'id-3',
          instanceName: 'New Chrome',
        }),
      );
      expect(proxy.getInstances().find((i) => i.instanceId === 'id-3')).toBeUndefined();
    });

    it('should handle relay message and resolve pending command', async () => {
      connectAndRegister();
      const proxy = BrowserProxyService.getInstance();

      // Set up one browser instance for auto-select
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'browser_list',
          instances: [{ instanceId: 'id-1', instanceName: 'Chrome', sessionId: 'bs-1' }],
        }),
      );

      // Send command
      const cmdPromise = proxy.sendCommand('navigate', { url: 'https://example.com' });

      // Capture the command ID from the sent relay_to message
      const sentMsg = JSON.parse(latestMockWs!.send.mock.lastCall![0] as string);
      expect(sentMsg.type).toBe('relay_to');
      const payload = JSON.parse(sentMsg.payload as string);
      const cmdId = payload.id;

      // Simulate relay response
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'relay',
          payload: JSON.stringify({ id: cmdId, success: true, result: { title: 'Example' } }),
        }),
      );

      const result = await cmdPromise;
      expect(result.success).toBe(true);
      expect(result.id).toBe(cmdId);
    });

    it('should handle error messages gracefully', () => {
      connectAndRegister();
      // Should not throw
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'error',
          code: 'BROWSER_NOT_FOUND',
          message: 'Target browser not found',
        }),
      );
      expect(BrowserProxyService.getInstance().getState()).toBe('connected');
    });

    it('should ignore non-JSON messages', () => {
      connectAndRegister();
      // Should not throw
      latestMockWs!._trigger('message', 'not json at all');
      expect(BrowserProxyService.getInstance().getState()).toBe('connected');
    });
  });

  describe('sendCommand', () => {
    /**
     * Helper: fully connect and add one browser instance.
     */
    function setupConnectedProxy(): void {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'browser_list',
          instances: [{ instanceId: 'id-1', instanceName: 'Chrome', sessionId: 'bs-1' }],
        }),
      );
    }

    it('should throw when not connected', async () => {
      const proxy = BrowserProxyService.getInstance();
      await expect(proxy.sendCommand('navigate', { url: 'https://example.com' })).rejects.toThrow(
        'Browser proxy not connected to relay',
      );
    });

    it('should reject on timeout', async () => {
      setupConnectedProxy();
      const proxy = BrowserProxyService.getInstance();

      const cmdPromise = proxy.sendCommand('screenshot', {}, undefined, 5000);

      // Advance time past timeout
      vi.advanceTimersByTime(5001);

      await expect(cmdPromise).rejects.toThrow("timed out after 5000ms");
    });

    it('should auto-select when only 1 instance is connected', async () => {
      setupConnectedProxy();
      const proxy = BrowserProxyService.getInstance();

      const cmdPromise = proxy.sendCommand('getTabs');

      // Verify relay_to was sent with targetInstance = 'Chrome'
      const sentMsg = JSON.parse(latestMockWs!.send.mock.lastCall![0] as string);
      expect(sentMsg.type).toBe('relay_to');
      expect(sentMsg.targetInstance).toBe('Chrome');

      // Resolve to avoid hanging promise
      const payload = JSON.parse(sentMsg.payload as string);
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'relay',
          payload: JSON.stringify({ id: payload.id, success: true, result: [] }),
        }),
      );
      await cmdPromise;
    });

    it('should route to explicit instance name', async () => {
      // Add two instances
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'browser_list',
          instances: [
            { instanceId: 'id-1', instanceName: 'Home', sessionId: 'bs-1' },
            { instanceId: 'id-2', instanceName: 'Work', sessionId: 'bs-2' },
          ],
        }),
      );

      const cmdPromise = proxy.sendCommand('navigate', { url: 'https://example.com' }, 'Work');

      const sentMsg = JSON.parse(latestMockWs!.send.mock.lastCall![0] as string);
      expect(sentMsg.targetInstance).toBe('Work');

      // Resolve
      const payload = JSON.parse(sentMsg.payload as string);
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'relay',
          payload: JSON.stringify({ id: payload.id, success: true }),
        }),
      );
      await cmdPromise;
    });

    it('should error when target instance not found', async () => {
      setupConnectedProxy();
      const proxy = BrowserProxyService.getInstance();

      await expect(
        proxy.sendCommand('navigate', { url: 'https://example.com' }, 'NonExistent'),
      ).rejects.toThrow('Browser instance "NonExistent" not found');
    });

    it('should error when no instances and no explicit target', async () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );
      // No browser_list → 0 instances

      await expect(proxy.sendCommand('navigate')).rejects.toThrow(
        'No browser instances connected',
      );
    });
  });

  describe('getInstances', () => {
    it('should return empty array before connection', () => {
      const proxy = BrowserProxyService.getInstance();
      expect(proxy.getInstances()).toEqual([]);
    });
  });

  describe('disconnect', () => {
    it('should clean up WebSocket and timers', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );

      const ws = latestMockWs!;
      proxy.disconnect();

      expect(ws.close).toHaveBeenCalledWith(1000, 'Proxy shutdown');
      expect(proxy.getState()).toBe('disconnected');
      expect(proxy.getInstances()).toEqual([]);
    });

    it('should reject pending commands on disconnect', async () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'browser_list',
          instances: [{ instanceId: 'id-1', instanceName: 'Chrome', sessionId: 'bs-1' }],
        }),
      );

      const cmdPromise = proxy.sendCommand('screenshot');
      proxy.disconnect();

      await expect(cmdPromise).rejects.toThrow('Browser proxy shutting down');
    });
  });

  describe('auto-reconnect', () => {
    it('should schedule reconnect on unexpected disconnect', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );

      const firstWs = latestMockWs;

      // Simulate connection close
      latestMockWs!._trigger('close', 1006, Buffer.from('abnormal'));

      expect(proxy.getState()).toBe('disconnected');

      // Advance past reconnect delay (5000ms)
      vi.advanceTimersByTime(5001);

      // Should have created a new WebSocket
      expect(latestMockWs).not.toBe(firstWs);
      expect(proxy.getState()).toBe('connecting');
    });

    it('should not reconnect after explicit disconnect()', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );

      proxy.disconnect();
      const wsAfterDisconnect = latestMockWs;

      // Advance past reconnect delay
      vi.advanceTimersByTime(10000);

      // Should NOT have created a new WebSocket
      expect(latestMockWs).toBe(wsAfterDisconnect);
    });
  });

  describe('token resolver and updateToken', () => {
    it('should use tokenResolver to get fresh token on reconnect', () => {
      const proxy = BrowserProxyService.getInstance();
      let currentToken = 'token-v1';
      proxy.setTokenResolver(() => currentToken);
      proxy.connect('token-v1');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );

      const firstWs = latestMockWs;

      // Simulate token refresh (external)
      currentToken = 'token-v2';

      // Simulate disconnect
      latestMockWs!._trigger('close', 4003, Buffer.from('Authentication failed'));

      // Advance past reconnect delay
      vi.advanceTimersByTime(5001);

      // Should have created a new WS
      expect(latestMockWs).not.toBe(firstWs);

      // Simulate open → register should use fresh token
      latestMockWs!._trigger('open');
      const sent = JSON.parse(latestMockWs!.send.mock.lastCall![0] as string);
      expect(sent.token).toBe('token-v2');
    });

    it('should re-register with new token when updateToken is called while connected', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('token-v1');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );

      // Clear previous send calls
      latestMockWs!.send.mockClear();

      // Update token while connected
      proxy.updateToken('token-v2');

      // Should have sent a new register message with the fresh token
      expect(latestMockWs!.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(latestMockWs!.send.mock.calls[0][0] as string);
      expect(sent.type).toBe('register');
      expect(sent.token).toBe('token-v2');
    });

    it('should not re-register when updateToken receives the same token', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('same-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );

      latestMockWs!.send.mockClear();

      proxy.updateToken('same-token');

      // Should NOT have sent any new messages
      expect(latestMockWs!.send).not.toHaveBeenCalled();
    });

    it('should use exponential backoff on repeated disconnections', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );

      // First disconnect → 5s delay
      latestMockWs!._trigger('close', 4002, Buffer.from('Heartbeat timeout'));
      const firstWs = latestMockWs;

      // 5s delay for first reconnect
      vi.advanceTimersByTime(5001);
      expect(latestMockWs).not.toBe(firstWs);

      // Simulate immediate close (no registration) → 10s delay
      const secondWs = latestMockWs;
      latestMockWs!._trigger('open');
      latestMockWs!._trigger('close', 4003, Buffer.from('Auth failed'));

      // 5s should NOT be enough now (exponential: 10s)
      vi.advanceTimersByTime(5001);
      expect(latestMockWs).toBe(secondWs);

      // 10s total should trigger reconnect
      vi.advanceTimersByTime(5001);
      expect(latestMockWs).not.toBe(secondWs);
    });
  });

  describe('AUTH_FAILED handling', () => {
    it('should fetch fresh token from resolver on AUTH_FAILED error message', () => {
      const proxy = BrowserProxyService.getInstance();
      let tokenVersion = 1;
      proxy.setTokenResolver(() => `token-v${tokenVersion}`);
      proxy.connect('token-v1');
      latestMockWs!._trigger('open');

      // Token refreshes externally
      tokenVersion = 2;

      // Relay sends AUTH_FAILED error before closing
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'jwt expired' }),
      );

      // Now close → reconnect should use token-v2
      latestMockWs!._trigger('close', 4003, Buffer.from('Authentication failed'));

      vi.advanceTimersByTime(5001);
      latestMockWs!._trigger('open');

      const sent = JSON.parse(latestMockWs!.send.mock.lastCall![0] as string);
      expect(sent.token).toBe('token-v2');
    });
  });

  describe('isAvailable / isConnected', () => {
    it('isConnected returns false when disconnected', () => {
      expect(BrowserProxyService.getInstance().isConnected()).toBe(false);
    });

    it('isConnected returns true when connected', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );
      expect(proxy.isConnected()).toBe(true);
    });

    it('isAvailable returns false when connected but no instances', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );
      expect(proxy.isAvailable()).toBe(false);
    });

    it('isAvailable returns true when connected with instances', () => {
      const proxy = BrowserProxyService.getInstance();
      proxy.connect('test-token');
      latestMockWs!._trigger('open');
      latestMockWs!._trigger(
        'message',
        JSON.stringify({ type: 'registered', sessionId: 'sess-1' }),
      );
      latestMockWs!._trigger(
        'message',
        JSON.stringify({
          type: 'browser_list',
          instances: [{ instanceId: 'id-1', instanceName: 'Chrome', sessionId: 'bs-1' }],
        }),
      );
      expect(proxy.isAvailable()).toBe(true);
    });
  });
});
