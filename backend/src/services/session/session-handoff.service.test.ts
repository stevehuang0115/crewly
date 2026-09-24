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
import { SessionHandoffService, type TeamDataReader, type AgentMessageSender, type ResumeThread, type PendingTaskInfo, awaitsReply, relabelStaleWaiting } from './session-handoff.service.js';
import { ThreadStatusQueueService } from '../messaging/thread-status-queue.service.js';

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

    it('leaves out channels the filter marks as a team\'s (not the orchestrator\'s to resume)', async () => {
      for (const ch of ['C-TEAM', 'D-OWNER']) {
        await fs.mkdir(path.join(testDir, ch), { recursive: true });
        await fs.writeFile(path.join(testDir, ch, '1.md'), '---\n---\n\n**A** (12:00):\nhi');
      }
      service.setChannelFilter((type, id) => type === 'slack' && id === 'C-TEAM');
      try {
        const result = await service.scanThreadDirectory(testDir, 'slack');
        expect(result.map((t) => t.channelId)).toEqual(['D-OWNER']);
        // The filter is per channel type: the same id under gchat is not excluded.
        expect((await service.scanThreadDirectory(testDir, 'gchat')).map((t) => t.channelId).sort()).toEqual(['C-TEAM', 'D-OWNER']);
      } finally {
        service.setChannelFilter(null);
      }
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
        pendingTasks: [],
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
        pendingTasks: [],
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
        pendingTasks: [],
      });

      const lineCount = markdown.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(80);
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
      expect(message).toContain('Do NOT re-process threads that were already handled');
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

    describe('size cap (restart cost)', () => {
      const ORIGINAL_MAX_THREADS = process.env.CREWLY_CHAT_RESUME_MAX_THREADS;
      const ORIGINAL_MAX_CHARS = process.env.CREWLY_CHAT_RESUME_MAX_CHARS_PER_THREAD;

      afterEach(() => {
        if (ORIGINAL_MAX_THREADS === undefined) delete process.env.CREWLY_CHAT_RESUME_MAX_THREADS;
        else process.env.CREWLY_CHAT_RESUME_MAX_THREADS = ORIGINAL_MAX_THREADS;
        if (ORIGINAL_MAX_CHARS === undefined) delete process.env.CREWLY_CHAT_RESUME_MAX_CHARS_PER_THREAD;
        else process.env.CREWLY_CHAT_RESUME_MAX_CHARS_PER_THREAD = ORIGINAL_MAX_CHARS;
      });

      /** Build N slack threads; index 0 is the OLDEST so ordering is exercised. */
      const makeThreads = (count: number, messageChars = 40): ResumeThread[] =>
        Array.from({ length: count }, (_, i) => ({
          channelType: 'slack' as const,
          channelId: `C${i}`,
          threadId: `t${i}`,
          filePath: `/home/.crewly/slack-threads/C${i}/t${i}.md`,
          lastActiveAt: new Date(Date.UTC(2026, 2, 16, 0, i)).toISOString(),
          recentMessages: ['Steve: ' + 'x'.repeat(messageChars)],
        }));

      it('caps at 5 threads, newest first, and says how many were left out', () => {
        delete process.env.CREWLY_CHAT_RESUME_MAX_THREADS;
        const { message, included, omitted } = SessionHandoffService.buildResumeMessage(makeThreads(12));

        expect(included).toBe(5);
        expect(omitted).toBe(7);
        expect(message).toContain('and 7 more — use list-my-followups');
        // Newest (highest index) first; the oldest seven never appear.
        for (const i of [11, 10, 9, 8, 7]) expect(message).toContain(`## SLACK Thread: C${i} / t${i}`);
        for (const i of [6, 5, 4, 3, 2, 1, 0]) expect(message).not.toContain(`Thread: C${i} / t${i}`);
        expect(message.indexOf('Thread: C11 /')).toBeLessThan(message.indexOf('Thread: C10 /'));
        expect(message.indexOf('Thread: C8 /')).toBeLessThan(message.indexOf('Thread: C7 /'));
      });

      it('does not add the "and K more" line when everything fits', () => {
        const { message, omitted } = SessionHandoffService.buildResumeMessage(makeThreads(3));
        expect(omitted).toBe(0);
        expect(message).not.toContain('more — use list-my-followups');
      });

      it('caps each thread block at 600 chars, cut at a line boundary with a marker', () => {
        delete process.env.CREWLY_CHAT_RESUME_MAX_CHARS_PER_THREAD;
        const threads: ResumeThread[] = [{
          channelType: 'chat-ui',
          channelId: 'conv-big',
          threadId: 'conv-big',
          filePath: '/home/.crewly/chat/conv-big.json',
          lastActiveAt: '2026-03-16T13:00:00.000Z',
          recentMessages: [
            'User: ' + 'a'.repeat(300),
            'User: ' + 'b'.repeat(300),
            'User: ' + 'c'.repeat(300),
          ],
        }];
        const { message } = SessionHandoffService.buildResumeMessage(threads);
        const block = message.split('\n\n').find((b) => b.startsWith('## CHAT-UI Thread')) ?? '';

        expect(block.length).toBeLessThanOrEqual(600);
        expect(block).toContain('## CHAT-UI Thread: conv-big / conv-big');
        expect(block).toContain('- File: `/home/.crewly/chat/conv-big.json`');
        expect(block).toContain('(truncated');
        // Whole lines only: a dropped message never appears half-cut.
        expect(block).not.toContain('b'.repeat(300));
        expect(block).not.toContain('c'.repeat(300));
        expect(block.split('\n').every((l) => !/a{1,299}$/.test(l) || l.endsWith('a'.repeat(300)))).toBe(true);
      });

      it('leaves short thread blocks untouched (no marker)', () => {
        const { message } = SessionHandoffService.buildResumeMessage(makeThreads(1));
        expect(message).not.toContain('(truncated');
        expect(message).toContain('Steve: ' + 'x'.repeat(40));
      });

      it('honours the env overrides and ignores garbage values', () => {
        process.env.CREWLY_CHAT_RESUME_MAX_THREADS = '2';
        process.env.CREWLY_CHAT_RESUME_MAX_CHARS_PER_THREAD = '120';
        const two = SessionHandoffService.buildResumeMessage(makeThreads(4, 200));
        expect(two.included).toBe(2);
        expect(two.omitted).toBe(2);
        expect(two.message).toContain('and 2 more — use list-my-followups');
        const blocks = two.message.split('\n\n').filter((b) => b.startsWith('## SLACK'));
        expect(blocks).toHaveLength(2);
        for (const b of blocks) expect(b.length).toBeLessThanOrEqual(120);

        process.env.CREWLY_CHAT_RESUME_MAX_THREADS = 'lots';
        process.env.CREWLY_CHAT_RESUME_MAX_CHARS_PER_THREAD = '-1';
        const fallback = SessionHandoffService.buildResumeMessage(makeThreads(7, 20));
        expect(fallback.included).toBe(5);
        expect(fallback.message).not.toContain('(truncated');
      });

      it('pushResumeNotification sends the capped message and logs the split', async () => {
        delete process.env.CREWLY_CHAT_RESUME_MAX_THREADS;
        jest.spyOn(service, 'findRecentThreads').mockResolvedValue(makeThreads(8));
        const mockSender: AgentMessageSender = {
          sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
        };

        await service.pushResumeNotification(mockSender, 'crewly-orc');

        const message = (mockSender.sendMessageToAgent as jest.Mock).mock.calls[0][1] as string;
        expect(message).toContain('[CHAT_RESUME]');
        expect((message.match(/^## SLACK Thread:/gm) ?? []).length).toBe(5);
        expect(message).toContain('and 3 more — use list-my-followups');
      });
    });

    it('should not send if no recent threads', async () => {
      jest.spyOn(service, 'findRecentThreads').mockResolvedValue([]);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushResumeNotification(mockSender, 'crewly-orc');

      expect(mockSender.sendMessageToAgent).not.toHaveBeenCalled();
    });

    // Regression gate (2026-05-16): pre-fix, the resume-notification
    // filter dynamic-imported ThreadStatusQueueService inside a
    // `catch {}` block. When the import or lookup threw silently, the
    // filter never excluded any threads — orc was re-prompted to reply
    // to threads already in `replied_completed` status, producing the
    // duplicate `agentic_explainer.mp4` upload after restart. The fix
    // switched to static imports + a logging catch.
    it('excludes threads whose thread-status is replied_completed (filter regression gate)', async () => {
      // Seed the queue with a terminal entry for the agentic_explainer thread.
      ThreadStatusQueueService.resetInstance();
      const tsq = new ThreadStatusQueueService();
      tsq.trackInbound({
        threadKey: 'D0AC7NF5N7L:1778816065.309289',
        conversationId: 'slack-D0AC7NF5N7L-1778816065-309289',
        source: 'slack',
        messagePreview: 'inbound msg',
      });
      tsq.markReplied('D0AC7NF5N7L:1778816065.309289', 'replied_completed');

      jest.spyOn(service, 'findRecentThreads').mockResolvedValue([
        // Terminal — should be filtered OUT.
        {
          channelType: 'slack',
          channelId: 'D0AC7NF5N7L',
          threadId: '1778816065.309289',
          filePath: '/x.md',
          lastActiveAt: new Date().toISOString(),
          recentMessages: [],
        },
        // Not in queue — should pass through (kept).
        {
          channelType: 'slack',
          channelId: 'D0AC7NF5N7L',
          threadId: '1778859267.970399',
          filePath: '/y.md',
          lastActiveAt: new Date().toISOString(),
          recentMessages: [],
        },
      ]);

      const mockSender: AgentMessageSender = {
        sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      };

      await service.pushResumeNotification(mockSender, 'crewly-orc');

      expect(mockSender.sendMessageToAgent).toHaveBeenCalledTimes(1);
      const message = (mockSender.sendMessageToAgent as jest.Mock).mock.calls[0][1] as string;
      // Terminal thread MUST NOT appear in the resume notification.
      expect(message).not.toContain('1778816065.309289');
      // Non-terminal thread MUST appear.
      expect(message).toContain('1778859267.970399');

      ThreadStatusQueueService.resetInstance();
    });

    // Regression (#757): cleanup() drops terminal entries 24h after their
    // last update, but the resume scan goes by thread-file mtime, which can
    // be later (the last write was an agent completion report). With the
    // entry gone, "no entry" read as "unreplied" and the closed threads were
    // re-flagged on every restart. Scenario from the issue: two threads
    // answered at 2026-09-20T04:14Z, restarts at 04:00 and 05:08 on 09-21.
    describe('closed threads whose status entry aged out (#757)', () => {
      const REPLIED_AT = '2026-09-20T04:14:00.000Z';
      const FIRST_RESTART = Date.parse('2026-09-21T04:00:00.000Z');
      const SECOND_RESTART = Date.parse('2026-09-21T05:08:00.000Z');
      const CLOSED = [
        { channelId: 'D0AC7NF5N7L', threadId: '1789877640.000100' },
        { channelId: 'C0BUILDS01', threadId: '1789877650.000200' },
      ];
      const UNTRACKED = { channelId: 'C0BUILDS01', threadId: '1789900000.000300' };

      /** The scan result: file mtimes all inside the 24h lookback. */
      const scan = (now: number): ResumeThread[] =>
        [...CLOSED, UNTRACKED].map((t, i) => ({
          channelType: 'slack' as const,
          channelId: t.channelId,
          threadId: t.threadId,
          filePath: `/threads/${t.threadId}.md`,
          lastActiveAt: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(),
          recentMessages: [],
        }));

      /** Answer both CLOSED threads at REPLIED_AT. */
      function seed(tsq: ThreadStatusQueueService): void {
        for (const t of CLOSED) {
          const threadKey = `${t.channelId}:${t.threadId}`;
          tsq.trackInbound({ threadKey, conversationId: `slack-${t.channelId}-${t.threadId}`, source: 'slack', messagePreview: 'q' });
          tsq.markReplied(threadKey, 'replied_completed');
        }
        for (const entry of tsq.getAllEntries()) entry.updatedAt = REPLIED_AT;
      }

      afterEach(() => {
        jest.restoreAllMocks();
        ThreadStatusQueueService.resetInstance();
      });

      it('does not resurface them once cleanup removed their entries, across a persisted restart', async () => {
        ThreadStatusQueueService.resetInstance();
        const first = new ThreadStatusQueueService(testDir);
        seed(first);

        // Restart 1 (04:00, entries 23h46m old): nothing is cleaned yet.
        const now = jest.spyOn(Date, 'now').mockReturnValue(FIRST_RESTART);
        expect(first.cleanup()).toBe(0);
        await first.persist();

        // Restart 2 (05:08): a fresh process loads the file, cleanup drops both entries.
        ThreadStatusQueueService.resetInstance();
        const second = new ThreadStatusQueueService(testDir);
        await second.loadPersistedState();
        now.mockReturnValue(SECOND_RESTART);
        expect(second.cleanup()).toBe(2);
        for (const t of CLOSED) expect(second.get(`${t.channelId}:${t.threadId}`)).toBeNull();
        await second.persist();

        // Restart 3: the records survive another reload.
        ThreadStatusQueueService.resetInstance();
        const third = new ThreadStatusQueueService(testDir);
        await third.loadPersistedState();

        jest.spyOn(service, 'findRecentThreads').mockResolvedValue(scan(SECOND_RESTART));
        const sender: AgentMessageSender = { sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }) };
        await service.pushResumeNotification(sender, 'crewly-orc');

        expect(sender.sendMessageToAgent).toHaveBeenCalledTimes(1);
        const message = (sender.sendMessageToAgent as jest.Mock).mock.calls[0][1] as string;
        for (const t of CLOSED) expect(message).not.toContain(t.threadId);
        // A thread the queue never tracked is still surfaced: no evidence it was answered.
        expect(message).toContain(UNTRACKED.threadId);
      });

      it('sends nothing when every recent thread is closed', async () => {
        ThreadStatusQueueService.resetInstance();
        const tsq = new ThreadStatusQueueService();
        seed(tsq);
        jest.spyOn(Date, 'now').mockReturnValue(SECOND_RESTART);
        tsq.cleanup();

        jest.spyOn(service, 'findRecentThreads').mockResolvedValue(scan(SECOND_RESTART).slice(0, CLOSED.length));
        const sender: AgentMessageSender = { sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }) };
        await service.pushResumeNotification(sender, 'crewly-orc');
        expect(sender.sendMessageToAgent).not.toHaveBeenCalled();
      });

      it('resurfaces a closed thread again when a new inbound message reopens it', async () => {
        ThreadStatusQueueService.resetInstance();
        const tsq = new ThreadStatusQueueService();
        seed(tsq);
        jest.spyOn(Date, 'now').mockReturnValue(SECOND_RESTART);
        tsq.cleanup();
        const [reopened] = CLOSED;
        tsq.trackInbound({ threadKey: `${reopened.channelId}:${reopened.threadId}`, conversationId: 'c-reopened', source: 'slack', messagePreview: 'one more thing' });

        jest.spyOn(service, 'findRecentThreads').mockResolvedValue(scan(SECOND_RESTART).slice(0, CLOSED.length));
        const sender: AgentMessageSender = { sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }) };
        await service.pushResumeNotification(sender, 'crewly-orc');
        const message = (sender.sendMessageToAgent as jest.Mock).mock.calls[0][1] as string;
        expect(message).toContain(reopened.threadId);
        expect(message).not.toContain(CLOSED[1].threadId);
      });

      it('filters a closed chat-ui conversation by its conversation id', async () => {
        ThreadStatusQueueService.resetInstance();
        const tsq = new ThreadStatusQueueService();
        tsq.trackInbound({ threadKey: 'chat:conv-42', conversationId: 'conv-42', source: 'web_chat', messagePreview: 'q' });
        tsq.markReplied('chat:conv-42', 'replied_completed');
        for (const entry of tsq.getAllEntries()) entry.updatedAt = REPLIED_AT;
        jest.spyOn(Date, 'now').mockReturnValue(SECOND_RESTART);
        tsq.cleanup();

        jest.spyOn(service, 'findRecentThreads').mockResolvedValue([
          { channelType: 'chat-ui', channelId: 'conv-42', threadId: 'conv-42', filePath: '/c.json', lastActiveAt: new Date(SECOND_RESTART).toISOString(), recentMessages: [] },
        ]);
        const sender: AgentMessageSender = { sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }) };
        await service.pushResumeNotification(sender, 'crewly-orc');
        expect(sender.sendMessageToAgent).not.toHaveBeenCalled();
      });
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

  // (parseTaskFile removed in Phase 2 Workstream C — V3 task-pool is now SoT,
  // no longer parses .md filesystem fixtures.
  // See specs/2026-05-06-projecttask-md-deprecation.md.)

  describe('scanPendingTasks (V3 task-pool source)', () => {
    /**
     * Replaces the TaskPoolService singleton's `getAllItems` for the duration
     * of one test.
     *
     * @param items - Stub WorkItem-shaped objects to be returned
     */
    async function stubTaskPool(
      items: Array<{
        id: string;
        title: string;
        target?: string;
        status: string;
        priority?: string;
      }>,
    ): Promise<jest.SpyInstance> {
      const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
      const pool = TaskPoolService.getInstance();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return jest.spyOn(pool, 'getAllItems').mockResolvedValue(items as any);
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns non-terminal WorkItems mapped to PendingTaskInfo', async () => {
      await stubTaskPool([
        { id: 'wi-1', title: 'Build API', target: 'sam-001', status: 'queued', priority: 'high' },
        { id: 'wi-2', title: 'Fix bug', target: 'leo-002', status: 'running', priority: 'low' },
        { id: 'wi-3', title: 'Done thing', target: 'max-003', status: 'done', priority: 'high' },
        { id: 'wi-4', title: 'Cancelled thing', status: 'cancelled' },
      ]);

      const result = await service.scanPendingTasks();
      expect(result).toHaveLength(2);
      // running first per the new sort key
      expect(result[0].title).toBe('Fix bug');
      expect(result[0].status).toBe('running');
      expect(result[1].title).toBe('Build API');
      expect(result[1].status).toBe('queued');
    });

    it('orders running before queued, then by priority within tier', async () => {
      await stubTaskPool([
        { id: 'wi-q-hi', title: 'Q high', target: 'a-1', status: 'queued', priority: 'high' },
        { id: 'wi-r-lo', title: 'R low', target: 'a-2', status: 'running', priority: 'low' },
        { id: 'wi-q-lo', title: 'Q low', target: 'a-3', status: 'queued', priority: 'low' },
      ]);

      const result = await service.scanPendingTasks();
      expect(result.map((t) => t.title)).toEqual(['R low', 'Q high', 'Q low']);
    });

    it('treats `proposed`, `accepted`, `blocked`, `done_by_worker` as still-pending', async () => {
      await stubTaskPool([
        { id: 'wi-prop', title: 'Proposed', target: 'a-1', status: 'proposed' },
        { id: 'wi-acc', title: 'Accepted', target: 'a-2', status: 'accepted' },
        { id: 'wi-blk', title: 'Blocked', target: 'a-3', status: 'blocked' },
        { id: 'wi-dbw', title: 'Awaiting verify', target: 'a-4', status: 'done_by_worker' },
        { id: 'wi-done', title: 'Done', target: 'a-5', status: 'done' },
        { id: 'wi-ver', title: 'Verified', target: 'a-6', status: 'verified' },
      ]);

      const result = await service.scanPendingTasks();
      const ids = result.map((t) => t.filePath);
      expect(ids).toEqual(expect.arrayContaining(['wi-prop', 'wi-acc', 'wi-blk', 'wi-dbw']));
      expect(ids).not.toEqual(expect.arrayContaining(['wi-done', 'wi-ver']));
    });

    it('uses WorkItem id as the stable filePath identifier', async () => {
      await stubTaskPool([
        { id: 'abc-123', title: 't', target: 'a', status: 'queued' },
      ]);
      const result = await service.scanPendingTasks();
      expect(result[0].filePath).toBe('abc-123');
    });

    it('falls back to "unassigned" when target is empty', async () => {
      await stubTaskPool([
        { id: 'wi-orphan', title: 'No-target task', status: 'queued' },
      ]);
      const result = await service.scanPendingTasks();
      expect(result[0].assignedTo).toBe('unassigned');
    });

    it('truncates titles longer than 100 chars', async () => {
      const longTitle = 'A'.repeat(200);
      await stubTaskPool([
        { id: 'wi-long', title: longTitle, target: 'a', status: 'queued' },
      ]);
      const result = await service.scanPendingTasks();
      expect(result[0].title.length).toBe(100);
      expect(result[0].title.endsWith('...')).toBe(true);
    });

    it('caps at MAX_PENDING_TASKS', async () => {
      const many = Array.from({ length: 25 }, (_, i) => ({
        id: `wi-${i}`,
        title: `Task ${i}`,
        target: `a-${i}`,
        status: 'queued',
      }));
      await stubTaskPool(many);
      const result = await service.scanPendingTasks();
      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('returns empty array when the task-pool throws', async () => {
      const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
      const pool = TaskPoolService.getInstance();
      jest.spyOn(pool, 'getAllItems').mockRejectedValue(new Error('boom'));

      const result = await service.scanPendingTasks();
      expect(result).toEqual([]);
    });

    it('ignores the legacy tasksBaseDir parameter (kept for caller compat)', async () => {
      await stubTaskPool([
        { id: 'wi-1', title: 't', target: 'a', status: 'queued' },
      ]);
      const result = await service.scanPendingTasks('/some/legacy/path/that/does/not/matter');
      expect(result).toHaveLength(1);
    });
  });

  describe('formatSummaryMarkdown with pending tasks', () => {
    it('should include Pending Tasks section when tasks exist', () => {
      const summary = {
        generatedAt: '2026-03-16T12:00:00.000Z',
        activeThreads: [],
        activeAgents: [],
        pendingTasks: [
          {
            title: 'Build login API',
            assignedTo: 'sam-dev-001',
            status: 'in_progress',
            priority: 'high',
            filePath: '/path/to/task.md',
          },
          {
            title: 'Fix CSS layout',
            assignedTo: 'leo-dev-002',
            status: 'open',
            priority: 'low',
            filePath: '/path/to/task2.md',
          },
        ],
      };

      const markdown = service.formatSummaryMarkdown(summary);

      expect(markdown).toContain('## Pending Tasks');
      expect(markdown).toContain('2 task(s) require attention');
      expect(markdown).toContain('IN PROGRESS');
      expect(markdown).toContain('Build login API');
      expect(markdown).toContain('sam-dev-001');
      expect(markdown).toContain('OPEN');
      expect(markdown).toContain('Fix CSS layout');
      expect(markdown).toContain('leo-dev-002');
    });

    it('should not include Pending Tasks section when no tasks', () => {
      const summary = {
        generatedAt: '2026-03-16T12:00:00.000Z',
        activeThreads: [],
        activeAgents: [],
        pendingTasks: [],
      };

      const markdown = service.formatSummaryMarkdown(summary);
      expect(markdown).not.toContain('## Pending Tasks');
    });
  });

  describe('generateSummary with pending tasks', () => {
    it('should include pending tasks (sourced from V3 task-pool) in generated summary', async () => {
      const summariesDir = path.join(testDir, 'session-summaries');
      jest.spyOn(service, 'getSummariesDir').mockReturnValue(summariesDir);
      jest.spyOn(service, 'getLatestSummaryPath').mockReturnValue(path.join(summariesDir, 'latest.md'));
      jest.spyOn(service, 'scanThreadDirectory').mockResolvedValue([]);
      jest.spyOn(service, 'scanChatUiConversations').mockResolvedValue([]);

      // V3 task-pool is the source of truth post-deprecation. Stub its
      // singleton to return one running task; everything else (cancelled,
      // done) must be filtered out by the consumer.
      const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
      const pool = TaskPoolService.getInstance();
      jest.spyOn(pool, 'getAllItems').mockResolvedValue([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'wi-deploy', title: 'Deploy v2.0', target: 'sam-001', status: 'running', priority: 'high' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'wi-finished', title: 'Old', target: 'a', status: 'done' } as any,
      ]);

      const mockReader: TeamDataReader = {
        getTeams: async () => [{ members: [] }],
      };

      // tasksBaseDir is now a no-op (kept for caller compat); the service
      // routes through TaskPoolService regardless.
      const result = await service.generateSummary(mockReader, '/ignored');

      expect(result.pendingTasks).toHaveLength(1);
      expect(result.pendingTasks[0].title).toBe('Deploy v2.0');
      expect(result.pendingTasks[0].status).toBe('running');

      const content = await fs.readFile(path.join(summariesDir, 'latest.md'), 'utf-8');
      expect(content).toContain('Pending Tasks');
      expect(content).toContain('Deploy v2.0');
    });
  });
});

