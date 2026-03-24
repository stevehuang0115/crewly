/**
 * Tests for ResponseRouterService
 *
 * @module services/messaging/response-router.test
 */

import { ResponseRouterService } from './response-router.service.js';
import type { QueuedMessage } from '../../types/messaging.types.js';

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

describe('ResponseRouterService', () => {
  let router: ResponseRouterService;

  const createMessage = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id: 'msg-1',
    content: 'Hello',
    conversationId: 'conv-1',
    source: 'web_chat',
    status: 'completed',
    enqueuedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    router = new ResponseRouterService();
  });

  describe('routeResponse', () => {
    it('should handle web_chat source without error', () => {
      const message = createMessage({ source: 'web_chat' });

      expect(() => router.routeResponse(message, 'Response')).not.toThrow();
    });

    it('should call slackResolve for slack source', () => {
      const slackResolve = jest.fn();
      const message = createMessage({
        source: 'slack',
        sourceMetadata: { slackResolve },
      });

      router.routeResponse(message, 'Slack response');

      expect(slackResolve).toHaveBeenCalledWith('Slack response');
    });

    it('should handle slack source without slackResolve callback', () => {
      const message = createMessage({
        source: 'slack',
        sourceMetadata: {},
      });

      expect(() => router.routeResponse(message, 'Response')).not.toThrow();
    });

    it('should handle slack source with no sourceMetadata', () => {
      const message = createMessage({ source: 'slack' });

      expect(() => router.routeResponse(message, 'Response')).not.toThrow();
    });

    it('should handle slackResolve that throws', () => {
      const slackResolve = jest.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      const message = createMessage({
        source: 'slack',
        sourceMetadata: { slackResolve },
      });

      expect(() => router.routeResponse(message, 'Response')).not.toThrow();
      expect(slackResolve).toHaveBeenCalled();
    });

    it('should call telegramResolve for telegram source', () => {
      const telegramResolve = jest.fn();
      const message = createMessage({
        source: 'telegram',
        sourceMetadata: { telegramResolve },
      });

      router.routeResponse(message, 'Telegram response');

      expect(telegramResolve).toHaveBeenCalledWith('Telegram response');
    });

    it('should handle telegram source without telegramResolve callback', () => {
      const message = createMessage({
        source: 'telegram',
        sourceMetadata: {},
      });

      expect(() => router.routeResponse(message, 'Response')).not.toThrow();
    });

    it('should handle unknown source without error', () => {
      const message = createMessage({ source: 'unknown' as any });

      expect(() => router.routeResponse(message, 'Response')).not.toThrow();
    });
  });

  describe('routeError', () => {
    it('should handle web_chat error without error', () => {
      const message = createMessage({ source: 'web_chat' });

      expect(() => router.routeError(message, 'Something failed')).not.toThrow();
    });

    it('should call slackResolve with error prefix for slack', () => {
      const slackResolve = jest.fn();
      const message = createMessage({
        source: 'slack',
        sourceMetadata: { slackResolve },
      });

      router.routeError(message, 'Timeout');

      expect(slackResolve).toHaveBeenCalledWith('Error: Timeout');
    });

    it('should handle slack error without slackResolve', () => {
      const message = createMessage({
        source: 'slack',
        sourceMetadata: {},
      });

      expect(() => router.routeError(message, 'Timeout')).not.toThrow();
    });

    it('should call telegramResolve with error prefix for telegram', () => {
      const telegramResolve = jest.fn();
      const message = createMessage({
        source: 'telegram',
        sourceMetadata: { telegramResolve },
      });

      router.routeError(message, 'Timeout');

      expect(telegramResolve).toHaveBeenCalledWith('Error: Timeout');
    });

    it('should handle unknown source error without error', () => {
      const message = createMessage({ source: 'unknown' as any });

      expect(() => router.routeError(message, 'Error')).not.toThrow();
    });
  });

  describe('remote device routing', () => {
    it('should handle routeResponse with source=remote without throwing', () => {
      const message = createMessage({
        source: 'remote' as any,
        sourceMetadata: {
          fromDeviceId: 'device-123',
          fromDeviceName: 'Home Server',
        },
      });

      expect(() => router.routeResponse(message, 'Remote response')).not.toThrow();
    });

    it('should handle routeError with source=remote without throwing', () => {
      const message = createMessage({
        source: 'remote' as any,
        sourceMetadata: {
          fromDeviceId: 'device-456',
          fromDeviceName: 'Work Laptop',
        },
      });

      expect(() => router.routeError(message, 'Connection lost')).not.toThrow();
    });

    it('should handle routeResponse with source=remote and no sourceMetadata', () => {
      const message = createMessage({
        source: 'remote' as any,
      });

      expect(() => router.routeResponse(message, 'Response')).not.toThrow();
    });

    it('should log fromDeviceId and fromDeviceName from sourceMetadata via routeToRemoteDevice', () => {
      // Access the private logger through the mock to verify log calls
      const loggerMock = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      // Create a fresh router and override its logger via prototype access
      const testRouter = new ResponseRouterService();
      (testRouter as any).logger = loggerMock;

      const message = createMessage({
        source: 'remote' as any,
        sourceMetadata: {
          fromDeviceId: 'dev-abc-123',
          fromDeviceName: 'My MacBook',
        },
      });

      testRouter.routeResponse(message, 'Test reply');

      expect(loggerMock.info).toHaveBeenCalledWith(
        expect.stringContaining('Remote device response'),
        expect.objectContaining({
          fromDeviceId: 'dev-abc-123',
          fromDeviceName: 'My MacBook',
        })
      );
    });
  });
});
