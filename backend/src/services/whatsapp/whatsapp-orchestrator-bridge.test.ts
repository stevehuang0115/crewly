/**
 * Tests for WhatsApp-Orchestrator Bridge
 *
 * @module services/whatsapp/whatsapp-orchestrator-bridge.test
 */

import {
  WhatsAppOrchestratorBridge,
  getWhatsAppOrchestratorBridge,
  resetWhatsAppOrchestratorBridge,
} from './whatsapp-orchestrator-bridge.js';
import { getWhatsAppService, resetWhatsAppService } from './whatsapp.service.js';
import { resetChatService, getChatService } from '../chat/chat.service.js';

// Phase 6c migration — bridge now writes via chat-v2 directly
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: jest.fn(() => ({
    ensureChannelForLegacyConversation: jest.fn(() => ({ id: 'test-channel' })),
    recordTurn: jest.fn(() => ({ message: { id: 'm1' }, deduped: false })),
  })),
}));

// Mock the orchestrator status module
jest.mock('../orchestrator/index.js', () => ({
  isOrchestratorActive: jest.fn().mockResolvedValue(true),
  isAgentActive: jest.fn().mockResolvedValue(false),
  getOrchestratorOfflineMessage: jest.fn().mockReturnValue('Orchestrator is offline'),
}));

// Mock Baileys (needed by whatsapp.service.ts import)
const EventEmitter = require('events');
jest.mock('@whiskeysockets/baileys', () => ({
  default: jest.fn().mockReturnValue({
    ev: new EventEmitter(),
    sendMessage: jest.fn(),
    end: jest.fn(),
  }),
  useMultiFileAuthState: jest.fn().mockResolvedValue({
    state: {},
    saveCreds: jest.fn(),
  }),
  DisconnectReason: { loggedOut: 401 },
}));

import { isOrchestratorActive, isAgentActive, getOrchestratorOfflineMessage } from '../orchestrator/index.js';

