/**
 * "Test" for a remote MCP server: MCP `initialize`, `notifications/initialized`
 * and `tools/list` over streamable HTTP, reporting the tool count and names.
 *
 * Handles both response shapes the transport allows (a JSON body or a
 * `text/event-stream` with the reply in a `data:` line) and carries the
 * `Mcp-Session-Id` the server hands out. Never puts the URL (or anything of
 * its path) into a result or error.
 *
 * @module services/connector/remote-mcp-probe.service
 */

import { REMOTE_MCP_CONSTANTS } from '../../constants.js';
import type { RemoteMcpServer } from './remote-mcp.service.js';

const C = REMOTE_MCP_CONSTANTS;

/** Result of a probe. */
export type RemoteMcpProbeResult =
  | { ok: true; serverName?: string; toolCount: number; tools: string[] }
  | { ok: false; error: string; /** The server answered 401 with a Bearer challenge: it wants OAuth. */ needsAuth?: boolean; /** Its `WWW-Authenticate` value (no secrets: metadata URL + scope). */ wwwAuthenticate?: string };

/** Minimal fetch signature (injectable for tests). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** A JSON-RPC response. */
interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/**
 * Remove every trace of the URL from a message: the whole URL, its path,
 * and any long path segment (Zoho's key is one).
 *
 * @param message - Raw message
 * @param url - Server URL
 * @returns Safe message
 */
export function scrubUrl(message: string, url: string): string {
  let out = message.split(url).join('(server URL)');
  try {
    const u = new URL(url);
    if (u.pathname.length > 1) out = out.split(u.pathname).join('/…');
    for (const seg of u.pathname.split('/').filter((s) => s.length >= 8)) out = out.split(seg).join('…');
    if (u.search) out = out.split(u.search).join('?…');
  } catch {
    /* unparseable URL: whole-string removal above is all we can do */
  }
  return out;
}

/**
 * Read a JSON-RPC reply out of a JSON or SSE body.
 *
 * @param contentType - Response content type
 * @param body - Response text
 * @param id - Request id to match
 * @returns The reply, or undefined
 */
export function parseRpcBody(contentType: string, body: string, id: number): JsonRpcResponse | undefined {
  const candidates: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    // Events are separated by blank lines; a data field may span several lines.
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        /* not JSON — skip */
      }
    }
  } else {
    try {
      candidates.push(JSON.parse(body));
    } catch {
      return undefined;
    }
  }
  const flat = candidates.flatMap((c) => (Array.isArray(c) ? c : [c])) as JsonRpcResponse[];
  return flat.find((m) => m && m.id === id);
}

/**
 * Probe a server: initialize, then list its tools (following `nextCursor`
 * up to five pages).
 *
 * @param server - Stored server (URL and headers)
 * @param fetchImpl - fetch (tests)
 * @returns Tool count and names, or a safe error
 */
export async function probeRemoteMcp(server: Pick<RemoteMcpServer, 'url' | 'headers'>, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<RemoteMcpProbeResult> {
  const { url } = server;
  let sessionId: string | null = null;
  let protocolVersion: string = C.PROTOCOL_VERSION;

  let challenge: string | null = null;
  const post = async (payload: Record<string, unknown>): Promise<{ status: number; contentType: string; body: string }> => {
    const headers: Record<string, string> = {
      ...(server.headers ?? {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (payload.method !== 'initialize') headers['MCP-Protocol-Version'] = protocolVersion;
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(C.TEST_TIMEOUT_MS) });
    if (res.status === 401) challenge = res.headers.get('www-authenticate');
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
  };

  const call = async (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await post({ jsonrpc: '2.0', id, method, params });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`The server refused the request (${res.status}). Check the URL — it may have been regenerated.`);
    }
    if (res.status === 404) throw new Error('The server was not found (404). Check the URL.');
    if (res.status < 200 || res.status >= 300) throw new Error(`The server answered ${res.status} to ${method}.`);
    const reply = parseRpcBody(res.contentType, res.body, id);
    if (!reply) throw new Error(`The server's reply to ${method} was not MCP (is this an MCP server URL?).`);
    if (reply.error) throw new Error(`The server returned an error for ${method}: ${String(reply.error.message ?? reply.error.code ?? 'unknown')}`);
    return reply.result ?? {};
  };

  try {
    const init = await call(1, 'initialize', {
      protocolVersion: C.PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'crewly', version: '1.0.0' },
    });
    if (typeof init.protocolVersion === 'string') protocolVersion = init.protocolVersion;
    const serverInfo = init.serverInfo as { name?: unknown } | undefined;
    // Notifications get 202 and no body; a failure here is not fatal.
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined);

    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await call(2 + page, 'tools/list', cursor ? { cursor } : {});
      const tools = Array.isArray(result.tools) ? (result.tools as Array<{ name?: unknown }>) : [];
      for (const t of tools) if (typeof t?.name === 'string') names.push(t.name);
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return {
      ok: true,
      ...(typeof serverInfo?.name === 'string' ? { serverName: scrubUrl(serverInfo.name, url) } : {}),
      toolCount: names.length,
      tools: names.slice(0, C.MAX_TOOL_NAMES),
    };
  } catch (err) {
    const raw = err instanceof Error
      ? (err.name === 'TimeoutError' || err.name === 'AbortError' ? 'The server did not answer in time.' : err.message)
      : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    // Assigned inside `post`, so TypeScript cannot see it here.
    const seen = challenge as string | null;
    if (seen && /\bBearer\b/i.test(seen)) {
      return { ok: false, error: 'The server wants you to sign in (OAuth).', needsAuth: true, wwwAuthenticate: seen };
    }
    return { ok: false, error: scrubUrl(`${raw}${cause}`, url) };
  }
}
