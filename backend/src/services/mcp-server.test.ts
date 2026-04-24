/**
 * Tests for the Crewly MCP Server Service.
 *
 * Validates tool registration, tool call routing, and each tool handler's
 * behavior including success paths, error handling, and edge cases.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  CrewlyMcpServer,
  MCP_SERVER_CONSTANTS,
} from './mcp-server.js';
import type { Team, TeamMember } from '../types/index.js';
import {
  CredentialStoreService,
  resetCredentialStoreService,
  _setCredentialStoreForTesting,
} from './credential/credential-store.service.js';
import { _resetDerivedKeyCache } from '../utils/encryption.utils.js';
import type { GoogleOAuthPayload } from '../types/credential.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockServerConnect = jest.fn().mockResolvedValue(undefined);
const mockServerClose = jest.fn().mockResolvedValue(undefined);
const mockSetRequestHandler = jest.fn();

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    connect: mockServerConnect,
    close: mockServerClose,
    setRequestHandler: mockSetRequestHandler,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock types schemas (imported by the service)
jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: { method: 'tools/list' },
  CallToolRequestSchema: { method: 'tools/call' },
}));

const mockGetTeams = jest.fn();
const mockSaveTeam = jest.fn();

jest.mock('./core/storage.service.js', () => ({
  StorageService: {
    getInstance: jest.fn(() => ({
      getTeams: mockGetTeams,
      saveTeam: mockSaveTeam,
    })),
  },
}));

const mockRecall = jest.fn();

jest.mock('./memory/memory.service.js', () => ({
  MemoryService: {
    getInstance: jest.fn(() => ({
      recall: mockRecall,
    })),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-1234'),
}));

// -----------------------------------------------------------------------------
//  Credential store + skill executor — used by the new tools.
// -----------------------------------------------------------------------------

// Real credential store backed by a scratch dir; injected per-test. Uses the
// _setCredentialStoreForTesting hook so we avoid stubbing.

const mockExecuteSkill = jest.fn();
jest.mock('./skill/skill-executor.service.js', () => ({
  getSkillExecutorService: jest.fn(() => ({
    executeSkill: mockExecuteSkill,
  })),
}));

const mockClearExtensionFile = jest.fn();
const mockCaptureFromFile = jest.fn();
jest.mock('./credential/helpers/gemini-cli-workspace.helper.js', () => ({
  GeminiCliWorkspaceHelper: jest.fn().mockImplementation(() => ({
    clearExtensionFile: mockClearExtensionFile,
    captureFromFile: mockCaptureFromFile,
  })),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a test team fixture.
 */
