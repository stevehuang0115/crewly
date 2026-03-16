/**
 * Session Handoff Service
 *
 * Generates a structured session summary on shutdown and pushes it to agents
 * on restart. Replaces the old Slack-only pushRecentSlackHistory approach with
 * a channel-agnostic summary that covers Slack, Google Chat, and Chat UI.
 *
 * Summary is stored at ~/.crewly/session-summaries/latest.md and is limited
 * to 50 lines for prompt-budget friendliness.
 *
 * @module services/session/session-handoff.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LoggerService } from '../core/logger.service.js';
import { CREWLY_CONSTANTS, SLACK_THREAD_CONSTANTS, GCHAT_THREAD_CONSTANTS } from '../../constants.js';
import type { RuntimeType } from '../../constants.js';
import { RUNTIME_TYPES } from '../../constants.js';

/** Maximum number of lines the summary may contain */
const MAX_SUMMARY_LINES = 80;

/** Maximum number of pending tasks to include in the summary */
const MAX_PENDING_TASKS = 10;

/** Maximum age in ms for a thread to be considered for resume notification (24 hours) */
const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Maximum number of recent user messages to include per thread */
const MAX_MESSAGES_PER_THREAD = 3;

/** Maximum number of active threads to include in the summary */
const MAX_ACTIVE_THREADS = 6;

/** Directory name for session summaries under crewly home */
const SUMMARIES_DIR = 'session-summaries';

/** Summary filename */
const LATEST_SUMMARY = 'latest.md';

/**
 * Information about an active conversation thread.
 */
export interface ActiveThread {
  /** Channel type: 'slack', 'gchat', or 'chat-ui' */
  channelType: 'slack' | 'gchat' | 'chat-ui';
  /** Channel or space identifier */
  channelId: string;
  /** Absolute path to the thread file */
  filePath: string;
  /** ISO timestamp of last modification */
  lastActiveAt: string;
  /** Last few message summaries */
  recentMessages: string[];
}

/**
 * Information about an active team member (agent).
 */
export interface ActiveAgentInfo {
  /** Agent session name */
  sessionName: string;
  /** Agent role */
  role: string;
  /** Current working status */
  workingStatus: string;
  /** Current task description (if any) */
  currentTask?: string;
}

/**
 * Information about a pending (non-completed) task from .crewly/tasks/.
 */
export interface PendingTaskInfo {
  /** Task title (first heading line from the MD file) */
  title: string;
  /** Agent session name the task is assigned to */
  assignedTo: string;
  /** Current task status (e.g., 'In Progress', 'open') */
  status: string;
  /** Task priority if specified */
  priority: string;
  /** Absolute path to the task file */
  filePath: string;
}

/**
 * Full session handoff summary data.
 */
export interface HandoffSummary {
  /** ISO timestamp of summary generation */
  generatedAt: string;
  /** Active conversation threads across all channels */
  activeThreads: ActiveThread[];
  /** Active agents and their status */
  activeAgents: ActiveAgentInfo[];
  /** Pending tasks that have not been completed */
  pendingTasks: PendingTaskInfo[];
}

/**
 * Thread info for the resume notification sent after orchestrator restart.
 * Covers Slack, Google Chat, and Chat UI channels.
 */
export interface ResumeThread {
  /** Channel type: 'slack', 'gchat', or 'chat-ui' */
  channelType: 'slack' | 'gchat' | 'chat-ui';
  /** Channel or space identifier */
  channelId: string;
  /** Thread identifier (threadTs for Slack, threadName for GChat, conversationId for Chat UI) */
  threadId: string;
  /** Absolute path to the thread file */
  filePath: string;
  /** ISO timestamp of last modification */
  lastActiveAt: string;
  /** Recent message previews */
  recentMessages: string[];
}

/**
 * @deprecated Use ResumeThread instead. Kept for backward compatibility.
 */
export type SlackResumeThread = ResumeThread;

/**
 * Service to send messages to agents.
 * Minimal interface to avoid tight coupling with AgentRegistrationService.
 */
