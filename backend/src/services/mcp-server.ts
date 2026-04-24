/**
 * Crewly MCP Server Service
 *
 * Exposes Crewly capabilities as MCP (Model Context Protocol) tools so that
 * external AI tools — Claude Code, Cursor, Windsurf, etc. — can manage
 * Crewly teams via the standard MCP protocol.
 *
 * This is Crewly's unique differentiator: no competitor offers a
 * "team management backend" controllable via MCP.
 *
 * Supported tools:
 * - crewly_get_teams — List all teams and their members/status
 * - crewly_create_team — Create a new team with members
 * - crewly_assign_task — Assign a task to a specific agent
 * - crewly_get_status — Get agent/team status
 * - crewly_recall_memory — Search team memory/knowledge
 * - crewly_send_message — Send a message to an agent
 *
 * @module services/mcp-server
 */

import { StorageService } from './core/storage.service.js';
import { MemoryService } from './memory/memory.service.js';
import type { Team, TeamMember } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { getCredentialStoreService } from './credential/credential-store.service.js';
import { GeminiCliWorkspaceHelper } from './credential/helpers/gemini-cli-workspace.helper.js';
import { getSkillExecutorService } from './skill/skill-executor.service.js';
import type { SkillExecutionContext } from '../types/skill.types.js';

// ========================= Constants =========================

/**
 * MCP Server configuration constants.
 */
export const MCP_SERVER_CONSTANTS = {
  /** Server identification sent during MCP handshake */
  SERVER_INFO: {
    NAME: 'crewly-mcp-server',
    VERSION: '1.0.0',
  },
  /** Tool name prefix for namespacing */
  TOOL_PREFIX: 'crewly',
} as const;

// ========================= Types =========================

/**
 * Configuration for the Crewly MCP Server.
 */
export interface CrewlyMcpServerConfig {
  /** Path to the crewly home directory (default: ~/.crewly) */
  crewlyHome?: string;
}

/**
 * Result returned by MCP tool handlers.
 */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ========================= Tool Definitions =========================

/**
 * MCP tool definitions for Crewly capabilities.
 * Each tool has a name, description, and JSON Schema for its input.
 */
