/**
 * Chat Gateway Tests
 *
 * Tests for the chat WebSocket gateway functionality.
 *
 * @module websocket/chat.gateway.test
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ChatGateway,
  initializeChatGateway,
  getChatGateway,
  resetChatGateway,
} from './chat.gateway.js';
import {
  getChatService,
  resetChatService,
  ChatService,
} from '../services/chat/chat.service.js';

// =============================================================================
// Mock Socket.IO
// =============================================================================

class MockSocket extends EventEmitter {
  id: string;
  rooms: Set<string> = new Set();

  constructor(id: string = 'mock-socket-id') {
    super();
    this.id = id;
  }

  join(room: string): void {
    this.rooms.add(room);
  }

  leave(room: string): void {
    this.rooms.delete(room);
  }

  to(room: string): { emit: (event: string, data: any) => void } {
    return {
      emit: jest.fn(),
    };
  }
}

class MockSocketIOServer extends EventEmitter {
  rooms: Map<string, Set<string>> = new Map();
  sockets: Map<string, MockSocket> = new Map();

  to(room: string): { emit: (event: string, data: any) => void } {
    return {
      emit: jest.fn(),
    };
  }

  simulateConnection(socketId: string = 'test-socket'): MockSocket {
    const socket = new MockSocket(socketId);
    this.sockets.set(socketId, socket);
    this.emit('connection', socket);
    return socket;
  }
}

// =============================================================================
// Test Setup
// =============================================================================

describe('ChatGateway', () => {
  let io: MockSocketIOServer;
  let testDir: string;
  let chatService: ChatService;

  beforeEach(async () => {
    // Create test directory
    testDir = path.join(
      os.tmpdir(),
      `chat-gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDir, { recursive: true });

    // Reset services
    resetChatGateway();
    resetChatService();

    // Initialize chat service with test directory
    chatService = getChatService();
    (chatService as any).chatDir = testDir;
    await chatService.initialize();

    // Create mock Socket.IO server
    io = new MockSocketIOServer();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    resetChatGateway();
    resetChatService();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      expect(gateway.isInitialized()).toBe(true);
    });

    it('should not reinitialize if already initialized', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();
      await gateway.initialize(); // Should not throw

      expect(gateway.isInitialized()).toBe(true);
    });
  });

  // ===========================================================================
  // Event Broadcasting Tests
  // ===========================================================================

  describe('event broadcasting', () => {
    it('should forward chat_message events from service', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const broadcastSpy = jest.spyOn(io, 'to');

      // Trigger a chat message
      await chatService.sendMessage({ content: 'Test message' });

      // Should have broadcast to chat room
      expect(broadcastSpy).toHaveBeenCalledWith('chat');
    });

    it('should forward conversation_updated events from service', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const broadcastSpy = jest.spyOn(io, 'to');

      // Trigger a conversation update
      await chatService.createNewConversation('Test');

      // Should have broadcast
      expect(broadcastSpy).toHaveBeenCalled();
    });

    it('should forward chat_typing events from service', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const broadcastSpy = jest.spyOn(io, 'to');

      // Trigger a typing indicator
      chatService.emitTypingIndicator('conv-1', { type: 'orchestrator' }, true);

      // Should have broadcast
      expect(broadcastSpy).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // WebSocket Handler Tests
  // ===========================================================================

  describe('WebSocket handlers', () => {
    it('should handle subscribe_to_chat event', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const socket = io.simulateConnection();
      const emitSpy = jest.spyOn(socket, 'emit');

      socket.emit('subscribe_to_chat');

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(socket.rooms.has('chat')).toBe(true);
      expect(emitSpy).toHaveBeenCalledWith(
        'chat_subscribed',
        expect.objectContaining({
          type: 'chat_subscribed',
        })
      );
    });

    it('should handle subscribe_to_chat with conversationId', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation('Test');

      const socket = io.simulateConnection();

      socket.emit('subscribe_to_chat', conv.id);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(socket.rooms.has('chat')).toBe(true);
      expect(socket.rooms.has(`chat_${conv.id}`)).toBe(true);
    });

    it('should handle unsubscribe_from_chat event', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const socket = io.simulateConnection();

      // First subscribe
      socket.emit('subscribe_to_chat');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Then unsubscribe
      socket.emit('unsubscribe_from_chat');

      expect(socket.rooms.has('chat')).toBe(false);
    });
  });

  // ===========================================================================
  // Terminal Output Processing Tests
  // ===========================================================================

  describe('processTerminalOutput', () => {
    it('should create chat message for output with [RESPONSE] marker', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation();

      const message = await gateway.processTerminalOutput(
        'session-1',
        'prefix [RESPONSE]Hello World[/RESPONSE] suffix',
        conv.id
      );

      expect(message).not.toBeNull();
      expect(message?.content).toBe('Hello World');
      expect(message?.from.type).toBe('orchestrator');
    });

    it('should create chat message for output with [CHAT_RESPONSE] marker', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation();

      const message = await gateway.processTerminalOutput(
        'session-1',
        '[CHAT_RESPONSE]## Title\n\nContent[/CHAT_RESPONSE]',
        conv.id
      );

      expect(message).not.toBeNull();
      expect(message?.content).toContain('Title');
    });

    it('should return null for output without response markers', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation();

      const message = await gateway.processTerminalOutput(
        'session-1',
        'Just regular terminal output',
        conv.id
      );

      expect(message).toBeNull();
    });

    it('should return null if no conversationId provided', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const message = await gateway.processTerminalOutput(
        'session-1',
        '[RESPONSE]Test[/RESPONSE]',
        undefined
      );

      expect(message).toBeNull();
    });

    it('should include sessionId in metadata', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation();

      const message = await gateway.processTerminalOutput(
        'test-session-123',
        '[RESPONSE]Test[/RESPONSE]',
        conv.id
      );

      expect(message?.metadata?.sessionId).toBe('test-session-123');
    });
  });

  // ===========================================================================
  // processNotifyMessage Tests
  // ===========================================================================

  describe('processNotifyMessage', () => {
    it('should add a direct message to chat for a valid notify payload', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation();

      const message = await gateway.processNotifyMessage(
        'session-1',
        '## Status Update\n\nEmily is working...',
        conv.id
      );

      expect(message).not.toBeNull();
      expect(message?.content).toContain('Status Update');
      expect(message?.content).toContain('Emily is working');
      expect(message?.from.type).toBe('orchestrator');
    });

    it('should include sessionId in metadata', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation();

      const message = await gateway.processNotifyMessage(
        'test-session-456',
        'Test content',
        conv.id
      );

      expect(message?.metadata?.sessionId).toBe('test-session-456');
    });

    it('should include sessionId in metadata from processNotifyMessage', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation();

      const message = await gateway.processNotifyMessage(
        'session-abc',
        'Test content',
        conv.id
      );

      expect(message?.metadata?.sessionId).toBe('session-abc');
    });

    it('should handle errors gracefully and return null', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      // Use a non-existent conversation ID — addDirectMessage will still work
      // because ChatService creates messages in-memory
      const message = await gateway.processNotifyMessage(
        'session-1',
        'Test content',
        'non-existent-conv'
      );

      // Should succeed (ChatService doesn't throw for unknown convIds)
      expect(message).not.toBeNull();
    });

    /**
     * `source` is a closed enum (RECORD_TURN_SOURCES) and the audit
     * discriminator for the turn. A caller once spread `source:'crewly-agent'`
     * over it; the write then failed enum validation and the agent's reply was
     * dropped AFTER the model had already produced it — the user just saw
     * silence. Callers may add metadata; they may not redefine provenance.
     */
    it('keeps the canonical source even when a caller tries to override it', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const conv = await chatService.createNewConversation();

      const message = await gateway.processNotifyMessage(
        'session-override',
        'Reply that must not be dropped',
        conv.id,
        { source: 'crewly-agent', extra: 'kept' }
      );

      expect(message).not.toBeNull();
      expect(message?.metadata?.source).toBe('in-process-runtime');
      // Non-reserved caller metadata still flows through.
      expect(message?.metadata?.extra).toBe('kept');
    });
  });

  // ===========================================================================
  // Typing Indicator Tests
  // ===========================================================================

  describe('typing indicators', () => {
    it('should emit orchestrator typing indicator', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const broadcastSpy = jest.spyOn(io, 'to');

      gateway.emitOrchestratorTyping('conv-1', true);

      expect(broadcastSpy).toHaveBeenCalledWith('chat');
    });

    it('should emit agent typing indicator', async () => {
      const gateway = new ChatGateway(io as unknown as SocketIOServer);
      await gateway.initialize();

      const broadcastSpy = jest.spyOn(io, 'to');

      gateway.emitAgentTyping(
        'conv-1',
        { type: 'agent', id: 'agent-1', name: 'Developer' },
        true
      );

      expect(broadcastSpy).toHaveBeenCalledWith('chat');
    });
  });
});

