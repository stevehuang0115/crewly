/**
 * Tests for WhatsApp Controller
 *
 * @module controllers/whatsapp/whatsapp.controller.test
 */

import request from 'supertest';
import express from 'express';
import whatsappController from './whatsapp.controller.js';

// Mock service and bridge — define inside factories to avoid jest.mock hoisting issues
jest.mock('../../services/whatsapp/whatsapp.service.js', () => {
  const svc = {
    getStatus: jest.fn().mockReturnValue({
      connected: false, qrCode: null, phoneNumber: null,
      messagesSent: 0, messagesReceived: 0,
    }),
    isConnected: jest.fn().mockReturnValue(false),
    getQRCode: jest.fn().mockReturnValue(null),
    initialize: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    isInboxMode: jest.fn().mockReturnValue(false),
    on: jest.fn(),
    once: jest.fn(),
  };
  return {
    getWhatsAppService: jest.fn().mockReturnValue(svc),
    resetWhatsAppService: jest.fn(),
    WhatsAppService: jest.fn(),
    _testRefs: { mockService: svc },
  };
});

jest.mock('../../services/whatsapp/whatsapp-orchestrator-bridge.js', () => {
  const brg = {
    initialize: jest.fn().mockResolvedValue(undefined),
    isInitialized: jest.fn().mockReturnValue(false),
    cleanup: jest.fn(),
    setMessageQueueService: jest.fn(),
  };
  return {
    getWhatsAppOrchestratorBridge: jest.fn().mockReturnValue(brg),
    resetWhatsAppOrchestratorBridge: jest.fn(),
    WhatsAppOrchestratorBridge: jest.fn(),
    _testRefs: { mockBridge: brg },
  };
});

// Never touch the real ~/.crewly from this suite.
jest.mock('../../services/whatsapp/whatsapp-connection-config.js', () => ({
  saveWhatsAppConnection: jest.fn().mockResolvedValue(undefined),
  markWhatsAppDisconnected: jest.fn().mockResolvedValue(undefined),
  loadWhatsAppConnection: jest.fn().mockResolvedValue(null),
  toWhatsAppConfig: jest.fn(),
}));

jest.mock('@whiskeysockets/baileys', () => ({
  default: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

// Get test references after mocks are applied
const mockService = require('../../services/whatsapp/whatsapp.service.js')._testRefs.mockService;
const mockBridge = require('../../services/whatsapp/whatsapp-orchestrator-bridge.js')._testRefs.mockBridge;
const connectionConfig = require('../../services/whatsapp/whatsapp-connection-config.js');

const app = express();
app.use(express.json());
app.use('/api/whatsapp', whatsappController);
// Error handler for next(error) propagation
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, error: err.message });
});