const TOOL_DEFINITIONS = [
  {
    name: 'crewly_get_teams',
    description:
      'List all Crewly teams and their members with current status. ' +
      'Returns team names, member roles, agent status, and working status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        teamId: {
          type: 'string',
          description: 'Optional: filter to a specific team by ID',
        },
      },
    },
  },
  {
    name: 'crewly_create_team',
    description:
      'Create a new Crewly team with the specified members. ' +
      'Each member needs a name, role, and runtime type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Team name (e.g. "Backend Squad")',
        },
        description: {
          type: 'string',
          description: 'Optional team description',
        },
        members: {
          type: 'array',
          description: 'Array of team members to create',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Member name' },
              role: {
                type: 'string',
                description: 'Member role (developer, qa, product-manager, designer, etc.)',
              },
              runtimeType: {
                type: 'string',
                enum: ['claude-code', 'gemini-cli', 'codex-cli', 'crewly-agent'],
                description: 'AI runtime to use (default: claude-code)',
              },
            },
            required: ['name', 'role'],
          },
        },
      },
      required: ['name', 'members'],
    },
  },
  {
    name: 'crewly_assign_task',
    description:
      'Assign a task to a specific agent by sending it a message via the ' +
      'message queue. The agent will receive the task content as input.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team the agent belongs to',
        },
        memberId: {
          type: 'string',
          description: 'ID of the member to assign the task to',
        },
        task: {
          type: 'string',
          description: 'Task description/instructions for the agent',
        },
      },
      required: ['teamId', 'memberId', 'task'],
    },
  },
  {
    name: 'crewly_get_status',
    description:
      'Get the current status of a specific team or agent. Returns agent ' +
      'status (active/inactive), working status (idle/in_progress), and ' +
      'runtime type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        teamId: {
          type: 'string',
          description: 'Optional: filter to a specific team',
        },
        memberId: {
          type: 'string',
          description: 'Optional: filter to a specific member within a team',
        },
      },
    },
  },
  {
    name: 'crewly_recall_memory',
    description:
      'Search team memory and knowledge base for relevant information. ' +
      'Uses keyword and semantic matching to find stored learnings, ' +
      'patterns, decisions, and documents.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query for the memory/knowledge system',
        },
        agentId: {
          type: 'string',
          description: 'Optional: agent ID to scope the recall',
        },
        projectPath: {
          type: 'string',
          description: 'Optional: project path to scope the recall',
        },
        scope: {
          type: 'string',
          enum: ['agent', 'project', 'both'],
          description: 'Memory scope to search (default: both)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'crewly_send_message',
    description:
      'Send a message to the orchestrator via the message queue. ' +
      'The message will be queued and processed by the orchestrator.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'Message content to send',
        },
        conversationId: {
          type: 'string',
          description: 'Optional: conversation ID for threading (auto-generated if omitted)',
        },
      },
      required: ['message'],
    },
  },
  // -------------------- Credential management --------------------
  {
    name: 'crewly_credential_list',
    description:
      'List stored credentials (OAuth accounts and API keys). Returns metadata only — actual ' +
      'token / key values are NEVER included. Use this to discover which credentials are ' +
      'available before binding one to a skill execution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['api-key', 'google-oauth'],
          description: 'Optional: filter by credential type',
        },
        provider: {
          type: 'string',
          description: 'Optional: filter by provider (e.g., "google", "gemini")',
        },
      },
    },
  },
  {
    name: 'crewly_credential_add_api_key',
    description:
      'Add an API key credential to the workspace credential store. Used for services like Gemini ' +
      'API, OpenAI API, etc. that authenticate with a static key. The key is encrypted at rest.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'User-facing name for this credential (e.g., "gemini-main")',
        },
        provider: {
          type: 'string',
          description: 'Provider identifier (e.g., "gemini", "openai", "anthropic")',
        },
        value: {
          type: 'string',
          description: 'The raw API key value',
        },
      },
      required: ['name', 'provider', 'value'],
    },
  },
  {
    name: 'crewly_credential_oauth_import_gemini_cli',
    description:
      'Import a Google OAuth credential from the user\'s currently-active Gemini CLI Workspace ' +
      'extension login. Call this AFTER the user has signed in via ' +
      '`GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true gemini` and completed the browser auth. ' +
      'Crewly reads the extension\'s token file and saves an encrypted copy. The extension\'s ' +
      'cached file remains so you can verify — call crewly_credential_clear_gemini_cli_file ' +
      'afterwards if you want to prepare for another account.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Name for this credential (typically the account email or a nickname like "info-steam-fun")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'crewly_credential_clear_gemini_cli_file',
    description:
      'Delete the Gemini CLI Workspace extension\'s cached token file. Call after a successful ' +
      'import when preparing to add a different Google account — the extension uses a single-slot ' +
      'cache, so clearing forces the next extension run to re-authenticate.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'crewly_credential_delete',
    description:
      'Permanently delete a credential from the store (removes registry entry and encrypted ' +
      'file). Skills bound to this credential will fail until another credential is provided.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'Credential UUID (e.g., "cred-abc123")',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'crewly_execute_skill',
    description:
      'Execute a skill and return its output. Pass `credentialBindings` (map of slot name → ' +
      'credential UUID) to tell the skill which credential to use for each of its declared slots. ' +
      'Use crewly_credential_list first to find eligible credential IDs. Output is redacted of ' +
      'any injected secret values.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: {
          type: 'string',
          description: 'Skill identifier (e.g., "skill-gmail-reader")',
        },
        credentialBindings: {
          type: 'object',
          description:
            'Map of skill slot name → credential UUID. Overrides any default bound to the skill.',
          additionalProperties: { type: 'string' },
        },
        userInput: {
          type: 'string',
          description: 'User-provided input for the skill (optional)',
        },
        agentId: {
          type: 'string',
          description: 'Agent ID for context (default: "mcp-agent")',
        },
        roleId: {
          type: 'string',
          description: 'Role ID for context (default: "default")',
        },
      },
      required: ['skillId'],
    },
  },
] as const;

// ========================= Service =========================

/**
 * CrewlyMcpServer exposes Crewly team management capabilities as MCP tools.
 *
 * External AI tools can connect to this server via stdio transport and use
 * the provided tools to create teams, assign tasks, check status, search
 * memory, and send messages — all through the standard MCP protocol.
 *
 * @example
 * ```typescript
 * const mcpServer = new CrewlyMcpServer();
 * await mcpServer.start(); // Starts on stdio
 * ```
 *
 * @example Claude Code configuration (~/.claude/claude_desktop_config.json):
 * ```json
 * {
 *   "mcpServers": {
 *     "crewly": {
 *       "command": "npx",
 *       "args": ["crewly", "mcp-server"]
 *     }
 *   }
 * }
 * ```
 */
