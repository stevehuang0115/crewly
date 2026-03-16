/**
 * Messenger Routes Tests
 *
 * Tests for the messenger API routes (status, connect, disconnect, send).
 *
 * @module messenger-routes.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';

const mockList = jest.fn();
const mockGet = jest.fn();
const mockRegister = jest.fn();

jest.mock('../../services/messaging/messenger-registry.service.js', () => ({
  MessengerRegistryService: {
    getInstance: jest.fn(() => ({
      list: mockList,
      get: mockGet,
      register: mockRegister,
    })),
  },
}));

jest.mock('../../services/messaging/adapters/slack-messenger.adapter.js', () => ({
  SlackMessengerAdapter: jest.fn(),
}));

jest.mock('../../services/messaging/adapters/telegram-messenger.adapter.js', () => ({
  TelegramMessengerAdapter: jest.fn(),
}));

jest.mock('../../services/messaging/adapters/discord-messenger.adapter.js', () => ({
  DiscordMessengerAdapter: jest.fn(),
}));

jest.mock('../../services/messaging/adapters/google-chat-messenger.adapter.js', () => ({
  GoogleChatMessengerAdapter: jest.fn(),
}));

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined as never),
    writeFile: jest.fn().mockResolvedValue(undefined as never),
    rm: jest.fn().mockResolvedValue(undefined as never),
  },
}));

import { createMessengerRouter } from './messenger.routes.js';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as any;
  res.json = jest.fn().mockReturnValue(res) as any;
  return res as Response;
}

describe('Messenger Routes', () => {
  let router: ReturnType<typeof createMessengerRouter>;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createMessengerRouter();
  });

  it('should export a createMessengerRouter function', () => {
    expect(typeof createMessengerRouter).toBe('function');
  });

  it('should return a router with expected routes', () => {
    // Router should have route layers
    const routes = (router as any).stack
      ?.map((layer: any) => ({
        path: layer.route?.path,
        methods: layer.route?.methods,
      }))
      .filter((r: any) => r.path);

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/status' }),
        expect.objectContaining({ path: '/:platform/connect' }),
        expect.objectContaining({ path: '/:platform/disconnect' }),
        expect.objectContaining({ path: '/:platform/send' }),
      ])
    );
  });

  describe('send route field aliasing', () => {
    /** Invoke the send route handler directly from the router stack */
    function getSendHandler(): (req: Request, res: Response, next: NextFunction) => void {
      const sendLayer = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:platform/send'
      );
      return sendLayer.route.stack[0].handle;
    }

    it('should accept space as alias for channel', async () => {
      const mockAdapter = { sendMessage: jest.fn().mockResolvedValue(undefined as never) };
      mockGet.mockReturnValue(mockAdapter);

      const req = mockReq({
        params: { platform: 'google-chat' },
        body: { space: 'spaces/AAAA', text: 'hello' },
      });
      const res = mockRes();
      const next = jest.fn() as unknown as NextFunction;

      await getSendHandler()(req, res, next);

      expect(mockAdapter.sendMessage).toHaveBeenCalledWith('spaces/AAAA', 'hello', { threadId: undefined });
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Message sent' });
    });

    it('should accept threadName as alias for threadId', async () => {
      const mockAdapter = { sendMessage: jest.fn().mockResolvedValue(undefined as never) };
      mockGet.mockReturnValue(mockAdapter);

      const req = mockReq({
        params: { platform: 'google-chat' },
        body: { space: 'spaces/AAAA', text: 'hello', threadName: 'spaces/AAAA/threads/BBB' },
      });
      const res = mockRes();
      const next = jest.fn() as unknown as NextFunction;

      await getSendHandler()(req, res, next);

      expect(mockAdapter.sendMessage).toHaveBeenCalledWith(
        'spaces/AAAA',
        'hello',
        { threadId: 'spaces/AAAA/threads/BBB' },
      );
    });

    it('should prefer channel over space when both provided', async () => {
      const mockAdapter = { sendMessage: jest.fn().mockResolvedValue(undefined as never) };
      mockGet.mockReturnValue(mockAdapter);

      const req = mockReq({
        params: { platform: 'google-chat' },
        body: { channel: 'spaces/XXXX', space: 'spaces/AAAA', text: 'hello' },
      });
      const res = mockRes();
      const next = jest.fn() as unknown as NextFunction;

      await getSendHandler()(req, res, next);

      expect(mockAdapter.sendMessage).toHaveBeenCalledWith('spaces/XXXX', 'hello', { threadId: undefined });
    });

    it('should prefer threadId over threadName when both provided', async () => {
      const mockAdapter = { sendMessage: jest.fn().mockResolvedValue(undefined as never) };
      mockGet.mockReturnValue(mockAdapter);

      const req = mockReq({
        params: { platform: 'google-chat' },
        body: { channel: 'spaces/AAAA', text: 'hello', threadId: 'tid-1', threadName: 'tname-2' },
      });
      const res = mockRes();
      const next = jest.fn() as unknown as NextFunction;

      await getSendHandler()(req, res, next);

      expect(mockAdapter.sendMessage).toHaveBeenCalledWith(
        'spaces/AAAA', 'hello', { threadId: 'tid-1' },
      );
    });
  });
});