function createTestTeam(overrides?: Partial<Team>): Team {
  const now = new Date().toISOString();
  return {
    id: 'team-1',
    name: 'Test Team',
    description: 'A test team',
    members: [
      createTestMember({ id: 'member-1', name: 'Alice', role: 'developer' }),
      createTestMember({ id: 'member-2', name: 'Bob', role: 'qa' }),
    ],
    projectIds: ['proj-1'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Creates a test team member fixture.
 */
function createTestMember(overrides?: Partial<TeamMember>): TeamMember {
  const now = new Date().toISOString();
  return {
    id: 'member-1',
    name: 'Alice',
    sessionName: 'test-team-alice-12345678',
    role: 'developer',
    systemPrompt: '',
    agentStatus: 'active',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Extract registered handlers from the mock.
 * Returns a map of method string -> handler function.
 * Uses the schema's `method` property for lookup since Map uses reference equality.
 */
function getRegisteredHandlers(): Map<string, Function> {
  const handlers = new Map<string, Function>();
  for (const call of mockSetRequestHandler.mock.calls) {
    const schema = call[0] as { method: string };
    handlers.set(schema.method, call[1]);
  }
  return handlers;
}

/**
 * Invoke the CallTool handler with the given tool name and arguments.
 */
async function callTool(
  handlers: Map<string, Function>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = handlers.get('tools/call');
  if (!handler) {
    throw new Error('CallTool handler not registered');
  }
  return handler({ params: { name, arguments: args } });
}

/**
 * Parse the JSON text content from a tool result.
 */
function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrewlyMcpServer', () => {
  let mcpServer: CrewlyMcpServer;
  let handlers: Map<string, Function>;
  let credDir: string;
  let credStore: CredentialStoreService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetTeams.mockResolvedValue([]);
    mockSaveTeam.mockResolvedValue(undefined);
    mockRecall.mockResolvedValue({
      agentMemories: [],
      projectMemories: [],
      combined: '',
      knowledgeDocuments: [],
    });

    _resetDerivedKeyCache();
    resetCredentialStoreService();
    credDir = path.join(
      os.tmpdir(),
      `mcp-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(credDir, { recursive: true });
    credStore = new CredentialStoreService({ dir: credDir });
    await credStore.init();
    _setCredentialStoreForTesting(credStore);

    mcpServer = new CrewlyMcpServer();
    await mcpServer.start();
    handlers = getRegisteredHandlers();
  });

  afterEach(async () => {
    resetCredentialStoreService();
    _resetDerivedKeyCache();
    await fs.rm(credDir, { recursive: true, force: true });
  });

  // ========================= Initialization =========================

  describe('initialization', () => {
    it('should create server with correct info', () => {
      expect(MCP_SERVER_CONSTANTS.SERVER_INFO.NAME).toBe('crewly-mcp-server');
      expect(MCP_SERVER_CONSTANTS.SERVER_INFO.VERSION).toBe('1.0.0');
    });

    it('should register two request handlers', () => {
      // tools/list and tools/call
      expect(mockSetRequestHandler).toHaveBeenCalledTimes(2);
    });

    it('should expose getServer()', () => {
      const server = mcpServer.getServer();
      expect(server).toBeDefined();
    });
  });

  // ========================= Lifecycle =========================

  describe('lifecycle', () => {
    it('should start on stdio transport', async () => {
      await mcpServer.start();
      expect(mockServerConnect).toHaveBeenCalled();
    });

    it('should stop cleanly', async () => {
      await mcpServer.start();
      await mcpServer.stop();
      expect(mockServerClose).toHaveBeenCalled();
    });
  });

  // ========================= tools/list =========================

  describe('tools/list', () => {
    it('should return all 12 tools (6 original + 6 credential/skill tools)', async () => {
      const handler = handlers.get('tools/list');
      expect(handler).toBeDefined();

      const result = await handler!({});
      expect(result.tools).toHaveLength(12);
    });

    it('should include expected tool names', async () => {
      const handler = handlers.get('tools/list');
      const result = await handler!({});

      const toolNames = result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('crewly_get_teams');
      expect(toolNames).toContain('crewly_create_team');
      expect(toolNames).toContain('crewly_assign_task');
      expect(toolNames).toContain('crewly_get_status');
      expect(toolNames).toContain('crewly_recall_memory');
      expect(toolNames).toContain('crewly_send_message');
      // Credential tools
      expect(toolNames).toContain('crewly_credential_list');
      expect(toolNames).toContain('crewly_credential_add_api_key');
      expect(toolNames).toContain('crewly_credential_oauth_import_gemini_cli');
      expect(toolNames).toContain('crewly_credential_clear_gemini_cli_file');
      expect(toolNames).toContain('crewly_credential_delete');
      // Skill execution tool
      expect(toolNames).toContain('crewly_execute_skill');
    });

    it('should include descriptions and input schemas for all tools', async () => {
      const handler = handlers.get('tools/list');
      const result = await handler!({});

      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  // ========================= crewly_get_teams =========================

  describe('crewly_get_teams', () => {
    it('should return empty array when no teams exist', async () => {
      const result = await callTool(handlers, 'crewly_get_teams');
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
      expect(result.isError).toBeUndefined();
    });

    it('should return all teams with member details', async () => {
      const team = createTestTeam();
      mockGetTeams.mockResolvedValue([team]);

      const result = await callTool(handlers, 'crewly_get_teams');
      const data = parseResult(result) as Array<{ id: string; members: unknown[] }>;

      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('team-1');
      expect(data[0].members).toHaveLength(2);
    });

    it('should filter by teamId', async () => {
      const team1 = createTestTeam({ id: 'team-1', name: 'Team 1' });
      const team2 = createTestTeam({ id: 'team-2', name: 'Team 2' });
      mockGetTeams.mockResolvedValue([team1, team2]);

      const result = await callTool(handlers, 'crewly_get_teams', { teamId: 'team-2' });
      const data = parseResult(result) as Array<{ id: string }>;

      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('team-2');
    });

    it('should return error for non-existent teamId', async () => {
      mockGetTeams.mockResolvedValue([]);

      const result = await callTool(handlers, 'crewly_get_teams', { teamId: 'nonexistent' });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as { error: string };
      expect(data.error).toContain('Team not found');
    });
  });

  // ========================= crewly_create_team =========================

  describe('crewly_create_team', () => {
    it('should create a team with members', async () => {
      const result = await callTool(handlers, 'crewly_create_team', {
        name: 'Dev Team',
        members: [
          { name: 'Alice', role: 'developer' },
          { name: 'Bob', role: 'qa' },
        ],
      });

      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { teamId: string; members: unknown[] };
      expect(data.teamId).toBe('test-uuid-1234');
      expect(data.members).toHaveLength(2);
      expect(mockSaveTeam).toHaveBeenCalledTimes(1);
    });

    it('should default runtimeType to claude-code', async () => {
      await callTool(handlers, 'crewly_create_team', {
        name: 'Test Team',
        members: [{ name: 'Charlie', role: 'developer' }],
      });

      const savedTeam = mockSaveTeam.mock.calls[0][0] as Team;
      expect(savedTeam.members[0].runtimeType).toBe('claude-code');
    });

    it('should accept custom runtimeType', async () => {
      await callTool(handlers, 'crewly_create_team', {
        name: 'Test Team',
        members: [{ name: 'Charlie', role: 'developer', runtimeType: 'gemini-cli' }],
      });

      const savedTeam = mockSaveTeam.mock.calls[0][0] as Team;
      expect(savedTeam.members[0].runtimeType).toBe('gemini-cli');
    });

    it('should return error when name is missing', async () => {
      const result = await callTool(handlers, 'crewly_create_team', {
        members: [{ name: 'Alice', role: 'developer' }],
      });
      expect(result.isError).toBe(true);
    });

    it('should return error when members is empty', async () => {
      const result = await callTool(handlers, 'crewly_create_team', {
        name: 'Empty Team',
        members: [],
      });
      expect(result.isError).toBe(true);
    });

    it('should include description when provided', async () => {
      await callTool(handlers, 'crewly_create_team', {
        name: 'Described Team',
        description: 'A team with a description',
        members: [{ name: 'Dan', role: 'developer' }],
      });

      const savedTeam = mockSaveTeam.mock.calls[0][0] as Team;
      expect(savedTeam.description).toBe('A team with a description');
    });
  });

  // ========================= crewly_assign_task =========================

  describe('crewly_assign_task', () => {
    it('should assign a task to a member', async () => {
      const team = createTestTeam();
      mockGetTeams.mockResolvedValue([team]);

      const result = await callTool(handlers, 'crewly_assign_task', {
        teamId: 'team-1',
        memberId: 'member-1',
        task: 'Build the login page',
      });

      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { ticketId: string; task: string };
      expect(data.ticketId).toMatch(/^mcp-task-/);
      expect(data.task).toBe('Build the login page');
      expect(mockSaveTeam).toHaveBeenCalled();
    });

    it('should return error for non-existent team', async () => {
      mockGetTeams.mockResolvedValue([]);

      const result = await callTool(handlers, 'crewly_assign_task', {
        teamId: 'bad-team',
        memberId: 'member-1',
        task: 'Something',
      });
      expect(result.isError).toBe(true);
    });

    it('should return error for non-existent member', async () => {
      const team = createTestTeam();
      mockGetTeams.mockResolvedValue([team]);

      const result = await callTool(handlers, 'crewly_assign_task', {
        teamId: 'team-1',
        memberId: 'nonexistent',
        task: 'Something',
      });
      expect(result.isError).toBe(true);
    });

    it('should return error when required params are missing', async () => {
      const result = await callTool(handlers, 'crewly_assign_task', {
        teamId: 'team-1',
      });
      expect(result.isError).toBe(true);
    });
  });

  // ========================= crewly_get_status =========================

  describe('crewly_get_status', () => {
    it('should return summary for all teams', async () => {
      const team1 = createTestTeam({ id: 'team-1', name: 'Team 1' });
      const team2 = createTestTeam({ id: 'team-2', name: 'Team 2' });
      mockGetTeams.mockResolvedValue([team1, team2]);

      const result = await callTool(handlers, 'crewly_get_status');
      const data = parseResult(result) as { teams: unknown[]; totalTeams: number };

      expect(data.totalTeams).toBe(2);
      expect(data.teams).toHaveLength(2);
    });

    it('should return team details when teamId is provided', async () => {
      const team = createTestTeam();
      mockGetTeams.mockResolvedValue([team]);

      const result = await callTool(handlers, 'crewly_get_status', { teamId: 'team-1' });
      const data = parseResult(result) as { team: { name: string }; members: unknown[] };

      expect(data.team.name).toBe('Test Team');
      expect(data.members).toHaveLength(2);
    });

    it('should return member details when teamId and memberId are provided', async () => {
      const team = createTestTeam();
      mockGetTeams.mockResolvedValue([team]);

      const result = await callTool(handlers, 'crewly_get_status', {
        teamId: 'team-1',
        memberId: 'member-1',
      });
      const data = parseResult(result) as { member: { name: string; role: string } };

      expect(data.member.name).toBe('Alice');
      expect(data.member.role).toBe('developer');
    });

    it('should return error for non-existent team', async () => {
      mockGetTeams.mockResolvedValue([]);

      const result = await callTool(handlers, 'crewly_get_status', { teamId: 'bad' });
      expect(result.isError).toBe(true);
    });

    it('should return error for non-existent member', async () => {
      const team = createTestTeam();
      mockGetTeams.mockResolvedValue([team]);

      const result = await callTool(handlers, 'crewly_get_status', {
        teamId: 'team-1',
        memberId: 'bad-member',
      });
      expect(result.isError).toBe(true);
    });
  });

  // ========================= crewly_recall_memory =========================

  describe('crewly_recall_memory', () => {
    it('should search memory with query', async () => {
      mockRecall.mockResolvedValue({
        agentMemories: ['Found memory 1'],
        projectMemories: ['Found memory 2'],
        combined: 'Combined results',
        knowledgeDocuments: [
          {
            id: 'doc-1',
            title: 'Deployment Guide',
            category: 'SOP',
            preview: 'How to deploy...',
          },
        ],
      });

      const result = await callTool(handlers, 'crewly_recall_memory', {
        query: 'deployment process',
      });

      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as {
        agentMemories: string[];
        projectMemories: string[];
        knowledgeDocuments: Array<{ title: string }>;
      };
      expect(data.agentMemories).toHaveLength(1);
      expect(data.projectMemories).toHaveLength(1);
      expect(data.knowledgeDocuments).toHaveLength(1);
    });

    it('should use default scope "both" and agentId "mcp-client"', async () => {
      await callTool(handlers, 'crewly_recall_memory', {
        query: 'test',
      });

      expect(mockRecall).toHaveBeenCalledWith({
        agentId: 'mcp-client',
        context: 'test',
        scope: 'both',
        projectPath: undefined,
      });
    });

    it('should pass custom scope and agentId', async () => {
      await callTool(handlers, 'crewly_recall_memory', {
        query: 'patterns',
        agentId: 'dev-001',
        scope: 'project',
        projectPath: '/my/project',
      });

      expect(mockRecall).toHaveBeenCalledWith({
        agentId: 'dev-001',
        context: 'patterns',
        scope: 'project',
        projectPath: '/my/project',
      });
    });

    it('should return error when query is missing', async () => {
      const result = await callTool(handlers, 'crewly_recall_memory', {});
      expect(result.isError).toBe(true);
    });
  });

  // ========================= crewly_send_message =========================

  describe('crewly_send_message', () => {
    it('should accept a message and return confirmation', async () => {
      const result = await callTool(handlers, 'crewly_send_message', {
        message: 'Hello orchestrator',
      });

      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { content: string; conversationId: string };
      expect(data.content).toBe('Hello orchestrator');
      expect(data.conversationId).toMatch(/^mcp-/);
    });

    it('should use provided conversationId', async () => {
      const result = await callTool(handlers, 'crewly_send_message', {
        message: 'Follow-up',
        conversationId: 'conv-123',
      });

      const data = parseResult(result) as { conversationId: string };
      expect(data.conversationId).toBe('conv-123');
    });

    it('should return error when message is missing', async () => {
      const result = await callTool(handlers, 'crewly_send_message', {});
      expect(result.isError).toBe(true);
    });
  });

  // ========================= Error handling =========================

  describe('error handling', () => {
    it('should return error for unknown tool name', async () => {
      const result = await callTool(handlers, 'unknown_tool');
      expect(result.isError).toBe(true);
      const data = parseResult(result) as { error: string };
      expect(data.error).toContain('Unknown tool');
    });

    it('should catch and return errors thrown by storage', async () => {
      mockGetTeams.mockRejectedValue(new Error('Storage unavailable'));

      const result = await callTool(handlers, 'crewly_get_teams');
      expect(result.isError).toBe(true);
      const data = parseResult(result) as { error: string };
      expect(data.error).toContain('Storage unavailable');
    });

    it('should catch and return errors thrown by memory service', async () => {
      mockRecall.mockRejectedValue(new Error('Memory service down'));

      const result = await callTool(handlers, 'crewly_recall_memory', {
        query: 'test',
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as { error: string };
      expect(data.error).toContain('Memory service down');
    });
  });

  // ========================= crewly_credential_list =========================

  describe('crewly_credential_list', () => {
    it('returns empty list when no credentials exist', async () => {
      const result = await callTool(handlers, 'crewly_credential_list');
      expect(result.isError).toBeUndefined();
      expect(parseResult(result)).toEqual([]);
    });

    it('returns credentials without exposing token values', async () => {
      await credStore.addApiKey({
        name: 'gemini-main',
        provider: 'gemini',
        value: 'k-shh-secret',
      });

      const result = await callTool(handlers, 'crewly_credential_list');
      const data = parseResult(result) as Array<{ id: string; name: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('gemini-main');
      // Value never leaks
      expect(JSON.stringify(result)).not.toContain('k-shh-secret');
    });

    it('filters by type', async () => {
      await credStore.addApiKey({ name: 'k1', provider: 'gemini', value: 'v' });
      await credStore.addOAuth({
        name: 'o1',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: {
          type: 'google-oauth',
          accessToken: 'AT', refreshToken: 'RT', tokenType: 'Bearer',
          expiresAt: Date.now() + 3600_000, scopes: ['s'], clientId: 'c',
        } as GoogleOAuthPayload,
      });

      const apiOnly = await callTool(handlers, 'crewly_credential_list', {
        type: 'api-key',
      });
      expect(parseResult(apiOnly)).toHaveLength(1);

      const oauthOnly = await callTool(handlers, 'crewly_credential_list', {
        type: 'google-oauth',
      });
      expect(parseResult(oauthOnly)).toHaveLength(1);
    });

    it('filters by provider', async () => {
      await credStore.addApiKey({ name: 'g', provider: 'gemini', value: 'v' });
      await credStore.addApiKey({ name: 'o', provider: 'openai', value: 'v' });

      const only = await callTool(handlers, 'crewly_credential_list', {
        provider: 'openai',
      });
      const data = parseResult(only) as Array<{ name: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('o');
    });
  });

  // ========================= crewly_credential_add_api_key =========================

  describe('crewly_credential_add_api_key', () => {
    it('rejects missing fields', async () => {
      const result = await callTool(handlers, 'crewly_credential_add_api_key', {
        name: 'x',
      });
      expect(result.isError).toBe(true);
    });

    it('adds a credential and returns metadata without the raw value', async () => {
      const result = await callTool(handlers, 'crewly_credential_add_api_key', {
        name: 'gemini-main',
        provider: 'gemini',
        value: 'k-secret',
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { id: string; type: string; name: string };
      expect(data.type).toBe('api-key');
      expect(data.name).toBe('gemini-main');
      expect(JSON.stringify(result)).not.toContain('k-secret');
    });
  });

  // ========================= crewly_credential_delete =========================

  describe('crewly_credential_delete', () => {
    it('rejects missing id', async () => {
      const result = await callTool(handlers, 'crewly_credential_delete', {});
      expect(result.isError).toBe(true);
    });

    it('deletes an existing credential', async () => {
      const added = await credStore.addApiKey({
        name: 'del', provider: 'p', value: 'v',
      });

      const result = await callTool(handlers, 'crewly_credential_delete', {
        id: added.id,
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { deleted: boolean; id: string };
      expect(data.deleted).toBe(true);
      expect(data.id).toBe(added.id);
      expect(await credStore.listCredentials()).toHaveLength(0);
    });

    it('surfaces CredentialNotFoundError as tool error', async () => {
      const result = await callTool(handlers, 'crewly_credential_delete', {
        id: 'cred-nope',
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as { error: string };
      expect(data.error).toMatch(/not found/i);
    });
  });

  // ========================= crewly_credential_oauth_import_gemini_cli =========================

  describe('crewly_credential_oauth_import_gemini_cli', () => {
    it('rejects missing name', async () => {
      const result = await callTool(
        handlers,
        'crewly_credential_oauth_import_gemini_cli',
        {},
      );
      expect(result.isError).toBe(true);
    });

    it('captures from the helper and stores the credential', async () => {
      mockCaptureFromFile.mockResolvedValueOnce({
        type: 'google-oauth',
        accessToken: 'AT-imp',
        refreshToken: 'RT-imp',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        accountEmail: 'info@example.com',
        clientId: 'cid',
      } as GoogleOAuthPayload);

      const result = await callTool(
        handlers,
        'crewly_credential_oauth_import_gemini_cli',
        { name: 'info-personal' },
      );
      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as {
        id: string; name: string; accountEmail?: string; type: string;
      };
      expect(data.name).toBe('info-personal');
      expect(data.accountEmail).toBe('info@example.com');
      expect(data.type).toBe('google-oauth');

      // Raw tokens never in response
      expect(JSON.stringify(result)).not.toContain('AT-imp');
      expect(JSON.stringify(result)).not.toContain('RT-imp');

      const creds = await credStore.listCredentials();
      expect(creds).toHaveLength(1);
      expect(creds[0].accountEmail).toBe('info@example.com');
    });

    it('surfaces helper capture errors as tool errors', async () => {
      mockCaptureFromFile.mockRejectedValueOnce(
        new Error('Gemini CLI Workspace token file not found'),
      );
      const result = await callTool(
        handlers,
        'crewly_credential_oauth_import_gemini_cli',
        { name: 'x' },
      );
      expect(result.isError).toBe(true);
      const data = parseResult(result) as { error: string };
      expect(data.error).toMatch(/token file not found/);
    });
  });

  // ========================= crewly_credential_clear_gemini_cli_file =========================

  describe('crewly_credential_clear_gemini_cli_file', () => {
    it('delegates to the helper and returns cleared: true', async () => {
      mockClearExtensionFile.mockResolvedValueOnce(undefined);
      const result = await callTool(
        handlers,
        'crewly_credential_clear_gemini_cli_file',
      );
      expect(result.isError).toBeUndefined();
      expect(parseResult(result)).toEqual({ cleared: true });
      expect(mockClearExtensionFile).toHaveBeenCalledTimes(1);
    });
  });

  // ========================= crewly_execute_skill =========================

  describe('crewly_execute_skill', () => {
    it('rejects missing skillId', async () => {
      const result = await callTool(handlers, 'crewly_execute_skill', {});
      expect(result.isError).toBe(true);
    });

    it('forwards skillId + context + credentialBindings to the executor', async () => {
      mockExecuteSkill.mockResolvedValueOnce({
        success: true,
        output: 'done',
        durationMs: 7,
      });

      const result = await callTool(handlers, 'crewly_execute_skill', {
        skillId: 'skill-x',
        agentId: 'orc',
        roleId: 'orchestrator',
        userInput: 'run',
        credentialBindings: { gmail: 'cred-abc' },
      });
      expect(result.isError).toBeUndefined();

      expect(mockExecuteSkill).toHaveBeenCalledTimes(1);
      const [skillId, ctx] = mockExecuteSkill.mock.calls[0];
      expect(skillId).toBe('skill-x');
      expect(ctx).toEqual({
        agentId: 'orc',
        roleId: 'orchestrator',
        userInput: 'run',
        credentialBindings: { gmail: 'cred-abc' },
      });
    });

    it('defaults agentId and roleId when not supplied', async () => {
      mockExecuteSkill.mockResolvedValueOnce({
        success: true, output: '', durationMs: 0,
      });
      await callTool(handlers, 'crewly_execute_skill', { skillId: 'x' });
      const [, ctx] = mockExecuteSkill.mock.calls[0];
      expect(ctx.agentId).toBe('mcp-agent');
      expect(ctx.roleId).toBe('default');
    });

    it('returns executor exceptions as tool errors', async () => {
      mockExecuteSkill.mockRejectedValueOnce(new Error('skill blew up'));
      const result = await callTool(handlers, 'crewly_execute_skill', {
        skillId: 'bad',
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as { error: string };
      expect(data.error).toMatch(/skill blew up/);
    });
  });
});
