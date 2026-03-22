/**
 * Cross-Machine Controller Tests
 *
 * Tests for the cross-machine REST API endpoints.
 *
 * @module controllers/cross-machine/cross-machine.controller.test
 */

import { createCrossMachineRouter } from './cross-machine.controller.js';
import express from 'express';
import request from 'supertest';

// Mock the service
const mockService = {
  isEnabled: jest.fn().mockReturnValue(true),
  getConfig: jest.fn().mockReturnValue({ channelId: 'C-XMACHINE', enabled: true }),
  getIdentity: jest.fn().mockReturnValue({ deviceId: 'dev-001', deviceName: 'My-Mac' }),
  initialize: jest.fn().mockResolvedValue(undefined),
  configure: jest.fn().mockResolvedValue(undefined),
  sendMessage: jest.fn().mockResolvedValue({ success: true, slackTs: '123.456' }),
};

jest.mock('../../services/slack/cross-machine-message.service.js', () => ({
  getCrossMachineMessageService: () => mockService,
}));

describe('Cross-Machine Controller', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset default mock return values
    mockService.isEnabled.mockReturnValue(true);
    mockService.getConfig.mockReturnValue({ channelId: 'C-XMACHINE', enabled: true });
    mockService.getIdentity.mockReturnValue({ deviceId: 'dev-001', deviceName: 'My-Mac' });
    mockService.sendMessage.mockResolvedValue({ success: true, slackTs: '123.456' });
    mockService.initialize.mockResolvedValue(undefined);
    mockService.configure.mockResolvedValue(undefined);

    app = express();
    app.use(express.json());
    app.use('/api/cross-machine', createCrossMachineRouter());
  });

  describe('GET /api/cross-machine/status', () => {
    it('should return status with device identity', async () => {
      const res = await request(app).get('/api/cross-machine/status');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.enabled).toBe(true);
      expect(res.body.identity.deviceId).toBe('dev-001');
      expect(res.body.config.channelId).toBe('C-XMACHINE');
    });

    it('should handle null identity gracefully', async () => {
      mockService.getIdentity.mockReturnValueOnce(null);
      const res = await request(app).get('/api/cross-machine/status');
      expect(res.status).toBe(200);
      expect(res.body.identity).toBeNull();
    });
  });

  describe('POST /api/cross-machine/configure', () => {
    it('should configure cross-machine messaging', async () => {
      const res = await request(app)
        .post('/api/cross-machine/configure')
        .send({ channelId: 'C-NEW', enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockService.configure).toHaveBeenCalledWith({
        channelId: 'C-NEW',
        enabled: true,
      });
    });

    it('should require channelId', async () => {
      const res = await request(app)
        .post('/api/cross-machine/configure')
        .send({ enabled: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('channelId');
    });

    it('should default enabled to true', async () => {
      const res = await request(app)
        .post('/api/cross-machine/configure')
        .send({ channelId: 'C-TEST' });

      expect(res.status).toBe(200);
      expect(mockService.configure).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true })
      );
    });
  });

  describe('POST /api/cross-machine/send', () => {
    it('should send a cross-machine message', async () => {
      const res = await request(app)
        .post('/api/cross-machine/send')
        .send({
          targetMachine: 'remote-device',
          type: 'delegate-task',
          message: 'Run tests',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.slackTs).toBe('123.456');
      expect(mockService.sendMessage).toHaveBeenCalledWith(
        'remote-device',
        'delegate-task',
        { message: 'Run tests' }
      );
    });

    it('should require targetMachine', async () => {
      const res = await request(app)
        .post('/api/cross-machine/send')
        .send({ type: 'ping' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('targetMachine');
    });

    it('should require type', async () => {
      const res = await request(app)
        .post('/api/cross-machine/send')
        .send({ targetMachine: 'remote' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('type');
    });

    it('should reject invalid message types', async () => {
      const res = await request(app)
        .post('/api/cross-machine/send')
        .send({ targetMachine: 'remote', type: 'invalid-type' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid type');
    });

    it('should accept all valid message types', async () => {
      const types = ['delegate-task', 'send-message', 'status-request', 'status-response', 'ping', 'pong'];
      for (const type of types) {
        mockService.sendMessage.mockResolvedValueOnce({ success: true, slackTs: '1.1' });
        const res = await request(app)
          .post('/api/cross-machine/send')
          .send({ targetMachine: 'remote', type });
        expect(res.status).toBe(200);
      }
    });

    it('should return 409 when service is not configured', async () => {
      mockService.isEnabled.mockReturnValue(false);
      const res = await request(app)
        .post('/api/cross-machine/send')
        .send({ targetMachine: 'remote', type: 'ping' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('not configured');
    });

    it('should include payload in the message', async () => {
      await request(app)
        .post('/api/cross-machine/send')
        .send({
          targetMachine: 'remote',
          type: 'delegate-task',
          payload: { task: 'Build', priority: 'high' },
        });

      expect(mockService.sendMessage).toHaveBeenCalledWith(
        'remote',
        'delegate-task',
        { task: 'Build', priority: 'high' }
      );
    });

    it('should handle send failures', async () => {
      mockService.sendMessage.mockResolvedValueOnce({ success: false, error: 'channel_not_found' });
      const res = await request(app)
        .post('/api/cross-machine/send')
        .send({ targetMachine: 'remote', type: 'ping' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('channel_not_found');
    });

    it('should support broadcast to all machines', async () => {
      await request(app)
        .post('/api/cross-machine/send')
        .send({ targetMachine: '*', type: 'ping' });

      expect(mockService.sendMessage).toHaveBeenCalledWith('*', 'ping', {});
    });
  });
});
