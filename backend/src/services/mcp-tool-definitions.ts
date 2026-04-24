/**
 * MCP Tool Definitions
 *
 * JSON Schema definitions for every tool exposed by the Crewly MCP server.
 * Extracted from `mcp-server.ts` so that the server module can stay focused
 * on routing + lifecycle, while tool contracts live on their own.
 *
 * Each entry describes the tool's public shape: `name`, `description`, and
 * `inputSchema`. The server advertises these verbatim in response to the
 * MCP `tools/list` request and uses the `name` to dispatch `tools/call`.
 *
 * @module services/mcp-tool-definitions
 */

/**
 * MCP tool definitions for Crewly capabilities.
 * Each tool has a name, description, and JSON Schema for its input.
 */
export const TOOL_DEFINITIONS = [
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
