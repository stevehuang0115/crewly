/**
 * Unit tests for SessionHandoffService
 *
 * Tests the session summary generation, thread scanning, and summary push
 * functionality that replaces the old pushRecentSlackHistory approach.
 *
 * @module services/session/session-handoff.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SessionHandoffService, type TeamDataReader, type AgentMessageSender, type ResumeThread } from './session-handoff.service.js';

describe('SessionHandoffService', () => {
  let service: SessionHandoffService;
  let testDir: string;

  beforeEach(async () => {
    SessionHandoffService.resetInstance();
    service = SessionHandoffService.getInstance();

    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
    testDir = path.join(os.tmpdir(), `crewly-handoff-test-${uniqueId}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    SessionHandoffService.resetInstance();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = SessionHandoffService.getInstance();
      const b = SessionHandoffService.getInstance();
      expect(a).toBe(b);
    });

    it('should return new instance after reset', () => {
      const a = SessionHandoffService.getInstance();
      SessionHandoffService.resetInstance();
      const b = SessionHandoffService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('scanThreadDirectory', () => {
    it('should find .md files in subdirectories', async () => {
      // Create test thread files
      const channelDir = path.join(testDir, 'C123');
      await fs.mkdir(channelDir, { recursive: true });
      await fs.writeFile(
        path.join(channelDir, '1707432600.md'),
        '---\nchannel: C123\nthread: 1707432600\n---\n\n**Steve** (2025-03-16 12:00):\nHello world\n',
      );

      const result = await service.scanThreadDirectory(testDir, 'slack');

      expect(result).toHaveLength(1);
      expect(result[0].channelType).toBe('slack');
      expect(result[0].channelId).toBe('C123');
      expect(result[0].filePath).toContain('1707432600.md');
      expect(result[0].lastActiveAt).toBeDefined();
    });

    it('should sort by most recent first', async () => {
      const ch1 = path.join(testDir, 'C1');
      const ch2 = path.join(testDir, 'C2');
      await fs.mkdir(ch1, { recursive: true });
      await fs.mkdir(ch2, { recursive: true });

      await fs.writeFile(path.join(ch1, 'old.md'), '---\n---\n\n**A** (12:00):\nOld');
      // Wait briefly to ensure different mtime
      await new Promise(r => setTimeout(r, 50));
      await fs.writeFile(path.join(ch2, 'new.md'), '---\n---\n\n**B** (12:01):\nNew');

      const result = await service.scanThreadDirectory(testDir, 'gchat');

      expect(result).toHaveLength(2);
      expect(result[0].channelId).toBe('C2');
      expect(result[1].channelId).toBe('C1');
    });

    it('should skip .json index files at root', async () => {
      await fs.writeFile(path.join(testDir, 'agent-index.json'), '{}');
      const result = await service.scanThreadDirectory(testDir, 'slack');
      expect(result).toHaveLength(0);
    });

    it('should return empty array for non-existent directory', async () => {
      const result = await service.scanThreadDirectory('/non/existent/dir', 'slack');
      expect(result).toHaveLength(0);
    });

    it('should respect maxThreads limit', async () => {
      for (let i = 0; i < 5; i++) {
        const ch = path.join(testDir, `CH${i}`);
        await fs.mkdir(ch, { recursive: true });
        await fs.writeFile(path.join(ch, 'thread.md'), `---\n---\n\n**U** (12:0${i}):\nMsg ${i}`);
      }

      const result = await service.scanThreadDirectory(testDir, 'slack', 2);
      expect(result).toHaveLength(2);
    });
  });

  describe('scanChatUiConversations', () => {
    it('should find .json conversation files', async () => {
      const conv = {
        conversation: { id: 'conv-1', title: 'Test' },
        messages: [
          { content: 'Hello', from: { name: 'User', type: 'user' } },
          { content: 'Hi there', from: { name: 'Crewly', type: 'assistant' } },
        ],
      };
      await fs.writeFile(path.join(testDir, 'conv-1.json'), JSON.stringify(conv));

      const result = await service.scanChatUiConversations(testDir);

      expect(result).toHaveLength(1);
      expect(result[0].channelType).toBe('chat-ui');
      expect(result[0].channelId).toBe('conv-1');
      expect(result[0].recentMessages).toHaveLength(2);
      expect(result[0].recentMessages[0]).toContain('User');
    });

    it('should return empty for non-existent dir', async () => {
      const result = await service.scanChatUiConversations('/non/existent');
      expect(result).toHaveLength(0);
    });
  });

  describe('extractRecentMessages', () => {
    it('should extract messages from markdown thread', async () => {
      const content = [
        '---',
        'channel: C123',
        '---',
        '',
        '**Steve** (2025-03-16 12:00):',
        'Hello world',
        '',
        '**Crewly** (2025-03-16 12:01):',
        'Got it, working on it now',
        '',
        '**Steve** (2025-03-16 12:05):',
        'Please check the tests too',
      ].join('\n');

      const filePath = path.join(testDir, 'thread.md');
      await fs.writeFile(filePath, content);

      const result = await service.extractRecentMessages(filePath);

      expect(result).toHaveLength(3);
      expect(result[0]).toContain('Steve');
      expect(result[0]).toContain('Hello world');
      expect(result[1]).toContain('Crewly');
      expect(result[2]).toContain('tests');
    });

    it('should return empty for non-existent file', async () => {
      const result = await service.extractRecentMessages('/non/existent.md');
      expect(result).toHaveLength(0);
    });

    it('should limit to MAX_MESSAGES_PER_THREAD most recent messages', async () => {
      const lines = ['---', 'test: true', '---', ''];
      for (let i = 0; i < 10; i++) {
        lines.push(`**User${i}** (2025-03-16 ${i}:00):`, `Message ${i}`, '');
      }
      const filePath = path.join(testDir, 'long.md');
      await fs.writeFile(filePath, lines.join('\n'));

      const result = await service.extractRecentMessages(filePath);
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });

  describe('extractChatUiMessages', () => {
    it('should extract messages from JSON conversation', async () => {
      const conv = {
        messages: [
          { content: 'Hello', from: { name: 'User' } },
          { content: 'World', from: { name: 'Bot' } },
        ],
      };
      const filePath = path.join(testDir, 'conv.json');
      await fs.writeFile(filePath, JSON.stringify(conv));

      const result = await service.extractChatUiMessages(filePath);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('User: Hello');
      expect(result[1]).toBe('Bot: World');
    });

    it('should handle empty messages array', async () => {
      const filePath = path.join(testDir, 'empty.json');
      await fs.writeFile(filePath, JSON.stringify({ messages: [] }));

      const result = await service.extractChatUiMessages(filePath);
      expect(result).toHaveLength(0);
    });

    it('should handle malformed JSON', async () => {
      const filePath = path.join(testDir, 'bad.json');
      await fs.writeFile(filePath, 'not json');

      const result = await service.extractChatUiMessages(filePath);
      expect(result).toHaveLength(0);
    });
  });

  describe('collectActiveAgents', () => {
    it('should collect active agents from teams', async () => {
      const mockReader: TeamDataReader = {
        getTeams: async () => [
          {
            members: [
              { sessionName: 'sam-001', role: 'developer', agentStatus: 'active', workingStatus: 'in_progress', currentTickets: ['TASK-1'] },
              { sessionName: 'leo-002', role: 'developer', agentStatus: 'inactive', workingStatus: 'idle' },
              { sessionName: 'max-003', role: 'developer', agentStatus: 'active', workingStatus: 'idle' },
            ],
          },
        ],
      };

      const result = await service.collectActiveAgents(mockReader);

      expect(result).toHaveLength(2);
      expect(result[0].sessionName).toBe('sam-001');
      expect(result[0].workingStatus).toBe('in_progress');
      expect(result[0].currentTask).toBe('TASK-1');
      expect(result[1].sessionName).toBe('max-003');
    });

    it('should return empty array when getTeams fails', async () => {
      const mockReader: TeamDataReader = {
        getTeams: async () => { throw new Error('storage unavailable'); },
      };

      const result = await service.collectActiveAgents(mockReader);
      expect(result).toHaveLength(0);
    });
  });

  describe('formatSummaryMarkdown', () => {
    it('should format summary with threads and agents', () => {
      const summary = {
        generatedAt: '2025-03-16T12:00:00.000Z',
        activeThreads: [
          {
            channelType: 'slack' as const,
            channelId: 'C123',
            filePath: '/home/.crewly/slack-threads/C123/thread.md',
            lastActiveAt: '2025-03-16T11:00:00.000Z',
            recentMessages: ['Steve: Hello', 'Crewly: Working on it'],
          },
        ],
        activeAgents: [
          { sessionName: 'sam-001', role: 'developer', workingStatus: 'in_progress', currentTask: 'Build API' },
        ],
      };

      const markdown = service.formatSummaryMarkdown(summary);

      expect(markdown).toContain('# Session Handoff Summary');
      expect(markdown).toContain('SLACK');
      expect(markdown).toContain('C123');
      expect(markdown).toContain('Steve: Hello');
      expect(markdown).toContain('sam-001');
      expect(markdown).toContain('Build API');
    });

    it('should handle empty summary', () => {
      const summary = {
        generatedAt: '2025-03-16T12:00:00.000Z',
        activeThreads: [],
        activeAgents: [],
      };

      const markdown = service.formatSummaryMarkdown(summary);
      expect(markdown).toContain('No active conversations found');
    });

    it('should not exceed MAX_SUMMARY_LINES', () => {
      const manyThreads = Array.from({ length: 20 }, (_, i) => ({
        channelType: 'slack' as const,
        channelId: `C${i}`,
        filePath: `/path/C${i}/thread.md`,
        lastActiveAt: new Date().toISOString(),
        recentMessages: [`User: msg ${i}`, `Bot: reply ${i}`, `User: followup ${i}`],
      }));

      const markdown = service.formatSummaryMarkdown({
        generatedAt: new Date().toISOString(),
        activeThreads: manyThreads,
        activeAgents: [],
      });

      const lineCount = markdown.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(50);
    });
  });

  describe('generateSummary', () => {
    it('should generate summary and save to file', async () => {
      // Override getSummariesDir to use test directory
      const summariesDir = path.join(testDir, 'session-summaries');
      jest.spyOn(service, 'getSummariesDir').mockReturnValue(summariesDir);
      jest.spyOn(service, 'getLatestSummaryPath').mockReturnValue(path.join(summariesDir, 'latest.md'));

      // Mock thread scanning to return empty (no real thread dirs)
      jest.spyOn(service, 'scanThreadDirectory').mockResolvedValue([]);
      jest.spyOn(service, 'scanChatUiConversations').mockResolvedValue([]);

      const mockReader: TeamDataReader = {
        getTeams: async () => [
          {
            members: [
              { sessionName: 'sam', role: 'developer', agentStatus: 'active', workingStatus: 'idle' },
            ],
          },
        ],
      };

      const result = await service.generateSummary(mockReader);

      expect(result.generatedAt).toBeDefined();
      expect(result.activeAgents).toHaveLength(1);

      // Verify file was written
      const content = await fs.readFile(path.join(summariesDir, 'latest.md'), 'utf-8');
      expect(content).toContain('Session Handoff Summary');
      expect(content).toContain('sam');
    });
  });

  describe('pushSessionSummary', () => {
    it('should push summary content to agent', async () => {
      // Write a test summary
      const summariesDir = path.join(testDir, 'session-summaries');
      await fs.mkdir(summariesDir, { recursive: true });
      const summaryPath = path.join(summariesDir, 'latest.md');
      await fs.writeFile(summaryPath, '# Test Summary\nSome context here');

      jest.spyOn(service, 'getLatestSummaryPath').mockReturnValue(summaryPath);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushSessionSummary(mockSender, 'crewly-orc');

      expect(mockSender.sendMessageToAgent).toHaveBeenCalledTimes(1);
      const call = (mockSender.sendMessageToAgent as jest.Mock).mock.calls[0];
      expect(call[0]).toBe('crewly-orc');
      expect(call[1]).toContain('[SESSION_CONTEXT]');
      expect(call[1]).toContain('Test Summary');
    });

    it('should not send if summary file does not exist', async () => {
      jest.spyOn(service, 'getLatestSummaryPath').mockReturnValue(path.join(testDir, 'nonexistent.md'));

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushSessionSummary(mockSender, 'crewly-orc');

      expect(mockSender.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should not send if summary is empty', async () => {
      const summaryPath = path.join(testDir, 'empty.md');
      await fs.writeFile(summaryPath, '  \n  ');

      jest.spyOn(service, 'getLatestSummaryPath').mockReturnValue(summaryPath);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushSessionSummary(mockSender, 'crewly-orc');

      expect(mockSender.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should handle sendMessageToAgent failure gracefully', async () => {
      const summaryPath = path.join(testDir, 'summary.md');
      await fs.writeFile(summaryPath, '# Summary');

      jest.spyOn(service, 'getLatestSummaryPath').mockReturnValue(summaryPath);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockRejectedValue(new Error('PTY error')),
      };

      // Should not throw
      await expect(service.pushSessionSummary(mockSender, 'agent-1')).resolves.toBeUndefined();
    });
  });

  describe('findRecentThreads', () => {
    let slackDir: string;
    let gchatDir: string;
    let chatDir: string;

    beforeEach(async () => {
      slackDir = path.join(testDir, 'slack-threads');
      gchatDir = path.join(testDir, 'gchat-threads');
      chatDir = path.join(testDir, 'chat');
      await fs.mkdir(slackDir, { recursive: true });
      await fs.mkdir(gchatDir, { recursive: true });
      await fs.mkdir(chatDir, { recursive: true });
    });

    it('should find Slack threads modified within maxAge', async () => {
      const channelDir = path.join(slackDir, 'D0AC7NF5N7L');
      await fs.mkdir(channelDir, { recursive: true });
      await fs.writeFile(
        path.join(channelDir, '1772987441.763389.md'),
        '---\nchannel: D0AC7NF5N7L\nthread: 1772987441.763389\n---\n\n**Steve** (2026-03-16 12:00):\nHey team\n',
      );

      const result = await service.findRecentThreads(undefined, { slackDir, gchatDir, chatDir });

      expect(result).toHaveLength(1);
      expect(result[0].channelType).toBe('slack');
      expect(result[0].channelId).toBe('D0AC7NF5N7L');
      expect(result[0].threadId).toBe('1772987441.763389');
      expect(result[0].filePath).toContain('1772987441.763389.md');
      expect(result[0].recentMessages[0]).toContain('Steve');
    });

    it('should find GChat threads modified within maxAge', async () => {
      const spaceDir = path.join(gchatDir, 'spaces-abc123');
      await fs.mkdir(spaceDir, { recursive: true });
      await fs.writeFile(
        path.join(spaceDir, 'thread-xyz.md'),
        '---\nspace: spaces/abc123\n---\n\n**User** (2026-03-16 14:00):\nGChat message\n',
      );

      const result = await service.findRecentThreads(undefined, { slackDir, gchatDir, chatDir });

      expect(result).toHaveLength(1);
      expect(result[0].channelType).toBe('gchat');
      expect(result[0].channelId).toBe('spaces-abc123');
      expect(result[0].threadId).toBe('thread-xyz');
    });

    it('should find Chat UI conversations modified within maxAge', async () => {
      const conv = {
        messages: [
          { content: 'Hi there', from: { name: 'User', type: 'user' } },
          { content: 'Hello!', from: { name: 'Crewly', type: 'assistant' } },
        ],
      };
      await fs.writeFile(path.join(chatDir, 'conv-123.json'), JSON.stringify(conv));

      const result = await service.findRecentThreads(undefined, { slackDir, gchatDir, chatDir });

      expect(result).toHaveLength(1);
      expect(result[0].channelType).toBe('chat-ui');
      expect(result[0].channelId).toBe('conv-123');
      expect(result[0].threadId).toBe('conv-123');
      expect(result[0].recentMessages).toHaveLength(2);
    });

    it('should combine threads from all channels sorted by recency', async () => {
      // Slack thread (oldest)
      const slackCh = path.join(slackDir, 'C1');
      await fs.mkdir(slackCh, { recursive: true });
      await fs.writeFile(path.join(slackCh, 'thread1.md'), '---\n---\n\n**A** (12:00):\nSlack msg');

      await new Promise(r => setTimeout(r, 50));

      // GChat thread (middle)
      const gchatSpace = path.join(gchatDir, 'S1');
      await fs.mkdir(gchatSpace, { recursive: true });
      await fs.writeFile(path.join(gchatSpace, 'thread2.md'), '---\n---\n\n**B** (13:00):\nGChat msg');

      await new Promise(r => setTimeout(r, 50));

      // Chat UI (newest)
      await fs.writeFile(path.join(chatDir, 'conv1.json'), JSON.stringify({
        messages: [{ content: 'Chat UI msg', from: { name: 'User' } }],
      }));

      const result = await service.findRecentThreads(undefined, { slackDir, gchatDir, chatDir });

      expect(result).toHaveLength(3);
      expect(result[0].channelType).toBe('chat-ui');
      expect(result[1].channelType).toBe('gchat');
      expect(result[2].channelType).toBe('slack');
    });

    it('should exclude threads older than maxAge', async () => {
      const channelDir = path.join(slackDir, 'C123');
      await fs.mkdir(channelDir, { recursive: true });
      const filePath = path.join(channelDir, 'old-thread.md');
      await fs.writeFile(filePath, '---\n---\n\n**User** (2025-01-01 12:00):\nOld msg');
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await fs.utimes(filePath, oldTime, oldTime);

      const result = await service.findRecentThreads(undefined, { slackDir, gchatDir, chatDir });
      expect(result).toHaveLength(0);
    });

    it('should return empty array when no directories exist', async () => {
      const result = await service.findRecentThreads(undefined, {
        slackDir: '/non/existent/1',
        gchatDir: '/non/existent/2',
        chatDir: '/non/existent/3',
      });
      expect(result).toHaveLength(0);
    });

    it('should skip .json index files in thread directories', async () => {
      await fs.writeFile(path.join(slackDir, 'agent-index.json'), '{}');

      const result = await service.findRecentThreads(undefined, { slackDir, gchatDir, chatDir });
      expect(result).toHaveLength(0);
    });

    it('should exclude old Chat UI conversations', async () => {
      const filePath = path.join(chatDir, 'old-conv.json');
      await fs.writeFile(filePath, JSON.stringify({ messages: [{ content: 'old', from: { name: 'User' } }] }));
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await fs.utimes(filePath, oldTime, oldTime);

      const result = await service.findRecentThreads(undefined, { slackDir, gchatDir, chatDir });
      expect(result).toHaveLength(0);
    });
  });

  describe('findRecentSlackThreads (backward compat)', () => {
    it('should return only Slack threads via slackDirOverride', async () => {
      const slackDir = path.join(testDir, 'slack-only');
      const channelDir = path.join(slackDir, 'C1');
      await fs.mkdir(channelDir, { recursive: true });
      await fs.writeFile(path.join(channelDir, '111.md'), '---\n---\n\n**A** (12:00):\nMsg');

      const result = await service.findRecentSlackThreads(undefined, slackDir);

      expect(result).toHaveLength(1);
      expect(result[0].channelType).toBe('slack');
      expect(result[0].threadId).toBe('111');
    });
  });

  describe('pushResumeNotification', () => {
    it('should push [CHAT_RESUME] message with thread info from all channels', async () => {
      const mockThreads: ResumeThread[] = [
        {
          channelType: 'slack',
          channelId: 'D0AC7NF5N7L',
          threadId: '1772987441.763389',
          filePath: '/home/.crewly/slack-threads/D0AC7NF5N7L/1772987441.763389.md',
          lastActiveAt: '2026-03-16T12:00:00.000Z',
          recentMessages: ['Steve: Hey team', 'Crewly: Working on it'],
        },
        {
          channelType: 'gchat',
          channelId: 'spaces-abc',
          threadId: 'thread-xyz',
          filePath: '/home/.crewly/gchat-threads/spaces-abc/thread-xyz.md',
          lastActiveAt: '2026-03-16T11:00:00.000Z',
          recentMessages: ['User: GChat msg'],
        },
      ];

      jest.spyOn(service, 'findRecentThreads').mockResolvedValue(mockThreads);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushResumeNotification(mockSender, 'crewly-orc');

      expect(mockSender.sendMessageToAgent).toHaveBeenCalledTimes(1);
      const message = (mockSender.sendMessageToAgent as jest.Mock).mock.calls[0][1] as string;
      expect(message).toContain('[CHAT_RESUME]');
      expect(message).toContain('SLACK');
      expect(message).toContain('D0AC7NF5N7L');
      expect(message).toContain('1772987441.763389');
      expect(message).toContain('GCHAT');
      expect(message).toContain('spaces-abc');
      expect(message).toContain('thread-xyz');
      expect(message).toContain('MUST read');
    });

    it('should include Chat UI threads', async () => {
      const mockThreads: ResumeThread[] = [
        {
          channelType: 'chat-ui',
          channelId: 'conv-123',
          threadId: 'conv-123',
          filePath: '/home/.crewly/chat/conv-123.json',
          lastActiveAt: '2026-03-16T13:00:00.000Z',
          recentMessages: ['User: Hello from chat UI'],
        },
      ];

      jest.spyOn(service, 'findRecentThreads').mockResolvedValue(mockThreads);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushResumeNotification(mockSender, 'crewly-orc');

      const message = (mockSender.sendMessageToAgent as jest.Mock).mock.calls[0][1] as string;
      expect(message).toContain('CHAT-UI');
      expect(message).toContain('conv-123');
      expect(message).toContain('Hello from chat UI');
    });

    it('should not send if no recent threads', async () => {
      jest.spyOn(service, 'findRecentThreads').mockResolvedValue([]);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushResumeNotification(mockSender, 'crewly-orc');

      expect(mockSender.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should handle sendMessageToAgent failure gracefully', async () => {
      jest.spyOn(service, 'findRecentThreads').mockResolvedValue([
        {
          channelType: 'slack',
          channelId: 'C1',
          threadId: '1111.1111',
          filePath: '/path/thread.md',
          lastActiveAt: new Date().toISOString(),
          recentMessages: [],
        },
      ]);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockRejectedValue(new Error('PTY error')),
      };

      await expect(service.pushResumeNotification(mockSender, 'crewly-orc')).resolves.toBeUndefined();
    });

    it('should handle findRecentThreads failure gracefully', async () => {
      jest.spyOn(service, 'findRecentThreads').mockRejectedValue(new Error('fs error'));

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await expect(service.pushResumeNotification(mockSender, 'crewly-orc')).resolves.toBeUndefined();
    });

    it('should include source channel type in each thread entry', async () => {
      const mockThreads: ResumeThread[] = [
        {
          channelType: 'slack',
          channelId: 'C1',
          threadId: '111',
          filePath: '/path/slack.md',
          lastActiveAt: new Date().toISOString(),
          recentMessages: [],
        },
      ];

      jest.spyOn(service, 'findRecentThreads').mockResolvedValue(mockThreads);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushResumeNotification(mockSender, 'crewly-orc');

      const message = (mockSender.sendMessageToAgent as jest.Mock).mock.calls[0][1] as string;
      expect(message).toContain('Source: slack');
    });
  });

  describe('pushSlackResumeNotification (backward compat)', () => {
    it('should delegate to pushResumeNotification', async () => {
      const spy = jest.spyOn(service, 'pushResumeNotification').mockResolvedValue();

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushSlackResumeNotification(mockSender, 'crewly-orc');

      expect(spy).toHaveBeenCalledWith(mockSender, 'crewly-orc');
    });
  });
});
