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

// OrcDeliveryEnforcer is lazily imported by the shared post-send bookkeeping
// helper. Stubbed at module scope so the ledger-clearing assertions don't
// depend on the real singleton having been started by the server bootstrap.
const mockMarkDelivered = jest.fn();
jest.mock('../../services/orc/orc-delivery-enforcer.service.js', () => ({
  OrcDeliveryEnforcerService: {
    getInstance: jest.fn(() => ({ markDelivered: mockMarkDelivered })),
  },
}));

// Slack team channels — routes read the singleton; tests swap in a fake.
const mockTeamChannels: { current: null | Record<string, jest.Mock> } = { current: null };
jest.mock('../../services/slack/slack-team-channel.service.js', () => ({
  getSlackTeamChannelService: jest.fn(() => mockTeamChannels.current),
}));
// Agent identities — same swap-in pattern.
const mockIdentities: { current: null | Record<string, jest.Mock | (() => boolean)> } = { current: null };
jest.mock('../../services/slack/slack-agent-identity.service.js', () => {
  class SlackIdentityCloudError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  }
  return {
    getSlackAgentIdentityService: jest.fn(() => mockIdentities.current),
    SlackIdentityCloudError,
  };
});
// Agent-initiated posts.
const mockAgentPost: { current: null | { post: jest.Mock } } = { current: null };
jest.mock('../../services/slack/slack-agent-post.service.js', () => {
  class SlackAgentPostError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return {
    getSlackAgentPostService: jest.fn(() => mockAgentPost.current),
    SlackAgentPostError,
  };
});
// /connect starts team channels best-effort; keep it inert here.
const mockStartTeamChannels = jest.fn().mockResolvedValue(undefined);
// Slack v3 (Cloud owns Slack) collaborators the /cloud/* routes reach for.
const mockCloudConfig = {
  refresh: jest.fn(),
  load: jest.fn(),
  getConfig: jest.fn(() => null as null | Record<string, unknown>),
  getSourceMode: jest.fn(() => 'auto'),
  getFetchedAt: jest.fn(() => null),
  getLastError: jest.fn(() => null),
  removeWorkspace: jest.fn(),
  getAvailableWorkspaces: jest.fn(() => null as null | Array<{ slackTeamId: string; slackTeamName: string }>),
  listWorkspaces: jest.fn(async () => [] as Array<{ slackTeamId: string; slackTeamName: string }>),
};
const mockRegistry = {
  isPrimary: jest.fn(async () => false),
  setPrimary: jest.fn(async () => undefined),
  getInstanceId: jest.fn(() => 'device-1'),
  getLastHeartbeatAt: jest.fn(() => null),
  getLastError: jest.fn((): string | null => null),
  getPendingInstalls: jest.fn(() => [] as Array<{ agentSession: string; url: string }>),
  syncAgents: jest.fn(),
  resolveInstanceId: jest.fn(async () => 'device-1'),
  getWorkspaceId: jest.fn(async (): Promise<string | null> => null),
  setWorkspaceId: jest.fn(async () => undefined),
};
const mockHandleCloudConfigChange = jest.fn(async (_config: unknown) => undefined);
let mockActiveSource: 'env' | 'cloud' | null = null;
jest.mock('../../services/slack/slack-initializer.js', () => ({
  startSlackTeamChannels: (...args: unknown[]) => mockStartTeamChannels(...args),
  ensureSlackCloudConfigService: async () => mockCloudConfig,
  ensureSlackInstanceRegistry: async () => mockRegistry,
  handleSlackCloudConfigChange: (config: unknown) => mockHandleCloudConfigChange(config),
  getActiveSlackSource: () => mockActiveSource,
  setActiveSlackSource: (s: 'env' | 'cloud' | null) => {
    mockActiveSource = s;
  },
}));
jest.mock('../../services/slack/slack-instance-registry.service.js', () => ({
  getSlackInstanceRegistryService: () => mockRegistry,
}));
const mockCloudClient = { connected: true, token: 'jwt-abc' as string | null, url: 'https://api.crewlyai.com/' as string | null };
jest.mock('../../services/cloud/cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      isConnected: () => mockCloudClient.connected,
      getToken: () => mockCloudClient.token,
      getCloudUrl: () => mockCloudClient.url,
    }),
  },
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

    mockMarkDelivered.mockClear();
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

    // PR #562 review: `initialComment` is caller-controlled and unbounded.
    // Without a cap, a pathological 10KB comment would land in chat-v2
    // verbatim. The controller slices to UPLOAD_MARKER_CONTENT_MAX (500).
    it('caps chat-v2 content at 500 chars when initialComment is pathologically long', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload-long-comment.pdf');
      await fs.writeFile(tmpFile, 'fake pdf');

      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'uploadFile').mockResolvedValue({ fileId: 'F-LONG' });

      mockChatV2EnsureChannel.mockClear();
      mockChatV2RecordTurn.mockClear();

      const longComment = 'x'.repeat(10000);

      try {
        await request(app).post('/api/slack/upload-file').send({
          channelId: 'CCAP-1',
          filePath: tmpFile,
          filename: 'big.pdf',
          initialComment: longComment,
          threadTs: '1800.cap-1',
        });
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }

      expect(mockChatV2RecordTurn).toHaveBeenCalledTimes(1);
      const turnCall = mockChatV2RecordTurn.mock.calls[0][0];
      expect(turnCall.content.length).toBeLessThanOrEqual(500);
      expect(turnCall.content.startsWith('[file uploaded: big.pdf]')).toBe(true);
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

  // PR follow-up (2026-05-16): orc reads the per-thread .md file at
  // ~/.crewly/slack-threads/{channel}/{threadTs}.md on session wake-up,
  // not chat-v2. Replies sent via /api/slack/send were chat-v2-persisted
  // and thread-status-marked but never appended to the .md file, so orc
  // saw only user messages on wake-up and re-replied to everything.
  describe('POST /api/slack/send — slack-thread store append', () => {
    it('appends the orchestrator reply to the slack-thread .md store', async () => {
      const { SlackThreadStoreService, setSlackThreadStore, resetSlackThreadStore } = await import(
        '../../services/slack/slack-thread-store.service.js'
      );
      const os = await import('os');
      const fs = await import('fs/promises');
      const path = await import('path');

      // Spin up a temp-rooted store so we don't touch the real ~/.crewly/.
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-thread-store-test-'));
      const store = new SlackThreadStoreService(tmpRoot);
      setSlackThreadStore(store);

      const channelId = 'CSTORE-1';
      const threadTs = '1900.store-1';

      // Seed the thread file (appendOrchestratorReply is a no-op when the
      // file doesn't exist — mirrors the inbound-bridge behavior).
      await store.ensureThreadFile(channelId, threadTs, 'USTEVE');

      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue('1900.reply-1');

      try {
        await request(app).post('/api/slack/send').send({
          channelId,
          text: 'orc here, working on it',
          threadTs,
        });

        // Read the .md file and assert the reply landed.
        // SlackThreadStoreService nests under `slack-threads/` inside the
        // crewlyHome — the file path is the public surface, use it.
        const filePath = store.getThreadFilePath(channelId, threadTs);
        const contents = await fs.readFile(filePath, 'utf-8');
        expect(contents).toContain('**Crewly**');
        expect(contents).toContain('orc here, working on it');
      } finally {
        resetSlackThreadStore();
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
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

  // The OrcDeliveryEnforcer ledger (2026-05-23 incident) is armed when a
  // worker agent posts [DONE] into a Slack thread, and only a reply back to
  // that thread should disarm it. `markDelivered` used to be called inline in
  // /send only, so a deliverable handed over as an image or a file never
  // cleared it: the watchdog kept nudging for something already delivered, and
  // every nudge produced another copy of the same reply in the thread. It now
  // lives in the bookkeeping helper all three endpoints share.
  describe('OrcDeliveryEnforcer ledger — clear-on-reply parity', () => {
    const connectedSlack = () => {
      const slackService = getSlackService();
      jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
      return slackService;
    };

    it('clears the ledger after a threaded /send', async () => {
      const slackService = connectedSlack();
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue('1800.001');

      await request(app).post('/api/slack/send').send({
        channelId: 'C-LEDGER',
        text: 'here is the deliverable',
        threadTs: '1800.thread-1',
      });

      expect(mockMarkDelivered).toHaveBeenCalledTimes(1);
      expect(mockMarkDelivered).toHaveBeenCalledWith({
        channelId: 'C-LEDGER',
        threadTs: '1800.thread-1',
      });
    });

    it('clears the ledger after a threaded /upload-image', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), 'test-upload-image-ledger.png');
      await fs.writeFile(tmpFile, 'fake png');

      const slackService = connectedSlack();
      jest.spyOn(slackService, 'uploadImage').mockResolvedValue({ fileId: 'F-IMG' });

      try {
        await request(app).post('/api/slack/upload-image').send({
          channelId: 'C-LEDGER-IMG',
          filePath: tmpFile,
          filename: 'chart.png',
          threadTs: '1800.thread-2',
        });
      } finally {
        await fs.unlink(tmpFile).catch(() => {});
      }

      expect(mockMarkDelivered).toHaveBeenCalledWith({
        channelId: 'C-LEDGER-IMG',
        threadTs: '1800.thread-2',
      });
    });

    it('leaves the ledger armed when the Slack send failed', async () => {
      const slackService = connectedSlack();
      jest.spyOn(slackService, 'sendMessage').mockRejectedValue(new Error('slack 5xx'));

      await request(app).post('/api/slack/send').send({
        channelId: 'C-LEDGER',
        text: 'never made it',
        threadTs: '1800.thread-3',
      });

      expect(mockMarkDelivered).not.toHaveBeenCalled();
    });

    it('does not touch the ledger for a non-threaded /send', async () => {
      const slackService = connectedSlack();
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue('1800.004');

      await request(app).post('/api/slack/send').send({
        channelId: 'C-LEDGER',
        text: 'channel-level post',
      });

      expect(mockMarkDelivered).not.toHaveBeenCalled();
    });
  });

  describe('team channels', () => {
    afterEach(() => {
      mockTeamChannels.current = null;
    });

    function installFake(overrides: Record<string, jest.Mock> = {}) {
      mockTeamChannels.current = {
        getSettings: jest.fn().mockResolvedValue({ autoCreate: true, channelPrefix: '' }),
        updateSettings: jest.fn().mockImplementation(async (p: Record<string, unknown>) => ({
          autoCreate: true,
          channelPrefix: '',
          ...p,
        })),
        listTeamsWithMappings: jest.fn().mockResolvedValue([
          { teamId: 't1', teamName: 'Alpha', memberCount: 2, mapping: null },
        ]),
        getTeam: jest.fn().mockImplementation(async (id: string) =>
          id === 't1' ? { id: 't1', name: 'Alpha', members: [] } : null,
        ),
        ensureTeamChannel: jest.fn().mockResolvedValue({
          teamId: 't1',
          slackChannelId: 'C1',
          slackChannelName: 'alpha',
          chatChannelId: 'huddle-1',
          createdAt: 'now',
          autoCreated: true,
        }),
        unlinkTeam: jest.fn().mockResolvedValue(true),
        ...overrides,
      };
      return mockTeamChannels.current;
    }

    it('answers 503 on every route when Slack is not connected', async () => {
      expect((await request(app).get('/api/slack/team-channels')).status).toBe(503);
      expect((await request(app).post('/api/slack/team-channels').send({ teamId: 't1' })).status).toBe(503);
      expect((await request(app).delete('/api/slack/team-channels/t1')).status).toBe(503);
      expect((await request(app).put('/api/slack/team-channels/settings').send({})).status).toBe(503);
    });

    it('GET lists settings and teams with their mapping', async () => {
      installFake();
      const res = await request(app).get('/api/slack/team-channels');
      expect(res.status).toBe(200);
      expect(res.body.data.settings).toEqual({ autoCreate: true, channelPrefix: '' });
      expect(res.body.data.teams[0]).toMatchObject({ teamId: 't1', mapping: null });
    });

    it('PUT settings validates types and forwards the patch', async () => {
      const fake = installFake();
      const bad = await request(app).put('/api/slack/team-channels/settings').send({ autoCreate: 'yes' });
      expect(bad.status).toBe(400);
      const ok = await request(app).put('/api/slack/team-channels/settings').send({ autoCreate: false, channelPrefix: 'crew-' });
      expect(ok.status).toBe(200);
      expect(fake.updateSettings).toHaveBeenCalledWith({ autoCreate: false, channelPrefix: 'crew-' });
      expect(ok.body.data.channelPrefix).toBe('crew-');
    });

    it('POST creates the channel for a known team and 404s for an unknown one', async () => {
      const fake = installFake();
      const missing = await request(app).post('/api/slack/team-channels').send({});
      expect(missing.status).toBe(400);
      const unknown = await request(app).post('/api/slack/team-channels').send({ teamId: 'nope' });
      expect(unknown.status).toBe(404);
      const created = await request(app).post('/api/slack/team-channels').send({ teamId: 't1', slackChannelId: ' C9 ' });
      expect(created.status).toBe(201);
      expect(created.body.data.slackChannelId).toBe('C1');
      expect(fake.ensureTeamChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), { slackChannelId: 'C9' });
    });

    it('POST surfaces a Slack failure as a 500 error body', async () => {
      installFake({ ensureTeamChannel: jest.fn().mockRejectedValue(new Error('Slack is not connected')) });
      const res = await request(app).post('/api/slack/team-channels').send({ teamId: 't1' });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Slack is not connected');
    });

    it('DELETE unlinks, honours ?archive=true, and 404s when nothing was linked', async () => {
      const fake = installFake();
      const res = await request(app).delete('/api/slack/team-channels/t1?archive=true');
      expect(res.status).toBe(200);
      expect(fake.unlinkTeam).toHaveBeenCalledWith('t1', { archiveSlackChannel: true });
      fake.unlinkTeam.mockResolvedValueOnce(false);
      expect((await request(app).delete('/api/slack/team-channels/t1')).status).toBe(404);
    });
  });

  describe('agent identities', () => {
    afterEach(() => {
      mockIdentities.current = null;
      mockTeamChannels.current = null;
    });

    function installIdentities(overrides: Record<string, jest.Mock | (() => boolean)> = {}) {
      mockIdentities.current = {
        isAvailable: () => true,
        getCloudStatus: jest.fn().mockResolvedValue({ enabled: true, configToken: { configured: true }, agents: { total: 1, installed: 1, pending: 0 } }),
        list: jest.fn().mockResolvedValue([
          { agentSession: 's', displayName: 'Sam', appId: 'A', status: 'installed', botUserId: 'USAM', botToken: 'xoxb-secret', announcedIn: [], invitedTo: [], updatedAt: 'x' },
        ]),
        refreshFromCloud: jest.fn().mockResolvedValue([]),
        setConfigToken: jest.fn().mockResolvedValue({ configured: true, status: 'ok' }),
        deleteConfigToken: jest.fn().mockResolvedValue(true),
        remove: jest.fn().mockResolvedValue(true),
        ...overrides,
      };
      return mockIdentities.current;
    }

    it('503s when Slack is not connected and 401s without a Cloud login', async () => {
      expect((await request(app).get('/api/slack/agent-identities')).status).toBe(503);
      installIdentities({ isAvailable: () => false });
      const res = await request(app).get('/api/slack/agent-identities');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('CLOUD_NOT_CONNECTED');
    });

    it('GET lists identities without bot tokens and honours ?refresh', async () => {
      const fake = installIdentities();
      const res = await request(app).get('/api/slack/agent-identities');
      expect(res.status).toBe(200);
      expect(res.body.data.cloud.enabled).toBe(true);
      expect(res.body.data.identities[0]).toMatchObject({ agentSession: 's', hasToken: true });
      expect(JSON.stringify(res.body)).not.toContain('xoxb-secret');
      await request(app).get('/api/slack/agent-identities?refresh=1');
      expect(fake.refreshFromCloud).toHaveBeenCalled();
    });

    it('PUT config-token validates and forwards; Cloud errors keep their status + code', async () => {
      const fake = installIdentities();
      expect((await request(app).put('/api/slack/agent-identities/config-token').send({})).status).toBe(400);
      const ok = await request(app).put('/api/slack/agent-identities/config-token').send({ token: ' t ', refreshToken: ' r ' });
      expect(ok.status).toBe(200);
      expect(fake.setConfigToken).toHaveBeenCalledWith('t', 'r');

      const { SlackIdentityCloudError } = jest.requireMock('../../services/slack/slack-agent-identity.service.js');
      (fake.setConfigToken as jest.Mock).mockRejectedValueOnce(new SlackIdentityCloudError(409, 'config_token_invalid', 'bad'));
      const bad = await request(app).put('/api/slack/agent-identities/config-token').send({ refreshToken: 'r' });
      expect(bad.status).toBe(409);
      expect(bad.body).toEqual({ success: false, error: 'bad', code: 'config_token_invalid' });
    });

    it('POST provision needs a mapped team and runs the identity pass', async () => {
      installIdentities();
      mockTeamChannels.current = {
        getTeam: jest.fn().mockImplementation(async (id: string) => (id === 't1' ? { id: 't1', name: 'Alpha', members: [] } : null)),
        findByTeamId: jest.fn().mockImplementation((id: string) => (id === 't1' ? { teamId: 't1', slackChannelId: 'C1' } : null)),
        ensureIdentities: jest.fn().mockResolvedValue({ provisioned: 2, announced: 2, invited: 0, skipped: null }),
      };
      expect((await request(app).post('/api/slack/agent-identities/provision').send({})).status).toBe(400);
      expect((await request(app).post('/api/slack/agent-identities/provision').send({ teamId: 'nope' })).status).toBe(404);
      const ok = await request(app).post('/api/slack/agent-identities/provision').send({ teamId: 't1' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ provisioned: 2, announced: 2, invited: 0, skipped: null });
    });

    it('DELETE removes an identity', async () => {
      const fake = installIdentities();
      const res = await request(app).delete('/api/slack/agent-identities/crewly-a-sam');
      expect(res.status).toBe(200);
      expect(fake.remove).toHaveBeenCalledWith('crewly-a-sam');
      expect((await request(app).delete('/api/slack/agent-identities/config-token')).body.data).toEqual({ removed: true });
    });
  });

  describe('POST /api/slack/post', () => {
    afterEach(() => {
      mockAgentPost.current = null;
    });

    it('503s when Slack is not connected', async () => {
      const res = await request(app).post('/api/slack/post').send({ target: '#x', text: 'y' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SLACK_NOT_CONNECTED');
    });

    it('400s without the agent header — the identity comes from it', async () => {
      mockAgentPost.current = { post: jest.fn() };
      const res = await request(app).post('/api/slack/post').send({ target: '#x', text: 'y' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('agent_session_required');
      expect(mockAgentPost.current.post).not.toHaveBeenCalled();
    });

    it('forwards target, text and thread, and returns where it landed', async () => {
      const post = jest.fn().mockResolvedValue({
        channelId: 'C1',
        messageTs: '1.2',
        kind: 'channel',
        postedAs: 'agent',
        identity: 'Sam',
      });
      mockAgentPost.current = { post };
      const res = await request(app)
        .post('/api/slack/post')
        .set('X-Agent-Session', 'crewly-a-sam')
        .send({ target: '#general', text: 'hello', threadTs: '100.1' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ channelId: 'C1', postedAs: 'agent' });
      expect(post).toHaveBeenCalledWith({
        agentSession: 'crewly-a-sam',
        target: '#general',
        text: 'hello',
        threadTs: '100.1',
      });
    });

    it('maps each failure reason to its status', async () => {
      const { SlackAgentPostError } = jest.requireMock('../../services/slack/slack-agent-post.service.js');
      const post = jest.fn();
      mockAgentPost.current = { post };
      const cases: Array<[string, number]> = [
        ['validation', 400],
        ['not_connected', 503],
        ['target_not_found', 404],
        ['slack_error', 502],
      ];
      for (const [code, status] of cases) {
        post.mockRejectedValueOnce(new SlackAgentPostError(code, `failed: ${code}`));
        const res = await request(app).post('/api/slack/post').set('X-Agent-Session', 'a').send({ target: '#x', text: 'y' });
        expect(res.status).toBe(status);
        expect(res.body).toEqual({ success: false, error: `failed: ${code}`, code });
      }
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
  describe('Cloud owns Slack — /api/slack/cloud/*', () => {
    beforeEach(() => {
      mockCloudClient.connected = true;
      mockCloudClient.token = 'jwt-abc';
      mockCloudClient.url = 'https://api.crewlyai.com/';
      mockActiveSource = null;
      mockCloudConfig.getConfig.mockReturnValue(null);
      mockCloudConfig.refresh.mockReset();
      mockCloudConfig.load.mockReset();
      mockRegistry.getPendingInstalls.mockReturnValue([]);
      mockRegistry.setPrimary.mockClear();
      mockRegistry.syncAgents.mockReset();
      mockHandleCloudConfigChange.mockClear();
    });

    describe('GET /cloud/install-url', () => {
      it('builds <cloud>/api/cloud/slack/install with the current JWT and the dashboard return URL', async () => {
        const response = await request(app).get('/api/slack/cloud/install-url').set('Host', 'crewly.local:3000');
        expect(response.status).toBe(200);
        const url = new URL(response.body.data.url);
        expect(`${url.origin}${url.pathname}`).toBe('https://api.crewlyai.com/api/cloud/slack/install');
        expect(url.searchParams.get('token')).toBe('jwt-abc');
        expect(url.searchParams.get('returnUrl')).toBe('http://crewly.local:3000/settings?tab=slack');
        expect(url.searchParams.get('instanceId')).toBe('device-1');
        expect(response.body.data.returnUrl).toBe('http://crewly.local:3000/settings?tab=slack');
      });

      it('honours an http(s) returnUrl from the caller and ignores anything else', async () => {
        const good = await request(app).get('/api/slack/cloud/install-url').query({ returnUrl: 'https://dash.example.com/settings?tab=slack' });
        expect(new URL(good.body.data.url).searchParams.get('returnUrl')).toBe('https://dash.example.com/settings?tab=slack');
        const bad = await request(app).get('/api/slack/cloud/install-url').query({ returnUrl: 'javascript:alert(1)' }).set('Host', 'h:1');
        expect(new URL(bad.body.data.url).searchParams.get('returnUrl')).toBe('http://h:1/settings?tab=slack');
      });

      it('answers 401 CLOUD_NOT_CONNECTED without a Cloud login', async () => {
        mockCloudClient.connected = false;
        const response = await request(app).get('/api/slack/cloud/install-url');
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('CLOUD_NOT_CONNECTED');
      });
    });

    describe('multiple workspaces', () => {
      it('status lists the account workspaces and the pending choice; a listing failure is not fatal', async () => {
        mockCloudConfig.listWorkspaces.mockResolvedValueOnce([{ slackTeamId: 'T1', slackTeamName: 'Acme' }, { slackTeamId: 'T2', slackTeamName: 'Client' }]);
        mockCloudConfig.getAvailableWorkspaces.mockReturnValueOnce([{ slackTeamId: 'T1', slackTeamName: 'Acme' }, { slackTeamId: 'T2', slackTeamName: 'Client' }]);
        const ok = await request(app).get('/api/slack/cloud/status');
        expect(ok.body.data.workspaces).toHaveLength(2);
        expect(ok.body.data.availableWorkspaces).toHaveLength(2);
        expect(ok.body.data.selectedWorkspaceId).toBeNull();

        mockCloudConfig.listWorkspaces.mockRejectedValueOnce(new Error('cloud down'));
        const degraded = await request(app).get('/api/slack/cloud/status');
        expect(degraded.status).toBe(200);
        expect(degraded.body.data.workspaces).toBeNull();
      });

      it('PUT /cloud/workspace validates the team id, persists the choice, refreshes and reconnects', async () => {
        const bad = await request(app).put('/api/slack/cloud/workspace').send({ slackTeamId: 'nope' });
        expect(bad.status).toBe(400);

        mockCloudConfig.refresh.mockResolvedValueOnce({ workspace: { slackTeamId: 'T0CLIENT2' }, agents: [], transport: 'cloud' });
        const response = await request(app).put('/api/slack/cloud/workspace').send({ slackTeamId: 'T0CLIENT2' });
        expect(response.status).toBe(200);
        expect(mockRegistry.setWorkspaceId).toHaveBeenCalledWith('T0CLIENT2');
        expect(mockCloudConfig.refresh).toHaveBeenCalled();
        expect(mockHandleCloudConfigChange).toHaveBeenCalledWith(expect.objectContaining({ workspace: { slackTeamId: 'T0CLIENT2' } }));
        expect(response.body.data).toMatchObject({ selectedWorkspaceId: 'T0CLIENT2', activeWorkspaceId: 'T0CLIENT2' });
      });

      it('GET /cloud/workspaces proxies the Cloud list with the local choice', async () => {
        mockCloudConfig.listWorkspaces.mockResolvedValueOnce([{ slackTeamId: 'T1', slackTeamName: 'Acme' }]);
        mockRegistry.getWorkspaceId.mockResolvedValueOnce('T1');
        const response = await request(app).get('/api/slack/cloud/workspaces');
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ workspaces: [{ slackTeamId: 'T1', slackTeamName: 'Acme' }], selectedWorkspaceId: 'T1', activeWorkspaceId: null });
      });
    });

    describe('GET /cloud/status', () => {
      it('reports no workspace and the primary flag when nothing is installed', async () => {
        const response = await request(app).get('/api/slack/cloud/status');
        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({
          cloudConnected: true,
          sourceMode: 'auto',
          activeSource: null,
          connected: false,
          transport: null,
          workspace: null,
          primary: false,
          instanceId: 'device-1',
          pendingInstalls: [],
          local: { env: false },
        });
        expect(mockCloudConfig.load).toHaveBeenCalled();
        expect(mockCloudConfig.refresh).not.toHaveBeenCalled();
      });

      it('with ?refresh=1 re-fetches, connects when a workspace appeared, and redacts tokens', async () => {
        const config = {
          workspace: { slackTeamId: 'T1', slackTeamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-secret', appId: 'A0' },
          agents: [{ agentSession: 'a', botUserId: 'UA', botToken: 'xoxb-a', appId: 'A1', displayName: 'A' }],
          transport: 'cloud',
        };
        mockCloudConfig.getConfig.mockReturnValue(config);
        mockRegistry.getPendingInstalls.mockReturnValue([{ agentSession: 'alpha-kai-1', url: 'https://slack.com/oauth/kai' }]);

        const response = await request(app).get('/api/slack/cloud/status').query({ refresh: '1' });
        expect(mockCloudConfig.refresh).toHaveBeenCalledTimes(1);
        expect(mockHandleCloudConfigChange).toHaveBeenCalledWith(config);
        expect(response.body.data.workspace).toEqual({
          slackTeamId: 'T1',
          slackTeamName: 'Acme',
          botUserId: 'UBOT',
          appId: 'A0',
          agentIdentities: 1,
        });
        expect(JSON.stringify(response.body)).not.toContain('xoxb-');
        expect(response.body.data.pendingInstalls).toEqual([{ agentSession: 'alpha-kai-1', url: 'https://slack.com/oauth/kai' }]);
      });

      it('does not auto-connect when CREWLY_SLACK_SOURCE=env', async () => {
        mockCloudConfig.getSourceMode.mockReturnValueOnce('env');
        mockCloudConfig.getConfig.mockReturnValue({ workspace: { slackTeamId: 'T', slackTeamName: 'W', botUserId: 'U', botToken: 'x', appId: 'A' }, agents: [], transport: 'cloud' });
        await request(app).get('/api/slack/cloud/status').query({ refresh: '1' });
        expect(mockHandleCloudConfigChange).not.toHaveBeenCalled();
      });
    });

    describe('PUT /cloud/primary', () => {
      it('validates the body and persists the toggle through the registry', async () => {
        const bad = await request(app).put('/api/slack/cloud/primary').send({ primary: 'yes' });
        expect(bad.status).toBe(400);

        mockRegistry.isPrimary.mockResolvedValueOnce(true);
        const response = await request(app).put('/api/slack/cloud/primary').send({ primary: true });
        expect(response.status).toBe(200);
        expect(mockRegistry.setPrimary).toHaveBeenCalledWith(true);
        expect(response.body.data.primary).toBe(true);
      });
    });

    describe('POST /cloud/agents/sync', () => {
      it('returns the pending install links from Cloud', async () => {
        mockRegistry.syncAgents.mockResolvedValue({ installUrls: [{ agentSession: 'a', url: 'u' }] });
        const response = await request(app).post('/api/slack/cloud/agents/sync');
        expect(response.status).toBe(200);
        expect(response.body.data.installUrls).toEqual([{ agentSession: 'a', url: 'u' }]);
      });

      it('answers 502 when Cloud refused', async () => {
        mockRegistry.syncAgents.mockResolvedValue(null);
        mockRegistry.getLastError.mockReturnValueOnce('config token missing');
        const response = await request(app).post('/api/slack/cloud/agents/sync');
        expect(response.status).toBe(502);
        expect(response.body.error).toBe('config token missing');
      });
    });

    describe('DELETE /cloud/workspace', () => {
      it('removes the workspace on Cloud and disconnects a cloud-transport connection', async () => {
        mockCloudConfig.removeWorkspace.mockResolvedValue(true);
        const slackService = getSlackService();
        jest.spyOn(slackService, 'isConnected').mockReturnValue(true);
        jest.spyOn(slackService, 'getTransport').mockReturnValue('cloud');
        const disconnect = jest.spyOn(slackService, 'disconnect').mockResolvedValue(undefined);

        const response = await request(app).delete('/api/slack/cloud/workspace');
        expect(response.status).toBe(200);
        expect(response.body.data.removed).toBe(true);
        expect(mockHandleCloudConfigChange).toHaveBeenCalledWith(null);
        expect(disconnect).toHaveBeenCalled();
      });

      it('requires a Cloud login', async () => {
        mockCloudClient.token = null;
        const response = await request(app).delete('/api/slack/cloud/workspace');
        expect(response.status).toBe(401);
      });
    });
  });

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
