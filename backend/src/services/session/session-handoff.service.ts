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
const MAX_SUMMARY_LINES = 50;

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
 * Full session handoff summary data.
 */
export interface HandoffSummary {
  /** ISO timestamp of summary generation */
  generatedAt: string;
  /** Active conversation threads across all channels */
  activeThreads: ActiveThread[];
  /** Active agents and their status */
  activeAgents: ActiveAgentInfo[];
}

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
   * Generates a full session handoff summary by scanning all thread stores
   * and collecting active agent status. Saves to ~/.crewly/session-summaries/latest.md.
   *
   * @param teamReader - Service to read team data for agent status
   * @returns The generated summary data
   */
  async generateSummary(teamReader: TeamDataReader): Promise<HandoffSummary> {
    this.logger.info('Generating session handoff summary...');

    const crewlyHome = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);

    // Scan all thread stores in parallel
    const [slackThreads, gchatThreads, chatUiThreads, activeAgents] = await Promise.all([
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
    ]);

    const allThreads = [...slackThreads, ...gchatThreads, ...chatUiThreads]
      .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
      .slice(0, MAX_ACTIVE_THREADS);

    const summary: HandoffSummary = {
      generatedAt: new Date().toISOString(),
      activeThreads: allThreads,
      activeAgents,
    };

    // Format and save
    const markdown = this.formatSummaryMarkdown(summary);
    const summariesDir = this.getSummariesDir();
    await fs.mkdir(summariesDir, { recursive: true });
    await fs.writeFile(this.getLatestSummaryPath(), markdown, 'utf-8');

    this.logger.info('Session handoff summary saved', {
      threadCount: allThreads.length,
      agentCount: activeAgents.length,
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
}