export interface AgentMessageSender {
  sendMessageToAgent(session: string, content: string, runtimeType: RuntimeType): Promise<{ success: boolean }>;
}

/**
 * Service to read team data.
 * Minimal interface to avoid tight coupling with StorageService.
 */
export interface TeamDataReader {
  getTeams(): Promise<Array<{
    members: Array<{
      sessionName: string;
      role: string;
      agentStatus: string;
      workingStatus: string;
      currentTickets?: string[];
    }>;
  }>>;
}

/**
 * Manages generation of session summaries on shutdown and delivery on restart.
 *
 * @example
 * ```typescript
 * const handoff = SessionHandoffService.getInstance();
 *
 * // On shutdown:
 * await handoff.generateSummary(storageService);
 *
 * // On agent registration:
 * await handoff.pushSessionSummary(agentService, 'crewly-orc');
 * ```
 */
export class SessionHandoffService {
  private static instance: SessionHandoffService | null = null;
  private readonly logger = LoggerService.getInstance().createComponentLogger('SessionHandoffService');

  private constructor() {}

  /**
   * Gets the singleton instance.
   *
   * @returns SessionHandoffService instance
   */
  static getInstance(): SessionHandoffService {
    if (!SessionHandoffService.instance) {
      SessionHandoffService.instance = new SessionHandoffService();
    }
    return SessionHandoffService.instance;
  }

  /**
   * Resets the singleton instance (for testing).
   */
  static resetInstance(): void {
    SessionHandoffService.instance = null;
  }

