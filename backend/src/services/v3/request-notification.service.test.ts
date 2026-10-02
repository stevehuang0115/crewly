/**
 * Tests for RequestNotificationService — proactive user feedback.
 *
 * @module services/v3/request-notification.service.test
 */

import { jest } from '@jest/globals';
import { RequestNotificationService } from './request-notification.service.js';
import { RequestService } from './request.service.js';

// Mocks
const mockEventBus = {
  on: jest.fn(),
  removeAllListeners: jest.fn(),
};

const mockThreadStatusQueue = {
  getByQueueMessageId: jest.fn(),
};

const mockSlackService = {
  addReaction: jest.fn<any>().mockResolvedValue(undefined),
  sendMessage: jest.fn<any>().mockResolvedValue(undefined),
};

const mockRequestService = {
  getById: jest.fn<any>(),
};

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

jest.mock('../event-bus/index.js', () => ({
  EventBusService: jest.fn().mockImplementation(() => mockEventBus),
}));

jest.mock('../messaging/thread-status-queue.service.js', () => ({
  ThreadStatusQueueService: jest.fn().mockImplementation(() => mockThreadStatusQueue),
}));

jest.mock('../slack/slack.service.js', () => ({
  getSlackService: () => mockSlackService,
}));

jest.mock('./request.service.js', () => ({
  RequestService: {
    getInstance: () => mockRequestService,
  },
}));

describe('RequestNotificationService', () => {
  let service: RequestNotificationService;
  const projectPath = '/test/project';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestNotificationService(
      mockEventBus as any,
      mockThreadStatusQueue as any,
      projectPath
    );
  });

  describe('initialize', () => {
    it('should subscribe to v3:request_updated events', () => {
      service.initialize();
      expect(mockEventBus.on).toHaveBeenCalledWith('v3:request_updated', expect.any(Function));
    });
  });

  describe('onRequestUpdated', () => {
    // A Slack confirmation card with approve/reject buttons was specified here
    // (8be57e585) but never implemented, and no handler exists for such
    // buttons. The ticket loop (specs/ticket-loop.md, "Owner" / "Silence
    // accepts") settled on the owner accepting by replying 验过了 / 打回 in the
    // thread, with no ping on entering 待验收. This test pins that behaviour.
    it('posts nothing to Slack when a request enters waiting_confirmation (owner is not pinged)', async () => {
      const requestId = 'req-123';
      const request = {
        id: requestId,
        title: 'Test Request',
        sourceConversationItemId: 'msg-456',
        status: 'waiting_confirmation',
      };
      const threadEntry = {
        source: 'slack',
        sourceMetadata: {
          channelId: 'C123',
          ts: '123456789.000000',
        },
      };

      mockRequestService.getById.mockResolvedValue(request);
      mockThreadStatusQueue.getByQueueMessageId.mockReturnValue(threadEntry);

      // Access private method for testing
      await (service as any).onRequestUpdated({
        requestId,
        status: 'waiting_confirmation',
        previousStatus: 'running',
      });

      expect(mockSlackService.sendMessage).not.toHaveBeenCalled();
      expect(mockSlackService.addReaction).not.toHaveBeenCalled();
    });

    it('should add white_check_mark reaction when status is done', async () => {
      const requestId = 'req-123';
      const request = {
        id: requestId,
        sourceConversationItemId: 'msg-456',
        status: 'done',
      };
      const threadEntry = {
        source: 'slack',
        sourceMetadata: {
          channelId: 'C123',
          ts: '123456789.000000',
        },
      };

      mockRequestService.getById.mockResolvedValue(request);
      mockThreadStatusQueue.getByQueueMessageId.mockReturnValue(threadEntry);

      await (service as any).onRequestUpdated({
        requestId,
        status: 'done',
        previousStatus: 'waiting_confirmation',
      });

      expect(mockSlackService.addReaction).toHaveBeenCalledWith('C123', '123456789.000000', 'white_check_mark');
    });
  });
});
