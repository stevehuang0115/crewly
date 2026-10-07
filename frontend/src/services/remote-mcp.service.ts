/**
 * Remote MCP servers API client (`/api/connectors/remote-mcp`, owner only).
 *
 * The backend never returns a server's URL — only `urlMasked`.
 *
 * @module services/remote-mcp.service
 */

const BASE = '/api/connectors/remote-mcp';

/** A server as the API shows it. */
export interface RemoteMcpServerView {
  id: string;
  label: string;
  provider: 'zoho' | 'custom';
  /** Scheme + host only. */
  urlMasked: string;
  headerNames: string[];
  createdAt: string;
  /** Its role allowlist key (`mcp:<id>`). */
  connectorId: string;
}

/** Result of the "Test" action. */
export type RemoteMcpTestResult =
  | { ok: true; serverName?: string; toolCount: number; tools: string[] }
  | { ok: false; error: string };

/**
 * Parse an API reply, throwing its message on failure.
 *
 * @param res - Fetch response
 * @returns The body
 */
async function parse<T>(res: Response): Promise<T & { success: boolean; note?: string }> {
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok || !data.success) throw new Error(String(data.message || data.error || `Request failed (${res.status})`));
  return data as T & { success: boolean; note?: string };
}

/**
 * List the servers.
 *
 * @returns Servers (masked)
 */
export async function listRemoteMcp(): Promise<RemoteMcpServerView[]> {
  return (await parse<{ data: RemoteMcpServerView[] }>(await fetch(BASE))).data ?? [];
}

/**
 * Add a server.
 *
 * @param input - Name, pasted URL, preset
 * @returns The stored server and when it applies
 */
export async function addRemoteMcp(input: { label: string; url: string; provider: string }): Promise<{ server: RemoteMcpServerView; note?: string }> {
  const body = await parse<{ data: RemoteMcpServerView }>(await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
  return { server: body.data, note: body.note };
}

/**
 * Rename a server.
 *
 * @param id - Server id
 * @param label - New name
 * @returns The updated server
 */
export async function renameRemoteMcp(id: string, label: string): Promise<RemoteMcpServerView> {
  return (await parse<{ data: RemoteMcpServerView }>(await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  }))).data;
}

/**
 * Remove a server.
 *
 * @param id - Server id
 */
export async function removeRemoteMcp(id: string): Promise<void> {
  await parse(await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

/**
 * Connect to a server and list its tools.
 *
 * @param id - Server id
 * @returns Tool count and names, or the error
 */
export async function testRemoteMcp(id: string): Promise<RemoteMcpTestResult> {
  return (await parse<{ data: RemoteMcpTestResult }>(await fetch(`${BASE}/${encodeURIComponent(id)}/test`, { method: 'POST' }))).data;
}