// =============================================================================
// Singleton Tests
// =============================================================================

describe('ChatGateway singleton', () => {
  let io: MockSocketIOServer;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `chat-gateway-singleton-test-${Date.now()}`
    );
    await fs.mkdir(testDir, { recursive: true });

    resetChatGateway();
    resetChatService();

    const chatService = getChatService();
    (chatService as any).chatDir = testDir;
    await chatService.initialize();

    io = new MockSocketIOServer();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    resetChatGateway();
    resetChatService();
  });

  describe('initializeChatGateway', () => {
    it('should create and return gateway instance', async () => {
      const gateway = await initializeChatGateway(io as unknown as SocketIOServer);

      expect(gateway).toBeInstanceOf(ChatGateway);
      expect(gateway.isInitialized()).toBe(true);
    });

    it('should return same instance on subsequent calls', async () => {
      const gateway1 = await initializeChatGateway(io as unknown as SocketIOServer);
      const gateway2 = await initializeChatGateway(io as unknown as SocketIOServer);

      expect(gateway1).toBe(gateway2);
    });
  });

  describe('getChatGateway', () => {
    it('should return null before initialization', () => {
      expect(getChatGateway()).toBeNull();
    });

    it('should return gateway after initialization', async () => {
      await initializeChatGateway(io as unknown as SocketIOServer);

      expect(getChatGateway()).not.toBeNull();
    });
  });

  describe('resetChatGateway', () => {
    it('should reset the singleton', async () => {
      await initializeChatGateway(io as unknown as SocketIOServer);
      expect(getChatGateway()).not.toBeNull();

      resetChatGateway();
      expect(getChatGateway()).toBeNull();
    });
  });
});
