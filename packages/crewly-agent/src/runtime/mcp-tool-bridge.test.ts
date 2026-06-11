/**
 * Tests for MCP Tool Bridge
 *
 * Validates MCP tool conversion, naming, sensitivity classification,
 * tool loading, and end-to-end execution via a mock MCP server.
 */

import { describe, it, expect, vi, type Mocked, type MockInstance } from 'vitest';
import {
  MCP_TOOL_PREFIX,
  MCP_DEFAULT_SENSITIVITY,
  jsonSchemaToZodPassthrough,
  buildMcpToolName,
  resolveSensitivity,
  convertMcpTool,
  loadMcpTools,
  connectAndLoadMcpTools,
} from './mcp-tool-bridge.js';
import type { McpClientService, McpToolInfo, McpServerConfig } from '../../mcp-client.js';
import type { ToolSensitivity } from './types.js';

// ---------------------------------------------------------------------------
// Mock MCP Client
// ---------------------------------------------------------------------------

/**
 * Create a mock McpClientService with configurable tool lists.
 */
function createMockMcpClient(tools: McpToolInfo[] = []): McpClientService {
  return {
    connectServer: vi.fn<any>().mockResolvedValue(undefined),
    disconnectServer: vi.fn<any>().mockResolvedValue(undefined),
    disconnectAll: vi.fn<any>().mockResolvedValue(undefined),
    listTools: vi.fn<any>().mockReturnValue(tools),
    callTool: vi.fn<any>().mockResolvedValue({
      content: [{ type: 'text', text: 'mock result' }],
      isError: false,
    }),
    refreshTools: vi.fn<any>().mockResolvedValue(undefined),
    getConnectedServers: vi.fn<any>().mockReturnValue(
      [...new Set(tools.map(t => t.serverName))],
    ),
    isServerConnected: vi.fn<any>().mockReturnValue(true),
    getServerStatuses: vi.fn<any>().mockReturnValue([]),
    connectAll: vi.fn<any>().mockResolvedValue(new Map()),
  } as unknown as McpClientService;
}

/** Sample MCP tool info for a filesystem read tool */
const SAMPLE_TOOL: McpToolInfo = {
  name: 'read_file',
  description: 'Read the contents of a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
    },
    required: ['path'],
  },
  serverName: 'filesystem',
};