  /**
   * Returns the directory path for session summaries.
   *
   * @returns Absolute path to ~/.crewly/session-summaries/
   */
  getSummariesDir(): string {
    return path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME, SUMMARIES_DIR);
  }

  /**
   * Returns the path to the latest summary file.
   *
   * @returns Absolute path to ~/.crewly/session-summaries/latest.md
   */
  getLatestSummaryPath(): string {
    return path.join(this.getSummariesDir(), LATEST_SUMMARY);
  }

  /**
   * Scans a thread directory for the most recently modified .md files.
   * Works for both Slack (~/.crewly/slack-threads/) and GChat (~/.crewly/gchat-threads/).
   *
   * @param baseDir - Base directory to scan (e.g., ~/.crewly/slack-threads/)
   * @param channelType - Type of channel ('slack' or 'gchat')
   * @param maxThreads - Maximum number of threads to return
   * @returns Array of ActiveThread info sorted by recency
   */
  async scanThreadDirectory(
    baseDir: string,
    channelType: 'slack' | 'gchat',
    maxThreads: number = MAX_ACTIVE_THREADS,
  ): Promise<ActiveThread[]> {
    const threads: ActiveThread[] = [];

    try {
      const entries = await fs.readdir(baseDir).catch(() => [] as string[]);

      // Collect all .md files across subdirectories
      const candidates: Array<{ filePath: string; channelId: string; mtimeMs: number }> = [];

      for (const entry of entries) {
        if (entry.endsWith('.json')) continue; // Skip index files

        const entryPath = path.join(baseDir, entry);
        const stat = await fs.stat(entryPath).catch(() => null);

        if (stat?.isDirectory()) {
          const files = await fs.readdir(entryPath).catch(() => [] as string[]);
          for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const filePath = path.join(entryPath, file);
            const fileStat = await fs.stat(filePath).catch(() => null);
            if (fileStat) {
              candidates.push({ filePath, channelId: entry, mtimeMs: fileStat.mtimeMs });
            }
          }
        }
      }

      // Sort by modification time (most recent first) and take top N
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const candidate of candidates.slice(0, maxThreads)) {
        const recentMessages = await this.extractRecentMessages(candidate.filePath);
        threads.push({
          channelType,
          channelId: candidate.channelId,
          filePath: candidate.filePath,
          lastActiveAt: new Date(candidate.mtimeMs).toISOString(),
          recentMessages,
        });
      }
    } catch (error) {
      this.logger.debug('Failed to scan thread directory', {
        baseDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return threads;
  }

  /**
   * Scans Chat UI conversation storage for active conversations.
   *
   * @param chatDir - Path to chat storage directory (default: ~/.crewly/chat/)
   * @param maxConversations - Maximum number of conversations to return
   * @returns Array of ActiveThread info for Chat UI conversations
   */
  async scanChatUiConversations(
    chatDir?: string,
    maxConversations: number = MAX_ACTIVE_THREADS,
  ): Promise<ActiveThread[]> {
    const threads: ActiveThread[] = [];
    const dir = chatDir || path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME, 'chat');

    try {
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const candidates: Array<{ filePath: string; id: string; mtimeMs: number }> = [];
      for (const file of jsonFiles) {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat) {
          candidates.push({ filePath, id: file.replace('.json', ''), mtimeMs: stat.mtimeMs });
        }
      }

      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const candidate of candidates.slice(0, maxConversations)) {
        const recentMessages = await this.extractChatUiMessages(candidate.filePath);
        threads.push({
          channelType: 'chat-ui',
          channelId: candidate.id,
          filePath: candidate.filePath,
          lastActiveAt: new Date(candidate.mtimeMs).toISOString(),
          recentMessages,
        });
      }
    } catch (error) {
      this.logger.debug('Failed to scan Chat UI conversations', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return threads;
  }

  /**
   * Extracts recent message summaries from a markdown thread file.
   * Reads the last few message blocks (lines starting with **Name**).
   *
   * @param filePath - Absolute path to the thread .md file
   * @returns Array of recent message summary strings
   */
  async extractRecentMessages(filePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // Skip frontmatter
      const frontmatterEnd = content.indexOf('---', content.indexOf('---') + 3);
      const body = frontmatterEnd > 0 ? content.slice(frontmatterEnd + 3).trim() : content;

      // Extract lines that look like message headers (e.g., "**Steve** (2025-03-16 12:00):")
      const messagePattern = /^\*\*(.+?)\*\*\s*\(([^)]+)\):\s*$/;
      const lines = body.split('\n');
      const messages: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(messagePattern);
        if (match) {
          const sender = match[1];
          // Grab the next non-empty line as content preview
          let preview = '';
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const trimmed = lines[j].trim();
            if (trimmed && !trimmed.startsWith('**')) {
              preview = trimmed.slice(0, 120);
              break;
            }
          }
          messages.push(`${sender}: ${preview || '(empty)'}`);
        }
      }

      return messages.slice(-MAX_MESSAGES_PER_THREAD);
    } catch {
      return [];
    }
  }

  /**
   * Extracts recent messages from a Chat UI JSON conversation file.
   *
   * @param filePath - Absolute path to the conversation .json file
   * @returns Array of recent message summary strings
   */
  async extractChatUiMessages(filePath: string): Promise<string[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as {
        messages?: Array<{
          content?: string;
          from?: { name?: string; type?: string };
        }>;
      };

      if (!data.messages || data.messages.length === 0) return [];

      return data.messages
        .slice(-MAX_MESSAGES_PER_THREAD)
        .map(m => {
          const sender = m.from?.name || m.from?.type || 'unknown';
          const content = (m.content || '').slice(0, 120);
          return `${sender}: ${content || '(empty)'}`;
        });
    } catch {
      return [];
    }
  }

  /**
   * Collects active agent info from team storage.
   *
   * @param teamReader - Service to read team data
   * @returns Array of active agent info
   */
  async collectActiveAgents(teamReader: TeamDataReader): Promise<ActiveAgentInfo[]> {
    const agents: ActiveAgentInfo[] = [];

    try {
      const teams = await teamReader.getTeams();
      for (const team of teams) {
        for (const member of team.members) {
          if (member.agentStatus === 'active' || member.agentStatus === 'started') {
            agents.push({
              sessionName: member.sessionName,
              role: member.role,
              workingStatus: member.workingStatus || 'idle',
              currentTask: member.currentTickets?.[0],
            });
          }
        }
      }
    } catch (error) {
      this.logger.debug('Failed to collect active agents', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return agents;
  }

  /**
   * Scans .crewly/tasks/delegated/ for non-completed tasks (open + in_progress).
   * Parses each task MD file to extract title, assignee, status, and priority.
   *
   * @param tasksBaseDir - Override for the tasks base directory (for testing)
   * @returns Array of PendingTaskInfo sorted by priority (high first)
   */
  async scanPendingTasks(tasksBaseDir?: string): Promise<PendingTaskInfo[]> {
    const baseDir = tasksBaseDir || path.join(
      os.homedir(),
      CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
      'tasks',
      'delegated',
    );
    const pendingTasks: PendingTaskInfo[] = [];

    const statusDirs = ['in_progress', 'open'];

    for (const statusDir of statusDirs) {
      const dirPath = path.join(baseDir, statusDir);
      try {
        const files = await fs.readdir(dirPath).catch(() => [] as string[]);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(dirPath, file);
          const task = await this.parseTaskFile(filePath, statusDir);
          if (task) {
            pendingTasks.push(task);
          }
        }
      } catch (error) {
        this.logger.debug('Failed to scan tasks directory', {
          dirPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Sort: in_progress first, then high priority first
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const statusOrder: Record<string, number> = { in_progress: 0, open: 1 };
    pendingTasks.sort((a, b) => {
      const statusDiff = (statusOrder[a.status] ?? 1) - (statusOrder[b.status] ?? 1);
      if (statusDiff !== 0) return statusDiff;
      return (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
    });

    return pendingTasks.slice(0, MAX_PENDING_TASKS);
  }

  /**
   * Parses a single task MD file to extract structured info.
   *
   * @param filePath - Absolute path to the task .md file
   * @param statusDir - Directory name indicating status ('open', 'in_progress')
   * @returns PendingTaskInfo or null if parsing fails
   */
  async parseTaskFile(filePath: string, statusDir: string): Promise<PendingTaskInfo | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Extract title from first heading
      let title = path.basename(filePath, '.md');
      for (const line of lines) {
        if (line.startsWith('# ')) {
          title = line.replace(/^#\s+/, '').trim();
          // Strip [TASK] prefix if present
          title = title.replace(/^\[TASK\]\s*/i, '');
          break;
        }
      }
      // Truncate long titles
      if (title.length > 100) {
        title = title.slice(0, 97) + '...';
      }

      // Extract assigned agent
      let assignedTo = 'unassigned';
      const assignedMatch = content.match(/\*\*Assigned to\*\*:\s*(.+)/i)
        || content.match(/Assignee:\s*(.+)/i);
      if (assignedMatch) {
        assignedTo = assignedMatch[1].trim();
      }

      // Extract priority
      let priority = 'medium';
      const priorityMatch = content.match(/\*\*Priority\*\*:\s*(.+)/i)
        || content.match(/Priority:\s*(.+)/i);
      if (priorityMatch) {
        priority = priorityMatch[1].trim().toLowerCase();
      }

      // Status from directory name
      const status = statusDir === 'in_progress' ? 'in_progress' : 'open';

      return { title, assignedTo, status, priority, filePath };
    } catch {
      return null;
    }
  }

  /**
   * Generates a full session handoff summary by scanning all thread stores
   * and collecting active agent status. Saves to ~/.crewly/session-summaries/latest.md.
   *
   * @param teamReader - Service to read team data for agent status
   * @param tasksBaseDir - Override for the tasks base directory (for testing)
   * @returns The generated summary data
   */
  async generateSummary(teamReader: TeamDataReader, tasksBaseDir?: string): Promise<HandoffSummary> {
    this.logger.info('Generating session handoff summary...');

    const crewlyHome = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);

    // Scan all thread stores and pending tasks in parallel
    const [slackThreads, gchatThreads, chatUiThreads, activeAgents, pendingTasks] = await Promise.all([
      this.scanThreadDirectory(
        path.join(crewlyHome, SLACK_THREAD_CONSTANTS.STORAGE_DIR),
        'slack',
        3,
      ),
      this.scanThreadDirectory(
        path.join(crewlyHome, GCHAT_THREAD_CONSTANTS.STORAGE_DIR),
        'gchat',
        3,
      ),
      this.scanChatUiConversations(undefined, 2),
      this.collectActiveAgents(teamReader),
      this.scanPendingTasks(tasksBaseDir),
    ]);

    const allThreads = [...slackThreads, ...gchatThreads, ...chatUiThreads]
      .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
      .slice(0, MAX_ACTIVE_THREADS);

    const summary: HandoffSummary = {
      generatedAt: new Date().toISOString(),
      activeThreads: allThreads,
      activeAgents,
      pendingTasks,
    };

    // Format and save
    const markdown = this.formatSummaryMarkdown(summary);
    const summariesDir = this.getSummariesDir();
    await fs.mkdir(summariesDir, { recursive: true });
    await fs.writeFile(this.getLatestSummaryPath(), markdown, 'utf-8');

    this.logger.info('Session handoff summary saved', {
      threadCount: allThreads.length,
      agentCount: activeAgents.length,
      pendingTaskCount: pendingTasks.length,
      path: this.getLatestSummaryPath(),
    });

    return summary;
  }

  /**
   * Formats a HandoffSummary into a markdown string, capped at MAX_SUMMARY_LINES.
   *
   * @param summary - The summary data
   * @returns Markdown string
   */
  formatSummaryMarkdown(summary: HandoffSummary): string {
    const lines: string[] = [];

    lines.push('# Session Handoff Summary');
    lines.push(`Generated: ${summary.generatedAt}`);
    lines.push('');

    // Active threads section
    if (summary.activeThreads.length > 0) {
      lines.push('## Active Conversations');
      for (const thread of summary.activeThreads) {
        lines.push(`### ${thread.channelType.toUpperCase()} — ${thread.channelId}`);
        lines.push(`- File: \`${thread.filePath}\``);
        lines.push(`- Last active: ${thread.lastActiveAt}`);
        if (thread.recentMessages.length > 0) {
          lines.push('- Recent:');
          for (const msg of thread.recentMessages) {
            lines.push(`  - ${msg}`);
          }
        }
        lines.push('');
      }
    } else {
      lines.push('## Active Conversations');
      lines.push('No active conversations found.');
      lines.push('');
    }

    // Active agents section
    if (summary.activeAgents.length > 0) {
      lines.push('## Active Agents');
      for (const agent of summary.activeAgents) {
        const taskInfo = agent.currentTask ? ` — task: ${agent.currentTask}` : '';
        lines.push(`- **${agent.sessionName}** (${agent.role}): ${agent.workingStatus}${taskInfo}`);
      }
      lines.push('');
    }

    // Pending tasks section
    if (summary.pendingTasks && summary.pendingTasks.length > 0) {
      lines.push('## Pending Tasks');
      lines.push(`${summary.pendingTasks.length} task(s) require attention after restart:`);
      lines.push('');
      for (const task of summary.pendingTasks) {
        const statusLabel = task.status === 'in_progress' ? '🔄 IN PROGRESS' : '📋 OPEN';
        lines.push(`- ${statusLabel} [${task.priority}] **${task.title}**`);
        lines.push(`  - Assigned to: ${task.assignedTo}`);
        lines.push(`  - File: \`${task.filePath}\``);
      }
      lines.push('');
    }

    // Truncate to max lines
    return lines.slice(0, MAX_SUMMARY_LINES).join('\n');
  }

  /**
   * Pushes the latest session summary to an agent after registration.
   * Replaces the old pushRecentSlackHistory function.
   *
   * Reads ~/.crewly/session-summaries/latest.md and sends it as a
   * [SESSION_CONTEXT] system message. Only sends if the summary exists
   * and is non-empty.
   *
   * @param agentService - Service to send messages to agents
   * @param sessionName - Target agent session name
   */
  async pushSessionSummary(
    agentService: AgentMessageSender,
    sessionName: string,
  ): Promise<void> {
    const summaryPath = this.getLatestSummaryPath();

    try {
      const content = await fs.readFile(summaryPath, 'utf-8');
      if (!content || content.trim().length === 0) {
        this.logger.debug('No session summary to push', { sessionName });
        return;
      }

      const message = `[SESSION_CONTEXT] Previous session context for restart recovery:\n\n${content.trim()}`;

      await agentService.sendMessageToAgent(
        sessionName,
        message,
        RUNTIME_TYPES.CLAUDE_CODE as RuntimeType,
      );

      this.logger.info('Pushed session summary to agent', {
        sessionName,
        summaryLength: content.length,
      });
    } catch (error) {
      this.logger.warn('Failed to push session summary', {
        sessionName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Scans a thread directory (Slack or GChat format) for threads modified within maxAge.
   * Filters by file modification time and returns ResumeThread objects.
   *
   * @param baseDir - Directory to scan (e.g., ~/.crewly/slack-threads/)
   * @param channelType - Channel type ('slack' or 'gchat')
   * @param cutoffMs - Cutoff timestamp in ms (threads older than this are excluded)
   * @returns Array of ResumeThread for qualifying threads
   */
  private async scanRecentMdThreads(
    baseDir: string,
    channelType: 'slack' | 'gchat',
    cutoffMs: number,
  ): Promise<ResumeThread[]> {
    const threads: ResumeThread[] = [];

    try {
      const entries = await fs.readdir(baseDir).catch(() => [] as string[]);

      for (const entry of entries) {
        if (entry.endsWith('.json')) continue;
        const channelDir = path.join(baseDir, entry);
        const stat = await fs.stat(channelDir).catch(() => null);
        if (!stat?.isDirectory()) continue;

        const files = await fs.readdir(channelDir).catch(() => [] as string[]);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(channelDir, file);
          const fileStat = await fs.stat(filePath).catch(() => null);
          if (!fileStat || fileStat.mtimeMs < cutoffMs) continue;

          const threadId = file.replace('.md', '');
          const recentMessages = await this.extractRecentMessages(filePath);
          threads.push({
            channelType,
            channelId: entry,
            threadId,
            filePath,
            lastActiveAt: new Date(fileStat.mtimeMs).toISOString(),
            recentMessages,
          });
        }
      }
    } catch (error) {
      this.logger.debug('Failed to scan recent threads', {
        baseDir,
        channelType,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return threads;
  }

  /**
   * Scans Chat UI conversations for those modified within maxAge.
   *
   * @param chatDir - Chat UI directory path
   * @param cutoffMs - Cutoff timestamp in ms
   * @returns Array of ResumeThread for qualifying conversations
   */
  private async scanRecentChatUiThreads(
    chatDir: string,
    cutoffMs: number,
  ): Promise<ResumeThread[]> {
    const threads: ResumeThread[] = [];

    try {
      const files = await fs.readdir(chatDir).catch(() => [] as string[]);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(chatDir, file);
        const fileStat = await fs.stat(filePath).catch(() => null);
        if (!fileStat || fileStat.mtimeMs < cutoffMs) continue;

        const conversationId = file.replace('.json', '');
        const recentMessages = await this.extractChatUiMessages(filePath);
        threads.push({
          channelType: 'chat-ui',
          channelId: conversationId,
          threadId: conversationId,
          filePath,
          lastActiveAt: new Date(fileStat.mtimeMs).toISOString(),
          recentMessages,
        });
      }
    } catch (error) {
      this.logger.debug('Failed to scan recent Chat UI conversations', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return threads;
  }

  /**
   * Finds threads across all chat channels (Slack, GChat, Chat UI) that were
   * active within the specified time window.
   *
   * @param maxAge - Maximum age in ms for a thread to qualify (default: 24h)
   * @param dirOverrides - Optional directory overrides for testing
   * @returns Array of ResumeThread sorted by most recent first
   */
  async findRecentThreads(
    maxAge: number = RESUME_MAX_AGE_MS,
    dirOverrides?: { slackDir?: string; gchatDir?: string; chatDir?: string },
  ): Promise<ResumeThread[]> {
    const crewlyHome = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
    const slackDir = dirOverrides?.slackDir || path.join(crewlyHome, SLACK_THREAD_CONSTANTS.STORAGE_DIR);
    const gchatDir = dirOverrides?.gchatDir || path.join(crewlyHome, GCHAT_THREAD_CONSTANTS.STORAGE_DIR);
    const chatDir = dirOverrides?.chatDir || path.join(crewlyHome, 'chat');
    const cutoff = Date.now() - maxAge;

    const [slackThreads, gchatThreads, chatUiThreads] = await Promise.all([
      this.scanRecentMdThreads(slackDir, 'slack', cutoff),
      this.scanRecentMdThreads(gchatDir, 'gchat', cutoff),
      this.scanRecentChatUiThreads(chatDir, cutoff),
    ]);

    const all = [...slackThreads, ...gchatThreads, ...chatUiThreads];
    return all.sort((a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
    );
  }

  /**
   * @deprecated Use findRecentThreads() instead. Kept for backward compatibility.
   * Finds Slack threads that were active within the last 24 hours.
   *
   * @param maxAge - Maximum age in ms for a thread to qualify (default: 24h)
   * @param slackDirOverride - Optional directory override (for testing)
   * @returns Array of ResumeThread sorted by most recent first (Slack only)
   */
  async findRecentSlackThreads(
    maxAge: number = RESUME_MAX_AGE_MS,
    slackDirOverride?: string,
  ): Promise<ResumeThread[]> {
    return this.findRecentThreads(maxAge, {
      slackDir: slackDirOverride,
      gchatDir: '/nonexistent',
      chatDir: '/nonexistent',
    });
  }

  /**
   * Pushes a [CHAT_RESUME] notification to the orchestrator after registration,
   * containing info about recently active threads across all channels (Slack,
   * GChat, Chat UI) so it can proactively send a greeting message.
   *
   * @param agentService - Service to send messages to agents
   * @param sessionName - Target agent session name (typically the orchestrator)
   */
  async pushResumeNotification(
    agentService: AgentMessageSender,
    sessionName: string,
  ): Promise<void> {
    try {
      const threads = await this.findRecentThreads();

      if (threads.length === 0) {
        this.logger.debug('No recent threads for resume notification', { sessionName });
        return;
      }

      const lines: string[] = [
        '[CHAT_RESUME] You just restarted. The following chat threads were active in the last 24 hours.',
        'You MUST read the most recent thread and send a greeting message to prove you have recovered context.',
        '',
      ];

      for (const thread of threads) {
        const label = thread.channelType.toUpperCase();
        lines.push(`## ${label} Thread: ${thread.channelId} / ${thread.threadId}`);
        lines.push(`- Source: ${thread.channelType}`);
        lines.push(`- File: \`${thread.filePath}\``);
        lines.push(`- Channel: ${thread.channelId}`);
        lines.push(`- Thread ID: ${thread.threadId}`);
        lines.push(`- Last active: ${thread.lastActiveAt}`);
        if (thread.recentMessages.length > 0) {
          lines.push('- Recent messages:');
          for (const msg of thread.recentMessages) {
            lines.push(`  - ${msg}`);
          }
        }
        lines.push('');
      }

      const message = lines.join('\n');

      await agentService.sendMessageToAgent(
        sessionName,
        message,
        RUNTIME_TYPES.CLAUDE_CODE as RuntimeType,
      );

      this.logger.info('Pushed resume notification', {
        sessionName,
        threadCount: threads.length,
        channels: [...new Set(threads.map(t => t.channelType))],
      });
    } catch (error) {
      this.logger.warn('Failed to push resume notification', {
        sessionName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * @deprecated Use pushResumeNotification() instead.
   */
  async pushSlackResumeNotification(
    agentService: AgentMessageSender,
    sessionName: string,
  ): Promise<void> {
    return this.pushResumeNotification(agentService, sessionName);
  }
}
