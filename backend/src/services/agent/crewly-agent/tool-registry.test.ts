import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { createTools, getToolNames, TOOL_SENSITIVITY, stripNotifyMarkers, convertMarkdownToSlackMrkdwn, globToRegExp, walkAndMatch, searchFileContents } from './tool-registry.js';
import { CrewlyApiClient } from './api-client.js';
import type { AuditEntry, ToolCallbacks, CompactionResult, AuditLogFilters } from './types.js';
import { WRITE_TOOLS } from './types.js';

describe('Tool Registry', () => {
  let mockClient: jest.Mocked<CrewlyApiClient>;
  let tools: ReturnType<typeof createTools>;

  beforeEach(() => {
    mockClient = {
      get: jest.fn<any>().mockResolvedValue({ success: false, data: null, status: 404 }),
      post: jest.fn<any>(),
      delete: jest.fn<any>(),
    } as any;
    tools = createTools(mockClient, 'crewly-orc', '/test/project');
  });

  describe('getToolNames', () => {
    it('should return all tool names including glob and grep', () => {
      const names = getToolNames();
      expect(names).toHaveLength(32);
      expect(names).toContain('delegate_task');
      expect(names).toContain('send_message');
      expect(names).toContain('get_agent_status');
      expect(names).toContain('get_team_status');
      expect(names).toContain('get_agent_logs');
      expect(names).toContain('reply_slack');
      expect(names).toContain('schedule_check');
      expect(names).toContain('cancel_schedule');
      expect(names).toContain('get_scheduled_checks');
      expect(names).toContain('start_agent');
      expect(names).toContain('stop_agent');
      expect(names).toContain('subscribe_event');
      expect(names).toContain('recall_memory');
      expect(names).toContain('remember');
      expect(names).toContain('heartbeat');
      expect(names).toContain('get_tasks');
      expect(names).toContain('complete_task');
      expect(names).toContain('broadcast');
      expect(names).toContain('handle_agent_failure');
      expect(names).toContain('edit_file');
      expect(names).toContain('read_file');
      expect(names).toContain('write_file');
      expect(names).toContain('register_self');
      expect(names).toContain('get_project_overview');
      expect(names).toContain('report_status');
      expect(names).toContain('compact_memory');
      expect(names).toContain('get_audit_log');
      expect(names).toContain('glob');
      expect(names).toContain('grep');
    });
  });

  describe('createTools', () => {
    it('should create all tools with descriptions and parameters', () => {
      const toolNames = Object.keys(tools);
      expect(toolNames.length).toBeGreaterThanOrEqual(30);
      for (const name of toolNames) {
        const t = tools[name] as any;
        expect(t).toBeDefined();
      }
    });
  });

  describe('delegate_task', () => {
    it('should deliver task message and create tracking entry', async () => {
      mockClient.post.mockResolvedValueOnce({ success: true, data: {}, status: 200 }); // deliver
      mockClient.post.mockResolvedValueOnce({ success: true, data: { taskId: 'task-1' }, status: 201 }); // task create
      mockClient.post.mockResolvedValueOnce({ success: true, data: { id: 'sub-1' }, status: 201 }); // subscribe

      const result = await (tools.delegate_task as any).execute({
        to: 'agent-sam',
        task: 'Build feature X',
        priority: 'high',
        projectPath: '/path/to/project',
      });

      expect(result.success).toBe(true);
      expect(result.delegatedTo).toBe('agent-sam');
      expect(result.taskId).toBe('task-1');
      expect(mockClient.post).toHaveBeenCalledTimes(3);
    });

    it('should fall back to force delivery on initial failure', async () => {
      mockClient.post
        .mockResolvedValueOnce({ success: false, error: 'not ready', status: 503 }) // deliver fails
        .mockResolvedValueOnce({ success: true, data: {}, status: 200 }) // force deliver
        .mockResolvedValueOnce({ success: true, data: {}, status: 201 }); // subscribe (no projectPath)

      const result = await (tools.delegate_task as any).execute({
        to: 'agent-sam',
        task: 'Build feature X',
        priority: 'normal',
      });

      expect(result.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledTimes(3);
    });

    it('should return error if both delivery attempts fail', async () => {
      mockClient.post
        .mockResolvedValueOnce({ success: false, error: 'not ready', status: 503 })
        .mockResolvedValueOnce({ success: false, error: 'session gone', status: 404 });

      const result = await (tools.delegate_task as any).execute({
        to: 'agent-sam',
        task: 'Build feature X',
        priority: 'normal',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('agent-sam');
    });
  });

  describe('send_message', () => {
    it('should deliver message with waitForReady', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      const result = await (tools.send_message as any).execute({
        sessionName: 'agent-sam',
        message: 'Hello',
        force: false,
      });

      expect(result.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith(
        '/terminal/agent-sam/deliver',
        expect.objectContaining({ message: 'Hello', waitForReady: true }),
      );
    });

    it('should force deliver when force=true', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      await (tools.send_message as any).execute({
        sessionName: 'agent-sam',
        message: 'Urgent',
        force: true,
      });

      expect(mockClient.post).toHaveBeenCalledWith(
        '/terminal/agent-sam/deliver',
        expect.objectContaining({ message: 'Urgent', force: true }),
      );
    });
  });

  describe('get_agent_status', () => {
    it('should find agent in team members', async () => {
      mockClient.get.mockResolvedValue({
        success: true,
        data: [
          { members: [{ sessionName: 'agent-sam', status: 'active' }] },
        ],
        status: 200,
      });

      const result = await (tools.get_agent_status as any).execute({
        sessionName: 'agent-sam',
      });

      expect(result.sessionName).toBe('agent-sam');
      expect(result.status).toBe('active');
    });

    it('should return error when agent not found', async () => {
      mockClient.get.mockResolvedValue({
        success: true,
        data: [{ members: [] }],
        status: 200,
      });

      const result = await (tools.get_agent_status as any).execute({
        sessionName: 'nonexistent',
      });

      expect(result.error).toBe('Agent not found');
    });
  });

  describe('get_team_status', () => {
    it('should return all teams', async () => {
      mockClient.get.mockResolvedValue({ success: true, data: [{ name: 'Team A' }], status: 200 });

      const result = await (tools.get_team_status as any).execute({});

      expect(result).toEqual([{ name: 'Team A' }]);
    });
  });

  describe('get_agent_logs', () => {
    it('should fetch terminal output', async () => {
      mockClient.get.mockResolvedValue({ success: true, data: 'line 1\nline 2', status: 200 });

      const result = await (tools.get_agent_logs as any).execute({
        sessionName: 'agent-sam',
        lines: 20,
      });

      expect(result).toBe('line 1\nline 2');
      expect(mockClient.get).toHaveBeenCalledWith('/terminal/agent-sam/output?lines=20');
    });
  });

  describe('reply_slack', () => {
    it('should send slack message with thread', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      const result = await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: 'Hello team',
        threadTs: '123.456',
      });

      expect(result.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith('/slack/send', {
        channelId: 'C123',
        text: '[Orc] Hello team',
        threadTs: '123.456',
      });
    });

    it('should send without threadTs', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: 'Hello',
      });

      expect(mockClient.post).toHaveBeenCalledWith('/slack/send', {
        channelId: 'C123',
        text: '[Orc] Hello',
      });
    });

    it('should strip [NOTIFY] markers from text before sending (Bug 6)', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: '[NOTIFY]\nconversationId: conv-123\n---\n## Task Done\nAll tasks completed.\n[/NOTIFY]',
        threadTs: '123.456',
      });

      // After stripping NOTIFY markers, text starts with "##" not "[", so prefix is added
      expect(mockClient.post).toHaveBeenCalledWith('/slack/send', {
        channelId: 'C123',
        text: '[Orc] ## Task Done\nAll tasks completed.',
        threadTs: '123.456',
      });
    });

    it('should handle text with no NOTIFY markers unchanged', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: 'Plain message without markers',
      });

      expect(mockClient.post).toHaveBeenCalledWith('/slack/send', {
        channelId: 'C123',
        text: '[Orc] Plain message without markers',
      });
    });

    it('should not double-prefix text already starting with [', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: '[Sam] Already prefixed message',
      });

      expect(mockClient.post).toHaveBeenCalledWith('/slack/send', {
        channelId: 'C123',
        text: '[Sam] Already prefixed message',
      });
    });

    it('should upload image when imagePath is provided', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { fileId: 'F123' }, status: 200 });

      const result = await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: 'Here is the screenshot',
        imagePath: '/tmp/screenshot.png',
      });

      expect(result.success).toBe(true);
      expect(result.uploaded).toBe(true);
      expect(result.filePath).toBe('/tmp/screenshot.png');
      expect(mockClient.post).toHaveBeenCalledWith('/slack/upload-image', {
        channelId: 'C123',
        filePath: '/tmp/screenshot.png',
        initialComment: '[Orc] Here is the screenshot',
      });
    });

    it('should upload image with threadTs', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { fileId: 'F123' }, status: 200 });

      await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: 'Screenshot',
        threadTs: '123.456',
        imagePath: '/tmp/shot.png',
      });

      expect(mockClient.post).toHaveBeenCalledWith('/slack/upload-image', {
        channelId: 'C123',
        filePath: '/tmp/shot.png',
        initialComment: '[Orc] Screenshot',
        threadTs: '123.456',
      });
    });

    it('should return error when image upload fails', async () => {
      mockClient.post.mockResolvedValue({ success: false, data: null, status: 404, error: 'File not found: /tmp/missing.png' });

      const result = await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: 'Missing image',
        imagePath: '/tmp/missing.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('File not found: /tmp/missing.png');
    });

    it('should use Slack context channelId for image upload when channelId omitted', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { fileId: 'F456' }, status: 200 });

      const toolsWithContext = createTools(mockClient, 'crewly-orc', '/test/project', undefined, undefined, { channelId: 'C-FROM-CONTEXT', threadTs: '999.888' });

      const result = await (toolsWithContext.reply_slack as any).execute({
        text: 'Image from context',
        imagePath: '/tmp/ctx.png',
      });

      expect(result.success).toBe(true);
      expect(result.uploaded).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith('/slack/upload-image', {
        channelId: 'C-FROM-CONTEXT',
        filePath: '/tmp/ctx.png',
        initialComment: '[Orc] Image from context',
        threadTs: '999.888',
      });
    });

    it('should return error when no channelId for image upload', async () => {
      const toolsNoContext = createTools(mockClient, 'crewly-orc', '/test/project');

      const result = await (toolsNoContext.reply_slack as any).execute({
        text: 'Image without channel',
        imagePath: '/tmp/no-channel.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No channelId');
    });

    it('should skip dedup and throttle for image uploads', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      // Send a text message first to populate dedup and throttle state
      await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: 'Duplicate text',
      });

      // Image upload with same text should NOT be deduped or throttled
      const result = await (tools.reply_slack as any).execute({
        channelId: 'C123',
        text: 'Duplicate text',
        imagePath: '/tmp/image.png',
      });

      expect(result.success).toBe(true);
      expect(result.uploaded).toBe(true);
      // Should have called upload-image, not been throttled/deduped
      expect(mockClient.post).toHaveBeenCalledWith('/slack/upload-image', expect.objectContaining({
        filePath: '/tmp/image.png',
      }));
    });
  });

  describe('stripNotifyMarkers', () => {
    it('should extract body after --- separator', () => {
      const input = '[NOTIFY]\nconversationId: conv-123\ntype: task_completed\n---\n## Done\nTask finished.\n[/NOTIFY]';
      expect(stripNotifyMarkers(input)).toBe('## Done\nTask finished.');
    });

    it('should return inner content when no --- separator', () => {
      const input = '[NOTIFY]\nHello world\n[/NOTIFY]';
      expect(stripNotifyMarkers(input)).toBe('Hello world');
    });

    it('should handle text mixed with NOTIFY blocks', () => {
      const input = 'Before [NOTIFY]\n---\nExtracted\n[/NOTIFY] After';
      expect(stripNotifyMarkers(input)).toBe('Before Extracted After');
    });

    it('should handle multiple NOTIFY blocks', () => {
      const input = '[NOTIFY]\n---\nFirst\n[/NOTIFY] and [NOTIFY]\n---\nSecond\n[/NOTIFY]';
      expect(stripNotifyMarkers(input)).toBe('First and Second');
    });

    it('should return text unchanged when no markers present', () => {
      expect(stripNotifyMarkers('No markers here')).toBe('No markers here');
    });

    it('should be case-insensitive', () => {
      const input = '[notify]\n---\nContent\n[/notify]';
      expect(stripNotifyMarkers(input)).toBe('Content');
    });
  });

  describe('#181: convertMarkdownToSlackMrkdwn', () => {
    it('should convert **bold** to *bold*', () => {
      expect(convertMarkdownToSlackMrkdwn('This is **bold** text')).toBe('This is *bold* text');
    });

    it('should convert multiple **bold** segments', () => {
      expect(convertMarkdownToSlackMrkdwn('**one** and **two**')).toBe('*one* and *two*');
    });

    it('should convert [text](url) to <url|text>', () => {
      expect(convertMarkdownToSlackMrkdwn('Visit [Google](https://google.com) now'))
        .toBe('Visit <https://google.com|Google> now');
    });

    it('should escape & < > to HTML entities', () => {
      expect(convertMarkdownToSlackMrkdwn('A & B < C > D'))
        .toBe('A &amp; B &lt; C &gt; D');
    });

    it('should strip language hints from fenced code blocks', () => {
      const input = '```typescript\nconst x = 1;\n```';
      const expected = '```\nconst x = 1;\n```';
      expect(convertMarkdownToSlackMrkdwn(input)).toBe(expected);
    });

    it('should preserve plain code blocks without language hint', () => {
      const input = '```\ncode here\n```';
      expect(convertMarkdownToSlackMrkdwn(input)).toBe('```\ncode here\n```');
    });

    it('should handle combined formatting', () => {
      const input = '**Important**: See [docs](https://docs.io) for A & B';
      const result = convertMarkdownToSlackMrkdwn(input);
      expect(result).toContain('*Important*');
      expect(result).toContain('<https://docs.io|docs>');
      expect(result).toContain('A &amp; B');
    });

    it('should not touch single asterisks (italic)', () => {
      expect(convertMarkdownToSlackMrkdwn('This is *italic* text')).toBe('This is *italic* text');
    });

    it('should return empty string unchanged', () => {
      expect(convertMarkdownToSlackMrkdwn('')).toBe('');
    });

    it('should handle text with no markdown', () => {
      expect(convertMarkdownToSlackMrkdwn('Plain text')).toBe('Plain text');
    });
  });

  describe('schedule_check', () => {
    it('should schedule a one-time check', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { checkId: 'sched-1' }, status: 201 });

      const result = await (tools.schedule_check as any).execute({
        minutes: 10,
        message: 'Check progress',
        recurring: false,
      });

      expect(result.checkId).toBe('sched-1');
      expect(mockClient.post).toHaveBeenCalledWith('/schedule', expect.objectContaining({
        targetSession: 'crewly-orc',
        minutes: 10,
        message: 'Check progress',
      }));
    });

    it('should schedule a recurring check', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { checkId: 'sched-2' }, status: 201 });

      await (tools.schedule_check as any).execute({
        minutes: 5,
        message: 'Recurring check',
        recurring: true,
        maxOccurrences: 3,
      });

      expect(mockClient.post).toHaveBeenCalledWith('/schedule', expect.objectContaining({
        isRecurring: true,
        intervalMinutes: 5,
        maxOccurrences: 3,
      }));
    });
  });

  describe('heartbeat', () => {
    it('should fetch teams, projects, and queue in parallel', async () => {
      mockClient.get
        .mockResolvedValueOnce({ success: true, data: [{ name: 'Team A' }], status: 200 })
        .mockResolvedValueOnce({ success: true, data: [{ name: 'Project 1' }], status: 200 })
        .mockResolvedValueOnce({ success: true, data: { pending: 0 }, status: 200 });

      const result = await (tools.heartbeat as any).execute({});

      expect(result.status).toBe('ok');
      expect(result.teams).toEqual([{ name: 'Team A' }]);
      expect(result.projects).toEqual([{ name: 'Project 1' }]);
      expect(result.queue).toEqual({ pending: 0 });
    });

    it('should handle partial failures gracefully', async () => {
      mockClient.get
        .mockResolvedValueOnce({ success: true, data: [], status: 200 })
        .mockResolvedValueOnce({ success: false, error: 'unavailable', status: 500 })
        .mockResolvedValueOnce({ success: true, data: {}, status: 200 });

      const result = await (tools.heartbeat as any).execute({});

      expect(result.status).toBe('ok');
      expect(result.projects).toBe('unavailable');
    });
  });

  describe('start_agent', () => {
    it('should start agent via API when not already active', async () => {
      // Pre-check returns team with inactive member
      mockClient.get.mockResolvedValueOnce({
        success: true,
        data: { members: [{ id: 'member-1', agentStatus: 'inactive', sessionName: '' }] },
        status: 200,
      });
      mockClient.post.mockResolvedValue({ success: true, data: { started: true }, status: 200 });

      const result = await (tools.start_agent as any).execute({
        teamId: 'team-1',
        memberId: 'member-1',
      });

      expect(result.started).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith('/teams/team-1/members/member-1/start', {});
    });

    it('should return already_active without calling start if agent is active', async () => {
      mockClient.get.mockResolvedValueOnce({
        success: true,
        data: { members: [{ id: 'member-1', agentStatus: 'active', sessionName: 'session-1', name: 'Sam' }] },
        status: 200,
      });

      const result = await (tools.start_agent as any).execute({
        teamId: 'team-1',
        memberId: 'member-1',
      });

      expect(result.status).toBe('already_active');
      expect(result.sessionName).toBe('session-1');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('should proceed with start if pre-check fails', async () => {
      mockClient.get.mockResolvedValueOnce({ success: false, error: 'not found', status: 404 });
      mockClient.post.mockResolvedValue({ success: true, data: { started: true }, status: 200 });

      const result = await (tools.start_agent as any).execute({
        teamId: 'team-1',
        memberId: 'member-1',
      });

      expect(result.started).toBe(true);
    });
  });

  describe('stop_agent', () => {
    it('should stop agent via API', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { stopped: true }, status: 200 });

      const result = await (tools.stop_agent as any).execute({
        teamId: 'team-1',
        memberId: 'member-1',
      });

      expect(result.stopped).toBe(true);
    });
  });

  describe('handle_agent_failure', () => {
    it('should restart agent by stopping then starting', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      const result = await (tools.handle_agent_failure as any).execute({
        teamId: 'team-1',
        memberId: 'member-1',
        sessionName: 'agent-sam',
        action: 'restart',
      });

      expect(result.action).toBe('restarted');
      expect(result.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledTimes(2); // stop + start
    });

    it('should handle escalation', async () => {
      const result = await (tools.handle_agent_failure as any).execute({
        teamId: 'team-1',
        memberId: 'member-1',
        sessionName: 'agent-sam',
        action: 'escalate',
        reason: 'Agent stuck',
      });

      expect(result.action).toBe('escalated');
      expect(result.reason).toBe('Agent stuck');
    });
  });

  describe('recall_memory', () => {
    it('should call memory recall API with auto-injected projectPath', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { memories: [] }, status: 200 });

      const result = await (tools.recall_memory as any).execute({
        context: 'deployment process',
        scope: 'project',
      });

      expect(result.memories).toEqual([]);
      expect(mockClient.post).toHaveBeenCalledWith('/memory/recall', {
        agentId: 'crewly-orc',
        context: 'deployment process',
        scope: 'project',
        projectPath: '/test/project',
      });
    });

    it('should auto-inject projectPath for scope=both', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { memories: [] }, status: 200 });

      await (tools.recall_memory as any).execute({
        context: 'OKR goals',
        scope: 'both',
      });

      expect(mockClient.post).toHaveBeenCalledWith('/memory/recall', expect.objectContaining({
        projectPath: '/test/project',
        scope: 'both',
      }));
    });

    it('should not inject projectPath for scope=agent', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { memories: [] }, status: 200 });

      await (tools.recall_memory as any).execute({
        context: 'my preferences',
        scope: 'agent',
      });

      expect(mockClient.post).toHaveBeenCalledWith('/memory/recall', {
        agentId: 'crewly-orc',
        context: 'my preferences',
        scope: 'agent',
      });
    });

    it('should prefer explicit projectPath over auto-injected', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      await (tools.recall_memory as any).execute({
        context: 'test',
        scope: 'project',
        projectPath: '/explicit/path',
      });

      expect(mockClient.post).toHaveBeenCalledWith('/memory/recall', expect.objectContaining({
        projectPath: '/explicit/path',
      }));
    });
  });

  describe('remember', () => {
    it('should store knowledge via API with auto-injected projectPath', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { id: 'mem-1' }, status: 201 });

      const result = await (tools.remember as any).execute({
        content: 'Always use async/await',
        category: 'pattern',
        scope: 'project',
      });

      expect(result.id).toBe('mem-1');
      expect(mockClient.post).toHaveBeenCalledWith('/memory/remember', expect.objectContaining({
        projectPath: '/test/project',
      }));
    });
  });

  describe('get_tasks', () => {
    it('should fetch tasks with project path', async () => {
      mockClient.get.mockResolvedValue({ success: true, data: [], status: 200 });

      await (tools.get_tasks as any).execute({
        projectPath: '/path/to/project',
        status: 'in_progress',
      });

      expect(mockClient.get).toHaveBeenCalledWith(
        '/task-management/tasks?projectPath=%2Fpath%2Fto%2Fproject&status=in_progress',
      );
    });
  });

  describe('broadcast', () => {
    it('should send message to all sessions except self', async () => {
      mockClient.get.mockResolvedValue({
        success: true,
        data: [{ name: 'agent-sam' }, { name: 'agent-leo' }, { name: 'crewly-orc' }],
        status: 200,
      });
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });

      const result = await (tools.broadcast as any).execute({ message: 'Hello all' });

      expect(result.sent).toBe(2); // sam + leo, skip crewly-orc (self)
      expect(result.failed).toBe(0);
    });
  });

  describe('edit_file', () => {
    let mockReadFile: jest.SpiedFunction<typeof import('fs').promises.readFile>;
    let mockWriteFile: jest.SpiedFunction<typeof import('fs').promises.writeFile>;

    beforeEach(async () => {
      const fs = await import('fs');
      mockReadFile = jest.spyOn(fs.promises, 'readFile') as any;
      mockWriteFile = jest.spyOn(fs.promises, 'writeFile') as any;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should replace unique string in file', async () => {
      mockReadFile.mockResolvedValue('Hello World\nGoodbye World' as any);
      mockWriteFile.mockResolvedValue(undefined as any);

      const result = await (tools.edit_file as any).execute({
        file_path: '/test/file.ts',
        old_string: 'Hello World',
        new_string: 'Hi World',
        replace_all: false,
      });

      expect(result.success).toBe(true);
      expect(result.replacements).toBe(1);
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/test/file.ts',
        'Hi World\nGoodbye World',
        'utf8',
      );
    });

    it('should fail when old_string not found', async () => {
      mockReadFile.mockResolvedValue('Hello World' as any);

      const result = await (tools.edit_file as any).execute({
        file_path: '/test/file.ts',
        old_string: 'Not Found',
        new_string: 'Replacement',
        replace_all: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when old_string has multiple matches and replace_all is false', async () => {
      mockReadFile.mockResolvedValue('foo bar foo baz foo' as any);

      const result = await (tools.edit_file as any).execute({
        file_path: '/test/file.ts',
        old_string: 'foo',
        new_string: 'qux',
        replace_all: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('3 times');
      expect(result.occurrences).toBe(3);
    });

    it('should replace all occurrences when replace_all is true', async () => {
      mockReadFile.mockResolvedValue('foo bar foo baz foo' as any);
      mockWriteFile.mockResolvedValue(undefined as any);

      const result = await (tools.edit_file as any).execute({
        file_path: '/test/file.ts',
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true,
      });

      expect(result.success).toBe(true);
      expect(result.replacements).toBe(3);
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/test/file.ts',
        'qux bar qux baz qux',
        'utf8',
      );
    });

    it('should handle single occurrence with replace_all true', async () => {
      mockReadFile.mockResolvedValue('Hello World\nGoodbye World' as any);
      mockWriteFile.mockResolvedValue(undefined as any);

      const result = await (tools.edit_file as any).execute({
        file_path: '/test/file.ts',
        old_string: 'Hello World',
        new_string: 'Hi World',
        replace_all: true,
      });

      expect(result.success).toBe(true);
      expect(result.replacements).toBe(1);
    });

    it('should handle file not found error', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await (tools.edit_file as any).execute({
        file_path: '/nonexistent/file.ts',
        old_string: 'foo',
        new_string: 'bar',
        replace_all: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('read_file', () => {
    let mockReadFile: jest.SpiedFunction<typeof import('fs').promises.readFile>;

    beforeEach(async () => {
      const fs = await import('fs');
      mockReadFile = jest.spyOn(fs.promises, 'readFile') as any;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should read entire file with line numbers', async () => {
      mockReadFile.mockResolvedValue('line 1\nline 2\nline 3' as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/file.ts',
      });

      expect(result.success).toBe(true);
      expect(result.totalLines).toBe(3);
      expect(result.content).toContain('1\tline 1');
      expect(result.content).toContain('3\tline 3');
    });

    it('should support offset and limit', async () => {
      mockReadFile.mockResolvedValue('a\nb\nc\nd\ne' as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/file.ts',
        offset: 2,
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('2\tb');
      expect(result.content).toContain('3\tc');
      expect(result.content).not.toContain('4\td');
    });

    it('should handle file not found', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await (tools.read_file as any).execute({
        file_path: '/nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return base64 image data for PNG files', async () => {
      const fakeImageBuffer = Buffer.from('fake-png-data');
      mockReadFile.mockResolvedValue(fakeImageBuffer as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/screenshot.png',
      });

      expect(result.success).toBe(true);
      expect(result.type).toBe('image');
      expect(result.mimeType).toBe('image/png');
      expect(result.data).toBe(fakeImageBuffer.toString('base64'));
      expect(result.sizeBytes).toBe(fakeImageBuffer.length);
      expect(result.file).toBe('/test/screenshot.png');
    });

    it('should return base64 image data for JPEG files', async () => {
      const fakeImageBuffer = Buffer.from('fake-jpg-data');
      mockReadFile.mockResolvedValue(fakeImageBuffer as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/photo.jpg',
      });

      expect(result.success).toBe(true);
      expect(result.type).toBe('image');
      expect(result.mimeType).toBe('image/jpeg');
    });

    it('should return base64 image data for WebP files', async () => {
      const fakeImageBuffer = Buffer.from('fake-webp-data');
      mockReadFile.mockResolvedValue(fakeImageBuffer as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/image.webp',
      });

      expect(result.success).toBe(true);
      expect(result.type).toBe('image');
      expect(result.mimeType).toBe('image/webp');
    });

    it('should return base64 image data for SVG files', async () => {
      const fakeSvgBuffer = Buffer.from('<svg></svg>');
      mockReadFile.mockResolvedValue(fakeSvgBuffer as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/icon.svg',
      });

      expect(result.success).toBe(true);
      expect(result.type).toBe('image');
      expect(result.mimeType).toBe('image/svg+xml');
    });

    it('should read text files normally even with image-like names', async () => {
      mockReadFile.mockResolvedValue('text content' as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/data.json',
      });

      expect(result.success).toBe(true);
      expect(result.type).toBeUndefined();
      expect(result.content).toContain('text content');
    });

    it('should handle image file not found', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await (tools.read_file as any).execute({
        file_path: '/nonexistent/image.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should truncate files exceeding 2000 lines when no limit specified', async () => {
      // Generate a file with 3000 lines
      const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1} content here`);
      const largeContent = lines.join('\n');
      mockReadFile.mockResolvedValue(largeContent as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/large-file.ts',
      });

      expect(result.success).toBe(true);
      expect(result.totalLines).toBe(3000);
      expect(result.truncated).toBe(true);
      expect(result.shownLines).toBe(2000);
      // Should only contain first 2000 lines
      const outputLines = result.content.split('\n');
      expect(outputLines.length).toBeLessThanOrEqual(2001); // 2000 lines + possible truncation msg
    });

    it('should not truncate small files', async () => {
      const smallContent = 'line1\nline2\nline3';
      mockReadFile.mockResolvedValue(smallContent as any);

      const result = await (tools.read_file as any).execute({
        file_path: '/test/small-file.ts',
      });

      expect(result.success).toBe(true);
      expect(result.totalLines).toBe(3);
      expect(result.truncated).toBeUndefined();
    });
  });

  describe('write_file', () => {
    let mockWriteFile: jest.SpiedFunction<typeof import('fs').promises.writeFile>;
    let mockMkdir: jest.SpiedFunction<typeof import('fs').promises.mkdir>;

    beforeEach(async () => {
      const fs = await import('fs');
      mockWriteFile = jest.spyOn(fs.promises, 'writeFile') as any;
      mockMkdir = jest.spyOn(fs.promises, 'mkdir') as any;
      mockWriteFile.mockResolvedValue(undefined as any);
      mockMkdir.mockResolvedValue(undefined as any);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should write file and return byte count', async () => {
      const result = await (tools.write_file as any).execute({
        file_path: '/test/new-file.ts',
        content: 'export const x = 1;\n',
      });

      expect(result.success).toBe(true);
      expect(result.file).toBe('/test/new-file.ts');
      expect(result.bytes).toBeGreaterThan(0);
      expect(mockMkdir).toHaveBeenCalledWith('/test', { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith('/test/new-file.ts', 'export const x = 1;\n', 'utf8');
    });

    it('should handle write errors', async () => {
      mockWriteFile.mockRejectedValue(new Error('EACCES'));

      const result = await (tools.write_file as any).execute({
        file_path: '/protected/file.ts',
        content: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('EACCES');
    });
  });

  describe('read_file bash fallback', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const tmpDir: string = os.tmpdir();

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should fallback to bash cat when fs.readFile fails with non-ENOENT error', async () => {
      // Create a real temp file so bash cat can read it
      const tmpFile = `${tmpDir}/crewly-test-read-fallback-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, 'line one\nline two\n');

      // Mock fs.promises.readFile to fail with EPERM (not ENOENT)
      const mockReadFile = jest.spyOn(fs.promises, 'readFile') as any;
      mockReadFile.mockRejectedValue(new Error('EPERM: operation not permitted'));

      try {
        const result = await (tools.read_file as any).execute({
          file_path: tmpFile,
        });

        expect(result.success).toBe(true);
        expect(result.fallback).toBe('bash');
        expect(result.content).toContain('line one');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('should not fallback for ENOENT errors', async () => {
      const result = await (tools.read_file as any).execute({
        file_path: '/nonexistent/crewly-test-no-such-file.ts',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.fallback).toBeUndefined();
    });

    it('should return original error when both fs and bash fail', async () => {
      // Mock readFile to fail with EPERM, use a non-existent file so bash cat also fails
      const mockReadFile = jest.spyOn(fs.promises, 'readFile') as any;
      mockReadFile.mockRejectedValue(new Error('EPERM'));

      const result = await (tools.read_file as any).execute({
        file_path: '/nonexistent/crewly-test-both-fail.ts',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('EPERM');
    });
  });

  describe('write_file bash fallback', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const tmpDir: string = os.tmpdir();

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should fallback to bash when fs.writeFile fails', async () => {
      const tmpFile = `${tmpDir}/crewly-test-write-fallback-${Date.now()}.txt`;
      const content = 'export const x = 1;\n';

      // Mock writeFile to fail, but mkdir succeeds and bash cat > works on a real path
      const mockWriteFile = jest.spyOn(fs.promises, 'writeFile') as any;
      mockWriteFile.mockRejectedValue(new Error('EPERM: operation not permitted'));

      try {
        const result = await (tools.write_file as any).execute({
          file_path: tmpFile,
          content,
        });

        expect(result.success).toBe(true);
        expect(result.fallback).toBe('bash');
        expect(result.file).toBe(tmpFile);
        expect(result.bytes).toBeGreaterThan(0);

        // Verify the file was actually written by bash fallback
        const written = fs.readFileSync(tmpFile, 'utf8');
        expect(written).toBe(content);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it('should return original error when both fs and bash fail', async () => {
      // Mock writeFile to fail; use an invalid path so bash cat > also fails
      const mockWriteFile = jest.spyOn(fs.promises, 'writeFile') as any;
      const mockMkdir = jest.spyOn(fs.promises, 'mkdir') as any;
      mockWriteFile.mockRejectedValue(new Error('EACCES'));
      mockMkdir.mockResolvedValue(undefined as any);

      const result = await (tools.write_file as any).execute({
        file_path: '/proc/nonexistent/crewly-test-both-fail.ts',
        content: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('EACCES');
    });
  });

  // ===== Bug 1: Tilde path expansion tests =====

  describe('read_file tilde expansion', () => {
    let mockReadFile: jest.SpiedFunction<typeof import('fs').promises.readFile>;

    beforeEach(async () => {
      const fs = await import('fs');
      mockReadFile = jest.spyOn(fs.promises, 'readFile') as any;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should expand ~ to home directory', async () => {
      mockReadFile.mockResolvedValue('file content' as any);

      await (tools.read_file as any).execute({
        file_path: '~/.crewly/skills/SKILLS_CATALOG.md',
      });

      const calledPath = mockReadFile.mock.calls[0][0] as string;
      expect(calledPath).not.toContain('~');
      expect(calledPath).toMatch(/^\//); // absolute path
      expect(calledPath).toContain('.crewly/skills/SKILLS_CATALOG.md');
    });

    it('should expand $HOME to home directory', async () => {
      mockReadFile.mockResolvedValue('file content' as any);

      await (tools.read_file as any).execute({
        file_path: '$HOME/.config/test.json',
      });

      const calledPath = mockReadFile.mock.calls[0][0] as string;
      expect(calledPath).not.toContain('$HOME');
      expect(calledPath).toMatch(/^\//);
      expect(calledPath).toContain('.config/test.json');
    });

    it('should not modify absolute paths', async () => {
      mockReadFile.mockResolvedValue('file content' as any);

      await (tools.read_file as any).execute({
        file_path: '/usr/local/test.txt',
      });

      expect(mockReadFile).toHaveBeenCalledWith('/usr/local/test.txt', 'utf8');
    });
  });

  describe('edit_file tilde expansion', () => {
    let mockReadFile: jest.SpiedFunction<typeof import('fs').promises.readFile>;
    let mockWriteFile: jest.SpiedFunction<typeof import('fs').promises.writeFile>;

    beforeEach(async () => {
      const fs = await import('fs');
      mockReadFile = jest.spyOn(fs.promises, 'readFile') as any;
      mockWriteFile = jest.spyOn(fs.promises, 'writeFile') as any;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should expand ~ in edit_file path', async () => {
      mockReadFile.mockResolvedValue('old content' as any);
      mockWriteFile.mockResolvedValue(undefined as any);

      await (tools.edit_file as any).execute({
        file_path: '~/test.ts',
        old_string: 'old content',
        new_string: 'new content',
        replace_all: false,
      });

      const readPath = mockReadFile.mock.calls[0][0] as string;
      expect(readPath).not.toContain('~');
      expect(readPath).toMatch(/^\//);
    });
  });

  // ===== Bug 3: New tool tests =====

  describe('register_self', () => {
    it('should register agent with the backend', async () => {
      mockClient.post.mockResolvedValue({
        success: true,
        data: { sessionName: 'crewly-orc', status: 'active' },
        status: 200,
      });

      const result = await (tools.register_self as any).execute({
        role: 'developer',
      });

      expect(result.sessionName).toBe('crewly-orc');
      expect(result.status).toBe('active');
      expect(mockClient.post).toHaveBeenCalledWith('/teams/members/register', {
        role: 'developer',
        sessionName: 'crewly-orc',
      });
    });

    it('should return error on failure', async () => {
      mockClient.post.mockResolvedValue({
        success: false,
        error: 'Agent not found',
        status: 404,
      });

      const result = await (tools.register_self as any).execute({
        role: 'developer',
      });

      expect(result.error).toBe('Agent not found');
    });
  });

  describe('get_project_overview', () => {
    it('should return all projects', async () => {
      const projects = [{ name: 'crewly', path: '/path' }];
      mockClient.get.mockResolvedValue({ success: true, data: projects, status: 200 });

      const result = await (tools.get_project_overview as any).execute({});

      expect(result).toEqual(projects);
      expect(mockClient.get).toHaveBeenCalledWith('/projects');
    });

    it('should return error on failure', async () => {
      mockClient.get.mockResolvedValue({ success: false, error: 'Server error', status: 500 });

      const result = await (tools.get_project_overview as any).execute({});

      expect(result.error).toBe('Server error');
    });
  });

  describe('report_status', () => {
    it('should send status via chat API with formatted message', async () => {
      mockClient.post.mockResolvedValue({
        success: true,
        data: { acknowledged: true },
        status: 200,
      });

      const result = await (tools.report_status as any).execute({
        status: 'done',
        summary: 'Task completed',
      });

      expect(result.acknowledged).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith('/chat/agent-response', {
        content: '[DONE] Agent crewly-orc: Task completed',
        senderName: 'crewly-orc',
        senderType: 'agent',
      });
    });

    it('should auto-complete tasks when status is done', async () => {
      mockClient.post.mockResolvedValue({
        success: true,
        data: { acknowledged: true },
        status: 200,
      });

      await (tools.report_status as any).execute({
        status: 'done',
        summary: 'Feature implemented',
      });

      expect(mockClient.post).toHaveBeenCalledWith(
        '/task-management/complete-by-session',
        { sessionName: 'crewly-orc' },
      );
    });

    it('should not auto-complete tasks when status is in_progress', async () => {
      mockClient.post.mockResolvedValue({
        success: true,
        data: { acknowledged: true },
        status: 200,
      });

      await (tools.report_status as any).execute({
        status: 'in_progress',
        summary: 'Working on it',
      });

      expect(mockClient.post).not.toHaveBeenCalledWith(
        '/task-management/complete-by-session',
        expect.anything(),
      );
    });
  });

  // ===== F13: Autonomous Context Compaction =====

  describe('compact_memory', () => {
    it('should call onCompactMemory callback when available', async () => {
      const mockCompact = jest.fn<() => Promise<CompactionResult>>().mockResolvedValue({
        compacted: true,
        messagesBefore: 50,
        messagesAfter: 11,
      });
      const callbacks: ToolCallbacks = { onCompactMemory: mockCompact };
      const toolsWithCallbacks = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsWithCallbacks.compact_memory as any).execute({});

      expect(result.success).toBe(true);
      expect(result.compacted).toBe(true);
      expect(result.messagesBefore).toBe(50);
      expect(result.messagesAfter).toBe(11);
      expect(mockCompact).toHaveBeenCalledTimes(1);
    });

    it('should return error when no callback configured', async () => {
      const result = await (tools.compact_memory as any).execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('should pass through skipped compaction result', async () => {
      const mockCompact = jest.fn<() => Promise<CompactionResult>>().mockResolvedValue({
        compacted: false,
        messagesBefore: 5,
        messagesAfter: 5,
        reason: 'Too few messages to compact',
      });
      const callbacks: ToolCallbacks = { onCompactMemory: mockCompact };
      const toolsWithCallbacks = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsWithCallbacks.compact_memory as any).execute({});

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Too few');
    });
  });

  describe('get_context_budget', () => {
    it('should return budget status when callback is configured', async () => {
      const mockBudget = jest.fn<any>().mockReturnValue({
        totalTokensUsed: 50000,
        contextWindowSize: 200000,
        usagePercent: 0.25,
        level: 'normal',
        messageCount: 20,
        compactionPending: false,
        summary: '25.0% of context budget used (50,000/200,000 tokens, 20 messages)',
      });
      const callbacks: ToolCallbacks = { onGetContextBudget: mockBudget };
      const toolsWithCallbacks = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsWithCallbacks.get_context_budget as any).execute({});

      expect(result.success).toBe(true);
      expect(result.totalTokensUsed).toBe(50000);
      expect(result.contextWindowSize).toBe(200000);
      expect(result.usagePercent).toBe(0.25);
      expect(result.level).toBe('normal');
      expect(mockBudget).toHaveBeenCalledTimes(1);
    });

    it('should return error when no callback configured', async () => {
      const result = await (tools.get_context_budget as any).execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('should return warning level when approaching threshold', async () => {
      const mockBudget = jest.fn<any>().mockReturnValue({
        totalTokensUsed: 140000,
        contextWindowSize: 200000,
        usagePercent: 0.7,
        level: 'warning',
        messageCount: 80,
        compactionPending: false,
        summary: '70.0% of context budget used — WARNING: approaching compaction threshold',
      });
      const callbacks: ToolCallbacks = { onGetContextBudget: mockBudget };
      const toolsWithCallbacks = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsWithCallbacks.get_context_budget as any).execute({});

      expect(result.success).toBe(true);
      expect(result.level).toBe('warning');
      expect(result.summary).toContain('WARNING');
    });

    it('should be classified as safe', () => {
      expect(TOOL_SENSITIVITY.get_context_budget).toBe('safe');
    });
  });

  // ===== F27: Security Audit Trail & Hardening =====

  describe('get_audit_log', () => {
    it('should return error when no callback configured', async () => {
      const result = await (tools.get_audit_log as any).execute({
        limit: 20,
        sensitivity: 'destructive',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('should return actual audit entries via onGetAuditLog callback', async () => {
      const mockEntries: AuditEntry[] = [
        { timestamp: '2026-01-01T00:00:00Z', toolName: 'edit_file', sensitivity: 'destructive', args: {}, success: true, durationMs: 10 },
        { timestamp: '2026-01-01T00:01:00Z', toolName: 'get_team_status', sensitivity: 'safe', args: {}, success: true, durationMs: 5 },
      ];
      const callbacks: ToolCallbacks = {
        onGetAuditLog: (filters: AuditLogFilters) => {
          let entries = [...mockEntries];
          if (filters.sensitivity) entries = entries.filter(e => e.sensitivity === filters.sensitivity);
          if (filters.toolName) entries = entries.filter(e => e.toolName === filters.toolName);
          return entries.slice(0, filters.limit);
        },
      };
      const toolsWithAudit = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsWithAudit.get_audit_log as any).execute({
        limit: 20,
        sensitivity: 'destructive',
      });

      expect(result.success).toBe(true);
      expect(result.totalEntries).toBe(1);
      expect(result.entries[0].toolName).toBe('edit_file');
      expect(result.filters.limit).toBe(20);
      expect(result.filters.sensitivity).toBe('destructive');
    });

    it('should use defaults when no filters provided', async () => {
      const callbacks: ToolCallbacks = {
        onGetAuditLog: () => [],
      };
      const toolsWithAudit = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsWithAudit.get_audit_log as any).execute({});

      expect(result.success).toBe(true);
      expect(result.filters.limit).toBe(50);
      expect(result.filters.sensitivity).toBe('all');
      expect(result.filters.toolName).toBe('all');
    });
  });

  describe('TOOL_SENSITIVITY', () => {
    it('should classify read-only tools as safe', () => {
      expect(TOOL_SENSITIVITY.get_agent_status).toBe('safe');
      expect(TOOL_SENSITIVITY.get_team_status).toBe('safe');
      expect(TOOL_SENSITIVITY.get_agent_logs).toBe('safe');
      expect(TOOL_SENSITIVITY.heartbeat).toBe('safe');
      expect(TOOL_SENSITIVITY.get_tasks).toBe('safe');
      expect(TOOL_SENSITIVITY.read_file).toBe('safe');
      expect(TOOL_SENSITIVITY.recall_memory).toBe('safe');
      expect(TOOL_SENSITIVITY.get_project_overview).toBe('safe');
      expect(TOOL_SENSITIVITY.get_scheduled_checks).toBe('safe');
    });

    it('should classify communication tools as sensitive', () => {
      expect(TOOL_SENSITIVITY.delegate_task).toBe('sensitive');
      expect(TOOL_SENSITIVITY.send_message).toBe('sensitive');
      expect(TOOL_SENSITIVITY.reply_slack).toBe('sensitive');
      expect(TOOL_SENSITIVITY.broadcast).toBe('sensitive');
      expect(TOOL_SENSITIVITY.report_status).toBe('sensitive');
      expect(TOOL_SENSITIVITY.remember).toBe('sensitive');
    });

    it('should classify high-impact tools as destructive', () => {
      expect(TOOL_SENSITIVITY.start_agent).toBe('destructive');
      expect(TOOL_SENSITIVITY.stop_agent).toBe('destructive');
      expect(TOOL_SENSITIVITY.handle_agent_failure).toBe('destructive');
      expect(TOOL_SENSITIVITY.edit_file).toBe('destructive');
      expect(TOOL_SENSITIVITY.write_file).toBe('destructive');
    });

    it('should have classifications for all tool names', () => {
      const allToolNames = getToolNames();
      for (const name of allToolNames) {
        expect(TOOL_SENSITIVITY[name]).toBeDefined();
      }
    });
  });

  describe('audit wrapping', () => {
    it('should call onAuditLog for each tool invocation', async () => {
      const auditEntries: AuditEntry[] = [];
      const callbacks: ToolCallbacks = {
        onAuditLog: (entry) => auditEntries.push(entry),
      };
      const toolsWithAudit = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      mockClient.get.mockResolvedValue({ success: true, data: [], status: 200 });
      await (toolsWithAudit.get_team_status as any).execute({});

      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].toolName).toBe('get_team_status');
      expect(auditEntries[0].sensitivity).toBe('safe');
      expect(auditEntries[0].success).toBe(true);
      expect(auditEntries[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should record failure in audit log', async () => {
      const auditEntries: AuditEntry[] = [];
      const callbacks: ToolCallbacks = {
        onAuditLog: (entry) => auditEntries.push(entry),
      };
      const toolsWithAudit = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      mockClient.post.mockResolvedValue({ success: false, error: 'Not found', status: 404 });
      await (toolsWithAudit.send_message as any).execute({
        sessionName: 'agent-sam',
        message: 'Hello',
        force: false,
      });

      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].toolName).toBe('send_message');
      expect(auditEntries[0].success).toBe(false);
      expect(auditEntries[0].error).toContain('Not found');
    });

    it('should record audit on tool exception', async () => {
      const auditEntries: AuditEntry[] = [];
      const callbacks: ToolCallbacks = {
        onAuditLog: (entry) => auditEntries.push(entry),
      };
      const toolsWithAudit = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      mockClient.get.mockRejectedValue(new Error('Network failure'));

      await expect(
        (toolsWithAudit.get_team_status as any).execute({}),
      ).rejects.toThrow('Network failure');

      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].success).toBe(false);
      expect(auditEntries[0].error).toBe('Network failure');
    });

    it('should redact sensitive fields in audit args', async () => {
      const auditEntries: AuditEntry[] = [];
      const callbacks: ToolCallbacks = {
        onAuditLog: (entry) => auditEntries.push(entry),
      };
      const toolsWithAudit = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      // Use send_message which has simple fields; inject args that include a sensitive-named key
      // The audit wrapper sanitizes the raw args object before logging
      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });
      await (toolsWithAudit.send_message as any).execute({
        sessionName: 'agent-sam',
        message: 'Hello',
        force: false,
        authorization_token: 'bearer-secret-123',
      });

      expect(auditEntries).toHaveLength(1);
      // authorization_token contains 'token' which is a sensitive key
      expect(auditEntries[0].args.authorization_token).toBe('[REDACTED]');
      expect(auditEntries[0].args.message).toBe('Hello');
    });

    it('should truncate long argument values', async () => {
      const auditEntries: AuditEntry[] = [];
      const callbacks: ToolCallbacks = {
        onAuditLog: (entry) => auditEntries.push(entry),
      };
      const toolsWithAudit = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });
      await (toolsWithAudit.remember as any).execute({
        content: 'x'.repeat(1000),
        category: 'pattern',
        scope: 'project',
      });

      expect(auditEntries).toHaveLength(1);
      const contentArg = auditEntries[0].args.content as string;
      // sanitizeArgs truncates at 2000 chars, so 1000-char input should NOT be truncated
      expect(contentArg).toBe('x'.repeat(1000));
    });

    it('should truncate argument values exceeding 2000 chars', async () => {
      const auditEntries: AuditEntry[] = [];
      const callbacks: ToolCallbacks = {
        onAuditLog: (entry) => auditEntries.push(entry),
      };
      const toolsWithAudit = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      mockClient.post.mockResolvedValue({ success: true, data: {}, status: 200 });
      await (toolsWithAudit.remember as any).execute({
        content: 'x'.repeat(3000),
        category: 'pattern',
        scope: 'project',
      });

      expect(auditEntries).toHaveLength(1);
      const contentArg = auditEntries[0].args.content as string;
      expect(contentArg.length).toBeLessThan(2100);
      expect(contentArg).toContain('[truncated]');
    });

    it('should assign sensitivity to all created tools', () => {
      for (const [name, tool] of Object.entries(tools)) {
        expect((tool as any).sensitivity).toBeDefined();
        expect(['safe', 'sensitive', 'destructive']).toContain((tool as any).sensitivity);
      }
    });
  });

  // ===== F27: Approval Mode & Blocked Tools Enforcement =====

  describe('approval mode enforcement', () => {
    it('should block tool when onCheckApproval returns not allowed (blocked)', async () => {
      const auditEntries: AuditEntry[] = [];
      const callbacks: ToolCallbacks = {
        onAuditLog: (entry) => auditEntries.push(entry),
        onCheckApproval: (toolName) => {
          if (toolName === 'stop_agent') {
            return { allowed: false, blocked: true, reason: "Tool 'stop_agent' is blocked by security policy" };
          }
          return { allowed: true };
        },
      };
      const toolsWithApproval = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsWithApproval.stop_agent as any).execute({
        teamId: 'team-1',
        memberId: 'member-1',
      });

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.error).toContain('blocked');
      // Should NOT have called the API
      expect(mockClient.post).not.toHaveBeenCalled();
      // Should still log the blocked attempt
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].success).toBe(false);
      expect(auditEntries[0].error).toContain('blocked');
    });

    it('should block tool when sensitivity requires approval', async () => {
      const auditEntries: AuditEntry[] = [];
      const callbacks: ToolCallbacks = {
        onAuditLog: (entry) => auditEntries.push(entry),
        onCheckApproval: (_toolName, sensitivity) => {
          if (sensitivity === 'destructive') {
            return { allowed: false, blocked: false, reason: 'Destructive tools require approval' };
          }
          return { allowed: true };
        },
      };
      const toolsWithApproval = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsWithApproval.edit_file as any).execute({
        file_path: '/test/file.ts',
        old_string: 'foo',
        new_string: 'bar',
        replace_all: false,
      });

      expect(result.success).toBe(false);
      expect(result.requiresApproval).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.error).toContain('approval');
    });

    it('should allow safe tools when only destructive requires approval', async () => {
      const callbacks: ToolCallbacks = {
        onCheckApproval: (_toolName, sensitivity) => {
          if (sensitivity === 'destructive') {
            return { allowed: false, blocked: false, reason: 'Requires approval' };
          }
          return { allowed: true };
        },
      };
      const toolsWithApproval = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      mockClient.get.mockResolvedValue({ success: true, data: [], status: 200 });
      const result = await (toolsWithApproval.get_team_status as any).execute({});

      expect(result).toEqual([]);
      expect(mockClient.get).toHaveBeenCalled();
    });

    it('should work without onCheckApproval callback (no enforcement)', async () => {
      const callbacks: ToolCallbacks = {
        onAuditLog: () => {},
      };
      const toolsNoApproval = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      mockClient.post.mockResolvedValue({ success: true, data: { stopped: true }, status: 200 });
      const result = await (toolsNoApproval.stop_agent as any).execute({
        teamId: 'team-1',
        memberId: 'member-1',
      });

      expect(result.stopped).toBe(true);
    });

    it('should enforce approval without audit logger', async () => {
      const callbacks: ToolCallbacks = {
        onCheckApproval: (toolName) => {
          if (toolName === 'write_file') {
            return { allowed: false, blocked: true, reason: 'Blocked' };
          }
          return { allowed: true };
        },
      };
      const toolsApprovalOnly = createTools(mockClient, 'crewly-orc', '/test/project', callbacks);

      const result = await (toolsApprovalOnly.write_file as any).execute({
        file_path: '/test/file.ts',
        content: 'hello',
      });

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
    });
  });

  describe('get_scheduled_checks', () => {
    it('should fetch all scheduled checks', async () => {
      mockClient.get.mockResolvedValue({ success: true, data: [{ id: 'chk-1', isRecurring: true }], status: 200 });

      const result = await (tools.get_scheduled_checks as any).execute({});

      expect(mockClient.get).toHaveBeenCalledWith('/schedule');
      expect(result).toEqual([{ id: 'chk-1', isRecurring: true }]);
    });

    it('should filter by session when provided', async () => {
      mockClient.get.mockResolvedValue({ success: true, data: [], status: 200 });

      await (tools.get_scheduled_checks as any).execute({ session: 'agent-sam' });

      expect(mockClient.get).toHaveBeenCalledWith('/schedule?session=agent-sam');
    });

    it('should return error on failure', async () => {
      mockClient.get.mockResolvedValue({ success: false, error: 'Server error', status: 500 });

      const result = await (tools.get_scheduled_checks as any).execute({});

      expect(result).toEqual({ error: 'Server error' });
    });
  });

  describe('schedule_check with taskId', () => {
    it('should pass taskId to the schedule API', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { checkId: 'sched-3' }, status: 201 });

      await (tools.schedule_check as any).execute({
        minutes: 5,
        message: 'Check Sam progress',
        recurring: true,
        taskId: 'task-42',
      });

      expect(mockClient.post).toHaveBeenCalledWith('/schedule', expect.objectContaining({
        taskId: 'task-42',
        isRecurring: true,
        intervalMinutes: 5,
      }));
    });

    it('should not include taskId when not provided', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { checkId: 'sched-4' }, status: 201 });

      await (tools.schedule_check as any).execute({
        minutes: 10,
        message: 'Check progress',
        recurring: false,
      });

      const postArgs = mockClient.post.mock.calls[0][1] as Record<string, unknown>;
      expect(postArgs.taskId).toBeUndefined();
    });
  });

  describe('complete_task with check cleanup', () => {
    it('should cancel recurring checks for the completing agent', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { completed: true }, status: 200 });
      mockClient.get.mockResolvedValue({
        success: true,
        data: [
          { id: 'chk-1', isRecurring: true },
          { id: 'chk-2', isRecurring: false },
          { id: 'chk-3', isRecurring: true },
        ],
        status: 200,
      });
      mockClient.delete.mockResolvedValue({ success: true, data: {}, status: 200 });

      const result = await (tools.complete_task as any).execute({
        absoluteTaskPath: '/tasks/task-1.md',
        sessionName: 'agent-sam',
        summary: 'Done',
      });

      expect(result.completed).toBe(true);
      expect(result.cancelledChecks).toBe(2); // Only recurring checks
      expect(mockClient.delete).toHaveBeenCalledWith('/schedule/chk-1');
      expect(mockClient.delete).toHaveBeenCalledWith('/schedule/chk-3');
      expect(mockClient.delete).not.toHaveBeenCalledWith('/schedule/chk-2');
    });

    it('should still complete task even if check cleanup fails', async () => {
      mockClient.post.mockResolvedValue({ success: true, data: { completed: true }, status: 200 });
      mockClient.get.mockRejectedValue(new Error('Network error'));

      const result = await (tools.complete_task as any).execute({
        absoluteTaskPath: '/tasks/task-1.md',
        sessionName: 'agent-sam',
        summary: 'Done',
      });

      expect(result.completed).toBe(true);
      expect(result.cancelledChecks).toBe(0);
    });
  });

  describe('WRITE_TOOLS', () => {
    it('should include all destructive and sensitive tools that modify state', () => {
      expect(WRITE_TOOLS).toContain('edit_file');
      expect(WRITE_TOOLS).toContain('write_file');
      expect(WRITE_TOOLS).toContain('start_agent');
      expect(WRITE_TOOLS).toContain('stop_agent');
      expect(WRITE_TOOLS).toContain('delegate_task');
      expect(WRITE_TOOLS).toContain('send_message');
      expect(WRITE_TOOLS).toContain('reply_slack');
      expect(WRITE_TOOLS).toContain('broadcast');
    });

    it('should not include read-only tools', () => {
      expect(WRITE_TOOLS).not.toContain('get_agent_status');
      expect(WRITE_TOOLS).not.toContain('get_team_status');
      expect(WRITE_TOOLS).not.toContain('read_file');
      expect(WRITE_TOOLS).not.toContain('recall_memory');
      expect(WRITE_TOOLS).not.toContain('heartbeat');
      expect(WRITE_TOOLS).not.toContain('get_audit_log');
      expect(WRITE_TOOLS).not.toContain('compact_memory');
    });

    it('should only contain valid tool names from the registry', () => {
      const validNames = getToolNames();
      for (const writeTool of WRITE_TOOLS) {
        expect(validNames).toContain(writeTool);
      }
    });
  });

  describe('git_status', () => {
    it('should parse git status output correctly', async () => {
      jest.spyOn(require('child_process'), 'exec').mockImplementation((...args: unknown[]) => {
        const cmd = String(args[0]);
        const callback = args[args.length - 1] as Function;
        if (cmd.includes('rev-parse')) { callback(null, 'main\n', ''); return; }
        if (cmd.includes('status --porcelain')) { callback(null, 'M  staged.ts\n M unstaged.ts\n?? new.ts\n', ''); return; }
        callback(null, '', '');
      });

      const result = await (tools.git_status as any).execute({ projectPath: '/test/project' });

      expect(result.success).toBe(true);
      expect(result.branch).toBe('main');
      expect(result.staged).toContain('staged.ts');
      expect(result.unstaged).toContain('unstaged.ts');
      expect(result.untracked).toContain('new.ts');

      jest.restoreAllMocks();
    });

    it('should handle errors gracefully', async () => {
      jest.spyOn(require('child_process'), 'exec').mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as Function;
        callback(new Error('not a git repository'));
      });

      const result = await (tools.git_status as any).execute({ projectPath: '/not/a/repo' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a git repository');

      jest.restoreAllMocks();
    });
  });

  describe('git_diff', () => {
    it('should return unstaged diff by default', async () => {
      jest.spyOn(require('child_process'), 'exec').mockImplementation((...args: unknown[]) => {
        const cmd = String(args[0]);
        const callback = args[args.length - 1] as Function;
        if (cmd === 'git diff') { callback(null, 'diff --git a/file.ts\n+added line\n', ''); return; }
        callback(null, '', '');
      });

      const result = await (tools.git_diff as any).execute({ projectPath: '/test/project', staged: false });

      expect(result.success).toBe(true);
      expect(result.diff).toContain('+added line');
      expect(result.truncated).toBe(false);

      jest.restoreAllMocks();
    });

    it('should return staged diff when staged=true', async () => {
      jest.spyOn(require('child_process'), 'exec').mockImplementation((...args: unknown[]) => {
        const cmd = String(args[0]);
        const callback = args[args.length - 1] as Function;
        if (cmd === 'git diff --cached') { callback(null, 'staged diff output\n', ''); return; }
        callback(null, '', '');
      });

      const result = await (tools.git_diff as any).execute({ projectPath: '/test/project', staged: true });

      expect(result.success).toBe(true);
      expect(result.diff).toContain('staged diff output');

      jest.restoreAllMocks();
    });

    it('should truncate long diffs to 5000 chars', async () => {
      const longDiff = 'x'.repeat(6000);
      jest.spyOn(require('child_process'), 'exec').mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as Function;
        callback(null, longDiff, '');
      });

      const result = await (tools.git_diff as any).execute({ projectPath: '/test/project', staged: false });

      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.diff.length).toBeLessThanOrEqual(5020);
      expect(result.totalLength).toBe(6000);

      jest.restoreAllMocks();
    });
  });

  describe('git_commit', () => {
    it('should stage all and commit when no files specified', async () => {
      const calls: string[] = [];
      jest.spyOn(require('child_process'), 'exec').mockImplementation((...args: unknown[]) => {
        const cmd = String(args[0]);
        calls.push(cmd);
        const callback = args[args.length - 1] as Function;
        if (cmd.includes('rev-parse HEAD')) { callback(null, 'abc123def\n', ''); return; }
        callback(null, '', '');
      });

      const result = await (tools.git_commit as any).execute({
        projectPath: '/test/project',
        message: 'feat: add feature',
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBe('abc123def');
      expect(calls).toContain('git add -A');
      expect(calls.some((c: string) => c.includes('git commit'))).toBe(true);

      jest.restoreAllMocks();
    });

    it('should stage specific files when provided', async () => {
      const calls: string[] = [];
      jest.spyOn(require('child_process'), 'exec').mockImplementation((...args: unknown[]) => {
        const cmd = String(args[0]);
        calls.push(cmd);
        const callback = args[args.length - 1] as Function;
        if (cmd.includes('rev-parse HEAD')) { callback(null, 'def456\n', ''); return; }
        callback(null, '', '');
      });

      const result = await (tools.git_commit as any).execute({
        projectPath: '/test/project',
        message: 'fix: bug',
        files: ['src/a.ts', 'src/b.ts'],
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBe('def456');
      expect(calls.some((c: string) => c.includes('git add') && c.includes('src/a.ts'))).toBe(true);
      expect(calls.some((c: string) => c.includes('git add') && c.includes('src/b.ts'))).toBe(true);
      expect(calls).not.toContain('git add -A');

      jest.restoreAllMocks();
    });

    it('should handle commit errors gracefully', async () => {
      jest.spyOn(require('child_process'), 'exec').mockImplementation((...args: unknown[]) => {
        const cmd = String(args[0]);
        const callback = args[args.length - 1] as Function;
        if (cmd.includes('git commit')) { callback(new Error('nothing to commit')); return; }
        callback(null, '', '');
      });

      const result = await (tools.git_commit as any).execute({
        projectPath: '/test/project',
        message: 'empty commit',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('nothing to commit');

      jest.restoreAllMocks();
    });

    it('should have sensitive classification', () => {
      expect(TOOL_SENSITIVITY.git_commit).toBe('sensitive');
    });
  });

  describe('git tool sensitivity', () => {
    it('should classify git_status as safe', () => {
      expect(TOOL_SENSITIVITY.git_status).toBe('safe');
    });

    it('should classify git_diff as safe', () => {
      expect(TOOL_SENSITIVITY.git_diff).toBe('safe');
    });

    it('should classify git_commit as sensitive', () => {
      expect(TOOL_SENSITIVITY.git_commit).toBe('sensitive');
    });
  });

  describe('getToolNames includes git tools', () => {
    it('should include all 3 git tools', () => {
      const names = getToolNames();
      expect(names).toContain('git_status');
      expect(names).toContain('git_diff');
      expect(names).toContain('git_commit');
    });
  });

  describe('validateBashCommand', () => {
    let validateFn: typeof import('./tool-registry.js')['validateBashCommand'];

    beforeEach(async () => {
      const mod = await import('./tool-registry.js');
      validateFn = mod.validateBashCommand;
    });

    it('should allow safe commands', () => {
      expect(validateFn('ls -la')).toBeNull();
      expect(validateFn('npm run build')).toBeNull();
      expect(validateFn('git status')).toBeNull();
      expect(validateFn('cat package.json')).toBeNull();
      expect(validateFn('echo "hello world"')).toBeNull();
      expect(validateFn('node -e "console.log(1)"')).toBeNull();
    });

    it('should block kill commands', () => {
      expect(validateFn('kill 1234')).not.toBeNull();
      expect(validateFn('kill -9 $$')).not.toBeNull();
      expect(validateFn('killall node')).not.toBeNull();
      expect(validateFn('pkill -f crewly')).not.toBeNull();
    });

    it('should block system commands', () => {
      expect(validateFn('shutdown -h now')).not.toBeNull();
      expect(validateFn('reboot')).not.toBeNull();
      expect(validateFn('launchctl unload com.crewly')).not.toBeNull();
      expect(validateFn('systemctl stop crewly')).not.toBeNull();
    });

    it('should block destructive disk commands', () => {
      expect(validateFn('mkfs /dev/sda1')).not.toBeNull();
      expect(validateFn('dd if=/dev/zero of=/dev/sda')).not.toBeNull();
    });

    it('should allow rm for specific files (not root wipe)', () => {
      expect(validateFn('rm file.txt')).toBeNull();
      expect(validateFn('rm -rf ./dist')).toBeNull();
      expect(validateFn('rm -rf node_modules')).toBeNull();
    });
  });

  describe('bash_exec tool', () => {
    let bashTools: ReturnType<typeof createTools>;

    beforeEach(() => {
      // Use a real directory so spawnSync can set cwd
      bashTools = createTools(mockClient, 'crewly-orc', '/tmp');
    });

    it('should execute simple commands successfully', async () => {
      const result = await bashTools.bash_exec.execute({ command: 'echo "hello"' }) as any;
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('hello');
    });

    it('should block dangerous commands', async () => {
      const result = await bashTools.bash_exec.execute({ command: 'kill 1234' }) as any;
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(126);
      expect(result.error).toContain('blocked');
    });

    it('should handle command failure gracefully', async () => {
      const result = await bashTools.bash_exec.execute({ command: 'false' }) as any;
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    it('should respect timeout', async () => {
      const result = await bashTools.bash_exec.execute({ command: 'sleep 30', timeout: 1000 }) as any;
      expect(result.success).toBe(false);
    }, 10000);

    it('should use process isolation (spawnSync, not execSync)', async () => {
      const result = await bashTools.bash_exec.execute({ command: 'echo $$' }) as any;
      expect(result.success).toBe(true);
      const childPid = parseInt(result.stdout.trim(), 10);
      expect(childPid).not.toBe(process.pid);
    });
  });

  // ===== globToRegExp unit tests =====

  describe('globToRegExp', () => {
    it('should match simple wildcards', () => {
      const re = globToRegExp('*.ts');
      expect(re.test('foo.ts')).toBe(true);
      expect(re.test('bar.js')).toBe(false);
      expect(re.test('src/foo.ts')).toBe(false); // * should not match /
    });

    it('should match ** for recursive paths', () => {
      const re = globToRegExp('**/*.ts');
      expect(re.test('foo.ts')).toBe(true);
      expect(re.test('src/foo.ts')).toBe(true);
      expect(re.test('src/deep/nested/foo.ts')).toBe(true);
      expect(re.test('foo.js')).toBe(false);
    });

    it('should match ? for single characters', () => {
      const re = globToRegExp('?.ts');
      expect(re.test('a.ts')).toBe(true);
      expect(re.test('ab.ts')).toBe(false);
    });

    it('should match brace alternatives', () => {
      const re = globToRegExp('*.{ts,tsx}');
      expect(re.test('foo.ts')).toBe(true);
      expect(re.test('foo.tsx')).toBe(true);
      expect(re.test('foo.js')).toBe(false);
    });

    it('should match character classes', () => {
      const re = globToRegExp('[abc].ts');
      expect(re.test('a.ts')).toBe(true);
      expect(re.test('d.ts')).toBe(false);
    });

    it('should escape regex special characters in literal parts', () => {
      const re = globToRegExp('file.test.ts');
      expect(re.test('file.test.ts')).toBe(true);
      expect(re.test('filextest.ts')).toBe(false); // dot should be literal
    });

    it('should handle src/**/*.test.ts pattern', () => {
      const re = globToRegExp('src/**/*.test.ts');
      expect(re.test('src/foo.test.ts')).toBe(true);
      expect(re.test('src/deep/bar.test.ts')).toBe(true);
      expect(re.test('lib/foo.test.ts')).toBe(false);
    });
  });

  // ===== walkAndMatch unit tests =====

  describe('walkAndMatch', () => {
    const fs = require('fs').promises;
    const os = require('os');
    const path = require('path');
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-glob-test-'));
      // Create test file structure
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'src', 'utils'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export {};');
      await fs.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'const app = 1;');
      await fs.writeFile(path.join(tmpDir, 'src', 'app.test.ts'), 'test("app", () => {});');
      await fs.writeFile(path.join(tmpDir, 'src', 'utils', 'helper.ts'), 'export function help() {}');
      await fs.writeFile(path.join(tmpDir, 'src', 'style.css'), 'body {}');
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should find all .ts files recursively', async () => {
      const re = globToRegExp('**/*.ts');
      const results = await walkAndMatch(tmpDir, re, new Set(['node_modules', '.git']), 100);
      expect(results.length).toBe(4);
      expect(results.some(f => f.endsWith('index.ts'))).toBe(true);
      expect(results.some(f => f.endsWith('app.ts'))).toBe(true);
      expect(results.some(f => f.endsWith('app.test.ts'))).toBe(true);
      expect(results.some(f => f.endsWith('helper.ts'))).toBe(true);
    });

    it('should ignore node_modules by default', async () => {
      const re = globToRegExp('**/*.js');
      const results = await walkAndMatch(tmpDir, re, new Set(['node_modules']), 100);
      expect(results.length).toBe(0); // Only .js is in node_modules
    });

    it('should respect maxResults limit', async () => {
      const re = globToRegExp('**/*');
      const results = await walkAndMatch(tmpDir, re, new Set(['node_modules']), 2);
      expect(results.length).toBe(2);
    });

    it('should match specific subdirectory patterns', async () => {
      const re = globToRegExp('src/**/*.ts');
      const results = await walkAndMatch(tmpDir, re, new Set(['node_modules']), 100);
      expect(results.length).toBe(3); // app.ts, app.test.ts, helper.ts
      expect(results.every(f => f.includes('/src/'))).toBe(true);
    });
  });

  // ===== searchFileContents unit tests =====

  describe('searchFileContents', () => {
    const fs = require('fs').promises;
    const os = require('os');
    const path = require('path');
    let tmpFile: string;

    beforeEach(async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-grep-test-'));
      tmpFile = path.join(tmpDir, 'test.ts');
      await fs.writeFile(tmpFile, [
        'import { foo } from "./foo";',
        'import { bar } from "./bar";',
        '',
        'export function hello() {',
        '  return "hello world";',
        '}',
        '',
        'export function goodbye() {',
        '  return "goodbye world";',
        '}',
      ].join('\n'));
    });

    it('should find matching lines with line numbers', async () => {
      const matches = await searchFileContents(tmpFile, /export function/, 0);
      expect(matches.length).toBe(2);
      expect(matches[0].line).toBe(4);
      expect(matches[0].content).toContain('hello');
      expect(matches[1].line).toBe(8);
      expect(matches[1].content).toContain('goodbye');
    });

    it('should return context lines when requested', async () => {
      const matches = await searchFileContents(tmpFile, /hello\(\)/, 1);
      expect(matches.length).toBe(1);
      expect(matches[0].line).toBe(4);
      expect(matches[0].context).toBeDefined();
      expect(matches[0].context!.length).toBe(3); // 1 before + match + 1 after
    });

    it('should return empty array when no matches', async () => {
      const matches = await searchFileContents(tmpFile, /nonexistent/, 0);
      expect(matches.length).toBe(0);
    });

    it('should handle regex special characters in content', async () => {
      const matches = await searchFileContents(tmpFile, /from "\.\/foo"/, 0);
      expect(matches.length).toBe(1);
      expect(matches[0].line).toBe(1);
    });
  });

  // ===== glob tool integration tests =====

  describe('glob tool', () => {
    it('should exist in createTools output', () => {
      expect(tools.glob).toBeDefined();
      expect((tools.glob as any).description).toContain('file pattern matching');
    });

    it('should find files in the project directory', async () => {
      const result = await (tools.glob as any).execute({
        pattern: '**/*.ts',
        path: __dirname,
      }) as any;
      expect(result.success).toBe(true);
      expect(result.matchCount).toBeGreaterThan(0);
      expect(result.files.some((f: string) => f.endsWith('tool-registry.ts'))).toBe(true);
    });

    it('should return error for non-existent directory', async () => {
      const result = await (tools.glob as any).execute({
        pattern: '**/*.ts',
        path: '/nonexistent/path/xyz',
      }) as any;
      expect(result.success).toBe(false);
    });

    it('should respect custom ignore patterns', async () => {
      const result = await (tools.glob as any).execute({
        pattern: '**/*.ts',
        path: __dirname,
        ignore: ['__snapshots__'],
      }) as any;
      expect(result.success).toBe(true);
    });

    it('should have safe sensitivity', () => {
      expect(TOOL_SENSITIVITY.glob).toBe('safe');
    });
  });

  // ===== grep tool integration tests =====

  describe('grep tool', () => {
    it('should exist in createTools output', () => {
      expect(tools.grep).toBeDefined();
      expect((tools.grep as any).description).toContain('Search file contents');
    });

    it('should find pattern matches in files', async () => {
      const result = await (tools.grep as any).execute({
        pattern: 'export function createTools',
        path: __dirname,
        file_pattern: '**/*.ts',
      }) as any;
      expect(result.success).toBe(true);
      expect(result.matchCount).toBeGreaterThan(0);
      // Match may come from source or test file — both contain the string
      expect(result.matches.some((m: any) => m.file.includes('tool-registry'))).toBe(true);
    });

    it('should support case insensitive search', async () => {
      const result = await (tools.grep as any).execute({
        pattern: 'EXPORT FUNCTION CREATETOOLS',
        path: __dirname,
        file_pattern: 'tool-registry.ts',
        case_insensitive: true,
      }) as any;
      expect(result.success).toBe(true);
      expect(result.matchCount).toBeGreaterThan(0);
    });

    it('should return context lines when requested', async () => {
      const result = await (tools.grep as any).execute({
        pattern: 'export function createTools',
        path: __dirname,
        file_pattern: 'tool-registry.ts',
        context_lines: 2,
      }) as any;
      expect(result.success).toBe(true);
      expect(result.matches[0].context).toBeDefined();
      expect(result.matches[0].context.length).toBeGreaterThanOrEqual(3);
    });

    it('should return error for invalid regex', async () => {
      const result = await (tools.grep as any).execute({
        pattern: '[invalid',
        path: __dirname,
      }) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid regex');
    });

    it('should search a single file when path is a file', async () => {
      const filePath = require('path').join(__dirname, 'tool-registry.ts');
      const result = await (tools.grep as any).execute({
        pattern: 'glob:',
        path: filePath,
      }) as any;
      expect(result.success).toBe(true);
      expect(result.matchCount).toBeGreaterThan(0);
    });

    it('should have safe sensitivity', () => {
      expect(TOOL_SENSITIVITY.grep).toBe('safe');
    });

    it('should respect max_matches limit', async () => {
      const result = await (tools.grep as any).execute({
        pattern: 'const|let|var',
        path: __dirname,
        file_pattern: '**/*.ts',
        max_matches: 3,
      }) as any;
      expect(result.success).toBe(true);
      expect(result.matchCount).toBeLessThanOrEqual(3);
      expect(result.truncated).toBe(true);
    });
  });
});