describe('what a restart hands the orchestrator', () => {
  // After every restart the orchestrator posted a status report into its
  // latest DM thread — one it had answered two days earlier (2026-09-23).
  it('treats a conversation whose last word is the assistant\'s as answered', () => {
    expect(awaitsReply(['UG94JLNGK: 这个邮件是谁在处理？', 'Crewly: [Orc] 抱歉 — 这条问题当时漏掉了'])).toBe(false);
    expect(awaitsReply(['Orchestrator: done'])).toBe(false);
    expect(awaitsReply(['Steve: [Orc] quoted'])).toBe(false);
  });

  it('treats one whose last word is a person\'s as waiting', () => {
    expect(awaitsReply(['Crewly: [Orc] which email?', 'UG94JLNGK: the Sunrun one'])).toBe(true);
    expect(awaitsReply(['You: 可以再看看Ruflo吗？'])).toBe(true);
    expect(awaitsReply([])).toBe(false);
  });
});

describe('how the restart summary labels conversations', () => {
  const thread = (id: string, lastActiveAt: string, recentMessages: string[]) => ({
    channelType: 'slack' as const, channelId: id, filePath: `/t/${id}.md`, lastActiveAt, recentMessages,
  });

  it('asks for a reply only on a recent unanswered message', () => {
    const md = SessionHandoffService.getInstance().formatSummaryMarkdown({
      generatedAt: '2026-09-23T04:00:00.000Z',
      activeThreads: [
        thread('ANSWERED', '2026-09-23T03:00:00.000Z', ['UG94: ?', 'Crewly: [Orc] done']),
        thread('RECENT', '2026-09-23T03:30:00.000Z', ['UG94: 这个邮件是谁在处理？']),
        thread('OLD', '2026-09-21T01:38:00.000Z', ['UG94: hi']),
      ],
      activeAgents: [],
      pendingTasks: [],
    } as never);

    expect(md).toContain('ANSWERED — already answered (context only)');
    expect(md).toContain('RECENT — WAITING FOR A REPLY');
    // A "hi" from two days ago is not something to answer after a restart.
    expect(md).toContain('OLD — unanswered but old (context only, do not reply now)');
  });
});

