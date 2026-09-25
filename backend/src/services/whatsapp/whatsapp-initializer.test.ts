/**
 * Tests for WhatsApp Initializer
 *
 * @module services/whatsapp/whatsapp-initializer.test
 */

import {
  isWhatsAppConfigured,
  getWhatsAppConfigFromEnv,
  getWhatsAppModeFromEnv,
  resolveStartupWhatsAppConfig,
  applyBridgeForMode,
  initializeWhatsAppIfConfigured,
  shutdownWhatsApp,
} from './whatsapp-initializer.js';
import { getWhatsAppService, resetWhatsAppService } from './whatsapp.service.js';
import { getWhatsAppOrchestratorBridge, resetWhatsAppOrchestratorBridge } from './whatsapp-orchestrator-bridge.js';

// Mock Baileys
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

// The bridge constructs ChatV2Service (SQLite) — irrelevant here, and it
// cannot open a database under the fs mock below.
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: jest.fn().mockReturnValue({}),
}));

// Persisted connection config, controlled per test.
jest.mock('./whatsapp-connection-config.js', () => ({
  loadWhatsAppConnection: jest.fn().mockResolvedValue(null),
  toWhatsAppConfig: jest.requireActual('./whatsapp-connection-config.js').toWhatsAppConfig,
}));

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
  },
}));

const { loadWhatsAppConnection: mockLoadConnection } = require('./whatsapp-connection-config.js');

