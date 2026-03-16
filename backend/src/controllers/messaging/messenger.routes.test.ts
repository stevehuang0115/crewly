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

  describe('Google Chat–specific routes', () => {
    function getRouteHandler(method: string, routePath: string): (req: Request, res: Response, next: NextFunction) => void {
      const layer = (router as any).stack.find(
        (l: any) => l.route?.path === routePath && l.route?.methods?.[method]
      );
      return layer.route.stack[0].handle;
    }

    describe('POST /google-chat/reaction', () => {
      it('should call addReaction on the adapter', async () => {
        const mockAdapter = { addReaction: jest.fn().mockResolvedValue(undefined as never) };
        mockGet.mockReturnValue(mockAdapter);

        const req = mockReq({
          body: { messageName: 'spaces/X/messages/Y', emoji: '👀' },
        });
        const res = mockRes();
        const next = jest.fn() as unknown as NextFunction;

        await getRouteHandler('post', '/google-chat/reaction')(req, res, next);

        expect(mockAdapter.addReaction).toHaveBeenCalledWith('spaces/X/messages/Y', '👀');
        expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Reaction added' });
      });

      it('should return 400 when messageName is missing', async () => {
        mockGet.mockReturnValue({ addReaction: jest.fn() });

        const req = mockReq({ body: { emoji: '👀' } });
        const res = mockRes();
        const next = jest.fn() as unknown as NextFunction;

        await getRouteHandler('post', '/google-chat/reaction')(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should return 400 when emoji is missing', async () => {
        mockGet.mockReturnValue({ addReaction: jest.fn() });

        const req = mockReq({ body: { messageName: 'spaces/X/messages/Y' } });
        const res = mockRes();
        const next = jest.fn() as unknown as NextFunction;

        await getRouteHandler('post', '/google-chat/reaction')(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should return 404 when adapter is not registered', async () => {
        mockGet.mockReturnValue(undefined);

        const req = mockReq({ body: { messageName: 'spaces/X/messages/Y', emoji: '👀' } });
        const res = mockRes();
        const next = jest.fn() as unknown as NextFunction;

        await getRouteHandler('post', '/google-chat/reaction')(req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
      });
    });

    describe('GET /google-chat/status', () => {
      it('should return adapter status details', () => {
        const mockAdapter = {
          getStatus: jest.fn().mockReturnValue({
            connected: true,
            platform: 'google-chat',
            details: { mode: 'pubsub', pullActive: true },
          }),
        };
        mockGet.mockReturnValue(mockAdapter);

        const req = mockReq();
        const res = mockRes();

        getRouteHandler('get', '/google-chat/status')(req, res, jest.fn() as unknown as NextFunction);

        expect(res.json).toHaveBeenCalledWith({
          success: true,
          data: { mode: 'pubsub', pullActive: true },
        });
      });
    });

    describe('POST /google-chat/pull', () => {
      it('should call pullMessages and return count', async () => {
        const mockAdapter = { pullMessages: jest.fn().mockResolvedValue(3 as never) };
        mockGet.mockReturnValue(mockAdapter);

        const req = mockReq();
        const res = mockRes();
        const next = jest.fn() as unknown as NextFunction;

        await getRouteHandler('post', '/google-chat/pull')(req, res, next);

        expect(mockAdapter.pullMessages).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({ success: true, messagesReceived: 3 });
      });
    });

    describe('POST /google-chat/test-send', () => {
      it('should send a test message to the specified space', async () => {
        const mockAdapter = { sendMessage: jest.fn().mockResolvedValue(undefined as never) };
        mockGet.mockReturnValue(mockAdapter);

        const req = mockReq({ body: { space: 'spaces/AAAA', text: 'Test' } });
        const res = mockRes();
        const next = jest.fn() as unknown as NextFunction;

        await getRouteHandler('post', '/google-chat/test-send')(req, res, next);

        expect(mockAdapter.sendMessage).toHaveBeenCalledWith('spaces/AAAA', 'Test');
        expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Test message sent' });
      });

      it('should return 400 when space is missing', async () => {
        mockGet.mockReturnValue({ sendMessage: jest.fn() });

        const req = mockReq({ body: { text: 'Test' } });
        const res = mockRes();
        const next = jest.fn() as unknown as NextFunction;

        await getRouteHandler('post', '/google-chat/test-send')(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
      });
    });
  });
});