/** Sample MCP tool info without description */
const TOOL_NO_DESC: McpToolInfo = {
  name: 'list_dir',
  inputSchema: { type: 'object', properties: {} },
  serverName: 'filesystem',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Tool Bridge', () => {
  describe('Constants', () => {
    it('should have correct prefix', () => {
      expect(MCP_TOOL_PREFIX).toBe('mcp_');
    });

    it('should default to sensitive classification', () => {
      expect(MCP_DEFAULT_SENSITIVITY).toBe('sensitive');
    });
  });

  describe('buildMcpToolName', () => {
    it('should namespace tool names with server prefix', () => {
      expect(buildMcpToolName('filesystem', 'read_file')).toBe('mcp_filesystem_read_file');
    });

    it('should handle different server names', () => {
      expect(buildMcpToolName('github', 'create_issue')).toBe('mcp_github_create_issue');
    });
  });

  describe('jsonSchemaToZodPassthrough', () => {
    it('should create a schema from JSON Schema with properties', () => {
      const schema = jsonSchemaToZodPassthrough({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          encoding: { type: 'string' },
        },
      });
      // Should parse without errors
      const result = schema.safeParse({ path: '/tmp/test.txt', encoding: 'utf-8' });
      expect(result.success).toBe(true);
    });

    it('should accept extra properties via passthrough', () => {
      const schema = jsonSchemaToZodPassthrough({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
      });
      const result = schema.safeParse({ path: '/tmp', extraKey: 'value' });
      expect(result.success).toBe(true);
    });

    it('should fall back to record schema when no properties', () => {
      const schema = jsonSchemaToZodPassthrough({ type: 'object' });
      const result = schema.safeParse({ anything: 'goes' });
      expect(result.success).toBe(true);
    });

    it('should handle empty properties object', () => {
      const schema = jsonSchemaToZodPassthrough({
        type: 'object',
        properties: {},
      });
      const result = schema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('resolveSensitivity', () => {
    it('should return default sensitivity when no overrides', () => {
      expect(resolveSensitivity('fs', 'read', undefined)).toBe('sensitive');
    });

    it('should return default sensitivity when no matching override', () => {
      const overrides = { 'other:tool': 'safe' as ToolSensitivity };
      expect(resolveSensitivity('fs', 'read', overrides)).toBe('sensitive');
    });

    it('should match server-specific override', () => {
      const overrides = { 'fs:read': 'safe' as ToolSensitivity };
      expect(resolveSensitivity('fs', 'read', overrides)).toBe('safe');
    });

    it('should match tool-level override', () => {
      const overrides = { read: 'safe' as ToolSensitivity };
      expect(resolveSensitivity('fs', 'read', overrides)).toBe('safe');
    });

    it('should prefer server-specific over tool-level override', () => {
      const overrides = {
        'fs:read': 'destructive' as ToolSensitivity,
        read: 'safe' as ToolSensitivity,
      };
      expect(resolveSensitivity('fs', 'read', overrides)).toBe('destructive');
    });
  });

  describe('convertMcpTool', () => {
    it('should convert MCP tool info to ToolDefinition', () => {
      const mcpClient = createMockMcpClient();
      const tool = convertMcpTool(mcpClient, SAMPLE_TOOL);

      expect(tool.description).toContain('[MCP:filesystem]');
      expect(tool.description).toContain('Read the contents of a file');
      expect(tool.sensitivity).toBe('sensitive');
      expect(typeof tool.execute).toBe('function');
      expect(tool.inputSchema).toBeDefined();
    });

    it('should use tool name as description fallback', () => {
      const mcpClient = createMockMcpClient();
      const tool = convertMcpTool(mcpClient, TOOL_NO_DESC);

      expect(tool.description).toBe('[MCP:filesystem] list_dir');
    });

    it('should apply sensitivity overrides', () => {
      const mcpClient = createMockMcpClient();
      const tool = convertMcpTool(mcpClient, SAMPLE_TOOL, {
        'filesystem:read_file': 'safe',
      });

      expect(tool.sensitivity).toBe('safe');
    });

    it('should call mcpClient.callTool on execute', async () => {
      const mcpClient = createMockMcpClient();
      const tool = convertMcpTool(mcpClient, SAMPLE_TOOL);

      const result = await tool.execute({ path: '/tmp/test.txt' });

      expect(mcpClient.callTool).toHaveBeenCalledWith(
        'filesystem',
        'read_file',
        { path: '/tmp/test.txt' },
      );
      // Single text content should be flattened
      expect(result).toEqual({ success: true, text: 'mock result' });
    });

    it('should return full content for multi-block results', async () => {
      const mcpClient = createMockMcpClient();
      (mcpClient.callTool as MockedFunction<any>).mockResolvedValue({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
        isError: false,
      });
      const tool = convertMcpTool(mcpClient, SAMPLE_TOOL);

      const result = await tool.execute({ path: '/tmp/test.txt' }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.content).toHaveLength(2);
    });

    it('should handle error results from MCP server', async () => {
      const mcpClient = createMockMcpClient();
      (mcpClient.callTool as MockedFunction<any>).mockResolvedValue({
        content: [{ type: 'text', text: 'Permission denied' }],
        isError: true,
      });
      const tool = convertMcpTool(mcpClient, SAMPLE_TOOL);

      const result = await tool.execute({ path: '/root/secret' }) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('MCP tool returned an error');
    });

    it('should return error result when callTool throws', async () => {
      const mcpClient = createMockMcpClient();
      (mcpClient.callTool as MockedFunction<any>).mockRejectedValue(new Error('Connection lost'));
      const tool = convertMcpTool(mcpClient, SAMPLE_TOOL);

      const result = await tool.execute({ path: '/tmp' }) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection lost');
    });
  });

  describe('loadMcpTools', () => {
    it('should load tools from all connected servers', () => {
      const tools: McpToolInfo[] = [
        SAMPLE_TOOL,
        { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: {} }, serverName: 'filesystem' },
        { name: 'create_issue', description: 'Create GitHub issue', inputSchema: { type: 'object', properties: {} }, serverName: 'github' },
      ];
      const mcpClient = createMockMcpClient(tools);

      const result = loadMcpTools(mcpClient);

      expect(Object.keys(result)).toEqual([
        'mcp_filesystem_read_file',
        'mcp_filesystem_write_file',
        'mcp_github_create_issue',
      ]);
    });

    it('should return empty map when no tools available', () => {
      const mcpClient = createMockMcpClient([]);
      const result = loadMcpTools(mcpClient);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should apply sensitivity overrides to loaded tools', () => {
      const mcpClient = createMockMcpClient([SAMPLE_TOOL]);
      const result = loadMcpTools(mcpClient, {
        'filesystem:read_file': 'safe',
      });

      expect(result['mcp_filesystem_read_file'].sensitivity).toBe('safe');
    });

    it('should default all tools to sensitive classification', () => {
      const mcpClient = createMockMcpClient([SAMPLE_TOOL, TOOL_NO_DESC]);
      const result = loadMcpTools(mcpClient);

      for (const tool of Object.values(result)) {
        expect(tool.sensitivity).toBe('sensitive');
      }
    });
  });

  describe('connectAndLoadMcpTools', () => {
    it('should connect to servers and load tools', async () => {
      const tools: McpToolInfo[] = [SAMPLE_TOOL];
      const mcpClient = createMockMcpClient(tools);
      const configs: Record<string, McpServerConfig> = {
        filesystem: { command: 'npx', args: ['-y', '@anthropic/mcp-filesystem'] },
      };

      const { tools: loaded, errors } = await connectAndLoadMcpTools(mcpClient, configs);

      expect(mcpClient.connectAll).toHaveBeenCalledWith(configs);
      expect(Object.keys(loaded)).toContain('mcp_filesystem_read_file');
      expect(errors.size).toBe(0);
    });

    it('should return errors for failed connections', async () => {
      const mcpClient = createMockMcpClient([]);
      const failError = new Error('spawn ENOENT');
      (mcpClient.connectAll as MockedFunction<any>).mockResolvedValue(
        new Map([['badserver', failError]]),
      );

      const { errors } = await connectAndLoadMcpTools(mcpClient, {
        badserver: { command: 'nonexistent' },
      });

      expect(errors.size).toBe(1);
      expect(errors.get('badserver')?.message).toBe('spawn ENOENT');
    });

    it('should still load tools from servers that connected successfully', async () => {
      const tools: McpToolInfo[] = [SAMPLE_TOOL];
      const mcpClient = createMockMcpClient(tools);
      (mcpClient.connectAll as MockedFunction<any>).mockResolvedValue(
        new Map([['badserver', new Error('fail')]]),
      );

      const { tools: loaded } = await connectAndLoadMcpTools(mcpClient, {
        filesystem: { command: 'npx', args: [] },
        badserver: { command: 'nonexistent' },
      });

      // filesystem tools should still be loaded
      expect(Object.keys(loaded)).toContain('mcp_filesystem_read_file');
    });

    it('should pass sensitivity overrides through', async () => {
      const mcpClient = createMockMcpClient([SAMPLE_TOOL]);
      const overrides = { 'filesystem:read_file': 'safe' as ToolSensitivity };

      const { tools: loaded } = await connectAndLoadMcpTools(
        mcpClient,
        { filesystem: { command: 'npx' } },
        overrides,
      );

      expect(loaded['mcp_filesystem_read_file'].sensitivity).toBe('safe');
    });
  });
});
