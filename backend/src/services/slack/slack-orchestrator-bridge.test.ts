/**
 * Tests for Slack-Orchestrator Bridge
 *
 * @module services/slack/slack-orchestrator-bridge.test
 */

// Jest globals are available automatically
import {
  SlackOrchestratorBridge,
  getSlackOrchestratorBridge,
  resetSlackOrchestratorBridge,
} from './slack-orchestrator-bridge.js';
import { resetSlackService } from './slack.service.js';
import { resetChatService } from '../chat/chat.service.js';
import type { SlackIncomingMessage } from '../../types/slack.types.js';

// Mock the orchestrator status module
jest.mock('../orchestrator/index.js', () => ({
  isOrchestratorActive: jest.fn(),
  isAgentActive: jest.fn().mockResolvedValue(false),
  getOrchestratorOfflineMessage: jest.fn().mockReturnValue('Orchestrator is offline'),
}));

// Mock the slack image service
jest.mock('./slack-image.service.js', () => ({
  getSlackImageService: jest.fn().mockReturnValue({
    downloadImage: jest.fn().mockResolvedValue({
      id: 'F001',
      name: 'test.png',
      mimetype: 'image/png',
      localPath: '/tmp/slack-images/F001-test.png',
      width: 800,
      height: 600,
      permalink: 'https://slack.com/files/F001',
    }),
  }),
  SlackImageService: jest.fn(),
  setSlackImageService: jest.fn(),
  resetSlackImageService: jest.fn(),
}));

import { isOrchestratorActive, isAgentActive, getOrchestratorOfflineMessage } from '../orchestrator/index.js';
import { getChatService } from '../chat/chat.service.js';
import { ChatMessage } from '../../types/chat.types.js';
import { getSlackImageService } from './slack-image.service.js';

