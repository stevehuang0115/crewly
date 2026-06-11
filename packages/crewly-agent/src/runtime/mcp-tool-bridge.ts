/**
 * MCP Tool Bridge
 *
 * Converts external MCP server tools into Crewly Agent ToolDefinitions
 * so they can be used alongside built-in tools during agent execution.
 * All MCP-sourced tools default to 'sensitive' classification for audit
 * purposes unless explicitly overridden.
 *
 * @module services/agent/crewly-agent/mcp-tool-bridge
 */

import { z } from 'zod';
import type {
  McpClientLike,
  McpToolInfo,
  McpServerConfig,
  ToolDefinition,
  ToolSensitivity,
} from './types.js';

/**
 * Prefix applied to MCP tool names to avoid collisions with built-in tools.
 */
export const MCP_TOOL_PREFIX = 'mcp_' as const;

/**
 * Default sensitivity for MCP-sourced tools.
 * External tools are classified as 'sensitive' because they interact
 * with systems outside the agent's direct control.
 */
export const MCP_DEFAULT_SENSITIVITY: ToolSensitivity = 'sensitive';

/**
 * Configuration for MCP tool sensitivity overrides.
 * Maps `serverName:toolName` or just `toolName` to a sensitivity level.
 *
 * @example
 * ```typescript
 * const overrides: McpSensitivityOverrides = {
 *   'filesystem:read_file': 'safe',
 *   'github:create_issue': 'sensitive',
 *   'admin:drop_database': 'destructive',
 * };
 * ```
 */
/**
 * Convert a JSON Schema object from an MCP tool into a Zod schema.
 *
 * MCP tools declare their input using JSON Schema. The AI SDK expects
 * Zod schemas. This function creates a z.object({}) passthrough schema
 * that accepts any object — actual validation is done server-side by
 * the MCP server itself.
 *
 * @param inputSchema - JSON Schema from the MCP tool definition
 * @returns A Zod schema that passes through any object
 */
export function jsonSchemaToZodPassthrough(
  inputSchema: Record<string, unknown>,
): z.ZodType {
  // Extract property names from JSON Schema for documentation,
  // but use a passthrough object since the MCP server validates inputs.
  const properties = inputSchema.properties as Record<string, unknown> | undefined;
  if (properties && typeof properties === 'object') {
    const shape: Record<string, z.ZodType> = {};
    for (const key of Object.keys(properties)) {
      shape[key] = z.unknown().optional().describe(
        String((properties[key] as Record<string, unknown>)?.description || key),
      );
    }
    return z.object(shape).passthrough();
  }
  // Fallback: accept any object
  return z.record(z.unknown());
}

/**
 * Build the namespaced tool name for an MCP tool.
 *
 * Format: `mcp_{serverName}_{toolName}` to prevent collisions
 * with built-in Crewly tools and tools from other MCP servers.
 *
 * @param serverName - Name of the MCP server
 * @param toolName - Original tool name from the MCP server
 * @returns Namespaced tool name
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}_${toolName}`;
}

/**
 * Resolve the sensitivity level for an MCP tool.
 *
 * Checks overrides in order of specificity:
 * 1. `serverName:toolName` (most specific)
 * 2. `toolName` (tool-level default)
 * 3. Falls back to MCP_DEFAULT_SENSITIVITY ('sensitive')
 *
 * @param serverName - Name of the MCP server
 * @param toolName - Original tool name
 * @param overrides - Optional sensitivity overrides map
 * @returns Resolved sensitivity level
 */
export function resolveSensitivity(
  serverName: string,
  toolName: string,
  overrides?: McpSensitivityOverrides,
): ToolSensitivity {
  if (!overrides) return MCP_DEFAULT_SENSITIVITY;

  // Check server-specific override first
  const serverSpecific = overrides[`${serverName}:${toolName}`];
  if (serverSpecific) return serverSpecific;

  // Check tool-level override
  const toolLevel = overrides[toolName];
  if (toolLevel) return toolLevel;

  return MCP_DEFAULT_SENSITIVITY;
}

