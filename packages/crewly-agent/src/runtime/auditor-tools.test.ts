import { describe, it, expect, beforeEach, afterEach, vi, type Mocked, type MockInstance } from 'vitest';
import { promises as fs, mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAuditorTools, getAuditorToolNames } from './auditor-tools.js';
import { CrewlyApiClient } from './api-client.js';

describe('Auditor Tools', () => {
  let mockClient: Mocked<CrewlyApiClient>;
  let tools: ReturnType<typeof createAuditorTools>;
  let readFileSpy: MockInstance<typeof fs.readFile>;
  let writeFileSpy: MockInstance<typeof fs.writeFile>;
  let mkdirSpy: MockInstance<typeof fs.mkdir>;
  const projectPath = '/test/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      get: vi.fn<any>(),
      post: vi.fn<any>(),
      put: vi.fn<any>(),
      delete: vi.fn<any>(),
    } as any;

    readFileSpy = vi.spyOn(fs, 'readFile') as any;
    writeFileSpy = vi.spyOn(fs, 'writeFile') as any;
    mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any) as any;

    tools = createAuditorTools(mockClient, projectPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAuditorToolNames', () => {
    it('should return all 11 tool names', () => {
      const names = getAuditorToolNames();
      expect(names).toHaveLength(11);
      expect(names).toContain('get_team_status');
      expect(names).toContain('get_agent_logs');
      expect(names).toContain('get_tasks');
      expect(names).toContain('recall_goals');
      expect(names).toContain('heartbeat');
      expect(names).toContain('get_agent_status');
      expect(names).toContain('subscribe_event');
      expect(names).toContain('write_audit_report');
      expect(names).toContain('reply_slack');
      expect(names).toContain('read_audit_history');
    });
  });

  describe('tool definitions', () => {
    it('should create all 11 tools', () => {
      expect(Object.keys(tools)).toHaveLength(11);
    });

    it('should have description and inputSchema on every tool', () => {
      for (const [name, tool] of Object.entries(tools)) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(typeof tool.execute).toBe('function');
      }
    });
  });

  describe('get_team_status', () => {
    it('should return team data on success', async () => {
      mockClient.get.mockResolvedValue({ success: true, status: 200, data: [{ id: 'team1' }] });
      const result = await tools.get_team_status.execute({});
      expect(mockClient.get).toHaveBeenCalledWith('/teams');
      expect(result).toEqual([{ id: 'team1' }]);
    });

    it('should return error on failure', async () => {
      mockClient.get.mockResolvedValue({ success: false, status: 500, error: 'Network error' });
      const result = await tools.get_team_status.execute({});
      expect(result).toEqual({ error: 'Network error' });
    });
  });

  describe('get_agent_logs', () => {
    it('should fetch logs with line count', async () => {
      mockClient.get.mockResolvedValue({ success: true, status: 200, data: { output: 'log data' } });
      const result = await tools.get_agent_logs.execute({ sessionName: 'agent-1', lines: 30 });
      expect(mockClient.get).toHaveBeenCalledWith('/terminal/agent-1/output?lines=30');
      expect(result).toEqual({ output: 'log data' });
    });
  });

  describe('get_tasks', () => {
    it('should fetch tasks with project path', async () => {
      mockClient.get.mockResolvedValue({ success: true, status: 200, data: [{ id: 'task1' }] });
      await tools.get_tasks.execute({ projectPath: '/proj', status: 'in_progress' });
      // V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
      expect(mockClient.get).toHaveBeenCalledWith(expect.stringContaining('/task-pool/items'));
      expect(mockClient.get).toHaveBeenCalledWith(expect.stringContaining('status=in_progress'));
    });

    it('should fetch all tasks when no status filter', async () => {
      mockClient.get.mockResolvedValue({ success: true, status: 200, data: [] });
      await tools.get_tasks.execute({ projectPath: '/proj' });
      expect(mockClient.get).toHaveBeenCalledWith(expect.not.stringContaining('status='));
    });
  });

  describe('recall_goals', () => {
    it('should call memory recall with project scope', async () => {
      mockClient.post.mockResolvedValue({ success: true, status: 200, data: { goals: ['OKR1'] } });
      const result = await tools.recall_goals.execute({ context: 'current goals' });
      expect(mockClient.post).toHaveBeenCalledWith('/memory/recall', {
        context: 'current goals',
        scope: 'project',
      });
      expect(result).toEqual({ goals: ['OKR1'] });
    });
  });

  describe('heartbeat', () => {
    it('should return combined teams and projects status', async () => {
      mockClient.get.mockResolvedValueOnce({ success: true, status: 200, data: [{ id: 't1' }] });
      mockClient.get.mockResolvedValueOnce({ success: true, status: 200, data: [{ id: 'p1' }] });
      const result = await tools.heartbeat.execute({}) as Record<string, unknown>;
      expect(result.teams).toEqual([{ id: 't1' }]);
      expect(result.projects).toEqual([{ id: 'p1' }]);
      expect(result.timestamp).toBeTruthy();
    });
  });

  describe('get_agent_status', () => {
    it('should find agent by session name across teams', async () => {
      mockClient.get.mockResolvedValue({
        success: true,
        status: 200,
        data: [
          { members: [{ sessionName: 'other', name: 'Other' }] },
          { members: [{ sessionName: 'target', name: 'Target', agentStatus: 'active' }] },
        ],
      });
      const result = await tools.get_agent_status.execute({ sessionName: 'target' });
      expect(result).toEqual({ sessionName: 'target', name: 'Target', agentStatus: 'active' });
    });

    it('should return error when agent not found', async () => {
      mockClient.get.mockResolvedValue({ success: true, status: 200, data: [{ members: [] }] });
      const result = await tools.get_agent_status.execute({ sessionName: 'missing' }) as { error: string };
      expect(result.error).toContain('not found');
    });
  });

  describe('subscribe_event', () => {
    it('should subscribe with auditor as target', async () => {
      mockClient.post.mockResolvedValue({ success: true, status: 200, data: { subscriptionId: 's1' } });
      await tools.subscribe_event.execute({
        eventType: 'agent:idle',
        oneShot: false,
      });
      expect(mockClient.post).toHaveBeenCalledWith('/events/subscribe', expect.objectContaining({
        eventType: 'agent:idle',
        target: 'crewly-auditor',
      }));
    });
  });

  describe('reply_slack', () => {
    it('should send message via slack API', async () => {
      mockClient.post.mockResolvedValue({ success: true, status: 200, data: { ok: true } });
      const result = await tools.reply_slack.execute({
        text: 'Here are the audit findings...',
        channelId: 'C12345',
        threadTs: '1234567890.123456',
      }) as { sent: boolean };
      expect(mockClient.post).toHaveBeenCalledWith('/slack/send', {
        channelId: 'C12345',
        text: 'Here are the audit findings...',
        threadTs: '1234567890.123456',
      });
      expect(result.sent).toBe(true);
    });

    it('should return error on failure', async () => {
      mockClient.post.mockResolvedValue({ success: false, status: 500, error: 'Slack API error' });
      const result = await tools.reply_slack.execute({
        text: 'test',
        channelId: 'C1',
        threadTs: 't1',
      }) as { error: string };
      expect(result.error).toBe('Slack API error');
    });
  });

  describe('write_audit_report', () => {
    it('should create bugs.md with header when file does not exist', async () => {
      readFileSpy.mockRejectedValue(new Error('ENOENT') as never);
      writeFileSpy.mockResolvedValue(undefined as never);

      const result = await tools.write_audit_report.execute({
        severity: 'high',
        agents: ['agent-sam'],
        title: 'Agent stuck in loop',
        description: 'Agent Sam has been retrying the same operation for 30 minutes.',
        evidence: 'Error: Build failed\nError: Build failed\nError: Build failed',
        suggestion: 'Investigate build configuration or reset agent.',
      }) as { success: boolean; severity: string; title: string };

      expect(mkdirSpy).toHaveBeenCalledWith(
        path.join(projectPath, '.crewly', 'audit'),
        { recursive: true },
      );
      expect(writeFileSpy).toHaveBeenCalled();
      const written = (writeFileSpy.mock.calls[0] as any[])[1] as string;
      expect(written).toContain('# Crewly Audit');
      expect(written).toContain('[HIGH] Agent stuck in loop');
      expect(written).toContain('agent-sam');
      expect(written).toContain('Build failed');
      expect(result.success).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('should append to existing bugs.md', async () => {
      readFileSpy.mockResolvedValue('# Existing content\n\n---\n' as never);
      writeFileSpy.mockResolvedValue(undefined as never);

      await tools.write_audit_report.execute({
        severity: 'medium',
        agents: ['agent-leo'],
        title: 'Idle agent with pending tasks',
        description: 'Leo has been idle for 20 minutes with 2 open tasks.',
        evidence: 'Status: idle. Open tasks: task-123, task-456',
        suggestion: 'Send a nudge message to Leo.',
      });

      const written = (writeFileSpy.mock.calls[0] as any[])[1] as string;
      expect(written).toContain('# Existing content');
      expect(written).toContain('[MEDIUM] Idle agent');
    });

    it('should use correct severity icons', async () => {
      readFileSpy.mockRejectedValue(new Error('ENOENT') as never);
      writeFileSpy.mockResolvedValue(undefined as never);

      for (const [sev, icon] of [['critical', '🔴'], ['high', '🟠'], ['medium', '🟡'], ['low', '🔵']] as const) {
        await tools.write_audit_report.execute({
          severity: sev,
          agents: ['test'],
          title: `${sev} issue`,
          description: 'Test',
          evidence: 'Test',
          suggestion: 'Test',
        });
      }

      const calls = writeFileSpy.mock.calls;
      expect((calls[0] as any[])[1]).toContain('🔴');
      expect((calls[1] as any[])[1]).toContain('🟠');
      expect((calls[2] as any[])[1]).toContain('🟡');
      expect((calls[3] as any[])[1]).toContain('🔵');
    });
  });

  describe('read_audit_history', () => {
    it('should return recent findings', async () => {
      readFileSpy.mockResolvedValue('# Header\n---\nFinding 1\n---\nFinding 2\n---\nFinding 3' as never);
      const result = await tools.read_audit_history.execute({ lastN: 2 }) as { totalFindings: number };
      expect(result.totalFindings).toBe(3); // 4 sections - 1 header
    });

    it('should return empty when no history', async () => {
      readFileSpy.mockRejectedValue(new Error('ENOENT') as never);
      const result = await tools.read_audit_history.execute({ lastN: 10 }) as { totalFindings: number; recentFindings: string };
      expect(result.totalFindings).toBe(0);
      expect(result.recentFindings).toContain('No audit history');
    });
  });
  describe('create_github_issue (CREW-967: no shell)', () => {
    let binDir: string;
    let logFile: string;
    let originalPath: string | undefined;

    /** Splits the fake gh's NUL-separated log into one argv array per call. */
    function readCalls(): string[][] {
      const parts = readFileSync(logFile, 'utf8').split('\0');
      const calls: string[][] = [];
      for (const part of parts) {
        if (part === 'CALL') calls.push([]);
        else if (part !== '' && calls.length > 0) calls[calls.length - 1].push(part);
      }
      return calls;
    }

    beforeEach(() => {
      binDir = mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
      logFile = path.join(binDir, 'argv.log');
      writeFileSync(logFile, '');
      const script = [
        '#!/bin/bash',
        'printf "CALL\\0" >> "$GH_ARGV_LOG"',
        'printf "%s\\0" "$@" >> "$GH_ARGV_LOG"',
        'if [ "$2" = "list" ]; then echo "[]"; else echo "https://github.com/o/r/issues/1"; fi',
      ].join('\n');
      writeFileSync(path.join(binDir, 'gh'), script);
      chmodSync(path.join(binDir, 'gh'), 0o755);
      originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath}`;
      process.env.GH_ARGV_LOG = logFile;
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      delete process.env.GH_ARGV_LOG;
      rmSync(binDir, { recursive: true, force: true });
    });

    it('does not evaluate $(...) or backticks and passes each value as one argv entry', async () => {
      const marker1 = path.join(binDir, 'pwned-subshell');
      const marker2 = path.join(binDir, 'pwned-backtick');
      const title = `[High] x $(touch ${marker1}) \`touch ${marker2}\` "q"`;
      const body = `body $(touch ${marker1}) \`touch ${marker2}\``;
      const label = `bug$(touch ${marker1})`;

      const result = await tools.create_github_issue.execute({ title, body, labels: [label, 'enhancement'] }) as { success: boolean; created: boolean };

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(existsSync(marker1)).toBe(false);
      expect(existsSync(marker2)).toBe(false);

      const calls = readCalls();
      expect(calls).toHaveLength(2); // dedup search + create
      const search = calls[0];
      expect(search.slice(0, 4)).toEqual(['issue', 'list', '--state', 'open']);
      expect(search[search.indexOf('--search') + 1]).toContain('$(touch');

      const create = calls[1];
      expect(create[0]).toBe('issue');
      expect(create[1]).toBe('create');
      expect(create[create.indexOf('--title') + 1]).toBe(title);
      expect(create[create.indexOf('--body') + 1]).toBe(body);
      const labelValues = create.flatMap((a, i) => (a === '--label' ? [create[i + 1]] : []));
      expect(labelValues).toEqual([label, 'enhancement']);
    });
  });
});