describe('WhatsApp Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockService.isConnected.mockReturnValue(false);
    mockService.getStatus.mockReturnValue({
      connected: false, qrCode: null, phoneNumber: null,
      messagesSent: 0, messagesReceived: 0,
    });
    mockService.getQRCode.mockReturnValue(null);
    mockService.isInboxMode.mockReturnValue(false);
    mockService.once.mockImplementation(() => undefined);
  });

  // --- GET /status ---

  describe('GET /api/whatsapp/status', () => {
    it('should return disconnected status', async () => {
      const res = await request(app).get('/api/whatsapp/status');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.connected).toBe(false);
      expect(res.body.data.isConfigured).toBe(false);
    });

    it('should return connected status', async () => {
      mockService.isConnected.mockReturnValue(true);
      mockService.getStatus.mockReturnValue({
        connected: true, qrCode: null, phoneNumber: '+123',
        messagesSent: 5, messagesReceived: 3,
      });

      const res = await request(app).get('/api/whatsapp/status');
      expect(res.body.data.connected).toBe(true);
      expect(res.body.data.isConfigured).toBe(true);
      expect(res.body.data.phoneNumber).toBe('+123');
    });
  });

  // --- GET /qr ---

  describe('GET /api/whatsapp/qr', () => {
    it('should return null QR when no QR pending', async () => {
      const res = await request(app).get('/api/whatsapp/qr');
      expect(res.status).toBe(200);
      expect(res.body.data.qrCode).toBeNull();
      expect(res.body.data.connected).toBe(false);
    });

    it('should return QR code when pending', async () => {
      mockService.getQRCode.mockReturnValue('test-qr');
      const res = await request(app).get('/api/whatsapp/qr');
      expect(res.body.data.qrCode).toBe('test-qr');
    });
  });

  // --- POST /connect ---

  describe('POST /api/whatsapp/connect', () => {
    it('should return already connected when service is connected', async () => {
      mockService.isConnected.mockReturnValue(true);
      mockService.getStatus.mockReturnValue({ connected: true, qrCode: null, phoneNumber: '+1' });

      const res = await request(app).post('/api/whatsapp/connect').send({});
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('already connected');
      expect(mockService.initialize).not.toHaveBeenCalled();
    });

    it('defaults to inbox mode: initializes the service, never starts the bridge, persists the mode', async () => {
      // Simulate connected event firing immediately
      mockService.once.mockImplementation((event: string, cb: Function) => {
        if (event === 'connected') cb();
      });

      const res = await request(app).post('/api/whatsapp/connect').send({
        allowedContacts: ['+111'],
      });

      expect(res.status).toBe(200);
      expect(mockService.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ allowedContacts: ['+111'], mode: 'inbox' }),
      );
      expect(mockBridge.initialize).not.toHaveBeenCalled();
      expect(mockBridge.cleanup).toHaveBeenCalled();
      expect(connectionConfig.saveWhatsAppConnection).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'inbox' }),
        'inbox',
      );
    });

    it('starts the orchestrator bridge only in assistant mode', async () => {
      mockService.once.mockImplementation((event: string, cb: Function) => {
        if (event === 'connected') cb();
      });

      const res = await request(app).post('/api/whatsapp/connect').send({ mode: 'assistant' });

      expect(res.status).toBe(200);
      expect(mockService.initialize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'assistant' }));
      expect(mockBridge.initialize).toHaveBeenCalled();
      expect(mockBridge.cleanup).not.toHaveBeenCalled();
      expect(connectionConfig.saveWhatsAppConnection).toHaveBeenCalledWith(expect.anything(), 'assistant');
    });

    it('rejects an unknown mode with 400', async () => {
      const res = await request(app).post('/api/whatsapp/connect').send({ mode: 'autopilot' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_mode');
      expect(mockService.initialize).not.toHaveBeenCalled();
    });

    it('still connects when persisting the config fails', async () => {
      mockService.once.mockImplementation((event: string, cb: Function) => {
        if (event === 'connected') cb();
      });
      connectionConfig.saveWhatsAppConnection.mockRejectedValueOnce(new Error('disk full'));
      const res = await request(app).post('/api/whatsapp/connect').send({});
      expect(res.status).toBe(200);
    });

    it('should return QR code when qr event fires', async () => {
      mockService.once.mockImplementation((event: string, cb: Function) => {
        if (event === 'qr') cb('my-qr-code');
      });
      mockService.getStatus.mockReturnValue({ connected: false, qrCode: 'my-qr-code' });

      const res = await request(app).post('/api/whatsapp/connect').send({});
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Scan the QR code');
      expect(res.body.data.qrCode).toBe('my-qr-code');
    });

    it('should pass through initialization errors', async () => {
      mockService.initialize.mockRejectedValueOnce(new Error('init failed'));

      const res = await request(app).post('/api/whatsapp/connect').send({});
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('init failed');
    });
  });

  // --- POST /disconnect ---

  describe('POST /api/whatsapp/disconnect', () => {
    it('should disconnect successfully', async () => {
      const res = await request(app).post('/api/whatsapp/disconnect');
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('WhatsApp disconnected');
      expect(mockService.disconnect).toHaveBeenCalled();
      expect(connectionConfig.markWhatsAppDisconnected).toHaveBeenCalled();
    });

    it('should pass through disconnect errors', async () => {
      mockService.disconnect.mockRejectedValueOnce(new Error('dc error'));
      const res = await request(app).post('/api/whatsapp/disconnect');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('dc error');
    });
  });

  // --- POST /send ---

  describe('POST /api/whatsapp/send', () => {
    it('should return 400 when missing to', async () => {
      const res = await request(app).post('/api/whatsapp/send').send({ text: 'hi' });
      expect(res.status).toBe(400);
    });

    it('should return 400 when missing text', async () => {
      const res = await request(app).post('/api/whatsapp/send').send({ to: '123' });
      expect(res.status).toBe(400);
    });

    it('should return 503 when not connected', async () => {
      const res = await request(app).post('/api/whatsapp/send')
        .send({ to: '123@s.whatsapp.net', text: 'hello' });
      expect(res.status).toBe(503);
    });

    it('should send message when connected', async () => {
      mockService.isConnected.mockReturnValue(true);
      const res = await request(app).post('/api/whatsapp/send')
        .send({ to: '123@s.whatsapp.net', text: 'hello' });
      expect(res.status).toBe(200);
      expect(mockService.sendMessage).toHaveBeenCalledWith({
        to: '123@s.whatsapp.net', text: 'hello',
      });
    });

    it('refuses agent callers with 403 in inbox mode', async () => {
      mockService.isConnected.mockReturnValue(true);
      mockService.isInboxMode.mockReturnValue(true);
      const res = await request(app).post('/api/whatsapp/send')
        .set('X-Agent-Session', 'crewly-orc')
        .send({ to: '123@s.whatsapp.net', text: 'hello' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('agent_send_forbidden_in_inbox_mode');
      expect(mockService.sendMessage).not.toHaveBeenCalled();
    });

    it('lets the owner (no agent header) send in inbox mode', async () => {
      mockService.isConnected.mockReturnValue(true);
      mockService.isInboxMode.mockReturnValue(true);
      const res = await request(app).post('/api/whatsapp/send')
        .send({ to: '123@s.whatsapp.net', text: 'hello' });
      expect(res.status).toBe(200);
      expect(mockService.sendMessage).toHaveBeenCalled();
    });

    it('keeps agent sends working in assistant mode', async () => {
      mockService.isConnected.mockReturnValue(true);
      const res = await request(app).post('/api/whatsapp/send')
        .set('X-Agent-Session', 'crewly-orc')
        .send({ to: '123@s.whatsapp.net', text: 'hello' });
      expect(res.status).toBe(200);
    });

    it('should pass through sendMessage errors', async () => {
      mockService.isConnected.mockReturnValue(true);
      mockService.sendMessage.mockRejectedValueOnce(new Error('send fail'));
      const res = await request(app).post('/api/whatsapp/send')
        .send({ to: '123@s.whatsapp.net', text: 'hi' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('send fail');
    });
  });
});