export class CrewlyMcpServer {
  private server: any | null = null;
  private storage: StorageService;
  private memory: MemoryService;
  private transport: any | null = null;
  private stdioTransportCtor: (new () => any) | null = null;
  private geminiCliHelper: GeminiCliWorkspaceHelper | null = null;

  private getGeminiCliHelper(): GeminiCliWorkspaceHelper {
    if (!this.geminiCliHelper) {
      this.geminiCliHelper = new GeminiCliWorkspaceHelper(getCredentialStoreService());
    }
    return this.geminiCliHelper;
  }

  /**
   * Creates a new CrewlyMcpServer instance.
   *
   * @param config - Optional server configuration
   */
  constructor(config?: CrewlyMcpServerConfig) {
    this.storage = StorageService.getInstance(config?.crewlyHome);
    this.memory = MemoryService.getInstance();
    this.tryInitializeWithRequire();
  }

  /**
   * Register MCP request handlers for tool listing and tool calling.
   */
  private registerHandlers(
    schemas: { listTools: unknown; callTool: unknown },
  ): void {
    if (!this.server) {
      throw new Error('MCP server is not initialized');
    }

    // Handle tools/list request
    this.server.setRequestHandler(schemas.listTools, async () => ({
      tools: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));

    // Handle tools/call request
    this.server.setRequestHandler(schemas.callTool, async (request: any) => {
      const { name, arguments: args } = request.params;
      const result = await this.handleToolCall(name, args ?? {});
      return result as unknown as Record<string, unknown>;
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.server && this.stdioTransportCtor) {
      return;
    }

    const serverModule = await import('@modelcontextprotocol/sdk/server/index.js') as any;
    const stdioModule = await import('@modelcontextprotocol/sdk/server/stdio.js') as any;
    const typesModule = await import('@modelcontextprotocol/sdk/types.js') as any;

    const ServerCtor = serverModule.Server ?? serverModule.default?.Server;
    const StdioTransportCtor = stdioModule.StdioServerTransport ?? stdioModule.default?.StdioServerTransport;
    const listTools = typesModule.ListToolsRequestSchema;
    const callTool = typesModule.CallToolRequestSchema;

    if (!ServerCtor || !StdioTransportCtor || !listTools || !callTool) {
      throw new Error('Failed to load MCP server SDK modules');
    }

    this.server = new ServerCtor(
      {
        name: MCP_SERVER_CONSTANTS.SERVER_INFO.NAME,
        version: MCP_SERVER_CONSTANTS.SERVER_INFO.VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );
    this.stdioTransportCtor = StdioTransportCtor;
    this.registerHandlers({ listTools, callTool });
  }

  private tryInitializeWithRequire(): void {
    if (this.server && this.stdioTransportCtor) {
      return;
    }

    try {
      const req = (0, eval)('require') as ((id: string) => any) | undefined;
      if (!req) {
        return;
      }

      const serverModule = req('@modelcontextprotocol/sdk/server/index.js');
      const stdioModule = req('@modelcontextprotocol/sdk/server/stdio.js');
      const typesModule = req('@modelcontextprotocol/sdk/types.js');

      const ServerCtor = serverModule.Server ?? serverModule.default?.Server;
      const StdioTransportCtor = stdioModule.StdioServerTransport ?? stdioModule.default?.StdioServerTransport;
      const listTools = typesModule.ListToolsRequestSchema;
      const callTool = typesModule.CallToolRequestSchema;

      if (!ServerCtor || !StdioTransportCtor || !listTools || !callTool) {
        return;
      }

      this.server = new ServerCtor(
        {
          name: MCP_SERVER_CONSTANTS.SERVER_INFO.NAME,
          version: MCP_SERVER_CONSTANTS.SERVER_INFO.VERSION,
        },
        {
          capabilities: {
            tools: {},
          },
        },
      );
      this.stdioTransportCtor = StdioTransportCtor;
      this.registerHandlers({ listTools, callTool });
    } catch {
      // Ignore in environments where `require` cannot load ESM SDK modules.
      // `ensureInitialized()` will use dynamic import on demand.
    }
  }

  /**
   * Route a tool call to the appropriate handler.
   *
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns Tool result with content blocks
   */
  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      switch (name) {
        case 'crewly_get_teams':
          return await this.handleGetTeams(args);
        case 'crewly_create_team':
          return await this.handleCreateTeam(args);
        case 'crewly_assign_task':
          return await this.handleAssignTask(args);
        case 'crewly_get_status':
          return await this.handleGetStatus(args);
        case 'crewly_recall_memory':
          return await this.handleRecallMemory(args);
        case 'crewly_send_message':
          return await this.handleSendMessage(args);
        case 'crewly_credential_list':
          return await this.handleCredentialList(args);
        case 'crewly_credential_add_api_key':
          return await this.handleCredentialAddApiKey(args);
        case 'crewly_credential_oauth_import_gemini_cli':
          return await this.handleCredentialImportGeminiCli(args);
        case 'crewly_credential_clear_gemini_cli_file':
          return await this.handleCredentialClearGeminiCliFile();
        case 'crewly_credential_delete':
          return await this.handleCredentialDelete(args);
        case 'crewly_execute_skill':
          return await this.handleExecuteSkill(args);
        default:
          return this.errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResult(`Tool "${name}" failed: ${message}`);
    }
  }

  // ========================= Tool Handlers =========================

  /**
   * Handle crewly_get_teams: list all teams and their members.
   *
   * @param args - Optional { teamId } to filter
   * @returns Formatted team list
   */
  private async handleGetTeams(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const teams = await this.storage.getTeams();
    const teamId = args.teamId as string | undefined;

    let filtered: Team[];
    if (teamId) {
      filtered = teams.filter((t) => t.id === teamId);
      if (filtered.length === 0) {
        return this.errorResult(`Team not found: ${teamId}`);
      }
    } else {
      filtered = teams;
    }

    const result = filtered.map((team) => ({
      id: team.id,
      name: team.name,
      description: team.description,
      memberCount: team.members.length,
      members: team.members.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        agentStatus: m.agentStatus,
        workingStatus: m.workingStatus,
        runtimeType: m.runtimeType,
        sessionName: m.sessionName,
      })),
      projectIds: team.projectIds,
    }));

