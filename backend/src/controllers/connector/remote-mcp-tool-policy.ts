/**
 * Per-tool deny policy for agents using a remote MCP server through the
 * proxy (CREW-400): refuse `tools/call` for a denied tool and hide denied
 * tools from `tools/list`. Pure functions; the proxy wires them in.
 *
 * @module controllers/connector/remote-mcp-tool-policy
 */

import { REMOTE_MCP_CONSTANTS } from '../../constants.js';

/** A parsed JSON-RPC message (loosely typed: it is agent input). */
export type RpcMessage = { id?: string | number | null; method?: unknown; params?: { name?: unknown } & Record<string, unknown>; result?: { tools?: unknown } & Record<string, unknown> };

/** Normalise a tool or method name for comparison. */
function norm(name: unknown): string {
  return typeof name === 'string' ? name.normalize('NFKC').trim().toLowerCase() : '';
}

/**
 * The denied tool names (normalised) for a server, or an empty set.
 *
 * @param server - The server's provider and id
 * @returns Normalised denied names
 */
export function deniedToolsFor(server: { id: string; provider?: string }): Set<string> {
  const map = REMOTE_MCP_CONSTANTS.DENIED_AGENT_TOOLS;
  const names = (server.provider && map[server.provider]) || map[server.id] || [];
  return new Set(names.map(norm));
}

/**
 * Parse a request body into its JSON-RPC messages.
 *
 * @param body - Raw body
 * @returns Messages and whether it was a batch, or null when not JSON
 */
export function parseRpc(body: string | undefined): { messages: RpcMessage[]; batch: boolean; parsed: unknown } | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    const batch = Array.isArray(parsed);
    const list = (batch ? parsed : [parsed]) as unknown[];
    return { messages: list.filter((m): m is RpcMessage => !!m && typeof m === 'object'), batch, parsed };
  } catch {
    return null;
  }
}

/**
 * Is this message a call to a denied tool?
 *
 * @param msg - JSON-RPC message
 * @param denied - Normalised denied names
 * @returns True when it must be refused
 */
export function isDeniedCall(msg: RpcMessage, denied: Set<string>): boolean {
  return norm(msg.method) === 'tools/call' && denied.has(norm(msg.params?.name));
}

/**
 * Is this message a `tools/list` request?
 *
 * @param msg - JSON-RPC message
 * @returns True for tools/list
 */
export function isToolsList(msg: RpcMessage): boolean {
  return norm(msg.method) === 'tools/list';
}

/**
 * Remove denied tools from a tools/list JSON-RPC response (single or batch).
 *
 * @param payload - Parsed response
 * @param denied - Normalised denied names
 * @returns The payload with denied tools removed
 */
export function filterToolsResult(payload: unknown, denied: Set<string>): unknown {
  const one = (m: unknown): unknown => {
    if (!m || typeof m !== 'object') return m;
    const msg = m as RpcMessage;
    if (msg.result && Array.isArray(msg.result.tools)) {
      const tools = (msg.result.tools as Array<{ name?: unknown }>).filter((t) => !denied.has(norm(t?.name)));
      return { ...msg, result: { ...msg.result, tools } };
    }
    return m;
  };
  return Array.isArray(payload) ? payload.map(one) : one(payload);
}

/**
 * Filter an upstream tools/list body, JSON or `text/event-stream`.
 *
 * @param text - Upstream body
 * @param contentType - Upstream content type
 * @param denied - Normalised denied names
 * @returns Filtered body (unchanged when it cannot be parsed)
 */
export function filterToolsBody(text: string, contentType: string, denied: Set<string>): string {
  if (contentType.includes('text/event-stream')) {
    return text
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data:')) return line;
        try {
          return `data: ${JSON.stringify(filterToolsResult(JSON.parse(line.slice(5)), denied))}`;
        } catch {
          return line;
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(filterToolsResult(JSON.parse(text), denied));
  } catch {
    return text;
  }
}