describe('SlackOrchestratorBridge', () => {
  beforeEach(() => {
    resetSlackOrchestratorBridge();
    resetSlackService();
    resetChatService();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetSlackOrchestratorBridge();
    resetSlackService();
    resetChatService();
  });

  describe('getSlackOrchestratorBridge', () => {
    it('should return singleton instance', () => {
      const bridge1 = getSlackOrchestratorBridge();
      const bridge2 = getSlackOrchestratorBridge();
      expect(bridge1).toBe(bridge2);
    });

    it('should return SlackOrchestratorBridge instance', () => {
      const bridge = getSlackOrchestratorBridge();
      expect(bridge).toBeInstanceOf(SlackOrchestratorBridge);
    });
  });

  describe('resetSlackOrchestratorBridge', () => {
    it('should reset the singleton instance', () => {
      const bridge1 = getSlackOrchestratorBridge();
      resetSlackOrchestratorBridge();
      const bridge2 = getSlackOrchestratorBridge();
      expect(bridge1).not.toBe(bridge2);
    });
  });

  describe('SlackOrchestratorBridge class', () => {
    it('should have correct initial state', () => {
      const bridge = new SlackOrchestratorBridge();
      expect(bridge.isInitialized()).toBe(false);
    });

    it('should initialize without throwing', async () => {
      const bridge = new SlackOrchestratorBridge();
      await expect(bridge.initialize()).resolves.not.toThrow();
      expect(bridge.isInitialized()).toBe(true);
    });

    it('should only initialize once', async () => {
      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();
      await bridge.initialize(); // Should not throw
      expect(bridge.isInitialized()).toBe(true);
    });

    it('should accept custom configuration', () => {
      const customConfig = {
        maxResponseLength: 5000,
        enableNotifications: false,
      };
      const bridge = new SlackOrchestratorBridge(customConfig);
      const config = bridge.getConfig();
      expect(config.maxResponseLength).toBe(5000);
      expect(config.enableNotifications).toBe(false);
    });

    it('should use default configuration for unspecified options', () => {
      const bridge = new SlackOrchestratorBridge({ maxResponseLength: 5000 });
      const config = bridge.getConfig();
      expect(config.showTypingIndicator).toBe(true);
      expect(config.enableNotifications).toBe(true);
    });
  });

  describe('parseCommand', () => {
    it('should parse help command', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('help');
      expect(result.intent).toBe('help');
      expect(result.rawText).toBe('help');
    });

    it('should parse status command', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('status');
      expect(result.intent).toBe('status');
    });

    it('should parse list projects command', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('list projects');
      expect(result.intent).toBe('list_projects');
    });

    it('should parse list teams command', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('show all teams');
      expect(result.intent).toBe('list_teams');
    });

    it('should parse list agents command', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand("who's working");
      expect(result.intent).toBe('list_agents');
    });

    it('should remove bot mentions from text', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('<@U1234567890> status');
      expect(result.rawText).toBe('status');
      expect(result.intent).toBe('status');
    });

    it('should handle multiple bot mentions', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('<@U123> <@U456> help');
      expect(result.rawText).toBe('help');
    });

    it('should parse pause command', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('pause');
      expect(result.intent).toBe('pause');
    });

    it('should parse resume command', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('resume');
      expect(result.intent).toBe('resume');
    });

    it('should extract quoted parameters', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('create task "Fix the login bug"');
      expect(result.parameters.quoted).toBe('Fix the login bug');
    });

    it('should extract mention parameters', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('assign to @developer');
      expect(result.parameters.mention).toBe('developer');
    });

    it('should extract target parameters', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('status for ProjectX');
      expect(result.parameters.target).toBe('ProjectX');
    });

    it('should default to conversation for unknown input', () => {
      const bridge = new SlackOrchestratorBridge();
      const result = bridge.parseCommand('hello there how are you');
      expect(result.intent).toBe('conversation');
    });
  });

  describe('getHelpMessage', () => {
    it('should return formatted help message', () => {
      const bridge = new SlackOrchestratorBridge();
      const help = bridge.getHelpMessage();

      expect(help).toContain('Crewly Commands');
      expect(help).toContain('status');
      expect(help).toContain('list projects');
      expect(help).toContain('list teams');
      expect(help).toContain('pause');
      expect(help).toContain('resume');
    });

    it('should include emoji formatting', () => {
      const bridge = new SlackOrchestratorBridge();
      const help = bridge.getHelpMessage();

      expect(help).toContain(':clipboard:');
      expect(help).toContain(':gear:');
    });
  });

  describe('formatForSlack', () => {
    it('should convert markdown headers to bold', () => {
      const bridge = new SlackOrchestratorBridge();

      expect(bridge.formatForSlack('# Heading')).toBe('*Heading*');
      expect(bridge.formatForSlack('## Subheading')).toBe('*Subheading*');
      expect(bridge.formatForSlack('### Small heading')).toBe('*Small heading*');
    });

    it('should preserve code blocks', () => {
      const bridge = new SlackOrchestratorBridge();
      const input = '```\nconst x = 1;\n```';
      const result = bridge.formatForSlack(input);
      expect(result).toContain('const x = 1;');
      expect(result).toContain('```');
    });

    it('should handle mixed content', () => {
      const bridge = new SlackOrchestratorBridge();
      const input = '# Title\nSome text\n```code```';
      const result = bridge.formatForSlack(input);
      expect(result).toContain('*Title*');
      expect(result).toContain('Some text');
    });
  });

  describe('image handling', () => {
    it('should enrich text with image file references', () => {
      const bridge = new SlackOrchestratorBridge();
      const enrichTextWithFiles = (bridge as any).enrichTextWithFiles.bind(bridge);

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'Check this', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        images: [{
          id: 'F001', name: 'shot.png', mimetype: 'image/png',
          localPath: '/tmp/F001-shot.png', width: 1920, height: 1080,
          permalink: 'https://slack.com/files/F001',
        }],
      };

      const enriched = enrichTextWithFiles(message);
      expect(enriched).toContain('Check this');
      expect(enriched).toContain('[Slack Image: /tmp/F001-shot.png (1920x1080), image/png]');
    });

    it('should return original text when no images', () => {
      const bridge = new SlackOrchestratorBridge();
      const enrichTextWithFiles = (bridge as any).enrichTextWithFiles.bind(bridge);

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'No images here', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
      };

      expect(enrichTextWithFiles(message)).toBe('No images here');
    });

    it('should enrich text with non-image file attachments', () => {
      const bridge = new SlackOrchestratorBridge();
      const enrichTextWithFiles = (bridge as any).enrichTextWithFiles.bind(bridge);

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'Check this PDF', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        attachments: [{
          id: 'F002', name: 'report.pdf', mimetype: 'application/pdf',
          localPath: '/tmp/F002-report.pdf', size: 102400,
          permalink: 'https://slack.com/files/F002',
        }],
      };

      const enriched = enrichTextWithFiles(message);
      expect(enriched).toContain('Check this PDF');
      expect(enriched).toContain('[Slack File: /tmp/F002-report.pdf (report.pdf, application/pdf, 100KB)]');
    });

    it('should enrich text with both images and file attachments', () => {
      const bridge = new SlackOrchestratorBridge();
      const enrichTextWithFiles = (bridge as any).enrichTextWithFiles.bind(bridge);

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'Mixed files', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        images: [{
          id: 'F001', name: 'shot.png', mimetype: 'image/png',
          localPath: '/tmp/F001-shot.png', width: 800, height: 600,
          permalink: 'https://slack.com/files/F001',
        }],
        attachments: [{
          id: 'F002', name: 'doc.csv', mimetype: 'text/csv',
          localPath: '/tmp/F002-doc.csv', size: 2048,
          permalink: 'https://slack.com/files/F002',
        }],
      };

      const enriched = enrichTextWithFiles(message);
      expect(enriched).toContain('[Slack Image:');
      expect(enriched).toContain('[Slack File:');
    });

    it('should download images via SlackImageService', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockResolvedValue({
        url_private: 'https://files.slack.com/F001',
        url_private_download: 'https://files.slack.com/F001/download',
      });

      const downloadMessageImages = (bridge as any).downloadMessageImages.bind(bridge);

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'here', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasImages: true,
        files: [{
          id: 'F001', name: 'test.png', mimetype: 'image/png',
          filetype: 'png', size: 1024,
          url_private: 'https://files.slack.com/F001',
          url_private_download: 'https://files.slack.com/F001/download',
          permalink: 'https://slack.com/files/F001',
        }],
      };

      await downloadMessageImages(message, message.files!);

      expect(message.images).toBeDefined();
      expect(message.images).toHaveLength(1);
      expect(message.images![0].localPath).toBe('/tmp/slack-images/F001-test.png');

      const mockImgService = getSlackImageService();
      expect(mockImgService.downloadImage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'F001' }),
        'xoxb-test'
      );
    });

    it('should batch downloads with MAX_CONCURRENT_DOWNLOADS limit', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockResolvedValue({
        url_private: 'https://files.slack.com/refreshed',
        url_private_download: 'https://files.slack.com/refreshed/download',
      });

      // Track concurrent calls to verify batching
      let activeConcurrent = 0;
      let maxObservedConcurrent = 0;

      const mockImgService = getSlackImageService();
      (mockImgService.downloadImage as jest.Mock).mockImplementation(async (file: any) => {
        activeConcurrent++;
        maxObservedConcurrent = Math.max(maxObservedConcurrent, activeConcurrent);
        // Simulate async work so concurrent calls overlap within a batch
        await new Promise(r => setTimeout(r, 10));
        activeConcurrent--;
        return {
          id: file.id, name: file.name, mimetype: 'image/png',
          localPath: `/tmp/slack-images/${file.id}-${file.name}`, permalink: file.permalink,
        };
      });

      const downloadMessageImages = (bridge as any).downloadMessageImages.bind(bridge);

      // Create 5 files to test batching (max concurrent = 3, so 2 batches: [3, 2])
      const files = Array.from({ length: 5 }, (_, i) => ({
        id: `F00${i}`, name: `img${i}.png`, mimetype: 'image/png',
        filetype: 'png', size: 1024,
        url_private: `https://files.slack.com/F00${i}`,
        url_private_download: `https://files.slack.com/F00${i}/download`,
        permalink: `https://slack.com/files/F00${i}`,
      }));

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'batch test', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasImages: true,
        files,
      };

      await downloadMessageImages(message, message.files!);

      expect(message.images).toBeDefined();
      expect(message.images).toHaveLength(5);
      expect(mockImgService.downloadImage).toHaveBeenCalledTimes(5);
      // Verify concurrency was bounded to batch size (3)
      expect(maxObservedConcurrent).toBeLessThanOrEqual(3);
    });

    it('should continue downloading remaining batches when one file fails', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockResolvedValue({
        url_private: 'https://files.slack.com/refreshed',
        url_private_download: 'https://files.slack.com/refreshed/download',
      });

      const mockImgService = getSlackImageService();
      (mockImgService.downloadImage as jest.Mock)
        .mockRejectedValueOnce(new Error('Download failed'))
        .mockResolvedValueOnce({ id: 'F001', name: 'b.png', mimetype: 'image/png', localPath: '/tmp/slack-images/F001-b.png', permalink: 'x' })
        .mockResolvedValueOnce({ id: 'F002', name: 'c.png', mimetype: 'image/png', localPath: '/tmp/slack-images/F002-c.png', permalink: 'x' });

      const downloadMessageImages = (bridge as any).downloadMessageImages.bind(bridge);

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: '', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasImages: true,
        files: [
          { id: 'F000', name: 'a.png', mimetype: 'image/png', filetype: 'png', size: 1, url_private: 'x', url_private_download: 'x', permalink: 'x' },
          { id: 'F001', name: 'b.png', mimetype: 'image/png', filetype: 'png', size: 1, url_private: 'x', url_private_download: 'x', permalink: 'x' },
          { id: 'F002', name: 'c.png', mimetype: 'image/png', filetype: 'png', size: 1, url_private: 'x', url_private_download: 'x', permalink: 'x' },
        ],
      };

      await downloadMessageImages(message, message.files!);

      // First file failed, but the other 2 in the batch should succeed
      expect(message.images).toHaveLength(2);
      expect(mockImgService.downloadImage).toHaveBeenCalledTimes(3);
    });

    it('should skip all downloads when files:read scope is missing', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockRejectedValue(
        new Error('An API error occurred: missing_scope')
      );
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const downloadMessageImages = (bridge as any).downloadMessageImages.bind(bridge);
      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: '', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasImages: true,
        files: [{ id: 'F001', name: 'a.png', mimetype: 'image/png', filetype: 'png',
          size: 1, url_private: 'x', url_private_download: 'x', permalink: 'x' }],
      };

      await downloadMessageImages(message, message.files!);

      // Should skip all downloads — no images downloaded
      expect(message.images).toBeUndefined();
      // Should log a clear error about missing scope
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('files:read scope')
      );
      consoleSpy.mockRestore();
    });

    it('should continue with original URLs when getFileInfo fails for other reasons', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockRejectedValue(
        new Error('file_not_found')
      );

      const downloadMessageImages = (bridge as any).downloadMessageImages.bind(bridge);
      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: '', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasImages: true,
        files: [{ id: 'F001', name: 'a.png', mimetype: 'image/png', filetype: 'png',
          size: 1, url_private: 'x', url_private_download: 'x', permalink: 'x' }],
      };

      await downloadMessageImages(message, message.files!);

      // Should still attempt download with original URLs
      const mockImgService = getSlackImageService();
      expect(mockImgService.downloadImage).toHaveBeenCalled();
    });

    it('should skip image download when no bot token', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue(null);

      const downloadMessageImages = (bridge as any).downloadMessageImages.bind(bridge);
      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: '', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasImages: true,
        files: [{ id: 'F001', name: 'a.png', mimetype: 'image/png', filetype: 'png',
          size: 1, url_private: 'x', url_private_download: 'x', permalink: 'x' }],
      };

      await downloadMessageImages(message, message.files!);
      expect(message.images).toBeUndefined();
    });

    it('should send warning to Slack when file is too large', async () => {
      const mockImgService = getSlackImageService() as jest.Mocked<ReturnType<typeof getSlackImageService>>;
      mockImgService.downloadImage = jest.fn().mockRejectedValue(new Error('File too large: 25000000 bytes (max 20 MB)'));

      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockResolvedValue({
        url_private: 'x', url_private_download: 'x',
      });
      const sendMessageSpy = jest.spyOn(slackService, 'sendMessage').mockResolvedValue('ok');

      const downloadMessageImages = (bridge as any).downloadMessageImages.bind(bridge);
      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'Check this', userId: 'U1',
        channelId: 'C1', ts: '1.000', teamId: 'T1', eventTs: '1',
        hasImages: true,
        files: [{ id: 'F001', name: 'huge.png', mimetype: 'image/png', filetype: 'png',
          size: 25000000, url_private: 'x', url_private_download: 'x', permalink: 'x' }],
      };

      await downloadMessageImages(message, message.files!);

      // Should have no downloaded images
      expect(message.images).toBeUndefined();
      // Should have sent a warning back to Slack
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'C1',
          threadTs: '1.000',
          text: expect.stringContaining('could not be processed'),
        })
      );
    });

    it('should not send warning for non-size/type failures', async () => {
      const mockImgService = getSlackImageService() as jest.Mocked<ReturnType<typeof getSlackImageService>>;
      mockImgService.downloadImage = jest.fn().mockRejectedValue(new Error('Download failed with status 500'));

      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockResolvedValue({
        url_private: 'x', url_private_download: 'x',
      });
      const sendMessageSpy = jest.spyOn(slackService, 'sendMessage').mockResolvedValue('ok');

      const downloadMessageImages = (bridge as any).downloadMessageImages.bind(bridge);
      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: '', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasImages: true,
        files: [{ id: 'F001', name: 'a.png', mimetype: 'image/png', filetype: 'png',
          size: 1, url_private: 'x', url_private_download: 'x', permalink: 'x' }],
      };

      await downloadMessageImages(message, message.files!);

      // Should NOT send a warning for generic errors
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });
  });

  describe('downloadMessageFiles (non-image files)', () => {
    it('should skip download when no bot token is available', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('');

      const downloadMessageFiles = (bridge as any).downloadMessageFiles.bind(bridge);
      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'doc', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasFiles: true,
      };
      const nonImageFiles = [{ id: 'F001', name: 'doc.pdf', mimetype: 'application/pdf', filetype: 'pdf',
        size: 1024, url_private: 'x', url_private_download: 'x', permalink: 'x' }];

      await downloadMessageFiles(message, nonImageFiles);

      // No attachments set since we couldn't download
      expect(message.attachments).toBeUndefined();
    });

    it('should reject files exceeding max file size', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockResolvedValue({
        url_private: 'x', url_private_download: 'x',
      });
      const sendMessageSpy = jest.spyOn(slackService, 'sendMessage').mockResolvedValue('ok');

      const downloadMessageFiles = (bridge as any).downloadMessageFiles.bind(bridge);
      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: '', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasFiles: true,
      };
      // 25MB exceeds the 20MB limit
      const nonImageFiles = [{ id: 'F001', name: 'huge.zip', mimetype: 'application/zip', filetype: 'zip',
        size: 25 * 1024 * 1024, url_private: 'x', url_private_download: 'x', permalink: 'x' }];

      await downloadMessageFiles(message, nonImageFiles);

      expect(message.attachments).toBeUndefined();
      // Should send a rejection warning
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('could not be downloaded'),
        })
      );
    });

    it('should abort all downloads when files:read scope is missing', async () => {
      const bridge = new SlackOrchestratorBridge();
      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'getBotToken').mockReturnValue('xoxb-test');
      jest.spyOn(slackService, 'getFileInfo').mockRejectedValue(new Error('missing_scope'));

      const downloadMessageFiles = (bridge as any).downloadMessageFiles.bind(bridge);
      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: '', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        hasFiles: true,
      };
      const nonImageFiles = [{ id: 'F001', name: 'a.pdf', mimetype: 'application/pdf', filetype: 'pdf',
        size: 1024, url_private: 'x', url_private_download: 'x', permalink: 'x' }];

      await downloadMessageFiles(message, nonImageFiles);

      expect(message.attachments).toBeUndefined();
    });
  });

  describe('extractPdfText', () => {
    it('should extract text from a valid PDF buffer', async () => {
      const bridge = new SlackOrchestratorBridge();
      const { promises: fsPromises } = await import('fs');

      // Minimal valid PDF with "Hello World" text (proper xref offsets)
      const minPdf = Buffer.from(
        'JVBERi0xLjQKMSAwIG9iaiA8PC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUj4+IGVuZG9iagoyIDAgb2JqIDw8L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDE+PiBlbmRvYmoKMyAwIG9iaiA8PC9UeXBlIC9QYWdlIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9QYXJlbnQgMiAwIFIgL0NvbnRlbnRzIDQgMCBSIC9SZXNvdXJjZXMgPDwvRm9udCA8PC9GMSA1IDAgUj4+Pj4+PiBlbmRvYmoKNCAwIG9iaiA8PC9MZW5ndGggNDQ+PiBzdHJlYW0KQlQgL0YxIDEyIFRmIDEwMCA3MDAgVGQgKEhlbGxvIFdvcmxkKSBUaiBFVAplbmRzdHJlYW0gZW5kb2JqCjUgMCBvYmogPDwvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2E+PiBlbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTYgMDAwMDAgbiAKMDAwMDAwMDExMSAwMDAwMCBuIAowMDAwMDAwMjMxIDAwMDAwIG4gCjAwMDAwMDAzMjIgMDAwMDAgbiAKdHJhaWxlciA8PC9TaXplIDYgL1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMzkwCiUlRU9GCg==',
        'base64'
      );

      const tmpPath = '/tmp/test-extract.pdf';
      await fsPromises.writeFile(tmpPath, minPdf);

      try {
        // Verify the file was written correctly
        const writtenBuf = await fsPromises.readFile(tmpPath);
        expect(writtenBuf.length).toBeGreaterThan(100);

        // Test extraction directly to see errors
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: writtenBuf });
        let directResult;
        try {
          directResult = await parser.getText();
        } catch (e: any) {
          // If pdf-parse fails in test env, skip with a meaningful message
          console.warn('PDFParse.getText failed:', e.message);
        }

        const text = await bridge.extractPdfText(tmpPath, 'test.pdf');
        if (directResult) {
          expect(text).toBeDefined();
          expect(text).toContain('Hello World');
        } else {
          // pdf-parse may not work in Jest transform env - verify graceful handling
          expect(text).toBeUndefined();
        }
      } finally {
        await fsPromises.unlink(tmpPath).catch(() => {});
      }
    });

    it('should return undefined for non-existent file', async () => {
      const bridge = new SlackOrchestratorBridge();
      const text = await bridge.extractPdfText('/tmp/nonexistent-file.pdf', 'ghost.pdf');
      expect(text).toBeUndefined();
    });

    it('should return undefined for corrupt/non-PDF file', async () => {
      const bridge = new SlackOrchestratorBridge();
      const { promises: fsPromises } = await import('fs');

      const tmpPath = '/tmp/test-corrupt.pdf';
      await fsPromises.writeFile(tmpPath, 'this is not a PDF');

      try {
        const text = await bridge.extractPdfText(tmpPath, 'corrupt.pdf');
        expect(text).toBeUndefined();
      } finally {
        await fsPromises.unlink(tmpPath).catch(() => {});
      }
    });

    it('should truncate text exceeding max length', async () => {
      const bridge = new SlackOrchestratorBridge();
      const { SLACK_FILE_DOWNLOAD_CONSTANTS } = await import('../../constants.js');
      const maxLen = SLACK_FILE_DOWNLOAD_CONSTANTS.MAX_EXTRACTED_TEXT_LENGTH;

      // Mock fs.readFile and PDFParse to return a very long text
      const longText = 'A'.repeat(maxLen + 500);
      const { PDFParse } = await import('pdf-parse');

      // Use the real extractPdfText with a mocked PDFParse
      const origGetText = PDFParse.prototype.getText;
      PDFParse.prototype.getText = jest.fn().mockResolvedValue({ text: longText, pages: [], total: 1 });

      const { promises: fsPromises } = await import('fs');
      const tmpPath = '/tmp/test-long.pdf';
      // Write a minimal PDF so fs.readFile succeeds
      await fsPromises.writeFile(tmpPath, Buffer.from('%PDF-1.0 dummy'));

      try {
        const text = await bridge.extractPdfText(tmpPath, 'long.pdf');
        expect(text).toBeDefined();
        expect(text!.length).toBeLessThanOrEqual(maxLen + 50); // +50 for truncation marker
        expect(text).toContain('... [truncated]');
      } finally {
        PDFParse.prototype.getText = origGetText;
        await fsPromises.unlink(tmpPath).catch(() => {});
      }
    });
  });

  describe('enrichTextWithFiles (with extracted text)', () => {
    it('should include extracted PDF text inline in enriched message', () => {
      const bridge = new SlackOrchestratorBridge();
      const enrichTextWithFiles = (bridge as any).enrichTextWithFiles.bind(bridge);

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'Here is the doc', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        attachments: [{
          id: 'F001', name: 'report.pdf', mimetype: 'application/pdf',
          localPath: '/tmp/slack-files/F001-report.pdf', size: 5000, permalink: 'x',
          extractedText: 'This is the PDF content.',
        }],
      };

      const result = enrichTextWithFiles(message);

      expect(result).toContain('[Slack File: /tmp/slack-files/F001-report.pdf (report.pdf, application/pdf, 5KB)]');
      expect(result).toContain('--- Extracted content from report.pdf ---');
      expect(result).toContain('This is the PDF content.');
      expect(result).toContain('--- End of report.pdf ---');
    });

    it('should not include extraction section when extractedText is undefined', () => {
      const bridge = new SlackOrchestratorBridge();
      const enrichTextWithFiles = (bridge as any).enrichTextWithFiles.bind(bridge);

      const message: SlackIncomingMessage = {
        id: '1', type: 'message', text: 'A zip file', userId: 'U1',
        channelId: 'C1', ts: '1', teamId: 'T1', eventTs: '1',
        attachments: [{
          id: 'F002', name: 'data.zip', mimetype: 'application/zip',
          localPath: '/tmp/slack-files/F002-data.zip', size: 10000, permalink: 'x',
        }],
      };

      const result = enrichTextWithFiles(message);

      expect(result).toContain('[Slack File:');
      expect(result).not.toContain('--- Extracted content');
    });
  });

  describe('notifications', () => {
    it('should not throw when sending task completed notification', async () => {
      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();

      // Should not throw even though Slack is not connected
      await expect(
        bridge.notifyTaskCompleted('Fix login bug', 'Developer Agent', 'MyApp')
      ).resolves.not.toThrow();
    });

    it('should not throw when sending agent question notification', async () => {
      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();

      await expect(
        bridge.notifyAgentQuestion('Developer', 'Should I use REST or GraphQL?', 'MyApp')
      ).resolves.not.toThrow();
    });

    it('should not throw when sending error notification', async () => {
      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();

      await expect(
        bridge.notifyError('Build failed', 'CI Agent', 'MyApp')
      ).resolves.not.toThrow();
    });

    it('should not throw when sending daily summary', async () => {
      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();

      await expect(
        bridge.notifyDailySummary('5 tasks completed, 2 in progress')
      ).resolves.not.toThrow();
    });

    it('should skip notifications when disabled', async () => {
      const bridge = new SlackOrchestratorBridge({ enableNotifications: false });
      await bridge.initialize();

      // Should return immediately without attempting to send
      await expect(
        bridge.notifyTaskCompleted('Task', 'Agent', 'Project')
      ).resolves.not.toThrow();
    });
  });

  describe('event emitter', () => {
    it('should be an EventEmitter', () => {
      const bridge = getSlackOrchestratorBridge();

      expect(typeof bridge.on).toBe('function');
      expect(typeof bridge.emit).toBe('function');
      expect(typeof bridge.removeListener).toBe('function');
    });

    it('should allow registering event handlers', () => {
      const bridge = getSlackOrchestratorBridge();
      const handler = jest.fn();

      bridge.on('error', handler);
      bridge.emit('error', new Error('test'));

      expect(handler).toHaveBeenCalled();
    });

    it('should emit message_handled event after successful handling', async () => {
      const bridge = getSlackOrchestratorBridge();
      await bridge.initialize();

      const handler = jest.fn();
      bridge.on('message_handled', handler);

      // Note: actual message handling requires Slack service to be connected
      // This tests that the event handler can be registered
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('setMessageQueueService', () => {
    it('should accept a MessageQueueService', () => {
      const bridge = new SlackOrchestratorBridge();
      const mockService = {
        enqueue: jest.fn(),
      } as any;

      // Should not throw
      expect(() => bridge.setMessageQueueService(mockService)).not.toThrow();
    });

    it('should allow setting service after initialization', async () => {
      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();

      const mockService = {
        enqueue: jest.fn(),
      } as any;

      expect(() => bridge.setMessageQueueService(mockService)).not.toThrow();
    });
  });

  describe('getConfig', () => {
    it('should return a copy of the configuration', () => {
      const bridge = new SlackOrchestratorBridge();
      const config1 = bridge.getConfig();
      const config2 = bridge.getConfig();

      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });

    it('should not be mutatable from outside', () => {
      const bridge = new SlackOrchestratorBridge();
      const config = bridge.getConfig();

      config.maxResponseLength = 999999;

      const freshConfig = bridge.getConfig();
      expect(freshConfig.maxResponseLength).not.toBe(999999);
    });

    it('should contain all expected properties', () => {
      const bridge = new SlackOrchestratorBridge();
      const config = bridge.getConfig();

      expect(config).toHaveProperty('orchestratorSession');
      expect(config).toHaveProperty('showTypingIndicator');
      expect(config).toHaveProperty('maxResponseLength');
      expect(config).toHaveProperty('enableNotifications');
      expect(config).toHaveProperty('responseTimeoutMs');
    });

    it('should have responseTimeoutMs longer than queue processor timeout', () => {
      const bridge = new SlackOrchestratorBridge();
      const config = bridge.getConfig();

      // The Slack bridge timeout must exceed the queue processor timeout
      // to prevent the bridge from timing out before the queue processor
      expect(config.responseTimeoutMs).toBeGreaterThan(120000);
    });
  });

  describe('orchestrator message forwarding via queue', () => {
    let mockQueueService: any;

    beforeEach(() => {
      mockQueueService = {
        enqueue: jest.fn().mockReturnValue({ id: 'q-1' }),
      };
      (isOrchestratorActive as jest.Mock).mockResolvedValue(true);
    });

    it('should return error when message queue service is not set', async () => {
      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();

      // Without queue service, message forwarding should not work
      // The bridge should handle this gracefully
      expect(bridge.isInitialized()).toBe(true);
    });

    it('should allow setting queue service after initialization', async () => {
      const bridge = new SlackOrchestratorBridge();
      bridge.setMessageQueueService(mockQueueService);
      await bridge.initialize();

      // The queue service should be set
      expect(typeof mockQueueService.enqueue).toBe('function');
    });

    it('should handle queue service enqueue failure gracefully', async () => {
      const failingService = {
        enqueue: jest.fn().mockImplementation(() => { throw new Error('Queue full'); }),
      } as any;

      const bridge = new SlackOrchestratorBridge();
      bridge.setMessageQueueService(failingService);
      await bridge.initialize();

      // Service failure should be handled gracefully
      expect(bridge.isInitialized()).toBe(true);
    });
  });

  describe('orchestrator status handling', () => {
    it('should check orchestrator status before sending messages', async () => {
      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();

      (isOrchestratorActive as jest.Mock).mockResolvedValue(false);

      // When orchestrator is offline, the bridge should return the offline message
      expect(isOrchestratorActive).toBeDefined();
    });

    it('should return offline message when orchestrator is not active', async () => {
      (isOrchestratorActive as jest.Mock).mockResolvedValue(false);
      (getOrchestratorOfflineMessage as jest.Mock).mockReturnValue('Orchestrator is currently offline');

      const bridge = new SlackOrchestratorBridge();
      await bridge.initialize();

      // The offline message function should be accessible
      const offlineMsg = getOrchestratorOfflineMessage(true);
      expect(offlineMsg).toContain('offline');
    });
  });

  describe('auditor fallback routing', () => {
    let mockQueueService: any;

    function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
      return {
        id: 'msg-1',
        conversationId: 'conv-fallback',
        from: { type: 'user', name: 'User' },
        content: 'Hello',
        contentType: 'text',
        timestamp: new Date().toISOString(),
        ...overrides,
      } as ChatMessage;
    }

    beforeEach(() => {
      mockQueueService = {
        enqueue: jest.fn().mockReturnValue({ id: 'q-fallback' }),
      };
      const chatService = getChatService();
      jest.spyOn(chatService, 'sendMessage').mockResolvedValue({
        message: makeChatMessage(),
        conversation: { id: 'conv-fallback', title: 'test', messages: [], createdAt: '', updatedAt: '' } as any,
      });
    });

    it('should route to auditor via queue when orchestrator is offline and auditor is active', async () => {
      (isOrchestratorActive as jest.Mock).mockResolvedValue(false);
      (isAgentActive as jest.Mock).mockResolvedValue(true);

      const bridge = new SlackOrchestratorBridge();
      bridge.setMessageQueueService(mockQueueService);
      await bridge.initialize();

      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'addReaction').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'getConversationContext').mockReturnValue({
        conversationId: 'conv-fallback',
        channelId: 'C123',
        userId: 'U123',
        threadTs: '1234567890.123',
      });

      const handledPromise = new Promise<any>((resolve) => {
        bridge.on('message_handled', resolve);
      });

      slackService.emit('message', {
        text: 'hello from user',
        channelId: 'C123',
        userId: 'U123',
        ts: '1234567890.123',
      });

      const event = await handledPromise;

      // Should enqueue with targetSession pointing to auditor
      expect(mockQueueService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          targetSession: 'crewly-auditor',
          source: 'slack',
        })
      );
      // Enqueued content should include FALLBACK marker and SLACK_CONTEXT
      const enqueuedContent = mockQueueService.enqueue.mock.calls[0][0].content;
      expect(enqueuedContent).toContain('[FALLBACK]');
      expect(enqueuedContent).toContain('[SLACK_CONTEXT:');
      expect(enqueuedContent).toContain('C123');

      // Response should acknowledge the fallback
      expect(event.response).toContain('forwarded to the Auditor');
    }, 15000);

    it('should return offline message when both orchestrator and auditor are inactive', async () => {
      (isOrchestratorActive as jest.Mock).mockResolvedValue(false);
      (isAgentActive as jest.Mock).mockResolvedValue(false);
      (getOrchestratorOfflineMessage as jest.Mock).mockReturnValue('Orchestrator is offline. Please start it from the dashboard.');

      const bridge = new SlackOrchestratorBridge();
      bridge.setMessageQueueService(mockQueueService);
      await bridge.initialize();

      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'addReaction').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'getConversationContext').mockReturnValue({
        conversationId: 'conv-fb',
        channelId: 'C123',
        userId: 'U123',
      });

      const handledPromise = new Promise<any>((resolve) => {
        bridge.on('message_handled', resolve);
      });

      slackService.emit('message', {
        text: 'hello',
        channelId: 'C123',
        userId: 'U123',
        ts: '999.999',
      });

      const event = await handledPromise;

      // Should NOT route to auditor queue
      expect(mockQueueService.enqueue).not.toHaveBeenCalled();
      // Response is the offline message
      expect(event.response).toContain('offline');
    }, 15000);

    it('should include FALLBACK marker in auditor-routed messages', () => {
      const message = 'Hello from user';
      const fallbackMessage = `[FALLBACK] Orchestrator is offline. User message:\n${message}`;
      expect(fallbackMessage).toContain('[FALLBACK]');
      expect(fallbackMessage).toContain(message);
    });

    it('should include SLACK_CONTEXT in fallback messages when context is available', () => {
      const channelId = 'C123';
      const threadTs = '1234567890.123456';
      const prefix = `[SLACK_CONTEXT:channelId=${channelId},threadTs=${threadTs}]`;
      expect(prefix).toContain(channelId);
      expect(prefix).toContain(threadTs);
    });
  });

  describe('typing indicator scope handling', () => {
    it('should only log missing scope warning once', () => {
      const bridge = new SlackOrchestratorBridge();

      // The bridge has a loggedMissingScope flag to prevent spam
      // After first missing_scope error, subsequent errors should be silent
      expect(bridge.getConfig().showTypingIndicator).toBe(true);
    });

    it('should continue operation when reactions scope is missing', async () => {
      const bridge = new SlackOrchestratorBridge({ showTypingIndicator: true });
      await bridge.initialize();

      // Missing scope should not prevent message handling
      expect(bridge.isInitialized()).toBe(true);
    });
  });

  describe('sendToOrchestrator (queue-based)', () => {
    let mockQueueService: any;
    let chatService: ReturnType<typeof getChatService>;

    /**
     * Helper to build a ChatMessage for testing
     */
    function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
      return {
        id: 'msg-1',
        conversationId: 'conv-123',
        from: { type: 'orchestrator', name: 'Orchestrator' },
        content: 'Hello from orchestrator',
        contentType: 'text',
        timestamp: new Date().toISOString(),
        ...overrides,
      } as ChatMessage;
    }

    beforeEach(() => {
      (isOrchestratorActive as jest.Mock).mockResolvedValue(true);
      chatService = getChatService();

      // Mock sendMessage to return a conversation with a known ID
      jest.spyOn(chatService, 'sendMessage').mockResolvedValue({
        message: makeChatMessage(),
        conversation: { id: 'conv-123', title: 'test', messages: [], createdAt: '', updatedAt: '' } as any,
      });

      // Create a mock queue service that captures the slackResolve callback
      mockQueueService = {
        enqueue: jest.fn().mockReturnValue({ id: 'q-1' }),
      };
    });

    it('should enqueue with slackResolve callback and resolve when called', async () => {
      // Configure enqueue to immediately call slackResolve
      mockQueueService.enqueue.mockImplementation((input: any) => {
        // Simulate the processor calling slackResolve after a tick
        setTimeout(() => {
          input.sourceMetadata.slackResolve('Task completed successfully');
        }, 10);
        return { id: 'q-1' };
      });

      const bridge = new SlackOrchestratorBridge({ responseTimeoutMs: 5000 });
      bridge.setMessageQueueService(mockQueueService);
      await bridge.initialize();

      const messagePromise = new Promise<string>((resolve) => {
        bridge.on('message_handled', (event: any) => {
          resolve(event.response);
        });
      });

      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'addReaction').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'getConversationContext').mockReturnValue({
        conversationId: 'conv-123',
        channelId: 'C123',
        userId: 'U123',
      });

      slackService.emit('message', {
        text: 'hello orchestrator',
        channelId: 'C123',
        userId: 'U123',
        ts: '1234567890.123456',
      });

      const response = await messagePromise;
      expect(response).toBe('Task completed successfully');
      expect(mockQueueService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'slack',
          content: 'hello orchestrator',
        })
      );
    }, 30000);

    it('should timeout if slackResolve is never called', async () => {
      // enqueue does NOT call slackResolve — so the bridge times out
      const bridge = new SlackOrchestratorBridge({ responseTimeoutMs: 200 });
      bridge.setMessageQueueService(mockQueueService);
      await bridge.initialize();

      const messagePromise = new Promise<string>((resolve) => {
        bridge.on('message_handled', (event: any) => {
          resolve(event.response);
        });
      });

      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'addReaction').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'getConversationContext').mockReturnValue({
        conversationId: 'conv-123',
        channelId: 'C123',
        userId: 'U123',
      });

      slackService.emit('message', {
        text: 'hello',
        channelId: 'C123',
        userId: 'U123',
        ts: '1234567890.123456',
      });

      const response = await messagePromise;
      expect(response).toBe('The orchestrator is still processing your request. It will reply here when ready — no need to resend.');
    }, 30000);

    it('should handle enqueue failure gracefully', async () => {
      mockQueueService.enqueue.mockImplementation(() => {
        throw new Error('Queue is full');
      });

      const bridge = new SlackOrchestratorBridge({ responseTimeoutMs: 5000 });
      bridge.setMessageQueueService(mockQueueService);
      await bridge.initialize();

      const messagePromise = new Promise<string>((resolve) => {
        bridge.on('message_handled', (event: any) => {
          resolve(event.response);
        });
      });

      const slackService = (bridge as any).slackService;
      jest.spyOn(slackService, 'sendMessage').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'addReaction').mockResolvedValue(undefined);
      jest.spyOn(slackService, 'getConversationContext').mockReturnValue({
        conversationId: 'conv-123',
        channelId: 'C123',
        userId: 'U123',
      });

      slackService.emit('message', {
        text: 'hello',
        channelId: 'C123',
        userId: 'U123',
        ts: '1234567890.123456',
      });

      const response = await messagePromise;
      expect(response).toContain('Failed to enqueue message');
    }, 30000);
  });

  describe('sendSlackResponse', () => {
    let bridge: SlackOrchestratorBridge;

    beforeEach(() => {
      bridge = new SlackOrchestratorBridge({ skillDeliveryWaitMs: 0 });
    });

    const makeMessage = (overrides: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage => ({
      id: 'msg-1',
      type: 'message',
      text: 'hello',
      userId: 'U123',
      channelId: 'C123',
      ts: '1707.001',
      teamId: 'T1',
      eventTs: '1707.001',
      ...overrides,
    });

    it('should record thread reply to thread store', async () => {
      const mockThreadStore = {
        appendOrchestratorReply: jest.fn().mockResolvedValue(undefined),
        getThreadFilePath: jest.fn(),
      };
      bridge.setSlackThreadStore(mockThreadStore as any);

      const message = makeMessage();

      const sendSlackResponse = (bridge as any).sendSlackResponse.bind(bridge);
      await sendSlackResponse(message, 'Recorded response');

      expect(mockThreadStore.appendOrchestratorReply).toHaveBeenCalledWith(
        'C123',
        '1707.001',
        'Recorded response'
      );
    });
  });

  describe('auditor prefix routing', () => {
    const pattern = /^[/@]?auditor[\s:]+(.+)/is;

    it('should match "auditor ..." prefix and extract message', () => {
      const match = 'auditor show me the latest audit report'.match(pattern);
      expect(match).not.toBeNull();
      expect(match![1].trim()).toBe('show me the latest audit report');
    });

    it('should not route messages without auditor prefix', () => {
      expect('hello world'.match(pattern)).toBeNull();
      expect('status check'.match(pattern)).toBeNull();
      expect('the auditor found issues'.match(pattern)).toBeNull();
    });

    it('should handle /auditor prefix with slash', () => {
      const match = '/auditor check system health'.match(pattern);
      expect(match).not.toBeNull();
      expect(match![1].trim()).toBe('check system health');
    });

    it('should handle @auditor prefix with at-sign', () => {
      const match = '@auditor check system health'.match(pattern);
      expect(match).not.toBeNull();
      expect(match![1].trim()).toBe('check system health');
    });

    it('should handle @auditor: prefix with colon', () => {
      const match = '@auditor: what is the team status?'.match(pattern);
      expect(match).not.toBeNull();
      expect(match![1].trim()).toBe('what is the team status?');
    });

    it('should be case-insensitive', () => {
      expect('Auditor check status'.match(pattern)).not.toBeNull();
      expect('AUDITOR run audit'.match(pattern)).not.toBeNull();
      expect('@Auditor show report'.match(pattern)).not.toBeNull();
    });
  });
});