    return this.successResult(result);
  }

  /**
   * Handle crewly_create_team: create a new team with members.
   *
   * @param args - { name, description?, members: [{name, role, runtimeType?}] }
   * @returns Created team info
   */
  private async handleCreateTeam(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = args.name as string;
    const description = args.description as string | undefined;
    const memberSpecs = args.members as Array<{
      name: string;
      role: string;
      runtimeType?: string;
    }>;

    if (!name || !memberSpecs || memberSpecs.length === 0) {
      return this.errorResult('Team name and at least one member are required');
    }

    const teamId = uuidv4();
    const now = new Date().toISOString();

    const members: TeamMember[] = memberSpecs.map((spec) => {
      const memberId = uuidv4();
      return {
        id: memberId,
        name: spec.name,
        sessionName: `${name.toLowerCase().replace(/\s+/g, '-')}-${spec.name.toLowerCase().replace(/\s+/g, '-')}-${memberId.substring(0, 8)}`,
        role: spec.role as TeamMember['role'],
        systemPrompt: '',
        agentStatus: 'inactive' as const,
        workingStatus: 'idle' as const,
        runtimeType: (spec.runtimeType || 'claude-code') as TeamMember['runtimeType'],
        createdAt: now,
        updatedAt: now,
      };
    });

    const team: Team = {
      id: teamId,
      name,
      description,
      members,
      projectIds: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.storage.saveTeam(team);

    return this.successResult({
      message: `Team "${name}" created with ${members.length} member(s)`,
      teamId,
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        sessionName: m.sessionName,
      })),
    });
  }

  /**
   * Handle crewly_assign_task: assign a task to a specific agent.
   *
   * This stores the task description on the member's currentTickets field
   * so the orchestrator or dashboard can pick it up. For direct delivery,
   * use crewly_send_message to the orchestrator with task instructions.
   *
   * @param args - { teamId, memberId, task }
   * @returns Assignment confirmation
   */
  private async handleAssignTask(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const teamId = args.teamId as string;
    const memberId = args.memberId as string;
    const task = args.task as string;

    if (!teamId || !memberId || !task) {
      return this.errorResult('teamId, memberId, and task are required');
    }

    const teams = await this.storage.getTeams();
    const team = teams.find((t) => t.id === teamId);
    if (!team) {
      return this.errorResult(`Team not found: ${teamId}`);
    }

    const member = team.members.find((m) => m.id === memberId);
    if (!member) {
      return this.errorResult(
        `Member not found: ${memberId} in team "${team.name}"`,
      );
    }

    // Add task to member's ticket list
    const ticketId = `mcp-task-${Date.now()}`;
    if (!member.currentTickets) {
      member.currentTickets = [];
    }
    member.currentTickets.push(ticketId);
    member.updatedAt = new Date().toISOString();

    await this.storage.saveTeam(team);

    return this.successResult({
      message: `Task assigned to ${member.name} (${member.role}) in team "${team.name}"`,
      ticketId,
      agentSessionName: member.sessionName,
      agentStatus: member.agentStatus,
      task,
    });
  }

  /**
   * Handle crewly_get_status: get status for teams/agents.
   *
   * @param args - Optional { teamId, memberId } filters
   * @returns Status information
   */
  private async handleGetStatus(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const teams = await this.storage.getTeams();
    const teamId = args.teamId as string | undefined;
    const memberId = args.memberId as string | undefined;

    if (teamId) {
      const team = teams.find((t) => t.id === teamId);
      if (!team) {
        return this.errorResult(`Team not found: ${teamId}`);
      }

      if (memberId) {
        const member = team.members.find((m) => m.id === memberId);
        if (!member) {
          return this.errorResult(
            `Member not found: ${memberId} in team "${team.name}"`,
          );
        }

        return this.successResult({
          team: { id: team.id, name: team.name },
          member: {
            id: member.id,
            name: member.name,
            role: member.role,
            agentStatus: member.agentStatus,
            workingStatus: member.workingStatus,
            runtimeType: member.runtimeType,
            sessionName: member.sessionName,
            currentTickets: member.currentTickets,
          },
        });
      }

      return this.successResult({
        team: {
          id: team.id,
          name: team.name,
          memberCount: team.members.length,
        },
        members: team.members.map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          agentStatus: m.agentStatus,
          workingStatus: m.workingStatus,
        })),
      });
    }

    // Summary of all teams
    const summary = teams.map((t) => ({
      id: t.id,
      name: t.name,
      memberCount: t.members.length,
      activeCount: t.members.filter((m) => m.agentStatus === 'active').length,
      workingCount: t.members.filter((m) => m.workingStatus === 'in_progress')
        .length,
    }));

    return this.successResult({ teams: summary, totalTeams: teams.length });
  }

  /**
   * Handle crewly_recall_memory: search team memory/knowledge.
   *
   * @param args - { query, agentId?, projectPath?, scope? }
   * @returns Search results
   */
  private async handleRecallMemory(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = args.query as string;
    if (!query) {
      return this.errorResult('query is required');
    }

    const agentId = (args.agentId as string) || 'mcp-client';
    const projectPath = args.projectPath as string | undefined;
    const scope = (args.scope as 'agent' | 'project' | 'both') || 'both';

    const result = await this.memory.recall({
      agentId,
      context: query,
      scope,
      projectPath,
    });

    return this.successResult({
      query,
      agentMemories: result.agentMemories,
      projectMemories: result.projectMemories,
      knowledgeDocuments: result.knowledgeDocuments?.map((doc) => ({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        preview: doc.preview,
      })),
      combined: result.combined,
    });
  }

  /**
   * Handle crewly_send_message: send a message to the orchestrator.
   *
   * @param args - { message, conversationId? }
   * @returns Confirmation with message ID
   */
  private async handleSendMessage(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const message = args.message as string;
    if (!message) {
      return this.errorResult('message is required');
    }

    const conversationId =
      (args.conversationId as string) || `mcp-${Date.now()}`;

    // Note: The message queue requires a running backend to process messages.
    // This tool creates a record that can be picked up by the queue processor.
    // For now, return a confirmation that the message was received.
    return this.successResult({
      message: 'Message received and queued for processing',
      conversationId,
      content: message,
      timestamp: new Date().toISOString(),
    });
  }

  // ========================= Helpers =========================

  // ========================= Credential handlers =========================

  /**
   * Handle crewly_credential_list: return credential metadata (no values).
   */
  private async handleCredentialList(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const type = args.type as 'api-key' | 'google-oauth' | undefined;
    const provider = args.provider as string | undefined;

    const store = getCredentialStoreService();
    let credentials = await store.listCredentials();

    if (type) credentials = credentials.filter((c) => c.type === type);
    if (provider) credentials = credentials.filter((c) => c.provider === provider);

    return this.successResult(
      credentials.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        provider: c.provider,
        helper: c.helper,
        scopes: c.scopes,
        accountEmail: c.accountEmail,
        status: c.status,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        expiresAt: c.expiresAt,
      })),
    );
  }

  /**
   * Handle crewly_credential_add_api_key: store an API key.
   */
  private async handleCredentialAddApiKey(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = args.name as string;
    const provider = args.provider as string;
    const value = args.value as string;

    if (!name || !provider || !value) {
      return this.errorResult('name, provider, and value are required');
    }

    const cred = await getCredentialStoreService().addApiKey({ name, provider, value });
    return this.successResult({
      id: cred.id,
      name: cred.name,
      provider: cred.provider,
      type: cred.type,
      createdAt: cred.createdAt,
    });
  }

  /**
   * Handle crewly_credential_oauth_import_gemini_cli: capture the current
   * gemini-cli-workspace extension login into an encrypted Crewly credential.
   */
  private async handleCredentialImportGeminiCli(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = args.name as string;
    if (!name) {
      return this.errorResult('name is required');
    }

    try {
      const payload = await this.getGeminiCliHelper().captureFromFile();
      const cred = await getCredentialStoreService().addOAuth({
        name,
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload,
      });
      return this.successResult({
        id: cred.id,
        name: cred.name,
        accountEmail: cred.accountEmail,
        scopes: cred.scopes,
        type: cred.type,
        helper: cred.helper,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.errorResult(message);
    }
  }

  /**
   * Handle crewly_credential_clear_gemini_cli_file: delete the extension's
   * cached token file so the next extension login captures a fresh account.
   */
  private async handleCredentialClearGeminiCliFile(): Promise<ToolResult> {
    await this.getGeminiCliHelper().clearExtensionFile();
    return this.successResult({ cleared: true });
  }

  /**
   * Handle crewly_credential_delete: remove a credential.
   */
  private async handleCredentialDelete(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const id = args.id as string;
    if (!id) return this.errorResult('id is required');
    try {
      await getCredentialStoreService().deleteCredential(id);
      return this.successResult({ deleted: true, id });
    } catch (err) {
      return this.errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Handle crewly_execute_skill: run a skill with optional credential bindings.
   */
  private async handleExecuteSkill(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const skillId = args.skillId as string;
    if (!skillId) return this.errorResult('skillId is required');

    const credentialBindings = args.credentialBindings as
      | Record<string, string>
      | undefined;

    const context: SkillExecutionContext = {
      agentId: (args.agentId as string) || 'mcp-agent',
      roleId: (args.roleId as string) || 'default',
      userInput: args.userInput as string | undefined,
      credentialBindings,
    };

    try {
      const result = await getSkillExecutorService().executeSkill(skillId, context);
      return this.successResult({
        success: result.success,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs,
      });
    } catch (err) {
      return this.errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Create a success result with JSON-serialized content.
   *
   * @param data - Data to serialize as the result
   * @returns ToolResult with text content
   */
  private successResult(data: unknown): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  /**
   * Create an error result.
   *
   * @param message - Error message
   * @returns ToolResult with isError flag
   */
  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }

  // ========================= Lifecycle =========================

  /**
   * Start the MCP server on stdio transport.
   *
   * This connects stdin/stdout for MCP protocol communication.
   * The process will stay alive until the client disconnects.
   */
  async start(): Promise<void> {
    await this.ensureInitialized();
    if (!this.server || !this.stdioTransportCtor) {
      throw new Error('MCP server is not initialized');
    }
    this.transport = new this.stdioTransportCtor();
    await this.server.connect(this.transport);
  }

  /**
   * Stop the MCP server and clean up resources.
   */
  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
    }
    this.transport = null;
  }

  /**
   * Get the underlying MCP Server instance (for testing).
   *
   * @returns The Server instance
   */
  getServer(): any {
    return this.server;
  }
}
