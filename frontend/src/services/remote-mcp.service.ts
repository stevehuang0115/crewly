/**
 * Remote MCP servers API client (`/api/connectors/remote-mcp`, owner only).
 *
 * The backend never returns a server's URL — only `urlMasked`.
 *
 * @module services/remote-mcp.service
 */

const BASE = '/api/connectors/remote-mcp';

/** An OAuth server's sign-in state (absent for static-key servers). */
export interface RemoteMcpAuthView {
  mode: 'oauth';
  status: 'needs_auth' | 'connected' | 'error';
  /** Host of the authorization server, e.g. `accounts.zoho.com`. */
  authorizationServer?: string;
  scopes?: string[];
  /** When the current access token expires (refreshed automatically). */
  expiresAt?: string;
  connectedAt?: string;
  error?: string;
  /** A live, single-use sign-in link (opens on any device). */
  authorizeUrl?: string;
  authorizeExpiresAt?: string;
}

/** A sign-in link the API handed out. */
export interface RemoteMcpAuthorizeLink {
  url: string;
  expiresAt: string;
  /** Also posted to the owner's Slack DM. */
  posted: boolean;
}

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
  /** OAuth sign-in state, for servers that want one (Zoho MCP). */
  auth?: RemoteMcpAuthView;
}

/** Result of the "Test" action. */
export type RemoteMcpTestResult =
  | { ok: true; serverName?: string; toolCount: number; tools: string[] }
  | { ok: false; error: string; /** The server wants the owner to sign in (OAuth). */ needsAuth?: boolean };

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
export async function addRemoteMcp(input: { label: string; url: string; provider: string }): Promise<{ server: RemoteMcpServerView; note?: string; authorize?: RemoteMcpAuthorizeLink | { error: string } }> {
  const body = await parse<{ data: RemoteMcpServerView; authorize?: RemoteMcpAuthorizeLink | { error: string } }>(await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
  return { server: body.data, note: body.note, ...(body.authorize ? { authorize: body.authorize } : {}) };
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

/**
 * Start (or reuse) an OAuth sign-in for a server.
 *
 * @param id - Server id
 * @param options - `notify` also posts the link to the owner's Slack DM
 * @returns The single-use sign-in link
 */
export async function authorizeRemoteMcp(id: string, options: { notify?: boolean } = {}): Promise<RemoteMcpAuthorizeLink> {
  return (await parse<{ data: RemoteMcpAuthorizeLink }>(await fetch(`${BASE}/${encodeURIComponent(id)}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notify: options.notify === true }),
  }))).data;
}
