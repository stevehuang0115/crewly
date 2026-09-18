/**
 * Tests for WebSocketService.
 *
 * Covers connection management, event listeners, terminal session management,
 * socket event handling, and reconnection logic.
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { WebSocketService } from './websocket.service';

// Create fresh mock socket for each test
const createMockSocket = () => ({
  connected: false,
  id: 'test-socket-id',
  on: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
});

let mockSocket = createMockSocket();

vi.mock('socket.io-client', () => {
  return {
    default: vi.fn(() => mockSocket),
  };
});

// Mock console methods
const consoleSpy = {
  log: vi.spyOn(console, 'log').mockImplementation(),
  error: vi.spyOn(console, 'error').mockImplementation(),
};

// Mock window.location
Object.defineProperty(window, 'location', {
  value: {
    protocol: 'http:',
    host: 'localhost:8788',
  },
  writable: true,
});

describe('WebSocketService', () => {
  let service: WebSocketService;
  const mockCallback = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSocket = createMockSocket();
    mockCallback.mockClear();
    consoleSpy.log.mockClear();
    consoleSpy.error.mockClear();

    service = new WebSocketService();
  });

  afterEach(() => {
    service.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  afterAll(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.error.mockRestore();
  });

  describe('Constructor', () => {
    it('uses default URL when none provided', () => {
      const defaultService = new WebSocketService();
      expect(defaultService).toBeDefined();
    });

    it('uses provided URL', () => {
      const customService = new WebSocketService('ws://custom:8080');
      expect(customService).toBeDefined();
    });
  });

  describe('Connection Management', () => {
    it('passes the stored API token as the `token` query param on the handshake', async () => {
      const ioMock = (await import('socket.io-client')).default as unknown as ReturnType<typeof vi.fn>;
      ioMock.mockClear();
      localStorage.setItem('crewly_api_token', 'ws-token');
      try {
        service.connect();
        expect(ioMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ query: { token: 'ws-token' } }),
        );
      } finally {
        localStorage.removeItem('crewly_api_token');
      }
    });

    it('sends no token query on loopback (nothing stored)', async () => {
      const ioMock = (await import('socket.io-client')).default as unknown as ReturnType<typeof vi.fn>;
      ioMock.mockClear();
      localStorage.removeItem('crewly_api_token');
      service.connect();
      expect(ioMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ query: {} }));
    });

    it('connects successfully when socket connects', async () => {
      const connectPromise = service.connect();

      // Simulate successful connection
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();

      await expect(connectPromise).resolves.toBeUndefined();
      expect(consoleSpy.log).toHaveBeenCalledWith('WebSocket connected:', 'test-socket-id');
    });

    it('rejects when initial connection fails', async () => {
      const connectPromise = service.connect();

      // Simulate connection error
      const errorHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect_error')?.[1];
      const testError = new Error('Connection failed');
      errorHandler?.(testError);

      await expect(connectPromise).rejects.toBe(testError);
    });

    it('does not reconnect when already connected', async () => {
      // First connect
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Clear mocks and try to connect again
      mockSocket.on.mockClear();
      await service.connect();

      // Socket.on should not have been called again
      expect(mockSocket.on).not.toHaveBeenCalled();
    });

    it('handles intentional disconnect', async () => {
      // First connect
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Now disconnect
      service.disconnect();

      expect(mockSocket.disconnect).toHaveBeenCalled();
      expect(consoleSpy.log).toHaveBeenCalledWith('WebSocket intentionally disconnected');
    });

    it('handles unexpected disconnection with reconnection', async () => {
      // Set up initial connection
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Get disconnect handler
      const disconnectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'disconnect')?.[1];

      // Simulate unexpected disconnect
      mockSocket.connected = false;
      disconnectHandler?.('io server disconnect');

      // Verify reconnection state
      expect(service.getConnectionState()).toBe('reconnecting');
    });
  });

  describe('Event Listener Management', () => {
    it('adds event listeners', async () => {
      // Connect first to set up socket
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Add listener
      service.on('terminal_output', mockCallback);

      // Simulate terminal output event
      const terminalHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'terminal_output'
      )?.[1];

      terminalHandler?.({ payload: { test: 'data' } });

      expect(mockCallback).toHaveBeenCalledWith({ test: 'data' });
    });

    it('removes event listeners', async () => {
      // Connect first
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Add and then remove listener
      service.on('terminal_output', mockCallback);
      service.off('terminal_output', mockCallback);

      // Simulate terminal output event
      const terminalHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'terminal_output'
      )?.[1];

      terminalHandler?.({ payload: { test: 'data' } });

      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('handles multiple listeners for same event', async () => {
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      service.on('terminal_output', callback1);
      service.on('terminal_output', callback2);

      const terminalHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'terminal_output'
      )?.[1];

      terminalHandler?.({ payload: { test: 'data' } });

      expect(callback1).toHaveBeenCalledWith({ test: 'data' });
      expect(callback2).toHaveBeenCalledWith({ test: 'data' });
    });

    it('handles errors in event callbacks gracefully', async () => {
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      const errorCallback = vi.fn(() => {
        throw new Error('Callback error');
      });

      service.on('terminal_output', errorCallback);

      const terminalHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'terminal_output'
      )?.[1];

      terminalHandler?.({ payload: { test: 'data' } });

      expect(consoleSpy.error).toHaveBeenCalledWith(
        'Error in WebSocket event handler for terminal_output:',
        expect.any(Error)
      );
    });
  });

  describe('Terminal Session Management', () => {
    beforeEach(async () => {
      // Connect first to create socket
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;
      mockSocket.emit.mockClear();
    });

    it('subscribes to terminal session', () => {
      service.subscribeToSession('test-session');

      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_to_session', 'test-session');
      expect(consoleSpy.log).toHaveBeenCalledWith('Subscribing to session:', 'test-session');
    });

    it('unsubscribes from terminal session', () => {
      service.unsubscribeFromSession('test-session');

      expect(mockSocket.emit).toHaveBeenCalledWith('unsubscribe_from_session', 'test-session');
      expect(consoleSpy.log).toHaveBeenCalledWith('Unsubscribing from session:', 'test-session');
    });

    it('sends terminal input', () => {
      service.sendInput('test-session', 'ls -la');

      expect(mockSocket.emit).toHaveBeenCalledWith('send_input', {
        sessionName: 'test-session',
        input: 'ls -la',
      });
    });

    it('resizes terminal', () => {
      service.resizeTerminal('test-session', 80, 24);

      expect(mockSocket.emit).toHaveBeenCalledWith('terminal_resize', {
        sessionName: 'test-session',
        cols: 80,
        rows: 24,
      });
    });

    it('handles operations when not connected', () => {
      mockSocket.connected = false;

      service.subscribeToSession('test-session');
      service.unsubscribeFromSession('test-session');
      service.sendInput('test-session', 'command');
      service.resizeTerminal('test-session', 80, 24);

      expect(consoleSpy.error).toHaveBeenCalledTimes(4);
      // emit should not be called after connection
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });
  });

  describe('Socket Event Handling', () => {
    beforeEach(async () => {
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;
    });

    it('handles terminal_output events', () => {
      service.on('terminal_output', mockCallback);

      const terminalOutputHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'terminal_output'
      )?.[1];

      const testMessage = {
        type: 'terminal_output',
        payload: { sessionName: 'test', content: 'output' },
        timestamp: '2023-01-01T00:00:00Z',
      };

      terminalOutputHandler?.(testMessage);

      expect(mockCallback).toHaveBeenCalledWith(testMessage.payload);
    });

    it('handles initial_terminal_state events', () => {
      service.on('initial_terminal_state', mockCallback);

      const initialStateHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'initial_terminal_state'
      )?.[1];

      const testMessage = {
        type: 'initial_terminal_state',
        payload: { sessionName: 'test', content: 'initial content' },
        timestamp: '2023-01-01T00:00:00Z',
      };

      initialStateHandler?.(testMessage);

      expect(mockCallback).toHaveBeenCalledWith(testMessage.payload);
    });

    it('handles error events', () => {
      service.on('error', mockCallback);

      const errorHandler = mockSocket.on.mock.calls.find(call => call[0] === 'error')?.[1];

      const testMessage = {
        type: 'error',
        payload: { error: 'Test error' },
        timestamp: '2023-01-01T00:00:00Z',
      };

      errorHandler?.(testMessage);

      expect(consoleSpy.error).toHaveBeenCalledWith('WebSocket error:', testMessage.payload);
      expect(mockCallback).toHaveBeenCalledWith(testMessage.payload);
    });

    it('handles team activity events', () => {
      const orchestratorCallback = vi.fn();
      const memberCallback = vi.fn();
      const activityCallback = vi.fn();

      service.on('orchestrator_status_changed', orchestratorCallback);
      service.on('team_member_status_changed', memberCallback);
      service.on('team_activity_updated', activityCallback);

      const orchestratorHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'orchestrator_status_changed'
      )?.[1];
      const memberHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'team_member_status_changed'
      )?.[1];
      const activityHandler = mockSocket.on.mock.calls.find(
        call => call[0] === 'team_activity_updated'
      )?.[1];

      const testMessages = [
        { payload: { status: 'active' } },
        { payload: { memberId: '1', status: 'active' } },
        { payload: { teamId: 'team1', activity: 'updated' } },
      ];

      orchestratorHandler?.(testMessages[0]);
      memberHandler?.(testMessages[1]);
      activityHandler?.(testMessages[2]);

      expect(orchestratorCallback).toHaveBeenCalledWith(testMessages[0].payload);
      expect(memberCallback).toHaveBeenCalledWith(testMessages[1].payload);
      expect(activityCallback).toHaveBeenCalledWith(testMessages[2].payload);
    });
  });

  describe('Connection Status', () => {
    it('returns correct connection status when disconnected', () => {
      expect(service.isConnected()).toBe(false);
      expect(service.getConnectionState()).toBe('disconnected');
    });

    it('returns correct connection status when connected', async () => {
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      expect(service.isConnected()).toBe(true);
      expect(service.getConnectionState()).toBe('connected');
    });

    it('returns reconnecting status during reconnection attempts', async () => {
      // Start connection
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Simulate disconnect that triggers reconnection
      const disconnectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'disconnect')?.[1];
      mockSocket.connected = false;
      disconnectHandler?.('io server disconnect');

      expect(service.getConnectionState()).toBe('reconnecting');
    });
  });

  describe('Reconnection Logic', () => {
    it('attempts reconnection on unexpected disconnect', async () => {
      // Set up initial connection
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Simulate unexpected disconnect
      const disconnectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'disconnect')?.[1];
      mockSocket.connected = false;
      disconnectHandler?.('io server disconnect');

      // Verify we're in reconnecting state
      expect(service.getConnectionState()).toBe('reconnecting');
    });

    it('does not reconnect on intentional disconnect', async () => {
      // Set up initial connection
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Intentional disconnect
      service.disconnect();

      // Should be disconnected, not reconnecting
      expect(service.getConnectionState()).toBe('disconnected');
    });
  });

  describe('Cleanup', () => {
    it('clears all listeners and disconnects on destroy', async () => {
      // Connect first
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      service.on('terminal_output', mockCallback);
      service.destroy();

      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    it('clears reconnection timer on disconnect', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      // Set up initial connection
      const connectPromise = service.connect();
      mockSocket.connected = true;
      const connectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'connect')?.[1];
      connectHandler?.();
      await connectPromise;

      // Trigger reconnection scenario
      const disconnectHandler = mockSocket.on.mock.calls.find(call => call[0] === 'disconnect')?.[1];
      mockSocket.connected = false;
      disconnectHandler?.('io server disconnect');

      // Now disconnect intentionally
      service.disconnect();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });
});
