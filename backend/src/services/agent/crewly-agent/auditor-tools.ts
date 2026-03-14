/**
 * Crewly Auditor Tool Registry
 *
 * Read-only tools for the Auditor agent. These tools allow the auditor
 * to observe agent activity, read logs, check task alignment, and write
 * structured bug reports — without any ability to modify system state.
 *
 * @module services/agent/crewly-agent/auditor-tools
 */

import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { CrewlyApiClient } from './api-client.js';
import type { ToolDefinition } from './types.js';
import { convertMarkdownToSlackMrkdwn } from './tool-registry.js';

/** Severity levels for audit findings */
const AUDIT_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/**
 * Create the auditor tool set for the Crewly Auditor agent.
 *
 * All tools are read-only except `write_audit_report` which appends
 * to the audit log file.
 *
 * @param client - API client for Crewly REST API calls
 * @param projectPath - Project root path for file operations
 * @returns Object of named tools for the auditor agent
 */
export function createAuditorTools(
  client: CrewlyApiClient,
  projectPath: string,
): Record<string, ToolDefinition> {
  const auditDir = path.join(projectPath, '.crewly', 'audit');
  const bugsFile = path.join(auditDir, 'bugs.md');

  return {
    get_team_status: {
      description: 'Get status of all teams and their agents. Returns team names, member statuses, and runtime types.',
      inputSchema: z.object({}),
      execute: async () => {
        const result = await client.get('/teams');
        return result.success ? result.data : { error: result.error };
      },
    },

    get_agent_logs: {
      description: 'Get recent terminal output from an agent session. Use to inspect agent activity and detect errors.',
      inputSchema: z.object({
        sessionName: z.string().describe('Agent session name'),
        lines: z.number().default(50).describe('Number of lines to retrieve'),
      }),
      execute: async (args) => {
        const { sessionName, lines } = args as { sessionName: string; lines: number };
        const result = await client.get(`/terminal/${sessionName}/output?lines=${lines}`);
        return result.success ? result.data : { error: result.error };
      },
    },

    get_tasks: {
      description: 'Get all tracked tasks for a project. Use to detect stale, failed, or orphaned tasks.',
      inputSchema: z.object({
        projectPath: z.string().describe('Project path'),
        status: z.string().optional().describe('Filter by status (open, in_progress, done, failed)'),
      }),
      execute: async (args) => {
        const { projectPath: pp, status } = args as { projectPath: string; status?: string };
        const query = status ? `?projectPath=${encodeURIComponent(pp)}&status=${status}` : `?projectPath=${encodeURIComponent(pp)}`;
        const result = await client.get(`/task-management/tasks${query}`);
        return result.success ? result.data : { error: result.error };
      },
    },

    recall_goals: {
      description: 'Retrieve current project goals, OKRs, and objectives from memory. Use to check goal alignment.',
      inputSchema: z.object({
        context: z.string().default('current project goals OKR objectives priorities').describe('Search context'),
      }),
      execute: async (args) => {
        const { context } = args as { context: string };
        const result = await client.post('/memory/recall', {
          context,
          scope: 'project',
        });
        return result.success ? result.data : { error: result.error };
      },
    },

    heartbeat: {
      description: 'System health check. Returns teams, projects, and queue status in one call.',
      inputSchema: z.object({}),
      execute: async () => {
        const [teams, projects] = await Promise.all([
          client.get('/teams'),
          client.get('/projects'),
        ]);
        return {
          teams: teams.success ? teams.data : { error: teams.error },
          projects: projects.success ? projects.data : { error: projects.error },
          timestamp: new Date().toISOString(),
        };
      },
    },

    get_agent_status: {
      description: 'Get the current status of a specific agent by session name.',
      inputSchema: z.object({
        sessionName: z.string().describe('Agent session name to check'),
      }),
      execute: async (args) => {
        const { sessionName } = args as { sessionName: string };
        const result = await client.get('/teams');
        if (!result.success) return { error: result.error };
        const teams = result.data as Array<{ members?: Array<{ sessionName: string }> }>;
        for (const team of teams) {
          const member = team.members?.find(m => m.sessionName === sessionName);
          if (member) return member;
        }
        return { error: `Agent '${sessionName}' not found` };
      },
    },

    subscribe_event: {
      description: 'Subscribe to agent lifecycle events for monitoring. Read-only observation.',
      inputSchema: z.object({
        eventType: z.string().describe('Event type (e.g., "agent:idle", "agent:busy", "agent:status_changed")'),
        filter: z.record(z.string()).optional().describe('Event filter criteria'),
        oneShot: z.boolean().default(false).describe('Auto-unsubscribe after first event'),
      }),
      execute: async (args) => {
        const { eventType, filter, oneShot } = args as { eventType: string; filter?: Record<string, string>; oneShot: boolean };
        const result = await client.post('/events/subscribe', {
          eventType,
          filter,
          oneShot,
          target: 'crewly-auditor',
        });
        return result.success ? result.data : { error: result.error };
      },
    },

    write_audit_report: {
      description: 'Append a structured audit finding to the bugs.md file. Use when you detect a problem.',
      inputSchema: z.object({
        severity: z.enum(AUDIT_SEVERITIES).describe('Problem severity level'),
        agents: z.array(z.string()).describe('Session names of involved agents'),
        title: z.string().describe('Short problem title'),
        description: z.string().describe('Detailed problem description'),
        evidence: z.string().describe('Log excerpts or data supporting the finding'),
        suggestion: z.string().describe('Recommended fix or action'),
      }),
      execute: async (args) => {
        const { severity, agents, title, description, evidence, suggestion } =
          args as { severity: string; agents: string[]; title: string; description: string; evidence: string; suggestion: string };

        const timestamp = new Date().toISOString();
        const severityIcon = severity === 'critical' ? '🔴' : severity === 'high' ? '🟠' : severity === 'medium' ? '🟡' : '🔵';

        const entry = [
          '',
          `### ${severityIcon} [${severity.toUpperCase()}] ${title}`,
          `**Time:** ${timestamp}`,
          `**Agents:** ${agents.join(', ')}`,
          '',
          description,
          '',
          '**Evidence:**',
          '```',
          evidence,
          '```',
          '',
          `**Suggestion:** ${suggestion}`,
          '',
          '---',
          '',
        ].join('\n');

        // Ensure audit directory exists
        await fsPromises.mkdir(auditDir, { recursive: true });

        // Append to bugs.md (create with header if new)
        let existing = '';
        try {
          existing = await fsPromises.readFile(bugsFile, 'utf8');
        } catch {
          existing = '# Crewly Audit — Bug Reports\n\nAutomated findings from the Crewly Auditor agent.\n\n---\n';
        }

        await fsPromises.writeFile(bugsFile, existing + entry, 'utf8');

        return {
          success: true,
          file: bugsFile,
          severity,
          title,
          timestamp,
        };
      },
    },

    reply_slack: {
      description: 'Send a message directly to a Slack thread. Use this to respond to user questions when SLACK_CONTEXT is present. Supports Slack mrkdwn formatting.',
      inputSchema: z.object({
        text: z.string().describe('Message text in Slack mrkdwn format'),
        channelId: z.string().describe('Slack channel ID from SLACK_CONTEXT'),
        threadTs: z.string().describe('Slack thread timestamp from SLACK_CONTEXT'),
      }),
      execute: async (args) => {
        const { text, channelId, threadTs } = args as { text: string; channelId: string; threadTs: string };
        // #181: Convert markdown to Slack mrkdwn format
        const slackText = convertMarkdownToSlackMrkdwn(text);
        const result = await client.post('/slack/send', { channelId, text: slackText, threadTs });
        return result.success ? { sent: true } : { error: result.error };
      },
    },

    create_github_issue: {
      description: 'Create a GitHub issue for a bug or enhancement found during audit (#178). Deduplicates: checks existing open issues before creating. Requires gh CLI to be available.',
      inputSchema: z.object({
        title: z.string().describe('Issue title (include severity prefix like [Critical], [High], [Medium])'),
        body: z.string().describe('Issue body in markdown format'),
        labels: z.array(z.string()).default(['bug']).describe('GitHub labels (e.g., bug, enhancement)'),
      }),
      execute: async (args) => {
        const { title, body, labels } = args as { title: string; body: string; labels: string[] };
        const { execSync } = await import('child_process');

        try {
          // Dedup: search for existing open issues with similar title
          const searchQuery = title.replace(/\[.*?\]\s*/, '').slice(0, 50);
          let existingIssues = '';
          try {
            existingIssues = execSync(
              `gh issue list --state open --search "${searchQuery.replace(/"/g, '\\"')}" --json number,title --limit 5`,
              { encoding: 'utf-8', timeout: 15000 }
            );
          } catch { /* gh not available or no repo */ }

          if (existingIssues) {
            const issues = JSON.parse(existingIssues);
            const duplicate = issues.find((i: { title: string }) =>
              i.title.toLowerCase().includes(searchQuery.toLowerCase().slice(0, 30))
            );
            if (duplicate) {
              return {
                success: true,
                created: false,
                duplicate: true,
                existingIssue: `#${duplicate.number}: ${duplicate.title}`,
              };
            }
          }

          // Create the issue
          const labelFlag = labels.map(l => `--label "${l}"`).join(' ');
          const result = execSync(
            `gh issue create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" ${labelFlag}`,
            { encoding: 'utf-8', timeout: 30000 }
          );

          const issueUrl = result.trim();
          return { success: true, created: true, url: issueUrl, title };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            note: 'GitHub CLI (gh) may not be installed or authenticated',
          };
        }
      },
    },

    read_audit_history: {
      description: 'Read previous audit findings from bugs.md. Use to avoid duplicate reports.',
      inputSchema: z.object({
        lastN: z.number().default(10).describe('Number of recent findings to return'),
      }),
      execute: async (args) => {
        const { lastN } = args as { lastN: number };
        try {
          const content = await fsPromises.readFile(bugsFile, 'utf8');
          // Split on --- separator, take last N entries
          const entries = content.split('---').filter(e => e.trim());
          const recent = entries.slice(-lastN);
          return {
            totalFindings: entries.length - 1, // subtract header
            recentFindings: recent.join('---'),
          };
        } catch {
          return { totalFindings: 0, recentFindings: 'No audit history found.' };
        }
      },
    },
  };
}

/**
 * Get the list of auditor tool names.
 *
 * @returns Array of auditor tool name strings
 */
export function getAuditorToolNames(): string[] {
  return [
    'get_team_status', 'get_agent_logs', 'get_tasks', 'recall_goals',
    'heartbeat', 'get_agent_status', 'subscribe_event',
    'write_audit_report', 'reply_slack', 'read_audit_history', 'create_github_issue',
  ];
}