describe('WhatsAppOrchestratorBridge', () => {
  beforeEach(() => {
    resetWhatsAppOrchestratorBridge();
    resetWhatsAppService();
    resetChatService();
    jest.clearAllMocks();
    (isOrchestratorActive as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => {
    resetWhatsAppOrchestratorBridge();
    resetWhatsAppService();
    resetChatService();
  });

  // --- Singleton ---

  describe('singleton', () => {
    it('should return same instance', () => {
      expect(getWhatsAppOrchestratorBridge()).toBe(getWhatsAppOrchestratorBridge());
    });

    it('should return WhatsAppOrchestratorBridge instance', () => {
      expect(getWhatsAppOrchestratorBridge()).toBeInstanceOf(WhatsAppOrchestratorBridge);
    });

    it('should return new instance after reset', () => {
      const b1 = getWhatsAppOrchestratorBridge();
      resetWhatsAppOrchestratorBridge();
      expect(getWhatsAppOrchestratorBridge()).not.toBe(b1);
    });
  });

  // --- initialize ---

  describe('initialize', () => {
    it('should set initialized to true', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      expect(bridge.isInitialized()).toBe(false);
      await bridge.initialize();
      expect(bridge.isInitialized()).toBe(true);
    });

    it('should be idempotent', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      await bridge.initialize();
      await bridge.initialize();
      expect(bridge.isInitialized()).toBe(true);
    });
  });

  // --- getConfig ---

  describe('getConfig', () => {
    it('should return default config', () => {
      const config = getWhatsAppOrchestratorBridge().getConfig();
      expect(config.orchestratorSession).toBeDefined();
      expect(config.maxResponseLength).toBe(3000);
      expect(config.responseTimeoutMs).toBeGreaterThan(0);
    });

    it('should merge partial config with defaults', () => {
      resetWhatsAppOrchestratorBridge();
      // Access via constructor for custom config
      const bridge = new WhatsAppOrchestratorBridge({ maxResponseLength: 5000 });
      expect(bridge.getConfig().maxResponseLength).toBe(5000);
      expect(bridge.getConfig().orchestratorSession).toBeDefined();
    });
  });

  // --- setMessageQueueService ---

  describe('setMessageQueueService', () => {
    it('should accept a message queue service', () => {
      const bridge = getWhatsAppOrchestratorBridge();
      const mockMQS = { enqueue: jest.fn() } as any;
      bridge.setMessageQueueService(mockMQS);
      // No throw
    });
  });

  // --- sendWhatsAppResponse ---

  describe('sendWhatsAppResponse', () => {
    it('should skip empty text', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      await expect(bridge.sendWhatsAppResponse('123@s.whatsapp.net', '')).resolves.toBeUndefined();
    });

    it('should skip whitespace-only text', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      await expect(bridge.sendWhatsAppResponse('123@s.whatsapp.net', '   ')).resolves.toBeUndefined();
    });

    it('should skip null text', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      await expect(bridge.sendWhatsAppResponse('123@s.whatsapp.net', null as any)).resolves.toBeUndefined();
    });

    it('should not throw when whatsapp service sendMessage fails', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();
      jest.spyOn(service, 'sendMessage').mockRejectedValueOnce(new Error('send failed'));

      await expect(
        bridge.sendWhatsAppResponse('123@s.whatsapp.net', 'hello'),
      ).resolves.toBeUndefined();
    });
  });

  // --- handleWhatsAppMessage (triggered via event) ---

  describe('handleWhatsAppMessage (via event)', () => {
    it('should route message to orchestrator and reply when MQS is configured', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();

      // Mock chatService.sendMessage
      const chatService = getChatService();
      jest.spyOn(chatService, 'sendMessage').mockResolvedValue({
        message: {} as any,
        conversation: { id: 'conv-1' } as any,
      });

      // Mock MQS — immediately resolve via the whatsappResolve callback
      const mockEnqueue = jest.fn().mockImplementation((msg) => {
        msg.sourceMetadata.whatsappResolve('Orchestrator says hi');
      });
      bridge.setMessageQueueService({ enqueue: mockEnqueue } as any);

      // Mock sendMessage on the WhatsApp service
      const sendSpy = jest.spyOn(service, 'sendMessage').mockResolvedValue();

      await bridge.initialize();

      // Trigger the message event
      const handled = new Promise<void>((resolve) => {
        bridge.once('message_handled', () => resolve());
      });

      service.emit('message', {
        messageId: 'm1',
        chatId: '555@s.whatsapp.net',
        from: '555@s.whatsapp.net',
        text: 'hello orchestrator',
        isGroup: false,
        contactName: 'Alice',
        timestamp: Date.now(),
      });

      await handled;

      expect(chatService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'hello orchestrator',
          metadata: expect.objectContaining({ source: 'whatsapp' }),
        }),
      );
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'whatsapp',
          conversationId: 'conv-1',
        }),
      );
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '555@s.whatsapp.net', text: 'Orchestrator says hi' }),
      );
    });

    it('should return offline message when orchestrator is not active', async () => {
      (isOrchestratorActive as jest.Mock).mockResolvedValue(false);

      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();
      bridge.setMessageQueueService({ enqueue: jest.fn() } as any);

      const sendSpy = jest.spyOn(service, 'sendMessage').mockResolvedValue();

      await bridge.initialize();

      const handled = new Promise<void>((resolve) => {
        bridge.once('message_handled', () => resolve());
      });

      service.emit('message', {
        messageId: 'm2', chatId: '555@s.whatsapp.net', from: '555@s.whatsapp.net',
        text: 'hi', isGroup: false, timestamp: Date.now(),
      });

      await handled;

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Orchestrator is offline' }),
      );
    });

    it('should return config error when MQS is not set', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();
      // Do NOT set MQS

      const sendSpy = jest.spyOn(service, 'sendMessage').mockResolvedValue();

      await bridge.initialize();

      const handled = new Promise<void>((resolve) => {
        bridge.once('message_handled', () => resolve());
      });

      service.emit('message', {
        messageId: 'm3', chatId: '555@s.whatsapp.net', from: '555@s.whatsapp.net',
        text: 'hi', isGroup: false, timestamp: Date.now(),
      });

      await handled;

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('not properly configured') }),
      );
    });

    it('should send error response when sendToOrchestrator throws', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();

      // Make chatService.sendMessage throw
      const chatService = getChatService();
      jest.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('DB error'));

      bridge.setMessageQueueService({ enqueue: jest.fn() } as any);

      const sendSpy = jest.spyOn(service, 'sendMessage').mockResolvedValue();

      await bridge.initialize();

      const errored = new Promise<void>((resolve) => {
        bridge.once('error', () => resolve());
      });

      service.emit('message', {
        messageId: 'm4', chatId: '555@s.whatsapp.net', from: '555@s.whatsapp.net',
        text: 'hi', isGroup: false, timestamp: Date.now(),
      });

      await errored;

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('DB error') }),
      );
    });

    it('should handle enqueue failure gracefully', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();

      const chatService = getChatService();
      jest.spyOn(chatService, 'sendMessage').mockResolvedValue({
        message: {} as any,
        conversation: { id: 'conv-2' } as any,
      });

      const mockEnqueue = jest.fn().mockImplementation(() => {
        throw new Error('Queue full');
      });
      bridge.setMessageQueueService({ enqueue: mockEnqueue } as any);

      const sendSpy = jest.spyOn(service, 'sendMessage').mockResolvedValue();

      await bridge.initialize();

      const handled = new Promise<void>((resolve) => {
        bridge.once('message_handled', () => resolve());
      });

      service.emit('message', {
        messageId: 'm5', chatId: '555@s.whatsapp.net', from: '555@s.whatsapp.net',
        text: 'hi', isGroup: false, timestamp: Date.now(),
      });

      await handled;

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Queue full') }),
      );
    });
  });

  describe('auditor fallback routing', () => {
    it('should return offline message when both orchestrator and auditor are inactive', async () => {
      (isOrchestratorActive as jest.Mock).mockResolvedValue(false);
      (isAgentActive as jest.Mock).mockResolvedValue(false);

      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();
      bridge.setMessageQueueService({ enqueue: jest.fn() } as any);

      const sendSpy = jest.spyOn(service, 'sendMessage').mockResolvedValue();

      await bridge.initialize();

      const handled = new Promise<void>((resolve) => {
        bridge.once('message_handled', () => resolve());
      });

      service.emit('message', {
        messageId: 'm-aud1', chatId: '555@s.whatsapp.net', from: '555@s.whatsapp.net',
        text: 'help', isGroup: false, timestamp: Date.now(),
      });

      await handled;

      // Both offline → should check auditor then return offline message
      expect(isAgentActive).toHaveBeenCalledWith('crewly-auditor');
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Orchestrator is offline' }),
      );
    });

    it('should route to auditor via queue when orchestrator is offline and auditor is active', async () => {
      (isOrchestratorActive as jest.Mock).mockResolvedValue(false);
      (isAgentActive as jest.Mock).mockResolvedValue(true);

      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();

      const chatService = getChatService();
      jest.spyOn(chatService, 'sendMessage').mockResolvedValue({
        message: {} as any,
        conversation: { id: 'conv-aud' } as any,
      });

      const mockEnqueue = jest.fn();
      bridge.setMessageQueueService({ enqueue: mockEnqueue } as any);

      const sendSpy = jest.spyOn(service, 'sendMessage').mockResolvedValue();

      await bridge.initialize();

      const handled = new Promise<void>((resolve) => {
        bridge.once('message_handled', () => resolve());
      });

      service.emit('message', {
        messageId: 'm-aud2', chatId: '555@s.whatsapp.net', from: '555@s.whatsapp.net',
        text: 'hello', isGroup: false, contactName: 'Alice', timestamp: Date.now(),
      });

      await handled;

      // Should route to auditor via queue with FALLBACK marker and targetSession
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          targetSession: 'crewly-auditor',
          content: expect.stringContaining('[FALLBACK]'),
        }),
      );
      // Enriched content should include contact name
      const enqueuedContent = mockEnqueue.mock.calls[0][0].content;
      expect(enqueuedContent).toContain('Alice');

      // User should get acknowledgement
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('forwarded to the Auditor') }),
      );
    });

    it('should fall back to offline message when auditor queue enqueue fails', async () => {
      (isOrchestratorActive as jest.Mock).mockResolvedValue(false);
      (isAgentActive as jest.Mock).mockResolvedValue(true);

      const bridge = getWhatsAppOrchestratorBridge();
      const service = getWhatsAppService();

      const chatService = getChatService();
      jest.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('chat error'));

      const mockEnqueue = jest.fn();
      bridge.setMessageQueueService({ enqueue: mockEnqueue } as any);

      const sendSpy = jest.spyOn(service, 'sendMessage').mockResolvedValue();

      await bridge.initialize();

      const handled = new Promise<void>((resolve) => {
        bridge.once('message_handled', () => resolve());
      });

      service.emit('message', {
        messageId: 'm-aud3', chatId: '555@s.whatsapp.net', from: '555@s.whatsapp.net',
        text: 'hi', isGroup: false, timestamp: Date.now(),
      });

      await handled;

      // When chat.sendMessage fails, fallback returns offline message
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('offline') }),
      );
    });
  });
});
