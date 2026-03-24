/**
 * Tests for MessageRouterService
 *
 * Covers: remote routing, session discovery, incoming message handling,
 * local delivery, graceful degradation, lifecycle management,
 * cross-machine message handling, and message enqueue handler.
 *
 * @module services/messaging/message-router.service.test
 */

import { MessageRouterService, MESSAGE_ROUTER_CONSTANTS } from './message-router.service.js';
import type { SyncDevice, IncomingMessage, AgentMessagePayload } from '../cloud/cloud-sync.types.js';

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

// Mock CloudSyncService
const mockSendMessage = jest.fn();
const mockIsStarted = jest.fn().mockReturnValue(true);
const mockGetOnlineDevices = jest.fn().mockReturnValue([]);
const mockGetDevices = jest.fn().mockReturnValue([]);
const mockOn = jest.fn();
const mockRemoveListener = jest.fn();

jest.mock('../cloud/cloud-sync.service.js', () => ({
  CloudSyncService: {
    getInstance: () => ({
      isStarted: mockIsStarted,
      getOnlineDevices: mockGetOnlineDevices,
      getDevices: mockGetDevices,
      sendMessage: mockSendMessage,
      on: mockOn,
      removeListener: mockRemoveListener,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock SyncDevice with agents */
function createDevice(overrides: Partial<SyncDevice> = {}): SyncDevice {
  return {
    deviceId: 'device-remote-1',
    deviceName: 'Remote Machine',
    status: 'online',
    lastHeartbeatAt: new Date().toISOString(),
    isLocal: false,
    teams: [
      {
        id: 'team-1',
        name: 'Crewly Product',
        memberCount: 3,
        activeAgents: 2,
        agents: [
          { sessionName: 'crewly-product-leo-member-n', role: 'developer', workingStatus: 'idle' },
          { sessionName: 'crewly-product-max-118c0421', role: 'developer', workingStatus: 'in_progress' },
        ],
      },
    ],
    ...overrides,
  };
}

/** Create a mock IncomingMessage for agent_message type */
function createAgentMessage(payload: AgentMessagePayload): IncomingMessage {
  return {
    id: 'msg-1',
    from: 'device-remote-1',
    fromDeviceName: 'Remote Machine',
    type: 'agent_message',
    payload,
    encrypted: false,
    sentAt: new Date().toISOString(),
  };
}

/** Create a mock cross-machine IncomingMessage */
function createCrossMachineMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'cm-msg-1',
    from: 'device-abc-123',
    fromDeviceName: 'Sams Laptop',
    type: 'cross-machine',
    payload: {
      from: 'device-abc-123',
      fromName: 'Sam',
      type: 'task-update',
      payload: {
        message: 'Feature X is complete',
      },
    },
    encrypted: false,
    sentAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageRouterService', () => {
  let router: MessageRouterService;

  beforeEach(() => {
    MessageRouterService.resetInstance();
    router = MessageRouterService.getInstance();
    jest.clearAllMocks();
    mockIsStarted.mockReturnValue(true);
    mockGetOnlineDevices.mockReturnValue([]);
    mockGetDevices.mockReturnValue([]);
  });

  afterEach(() => {
    MessageRouterService.resetInstance();
  });

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = MessageRouterService.getInstance();
      const b = MessageRouterService.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance creates a fresh instance', () => {
      const a = MessageRouterService.getInstance();
      MessageRouterService.resetInstance();
      const b = MessageRouterService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // -----------------------------------------------------------------------
  // findDeviceForSession
  // -----------------------------------------------------------------------

  describe('findDeviceForSession', () => {
    it('returns the device hosting the target session', () => {
      const device = createDevice();
      mockGetOnlineDevices.mockReturnValue([device]);

      const result = router.findDeviceForSession('crewly-product-leo-member-n');
      expect(result).toEqual(device);
    });

    it('returns null when session not found on any device', () => {
      const device = createDevice();
      mockGetOnlineDevices.mockReturnValue([device]);

      const result = router.findDeviceForSession('nonexistent-session');
      expect(result).toBeNull();
    });

    it('returns null when CloudSync is not started', () => {
      mockIsStarted.mockReturnValue(false);

      const result = router.findDeviceForSession('crewly-product-leo-member-n');
      expect(result).toBeNull();
    });

    it('returns null when devices have no teams', () => {
      const device = createDevice({ teams: undefined });
      mockGetOnlineDevices.mockReturnValue([device]);

      const result = router.findDeviceForSession('crewly-product-leo-member-n');
      expect(result).toBeNull();
    });

    it('returns null when teams have no agents', () => {
      const device = createDevice({
        teams: [{ id: 't1', name: 'Team', memberCount: 1, activeAgents: 0, agents: undefined }],
      });
      mockGetOnlineDevices.mockReturnValue([device]);

      const result = router.findDeviceForSession('crewly-product-leo-member-n');
      expect(result).toBeNull();
    });

    it('searches across multiple devices and teams', () => {
      const device1 = createDevice({ deviceId: 'dev-1', teams: [] });
      const device2 = createDevice({
        deviceId: 'dev-2',
        deviceName: 'Desktop',
        teams: [
          {
            id: 'team-2',
            name: 'Marketing',
            memberCount: 1,
            activeAgents: 1,
            agents: [{ sessionName: 'crewly-mkt-luna', role: 'researcher', workingStatus: 'idle' }],
          },
        ],
      });
      mockGetOnlineDevices.mockReturnValue([device1, device2]);

      const result = router.findDeviceForSession('crewly-mkt-luna');
      expect(result?.deviceId).toBe('dev-2');
    });
  });

  // -----------------------------------------------------------------------
  // routeRemote
  // -----------------------------------------------------------------------

  describe('routeRemote', () => {
    it('routes message to device hosting the target session', async () => {
      const device = createDevice();
      mockGetOnlineDevices.mockReturnValue([device]);
      mockGetDevices.mockReturnValue([{ deviceId: 'local-dev', deviceName: 'Local', isLocal: true }]);
      mockSendMessage.mockResolvedValue(undefined);

      const result = await router.routeRemote('crewly-product-leo-member-n', 'Hello Leo');

      expect(result.routed).toBe(true);
      expect(result.deviceId).toBe('device-remote-1');
      expect(result.deviceName).toBe('Remote Machine');
      expect(mockSendMessage).toHaveBeenCalledWith(
        'device-remote-1',
        'agent_message',
        expect.objectContaining({
          targetSession: 'crewly-product-leo-member-n',
          message: 'Hello Leo',
        }),
      );
    });

    it('returns routed:false when CloudSync is not started', async () => {
      mockIsStarted.mockReturnValue(false);

      const result = await router.routeRemote('crewly-product-leo-member-n', 'Hello');
      expect(result.routed).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('returns routed:false when session not found on any device', async () => {
      mockGetOnlineDevices.mockReturnValue([]);

      const result = await router.routeRemote('nonexistent-session', 'Hello');
      expect(result.routed).toBe(false);
      expect(result.error).toContain('not found on any online device');
    });

    it('returns routed:false when sendMessage throws', async () => {
      const device = createDevice();
      mockGetOnlineDevices.mockReturnValue([device]);
      mockGetDevices.mockReturnValue([]);
      mockSendMessage.mockRejectedValue(new Error('Network error'));

      const result = await router.routeRemote('crewly-product-leo-member-n', 'Hello');
      expect(result.routed).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('includes priority in the payload', async () => {
      const device = createDevice();
      mockGetOnlineDevices.mockReturnValue([device]);
      mockGetDevices.mockReturnValue([]);
      mockSendMessage.mockResolvedValue(undefined);

      await router.routeRemote('crewly-product-leo-member-n', 'Urgent', 'high');

      expect(mockSendMessage).toHaveBeenCalledWith(
        'device-remote-1',
        'agent_message',
        expect.objectContaining({ priority: 'high' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Incoming Message Handling
  // -----------------------------------------------------------------------

  describe('handleIncomingMessage', () => {
    it('delivers agent_message to local session via handler', async () => {
      const handler = jest.fn().mockResolvedValue({ success: true });
      router.setLocalDeliveryHandler(handler);

      const msg = createAgentMessage({
        targetSession: 'crewly-product-sam',
        message: 'Build feature X',
        fromDevice: 'dev-1',
        fromDeviceName: 'Laptop',
      });

      await router.handleIncomingMessage(msg);

      expect(handler).toHaveBeenCalledWith('crewly-product-sam', 'Build feature X');
    });

    it('ignores non-agent_message types (except cross-machine)', async () => {
      const handler = jest.fn();
      router.setLocalDeliveryHandler(handler);

      const msg: IncomingMessage = {
        id: 'msg-2',
        from: 'dev-1',
        fromDeviceName: 'Remote',
        type: 'command',
        payload: { action: 'test' },
        encrypted: false,
        sentAt: new Date().toISOString(),
      };

      await router.handleIncomingMessage(msg);
      expect(handler).not.toHaveBeenCalled();
    });

    it('warns on invalid agent_message payload', async () => {
      const handler = jest.fn();
      router.setLocalDeliveryHandler(handler);

      const msg: IncomingMessage = {
        id: 'msg-3',
        from: 'dev-1',
        fromDeviceName: 'Remote',
        type: 'agent_message',
        payload: { bad: 'payload' }, // Missing required fields
        encrypted: false,
        sentAt: new Date().toISOString(),
      };

      await router.handleIncomingMessage(msg);
      expect(handler).not.toHaveBeenCalled();
    });

    it('handles delivery handler failure gracefully', async () => {
      const handler = jest.fn().mockResolvedValue({ success: false, error: 'Session not found' });
      router.setLocalDeliveryHandler(handler);

      const msg = createAgentMessage({
        targetSession: 'missing-session',
        message: 'Hello',
        fromDevice: 'dev-1',
        fromDeviceName: 'Laptop',
      });

      // Should not throw
      await router.handleIncomingMessage(msg);
      expect(handler).toHaveBeenCalled();
    });

    it('handles delivery handler exception gracefully', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('PTY crashed'));
      router.setLocalDeliveryHandler(handler);

      const msg = createAgentMessage({
        targetSession: 'crewly-product-sam',
        message: 'Hello',
        fromDevice: 'dev-1',
        fromDeviceName: 'Laptop',
      });

      // Should not throw
      await router.handleIncomingMessage(msg);
    });

    it('logs error when no delivery handler is configured', async () => {
      // Don't set handler
      const msg = createAgentMessage({
        targetSession: 'crewly-product-sam',
        message: 'Hello',
        fromDevice: 'dev-1',
        fromDeviceName: 'Laptop',
      });

      // Should not throw
      await router.handleIncomingMessage(msg);
    });
  });

  // -----------------------------------------------------------------------
  // handleCrossMachineMessage (via handleIncomingMessage with type 'cross-machine')
  // -----------------------------------------------------------------------

  describe('handleCrossMachineMessage', () => {
    it('enqueues message with correct conversationId format (remote-{deviceId})', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage();
      await router.handleIncomingMessage(msg);

      expect(enqueueHandler).toHaveBeenCalledTimes(1);
      expect(enqueueHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'remote-device-abc-123',
        }),
      );
    });

    it('extracts fromName from payload.fromName', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage({
        from: 'dev-fallback',
        fromDeviceName: 'Fallback Device',
        payload: {
          from: 'dev-xyz',
          fromName: 'Alice',
          type: 'status',
          payload: { message: 'Done' },
        },
      });

      await router.handleIncomingMessage(msg);

      const call = enqueueHandler.mock.calls[0][0];
      expect(call.content).toContain('[REMOTE from Alice]');
    });

    it('falls back to fromDeviceName when payload.fromName is absent', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage({
        fromDeviceName: 'Bobs Desktop',
        payload: {
          from: 'dev-bob',
          // no fromName
          type: 'ping',
          payload: { message: 'Hello' },
        },
      });

      await router.handleIncomingMessage(msg);

      const call = enqueueHandler.mock.calls[0][0];
      expect(call.content).toContain('[REMOTE from Bobs Desktop]');
    });

    it('falls back to msg.from when both fromName and fromDeviceName are falsy', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg: IncomingMessage = {
        id: 'cm-2',
        from: 'device-fallback-id',
        fromDeviceName: '',
        type: 'cross-machine',
        payload: {
          from: 'device-fallback-id',
          // no fromName
          type: 'info',
          payload: { message: 'test' },
        },
        encrypted: false,
        sentAt: new Date().toISOString(),
      };

      await router.handleIncomingMessage(msg);

      const call = enqueueHandler.mock.calls[0][0];
      // Empty fromDeviceName is falsy, so falls through to msg.from
      expect(call.content).toContain('[REMOTE from device-fallback-id]');
    });

    it('extracts fromDeviceId from payload.from', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage({
        from: 'msg-level-from',
        payload: {
          from: 'payload-device-id',
          fromName: 'Test',
          type: 'update',
          payload: { message: 'content' },
        },
      });

      await router.handleIncomingMessage(msg);

      const call = enqueueHandler.mock.calls[0][0];
      expect(call.conversationId).toBe('remote-payload-device-id');
      expect(call.sourceMetadata).toEqual(
        expect.objectContaining({ fromDeviceId: 'payload-device-id' }),
      );
    });

    it('formats content as [REMOTE from {name}] ({type}) {content}', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage();
      await router.handleIncomingMessage(msg);

      const call = enqueueHandler.mock.calls[0][0];
      expect(call.content).toBe(
        '[REMOTE from Sam] (task-update) Feature X is complete',
      );
    });

    it('falls back to localDeliveryHandler when enqueueHandler is null', async () => {
      // Do NOT set enqueueHandler
      const deliveryHandler = jest.fn().mockResolvedValue({ success: true });
      router.setLocalDeliveryHandler(deliveryHandler);

      const msg = createCrossMachineMessage();
      await router.handleIncomingMessage(msg);

      expect(deliveryHandler).toHaveBeenCalledTimes(1);
      expect(deliveryHandler).toHaveBeenCalledWith(
        'crewly-orc',
        '[REMOTE from Sam] (task-update) Feature X is complete',
      );
    });

    it('handles missing payload gracefully (undefined payload)', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg: IncomingMessage = {
        id: 'cm-empty',
        from: 'device-x',
        fromDeviceName: 'Device X',
        type: 'cross-machine',
        payload: undefined,
        encrypted: false,
        sentAt: new Date().toISOString(),
      };

      // Should not throw
      await router.handleIncomingMessage(msg);

      expect(enqueueHandler).toHaveBeenCalledTimes(1);
      const call = enqueueHandler.mock.calls[0][0];
      // fromName falls back to fromDeviceName since payload is undefined
      expect(call.content).toContain('[REMOTE from Device X]');
      expect(call.conversationId).toBe('remote-device-x');
    });

    it('extracts message from inner payload.payload.message', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage({
        payload: {
          from: 'dev-1',
          fromName: 'Test',
          type: 'nested',
          payload: { message: 'inner message content' },
        },
      });

      await router.handleIncomingMessage(msg);

      const call = enqueueHandler.mock.calls[0][0];
      expect(call.content).toBe('[REMOTE from Test] (nested) inner message content');
    });

    it('falls back to payload.message when inner payload has no message', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage({
        payload: {
          from: 'dev-1',
          fromName: 'Test',
          type: 'flat',
          message: 'top-level message',
          payload: { other: 'data' },
        },
      });

      await router.handleIncomingMessage(msg);

      const call = enqueueHandler.mock.calls[0][0];
      expect(call.content).toBe('[REMOTE from Test] (flat) top-level message');
    });

    it('does nothing when neither enqueueHandler nor localDeliveryHandler is set', async () => {
      // Neither handler set -- should not throw
      const msg = createCrossMachineMessage();
      await router.handleIncomingMessage(msg);
    });
  });

  // -----------------------------------------------------------------------
  // setMessageEnqueueHandler
  // -----------------------------------------------------------------------

  describe('setMessageEnqueueHandler', () => {
    it('handler is called when cross-machine message arrives', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage();
      await router.handleIncomingMessage(msg);

      expect(enqueueHandler).toHaveBeenCalledTimes(1);
    });

    it('source metadata includes fromDeviceId, fromDeviceName, messageType', async () => {
      const enqueueHandler = jest.fn();
      router.setMessageEnqueueHandler(enqueueHandler);

      const msg = createCrossMachineMessage({
        payload: {
          from: 'device-meta-test',
          fromName: 'MetaUser',
          type: 'delegation',
          payload: { message: 'delegate this' },
        },
      });

      await router.handleIncomingMessage(msg);

      const call = enqueueHandler.mock.calls[0][0];
      expect(call.source).toBe('remote');
      expect(call.sourceMetadata).toEqual({
        fromDeviceId: 'device-meta-test',
        fromDeviceName: 'MetaUser',
        messageType: 'delegation',
      });
    });

    it('replaces previous handler when called again', async () => {
      const firstHandler = jest.fn();
      const secondHandler = jest.fn();

      router.setMessageEnqueueHandler(firstHandler);
      router.setMessageEnqueueHandler(secondHandler);

      const msg = createCrossMachineMessage();
      await router.handleIncomingMessage(msg);

      expect(firstHandler).not.toHaveBeenCalled();
      expect(secondHandler).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Listener Lifecycle
  // -----------------------------------------------------------------------

  describe('startListening / stopListening', () => {
    it('starts listening for CloudSync message events', () => {
      router.startListening();
      expect(router.isListening()).toBe(true);
      expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('does not double-register on multiple start calls', () => {
      router.startListening();
      router.startListening();
      expect(mockOn).toHaveBeenCalledTimes(1);
    });

    it('stops listening and removes event handler', () => {
      router.startListening();
      router.stopListening();
      expect(router.isListening()).toBe(false);
      expect(mockRemoveListener).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('stopListening is safe to call when not listening', () => {
      router.stopListening(); // Should not throw
      expect(mockRemoveListener).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('has expected constant values', () => {
      expect(MESSAGE_ROUTER_CONSTANTS.REMOTE_DELIVERY_TIMEOUT_MS).toBe(15_000);
      expect(MESSAGE_ROUTER_CONSTANTS.COMPONENT_NAME).toBe('MessageRouterService');
    });
  });
});
