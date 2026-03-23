/**
 * Tests for WeChat iLink Bot Service.
 */

// Mock dependencies
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

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn(),
  unlink: jest.fn(),
}));

import { WeChatService } from './wechat.service.js';

describe('WeChatService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    WeChatService.resetInstance();
  });

  afterEach(() => {
    WeChatService.resetInstance();
  });

  it('returns singleton instance', () => {
    const a = WeChatService.getInstance();
    const b = WeChatService.getInstance();
    expect(a).toBe(b);
  });

  it('starts in disconnected state', () => {
    const service = WeChatService.getInstance();
    expect(service.isConnected()).toBe(false);
    expect(service.getStatus().state).toBe('disconnected');
  });

  it('getQRCode calls iLink API', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          qrcode_url: 'https://example.com/qr.png',
          qrcode_ticket: 'ticket-123',
        },
      }),
    });
    global.fetch = mockFetch as any;

    const service = WeChatService.getInstance();
    const result = await service.getQRCode();

    expect(result.qrcode_url).toBe('https://example.com/qr.png');
    expect(result.qrcode_ticket).toBe('ticket-123');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('get_bot_qrcode'),
      expect.any(Object),
    );
  });

  it('getQRCode throws on API error', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    global.fetch = mockFetch as any;

    const service = WeChatService.getInstance();
    await expect(service.getQRCode()).rejects.toThrow('Failed to get QR code: 500');
  });

  it('sendMessage throws when not connected', async () => {
    const service = WeChatService.getInstance();
    await expect(service.sendMessage('hello', 'ctx-token')).rejects.toThrow('WeChat is not connected');
  });

  it('disconnect resets state', () => {
    const service = WeChatService.getInstance();
    service.disconnect();
    expect(service.isConnected()).toBe(false);
    expect(service.getStatus().state).toBe('disconnected');
  });

  it('getStatus returns correct shape', () => {
    const service = WeChatService.getInstance();
    const status = service.getStatus();
    expect(status).toHaveProperty('state');
    expect(status).toHaveProperty('botName');
    expect(status).toHaveProperty('connectedAt');
  });

  it('emits disconnected event on disconnect', () => {
    const service = WeChatService.getInstance();
    const handler = jest.fn();
    service.on('disconnected', handler);
    service.disconnect();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