describe('relabelStaleWaiting (at push time, whatever wrote the file)', () => {
  const md = [
    '## Active Conversations',
    '### SLACK — D1 — WAITING FOR A REPLY',
    '- File: `/t/d1.md`',
    '- Last active: 2026-09-21T01:38:41.410Z',
    '- Recent:',
    '  - UG94JLNGK: hi',
    '',
    '### CHAT-UI — c-may',
    '- File: `/t/c.json`',
    '- Last active: 2026-05-14T20:45:54.201Z',
    '- Recent:',
    '  - You: 可以让战略团队看看这个吗',
    '',
    '### SLACK — D2',
    '- File: `/t/d2.md`',
    '- Last active: 2026-09-23T03:03:07.385Z',
    '- Recent:',
    '  - Crewly: [Orc] Atlas is blocked',
    '',
    '### SLACK — D3',
    '- File: `/t/d3.md`',
    '- Last active: 2026-09-23T03:50:00.000Z',
    '- Recent:',
    '  - UG94JLNGK: 谁是TL',
  ].join('\n');

  it('keeps only a recent unanswered message as waiting', () => {
    // A May request ("have the strategy team look at this") must not be acted
    // on four months later just because Crewly restarted.
    const out = relabelStaleWaiting(md, Date.parse('2026-09-23T04:00:00.000Z'));
    expect(out).toContain('### SLACK — D1 — unanswered but old (context only, do not reply now)');
    expect(out).toContain('### CHAT-UI — c-may — unanswered but old (context only, do not reply now)');
    expect(out).toContain('### SLACK — D2 — already answered (context only)');
    expect(out).toContain('### SLACK — D3 — WAITING FOR A REPLY');
  });
});