describe('WhatsApp Initializer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WHATSAPP_MODE;
    resetWhatsAppService();
    resetWhatsAppOrchestratorBridge();
    jest.clearAllMocks();
    mockLoadConnection.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetWhatsAppService();
    resetWhatsAppOrchestratorBridge();
  });

  // --- isWhatsAppConfigured ---

  describe('isWhatsAppConfigured', () => {
    it('should return false when WHATSAPP_ENABLED is not set', () => {
      delete process.env.WHATSAPP_ENABLED;
      expect(isWhatsAppConfigured()).toBe(false);
    });

    it('should return false when WHATSAPP_ENABLED is "false"', () => {
      process.env.WHATSAPP_ENABLED = 'false';
      expect(isWhatsAppConfigured()).toBe(false);
    });

    it('should return true when WHATSAPP_ENABLED is "true"', () => {
      process.env.WHATSAPP_ENABLED = 'true';
      expect(isWhatsAppConfigured()).toBe(true);
    });
  });

  // --- getWhatsAppConfigFromEnv ---

  describe('getWhatsAppConfigFromEnv', () => {
    it('should return null when not configured', () => {
      delete process.env.WHATSAPP_ENABLED;
      expect(getWhatsAppConfigFromEnv()).toBeNull();
    });

    it('should return config with allowed contacts', () => {
      process.env.WHATSAPP_ENABLED = 'true';
      process.env.WHATSAPP_ALLOWED_CONTACTS = '+111,+222';
      const config = getWhatsAppConfigFromEnv();
      expect(config!.allowedContacts).toEqual(['+111', '+222']);
    });

    it('should filter empty strings from trailing comma', () => {
      process.env.WHATSAPP_ENABLED = 'true';
      process.env.WHATSAPP_ALLOWED_CONTACTS = '+111,,';
      const config = getWhatsAppConfigFromEnv();
      expect(config!.allowedContacts).toEqual(['+111']);
    });

    it('should return undefined allowedContacts when env var is not set', () => {
      process.env.WHATSAPP_ENABLED = 'true';
      delete process.env.WHATSAPP_ALLOWED_CONTACTS;
      const config = getWhatsAppConfigFromEnv();
      expect(config!.allowedContacts).toBeUndefined();
    });

    it('should include phoneNumber and authStatePath from env', () => {
      process.env.WHATSAPP_ENABLED = 'true';
      process.env.WHATSAPP_PHONE_NUMBER = '+999';
      process.env.WHATSAPP_AUTH_PATH = '/custom';
      const config = getWhatsAppConfigFromEnv();
      expect(config!.phoneNumber).toBe('+999');
      expect(config!.authStatePath).toBe('/custom');
    });
  });

  // --- initializeWhatsAppIfConfigured ---

  describe('initializeWhatsAppIfConfigured', () => {
    it('should return not attempted when not configured', async () => {
      delete process.env.WHATSAPP_ENABLED;
      const result = await initializeWhatsAppIfConfigured();
      expect(result).toEqual({ attempted: false, success: false });
    });

    it('should initialize service and bridge on success', async () => {
      process.env.WHATSAPP_ENABLED = 'true';
      const service = getWhatsAppService();
      const bridge = getWhatsAppOrchestratorBridge();

      jest.spyOn(service, 'initialize').mockResolvedValue();
      jest.spyOn(bridge, 'initialize').mockResolvedValue();

      const result = await initializeWhatsAppIfConfigured();
      expect(result).toEqual({ attempted: true, success: true });
      expect(service.initialize).toHaveBeenCalled();
      expect(bridge.initialize).toHaveBeenCalled();
    });

    it('should set messageQueueService on bridge when provided', async () => {
      process.env.WHATSAPP_ENABLED = 'true';
      const service = getWhatsAppService();
      const bridge = getWhatsAppOrchestratorBridge();

      jest.spyOn(service, 'initialize').mockResolvedValue();
      jest.spyOn(bridge, 'initialize').mockResolvedValue();
      const setMQS = jest.spyOn(bridge, 'setMessageQueueService');

      const mockMQS = { enqueue: jest.fn() } as any;
      await initializeWhatsAppIfConfigured({ messageQueueService: mockMQS });

      expect(setMQS).toHaveBeenCalledWith(mockMQS);
    });

    it('should NOT set messageQueueService when not provided', async () => {
      process.env.WHATSAPP_ENABLED = 'true';
      const service = getWhatsAppService();
      const bridge = getWhatsAppOrchestratorBridge();

      jest.spyOn(service, 'initialize').mockResolvedValue();
      jest.spyOn(bridge, 'initialize').mockResolvedValue();
      const setMQS = jest.spyOn(bridge, 'setMessageQueueService');

      await initializeWhatsAppIfConfigured();
      expect(setMQS).not.toHaveBeenCalled();
    });

    it('should return failure result when service initialization throws', async () => {
      process.env.WHATSAPP_ENABLED = 'true';
      const service = getWhatsAppService();
      jest.spyOn(service, 'initialize').mockRejectedValue(new Error('Baileys fail'));

      const result = await initializeWhatsAppIfConfigured();
      expect(result).toEqual({
        attempted: true, success: false, error: 'Baileys fail',
      });
    });

    it('should return "Unknown error" for non-Error thrown values', async () => {
      process.env.WHATSAPP_ENABLED = 'true';
      const service = getWhatsAppService();
      jest.spyOn(service, 'initialize').mockRejectedValue('string error');

      const result = await initializeWhatsAppIfConfigured();
      expect(result).toEqual({
        attempted: true, success: false, error: 'Unknown error',
      });
    });
  });

  // --- mode resolution (inbox connector) ---

  describe('getWhatsAppModeFromEnv', () => {
    it('reads a valid WHATSAPP_MODE case-insensitively', () => {
      process.env.WHATSAPP_MODE = ' Inbox ';
      expect(getWhatsAppModeFromEnv()).toBe('inbox');
    });

    it('ignores invalid or missing values', () => {
      process.env.WHATSAPP_MODE = 'autopilot';
      expect(getWhatsAppModeFromEnv()).toBeUndefined();
      delete process.env.WHATSAPP_MODE;
      expect(getWhatsAppModeFromEnv()).toBeUndefined();
    });
  });

  describe('resolveStartupWhatsAppConfig', () => {
    it('env path defaults to assistant (legacy meaning)', async () => {
      process.env.WHATSAPP_ENABLED = 'true';
      expect((await resolveStartupWhatsAppConfig())?.mode).toBe('assistant');
    });

    it('env path keeps a persisted inbox mode across restarts', async () => {
      process.env.WHATSAPP_ENABLED = 'true';
      mockLoadConnection.mockResolvedValue({ mode: 'inbox', autoConnect: false, updatedAt: 1 });
      expect((await resolveStartupWhatsAppConfig())?.mode).toBe('inbox');
    });

    it('WHATSAPP_MODE wins over the persisted mode', async () => {
      process.env.WHATSAPP_ENABLED = 'true';
      process.env.WHATSAPP_MODE = 'assistant';
      mockLoadConnection.mockResolvedValue({ mode: 'inbox', autoConnect: true, updatedAt: 1 });
      expect((await resolveStartupWhatsAppConfig())?.mode).toBe('assistant');
    });

    it('without env, reconnects a persisted dashboard connection', async () => {
      delete process.env.WHATSAPP_ENABLED;
      mockLoadConnection.mockResolvedValue({ mode: 'inbox', autoConnect: true, allowedContacts: ['+1'], updatedAt: 1 });
      expect(await resolveStartupWhatsAppConfig()).toEqual(
        expect.objectContaining({ mode: 'inbox', allowedContacts: ['+1'] }),
      );
    });

    it('without env, stays disconnected after an explicit disconnect', async () => {
      delete process.env.WHATSAPP_ENABLED;
      mockLoadConnection.mockResolvedValue({ mode: 'inbox', autoConnect: false, updatedAt: 1 });
      expect(await resolveStartupWhatsAppConfig()).toBeNull();
    });
  });

  describe('inbox mode startup', () => {
    it('does not start the orchestrator bridge in inbox mode', async () => {
      delete process.env.WHATSAPP_ENABLED;
      mockLoadConnection.mockResolvedValue({ mode: 'inbox', autoConnect: true, updatedAt: 1 });
      const service = getWhatsAppService();
      const bridge = getWhatsAppOrchestratorBridge();
      jest.spyOn(service, 'initialize').mockResolvedValue();
      const init = jest.spyOn(bridge, 'initialize').mockResolvedValue();
      const cleanup = jest.spyOn(bridge, 'cleanup');

      const result = await initializeWhatsAppIfConfigured({ messageQueueService: { enqueue: jest.fn() } as any });
      expect(result).toEqual({ attempted: true, success: true });
      expect(service.initialize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'inbox' }));
      expect(init).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalled();
    });

    it('applyBridgeForMode tears down a bridge left from an assistant session', async () => {
      const bridge = getWhatsAppOrchestratorBridge();
      jest.spyOn(bridge, 'initialize').mockResolvedValue();
      const cleanup = jest.spyOn(bridge, 'cleanup');
      await applyBridgeForMode('assistant');
      expect(bridge.initialize).toHaveBeenCalledTimes(1);
      await applyBridgeForMode('inbox');
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(bridge.initialize).toHaveBeenCalledTimes(1);
    });
  });

  // --- shutdownWhatsApp ---

  describe('shutdownWhatsApp', () => {
    it('should not throw when not connected', async () => {
      await expect(shutdownWhatsApp()).resolves.toBeUndefined();
    });

    it('should call disconnect when connected', async () => {
      const service = getWhatsAppService();
      jest.spyOn(service, 'isConnected').mockReturnValue(true);
      jest.spyOn(service, 'disconnect').mockResolvedValue();

      await shutdownWhatsApp();
      expect(service.disconnect).toHaveBeenCalled();
    });

    it('should not throw when disconnect fails', async () => {
      const service = getWhatsAppService();
      jest.spyOn(service, 'isConnected').mockReturnValue(true);
      jest.spyOn(service, 'disconnect').mockRejectedValue(new Error('fail'));

      await expect(shutdownWhatsApp()).resolves.toBeUndefined();
    });
  });
});
