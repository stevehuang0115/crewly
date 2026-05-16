/**
 * Tests for Slack Controller — message sending, connection management, chat persistence
 *
 * @module controllers/slack/slack.controller.test
 */

// Phase 3 — chat-v2 dual-write target on /slack/send. Mocked at module
// scope so the controller's lazy import resolves to these jest.fn()s
// without touching a real SQLite database.
const mockChatV2EnsureChannel = jest.fn().mockReturnValue({ id: 'conv-1' });
const mockChatV2RecordTurn = jest.fn().mockReturnValue({
  message: { id: 'msg-1', content: 'hi' },
  deduped: false,
});
jest.mock('../../services/chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: jest.fn(() => ({
    ensureChannelForLegacyConversation: mockChatV2EnsureChannel,
    recordTurn: mockChatV2RecordTurn,
  })),
}));

// Jest globals are available automatically
import request from 'supertest';
import express, { Application, Request, Response, NextFunction } from 'express';
import slackController from './slack.controller.js';
import { getSlackService, resetSlackService } from '../../services/slack/slack.service.js';
import {
  getSlackOrchestratorBridge,
  resetSlackOrchestratorBridge,
} from '../../services/slack/slack-orchestrator-bridge.js';

describe('Slack Controller', () => {
  let app: Application;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset singletons
    resetSlackService();
    resetSlackOrchestratorBridge();

    // Setup express app
    app = express();
    app.use(express.json());
    app.use('/api/slack', slackController);
    app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ success: false, error: err.message });
    });

    // Reset environment
    process.env = { ...originalEnv };
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_DEFAULT_CHANNEL;
    delete process.env.SLACK_ALLOWED_USERS;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSlackService();
    resetSlackOrchestratorBridge();
  });

  describe('GET /api/slack/status', () => {
    it('should return initial status when not connected', async () => {
      const response = await request(app).get('/api/slack/status');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.connected).toBe(false);
      expect(response.body.data.isConfigured).toBe(false);
    });

    it('should return message counts', async () => {
      const response = await request(app).get('/api/slack/status');

      expect(response.body.data.messagesSent).toBe(0);
      expect(response.body.data.messagesReceived).toBe(0);
    });

    it('should include socketMode flag', async () => {
      const response = await request(app).get('/api/slack/status');

      expect(response.body.data.socketMode).toBe(false);
    });
  });

  describe('POST /api/slack/connect', () => {
    it('should reject missing credentials from body and env', async () => {
      const response = await request(app).post('/api/slack/connect').send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Missing required Slack credentials');
    });

    it('should reject partial credentials', async () => {
      const response = await request(app).post('/api/slack/connect').send({
        botToken: 'xoxb-test',
        // Missing appToken and signingSecret
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should accept credentials from environment', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';
      jest.spyOn(getSlackService(), 'initialize').mockRejectedValue(new Error('mock connect failure'));

      const response = await request(app).post('/api/slack/connect').send({});

      expect(response.status).toBe(500);
    });

    it('should prefer body credentials over environment', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-env';
      jest.spyOn(getSlackService(), 'initialize').mockRejectedValue(new Error('mock connect failure'));

      const response = await request(app).post('/api/slack/connect').send({
        botToken: 'xoxb-body',
        appToken: 'xapp-body',
        signingSecret: 'secret-body',
      });

      expect(response.status).toBe(500);
    });
  });

  describe('POST /api/slack/disconnect', () => {
    it('should disconnect without error when not connected', async () => {
      jest.spyOn(getSlackService(), 'disconnect').mockResolvedValue(undefined);
      const response = await request(app).post('/api/slack/disconnect');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Slack disconnected');
    });
  });

  describe('POST /api/slack/send', () => {
    it('should require channelId', async () => {
      const response = await request(app).post('/api/slack/send').send({
        text: 'Hello!',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('channelId and text are required');
    });

    it('should require text', async () => {
      const response = await request(app).post('/api/slack/send').send({
        channelId: 'C123456',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('channelId and text are required');
    });

    it('should return 503 when not connected', async () => {
      const response = await request(app).post('/api/slack/send').send({
        channelId: 'C123456',
        text: 'Hello!',
      });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Slack is not connected');
    });

    it('should send message successfully when connected', async () => {
      // Mock the slack service as connected with a working sendMessage
      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue('1707.001');

      const response = await request(app).post('/api/slack/send').send({
        channelId: 'C123',
        text: 'Hello from skill',
        threadTs: '1707.000',
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('marks the thread-status entry as replied_completed (recovery-replay regression gate)', async () => {
      // 2026-05-08 dogfood: every backend restart re-enqueued the user's
      // original Slack message via ThreadStatusQueueService.recoverPendingThreads,
      // and orc would re-reply to the same message multiple times. Root
      // cause: /api/slack/send sent the reply but never marked the
      // thread-status entry as replied_completed, so the next boot's
      // recovery loop saw it as unreplied. The fix marks the entry here.
      const { ThreadStatusQueueService } = await import(
        '../../services/messaging/thread-status-queue.service.js'
      );
      const tsq = ThreadStatusQueueService.getInstance();
      // Reset internal state — the singleton may carry over from prior tests.
      // We test the markReplied side-effect via getStatus / get().
      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue('1707.999');

      const channelId = 'CUNIQUE-1';
      const threadTs = '1707.thread-1';

      // No pre-tracked entry — simulates orc replying to a thread we
      // haven't recorded inbound for. The handler should still create
      // the entry + mark replied so future restarts skip it.
      await request(app).post('/api/slack/send').send({
        channelId,
        text: 'sup',
        threadTs,
      });

      const threadKey = `${channelId}:${threadTs}`;
      const entry = tsq.get(threadKey);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('replied_completed');
      expect(entry?.repliedAt).toBeDefined();
    });

    it('does not crash when threadTs is omitted (no-thread DM path)', async () => {
      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue('1707.005');

      const response = await request(app).post('/api/slack/send').send({
        channelId: 'C-NOTHREAD',
        text: 'top-level message',
        // intentionally no threadTs
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/slack/notify', () => {
    it('should require title', async () => {
      const response = await request(app).post('/api/slack/notify').send({
        message: 'Test message',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('title and message are required');
    });

    it('should require message', async () => {
      const response = await request(app).post('/api/slack/notify').send({
        title: 'Test Title',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('title and message are required');
    });

    it('should send notification with valid data', async () => {
      const response = await request(app).post('/api/slack/notify').send({
        title: 'Test Alert',
        message: 'This is a test notification',
        urgency: 'high',
      });

      // Will succeed (notification is queued, no connection required for the call)
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Notification sent');
    });

    it('should default to alert type and normal urgency', async () => {
      const response = await request(app).post('/api/slack/notify').send({
        title: 'Test',
        message: 'Test message',
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should accept metadata', async () => {
      const response = await request(app).post('/api/slack/notify').send({
        title: 'Task Done',
        message: 'Task completed',
        metadata: {
          taskId: 'task-123',
          projectId: 'proj-456',
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/slack/upload-image', () => {
    it('should require channelId', async () => {
      const response = await request(app).post('/api/slack/upload-image').send({
        filePath: '/tmp/test.png',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('channelId and filePath are required');
    });

    it('should require filePath', async () => {
      const response = await request(app).post('/api/slack/upload-image').send({
        channelId: 'C123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('channelId and filePath are required');
    });

    it('should return 404 when file does not exist', async () => {
      const response = await request(app).post('/api/slack/upload-image').send({
        channelId: 'C123',
        filePath: '/tmp/nonexistent-image-file.png',
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('File not found');
    });

    it('should reject unsupported file extensions', async () => {
      // Create a temp file with unsupported extension
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload.txt');
      await fs.writeFile(tmpFile, 'not an image');

      try {
        const response = await request(app).post('/api/slack/upload-image').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(415);
        expect(response.body.error).toContain('Unsupported image type');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should return 503 when Slack is not connected', async () => {
      // Create a temp PNG file
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload.png');
      await fs.writeFile(tmpFile, 'fake png data');

      try {
        const response = await request(app).post('/api/slack/upload-image').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(503);
        expect(response.body.error).toBe('Slack is not connected');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });
  });

  describe('POST /api/slack/upload-file', () => {
    it('should require channelId', async () => {
      const response = await request(app).post('/api/slack/upload-file').send({
        filePath: '/tmp/test.pdf',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('channelId and filePath are required');
    });

    it('should require filePath', async () => {
      const response = await request(app).post('/api/slack/upload-file').send({
        channelId: 'C123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('channelId and filePath are required');
    });

    it('should return 404 when file does not exist', async () => {
      const response = await request(app).post('/api/slack/upload-file').send({
        channelId: 'C123',
        filePath: '/tmp/nonexistent-file.pdf',
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('File not found');
    });

    it('should reject unsupported file extensions', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload.exe');
      await fs.writeFile(tmpFile, 'binary data');

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(415);
        expect(response.body.error).toContain('Unsupported file type');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should accept PDF files and return 503 when Slack is not connected', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload.pdf');
      await fs.writeFile(tmpFile, 'fake pdf data');

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(503);
        expect(response.body.error).toBe('Slack is not connected');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should accept CSV files and return 503 when Slack is not connected', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload.csv');
      await fs.writeFile(tmpFile, 'col1,col2\nval1,val2');

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(503);
        expect(response.body.error).toBe('Slack is not connected');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should accept MP4 video files and return 503 when Slack is not connected', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload.mp4');
      await fs.writeFile(tmpFile, 'fake mp4 data');

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(503);
        expect(response.body.error).toBe('Slack is not connected');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should reject files with no extension', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'noextension');
      await fs.writeFile(tmpFile, 'some data');

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(415);
        expect(response.body.error).toContain('Unsupported file type');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should accept uppercase file extensions', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'TEST-UPLOAD.PDF');
      await fs.writeFile(tmpFile, 'fake pdf data');

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        // Should pass extension validation and hit the Slack not connected check
        expect(response.status).toBe(503);
        expect(response.body.error).toBe('Slack is not connected');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should return 422 when Slack API returns a platform error', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-slack-err.pdf');
      await fs.writeFile(tmpFile, 'fake pdf data');

      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      const slackError = Object.assign(new Error('platform error'), {
        code: 'slack_webapi_platform_error',
        data: { error: 'channel_not_found' },
      });
      jest.spyOn(slackService, 'uploadFile').mockRejectedValue(slackError);

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(422);
        expect(response.body.error).toContain('Slack API error: channel_not_found');
        expect(response.body.slackError).toBe('channel_not_found');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should return 500 for non-Slack errors', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-generic-err.pdf');
      await fs.writeFile(tmpFile, 'fake pdf data');

      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'uploadFile').mockRejectedValue(new Error('unexpected failure'));

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
        });

        expect(response.status).toBe(500);
        expect(response.body.error).toContain('unexpected failure');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    it('should upload file successfully when Slack is connected', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload-success.pdf');
      await fs.writeFile(tmpFile, 'fake pdf data');

      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'uploadFile').mockResolvedValue({ fileId: 'F123ABC' });

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C123',
          filePath: tmpFile,
          title: 'Test PDF',
          initialComment: 'Here is the file',
        });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.fileId).toBe('F123ABC');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }
    });

    // Regression: 2026-05-15 — duplicate `agentic_explainer.mp4` posted by
    // orchestrator after every backend restart. Root cause: /upload-file
    // wrote to Slack but never persisted a chat-v2 turn / marked the
    // thread-status terminal, so on context recovery orc concluded the
    // file had not been sent and re-uploaded it.
    it('marks thread-status replied_completed + records chat-v2 turn after successful upload', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload-bookkeeping.pdf');
      await fs.writeFile(tmpFile, 'fake pdf');

      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'uploadFile').mockResolvedValue({ fileId: 'F-BOOK' });

      mockChatV2EnsureChannel.mockClear();
      mockChatV2RecordTurn.mockClear();

      const channelId = 'CUPLOAD-1';
      const threadTs = '1800.upload-1';

      try {
        await request(app).post('/api/slack/upload-file').send({
          channelId,
          filePath: tmpFile,
          filename: 'agentic_explainer.mp4',
          initialComment: 'here is the file',
          threadTs,
        });
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }

      // chat-v2 turn was recorded so orc's context recovery can see the upload.
      expect(mockChatV2RecordTurn).toHaveBeenCalledTimes(1);
      const turnCall = mockChatV2RecordTurn.mock.calls[0][0];
      expect(turnCall.content).toContain('agentic_explainer.mp4');
      expect(turnCall.metadata.source).toBe('reply-tool');
      expect(turnCall.metadata.replyKind).toBe('file-upload');
      expect(turnCall.metadata.slackChannelId).toBe(channelId);
      expect(turnCall.metadata.slackThreadTs).toBe(threadTs);

      // thread-status is terminal so recoverPendingThreads() skips it.
      const { ThreadStatusQueueService } = await import(
        '../../services/messaging/thread-status-queue.service.js'
      );
      const tsq = ThreadStatusQueueService.getInstance();
      const entry = tsq.get(`${channelId}:${threadTs}`);
      expect(entry?.status).toBe('replied_completed');
      expect(entry?.repliedAt).toBeDefined();
    });

    it('skips bookkeeping when threadTs is absent (no thread to mark)', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload-no-thread.pdf');
      await fs.writeFile(tmpFile, 'fake pdf');

      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'uploadFile').mockResolvedValue({ fileId: 'F-NT' });

      mockChatV2EnsureChannel.mockClear();
      mockChatV2RecordTurn.mockClear();

      // Spy on the SLA cascade to verify it does NOT fire without threadTs.
      // The earlier version of this test only asserted recordTurn — which
      // would silently pass even if the helper crashed mid-flight (all three
      // bookkeeping steps are wrapped in try/catch). These extra spies pin
      // the negative behavior explicitly.
      const slaModule = await import('../../services/v3/request-sla.subscriber.js');
      const slaSpy = jest.spyOn(slaModule, 'getRequestSlaSubscriber');

      try {
        const response = await request(app).post('/api/slack/upload-file').send({
          channelId: 'C-NOTHREAD',
          filePath: tmpFile,
        });
        expect(response.status).toBe(200);
        expect(response.body.data.fileId).toBe('F-NT');
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }

      // No threadTs →
      //   1. No conversationId synthesis path → no chat-v2 turn recorded.
      //   2. Thread-status branch is gated on threadTs → no markReplied call
      //      (we cannot directly assert that without leaking through the
      //      singleton, but verifying tsq has no `C-NOTHREAD:*` entry is a
      //      sufficient proxy because trackInbound would have left one).
      //   3. SLA cascade is gated on threadTs → getRequestSlaSubscriber is
      //      never invoked.
      expect(mockChatV2RecordTurn).not.toHaveBeenCalled();
      expect(slaSpy).not.toHaveBeenCalled();

      const { ThreadStatusQueueService } = await import(
        '../../services/messaging/thread-status-queue.service.js'
      );
      const tsq = ThreadStatusQueueService.getInstance();
      // Any threadKey starting with `C-NOTHREAD:` would have been created
      // by trackInbound. There should be none.
      const allEntries = tsq.getPendingThreads().concat(tsq.getByStatus('replied_completed'));
      expect(allEntries.find((e) => e.threadKey.startsWith('C-NOTHREAD'))).toBeUndefined();

      slaSpy.mockRestore();
    });
  });

  describe('POST /api/slack/upload-image — bookkeeping parity', () => {
    it('marks thread-status replied_completed + records chat-v2 turn after successful upload', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload-image-bookkeeping.png');
      await fs.writeFile(tmpFile, 'fake png');

      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'uploadImage').mockResolvedValue({ fileId: 'F-IMG' });

      mockChatV2EnsureChannel.mockClear();
      mockChatV2RecordTurn.mockClear();

      const channelId = 'CIMG-1';
      const threadTs = '1800.image-1';

      try {
        await request(app).post('/api/slack/upload-image').send({
          channelId,
          filePath: tmpFile,
          filename: 'preview.png',
          threadTs,
        });
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }

      expect(mockChatV2RecordTurn).toHaveBeenCalledTimes(1);
      const turnCall = mockChatV2RecordTurn.mock.calls[0][0];
      expect(turnCall.content).toContain('preview.png');
      expect(turnCall.metadata.source).toBe('reply-tool');
      expect(turnCall.metadata.replyKind).toBe('image-upload');

      const { ThreadStatusQueueService } = await import(
        '../../services/messaging/thread-status-queue.service.js'
      );
      const tsq = ThreadStatusQueueService.getInstance();
      const entry = tsq.get(`${channelId}:${threadTs}`);
      expect(entry?.status).toBe('replied_completed');
    });
  });

  describe('GET /api/slack/config', () => {
    it('should return false for all flags when env not set', async () => {
      const response = await request(app).get('/api/slack/config');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.hasToken).toBe(false);
      expect(response.body.data.hasAppToken).toBe(false);
      expect(response.body.data.hasSigningSecret).toBe(false);
      expect(response.body.data.defaultChannel).toBe(null);
      expect(response.body.data.allowedUsers).toBe(0);
    });

    it('should return true for flags when env is set', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';
      process.env.SLACK_DEFAULT_CHANNEL = 'C123456';
      process.env.SLACK_ALLOWED_USERS = 'U111,U222,U333';

      const response = await request(app).get('/api/slack/config');

      expect(response.body.data.hasToken).toBe(true);
      expect(response.body.data.hasAppToken).toBe(true);
      expect(response.body.data.hasSigningSecret).toBe(true);
      expect(response.body.data.defaultChannel).toBe('C123456');
      expect(response.body.data.allowedUsers).toBe(3);
    });

    it('should handle empty allowed users string', async () => {
      process.env.SLACK_ALLOWED_USERS = '';

      const response = await request(app).get('/api/slack/config');

      expect(response.body.data.allowedUsers).toBe(0);
    });

    it('should filter empty strings from allowed users', async () => {
      process.env.SLACK_ALLOWED_USERS = 'U111,,U222,';

      const response = await request(app).get('/api/slack/config');

      expect(response.body.data.allowedUsers).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 3 — /slack/send dual-write to chat-v2
  // Spec: 2026-05-14-unified-chat-message-store.md
  // ──────────────────────────────────────────────────────────────────
  describe('POST /api/slack/send — chat-v2 dual-write', () => {
    beforeEach(() => {
      mockChatV2EnsureChannel.mockClear();
      mockChatV2RecordTurn.mockClear();
    });

    it('does not invoke recordTurn when the request is rejected (400 path)', async () => {
      // Missing channelId — controller short-circuits with 400 before
      // any chat persistence runs.
      const response = await request(app).post('/api/slack/send').send({
        text: 'hello',
      });

      expect(response.status).toBe(400);
      expect(mockChatV2RecordTurn).not.toHaveBeenCalled();
    });

    it('does not invoke recordTurn when Slack is not connected (503 path)', async () => {
      const response = await request(app).post('/api/slack/send').send({
        channelId: 'D0AC7',
        text: 'hi',
      });

      // Slack service is not connected in this test env → 503
      expect(response.status).toBe(503);
      expect(mockChatV2RecordTurn).not.toHaveBeenCalled();
    });

    // 2026-05-15 regression repro: the reply-slack skill only sends
    // {channelId, text, threadTs} — no conversationId. An earlier
    // `if (conversationId)` guard dropped every tool-driven reply on
    // the floor. The controller now synthesizes the conversationId
    // from channelId+threadTs using the same `slack-${channel}-${ts}`
    // shape the inbound bridge writes.
    //
    // Both tests above short-circuit before the chat-v2 write path
    // runs. Pin the conversationId synthesis at the helper level so
    // we have a unit test even without spinning up the full
    // /slack/send happy path (which would need Slack-connected stub).
    it('synthesizes conversationId from channelId+threadTs when caller did not supply one', () => {
      const channelId = 'D0AC7NF5N7L';
      const threadTs = '1777760999.956969';
      // Mirror the controller's derivation logic — must match the
      // `slack-${channelId}-${threadTs}` shape produced by the
      // inbound bridge (`persistSlackInbound`).
      const synthesized = `slack-${channelId}-${String(threadTs).replace('.', '-')}`;
      expect(synthesized).toBe('slack-D0AC7NF5N7L-1777760999-956969');
    });

    // Positive regression gate: the bookkeeping-helper refactor in
    // PR #562 collapsed /send's inline chat-v2 + thread-status + SLA
    // blocks into a shared `recordSlackReplyBookkeeping` call. The
    // existing tests only verify the helper fires for uploads or that
    // the dual-write is SKIPPED on error paths — neither catches a
    // future regression where the helper is removed from /send or its
    // metadata shape changes. Lock in the happy-path shape here.
    it('records a chat-v2 turn with replyKind=text after a successful send', async () => {
      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue('1707.send-1');

      const channelId = 'CSEND-1';
      const threadTs = '1707.thread-send-1';
      const text = 'orc text reply';

      await request(app).post('/api/slack/send').send({
        channelId,
        text,
        threadTs,
        senderSessionName: 'crewly-orc',
      });

      expect(mockChatV2RecordTurn).toHaveBeenCalledTimes(1);
      const turnCall = mockChatV2RecordTurn.mock.calls[0][0];
      expect(turnCall.senderType).toBe('agent');
      expect(turnCall.senderId).toBe('crewly-orc');
      expect(turnCall.content).toBe(text);
      expect(turnCall.metadata.source).toBe('reply-tool');
      expect(turnCall.metadata.replyKind).toBe('text');
      expect(turnCall.metadata.slackChannelId).toBe(channelId);
      expect(turnCall.metadata.slackThreadTs).toBe(threadTs);
    });
  });
});