/**
 * Convert a single MCP tool into a Crewly ToolDefinition.
 *
 * The resulting tool definition:
 * - Has a namespaced name (`mcp_{server}_{tool}`)
 * - Uses a passthrough Zod schema for input validation
 * - Delegates execution to McpClientService.callTool()
 * - Defaults to 'sensitive' classification for auditing
 *
 * @param mcpClient - The MCP client service for executing tool calls
 * @param toolInfo - Tool metadata from the MCP server
 * @param overrides - Optional sensitivity overrides
 * @returns A ToolDefinition compatible with the Crewly Agent runtime
 */
export function convertMcpTool(
  mcpClient: McpClientLike,
  toolInfo: McpToolInfo,
  overrides?: McpSensitivityOverrides,
): ToolDefinition {
  const sensitivity = resolveSensitivity(
    toolInfo.serverName,
    toolInfo.name,
    overrides,
  );

  return {
    description: toolInfo.description
      ? `[MCP:${toolInfo.serverName}] ${toolInfo.description}`
      : `[MCP:${toolInfo.serverName}] ${toolInfo.name}`,
    inputSchema: jsonSchemaToZodPassthrough(toolInfo.inputSchema),
    sensitivity,
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      try {
        const result = await mcpClient.callTool(
          toolInfo.serverName,
          toolInfo.name,
          args,
        );

        // Flatten text content for simpler tool results
        if (!result.isError && result.content.length === 1
          && result.content[0].type === 'text' && 'text' in result.content[0]) {
          return { success: true, text: result.content[0].text };
        }

        return {
          success: !result.isError,
          content: result.content,
          ...(result.isError && { error: 'MCP tool returned an error' }),
        };
      } catch (error) {
        return {
          success: false,
          error: `MCP tool call failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Load all tools from connected MCP servers and convert them to ToolDefinitions.
 *
 * This is the primary entry point for integrating MCP tools into the agent
 * runtime. It queries all connected MCP servers, converts their tools to
 * the Crewly ToolDefinition format, and returns a map ready to merge with
 * the built-in tool registry.
 *
 * @param mcpClient - The MCP client service with active server connections
 * @param overrides - Optional sensitivity overrides
 * @returns Map of namespaced tool name -> ToolDefinition
 *
 * @example
 * ```typescript
 * const mcpClient = new McpClientService();
 * await mcpClient.connectServer('filesystem', config);
 * const mcpTools = loadMcpTools(mcpClient);
 * // mcpTools = { mcp_filesystem_read_file: {...}, mcp_filesystem_write_file: {...} }
 * ```
 */
export function loadMcpTools(
  mcpClient: McpClientLike,
  overrides?: McpSensitivityOverrides,
): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {};
  const mcpToolInfos = mcpClient.listTools();

  for (const toolInfo of mcpToolInfos) {
    const toolName = buildMcpToolName(toolInfo.serverName, toolInfo.name);
    tools[toolName] = convertMcpTool(mcpClient, toolInfo, overrides);
  }

  return tools;
}

/**
 * Connect to MCP servers and load their tools in one step.
 *
 * Convenience function that handles the full lifecycle:
 * 1. Connects to all configured MCP servers (tolerates failures)
 * 2. Loads and converts all available tools
 * 3. Returns tools ready to merge into the agent's tool registry
 *
 * @param mcpClient - The MCP client service instance
 * @param serverConfigs - Map of server name -> server configuration
 * @param overrides - Optional sensitivity overrides
 * @returns Object with loaded tools and any connection errors
 *
 * @example
 * ```typescript
 * const { tools, errors } = await connectAndLoadMcpTools(mcpClient, {
 *   filesystem: { command: 'npx', args: ['-y', '@anthropic/mcp-filesystem'] },
 * });
 * ```
 */
export async function connectAndLoadMcpTools(
  mcpClient: McpClientLike,
  serverConfigs: Record<string, McpServerConfig>,
  overrides?: McpSensitivityOverrides,
): Promise<{ tools: Record<string, ToolDefinition>; errors: Map<string, Error> }> {
  const errors = await mcpClient.connectAll(serverConfigs);
  const tools = loadMcpTools(mcpClient, overrides);
  return { tools, errors };
}
