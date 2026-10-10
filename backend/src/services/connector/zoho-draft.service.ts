/**
 * Draft-only Zoho mail for agents (CREW-400).
 *
 * Zoho's MCP has no draft tool: a draft is `ZohoMail_sendEmail` with
 * `mode: "draft"`, and omitting `mode` sends. Agents are therefore denied
 * that tool in the proxy; this service is the one internal caller that may
 * use it, and it builds the arguments itself: only whitelisted content
 * fields are copied from the request, and `mode` is always `draft` — the
 * caller has no way to pass it, nor scheduling, receipts or attachments.
 *
 * @module services/connector/zoho-draft.service
 */

import { REMOTE_MCP_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { RemoteMcpService, type RemoteMcpServer } from './remote-mcp.service.js';
import { RemoteMcpAuthService } from './remote-mcp-auth.service.js';
import { parseRpcBody, scrubUrl, type FetchLike } from './remote-mcp-probe.service.js';

const C = REMOTE_MCP_CONSTANTS;
const logger = LoggerService.getInstance().createComponentLogger('ZohoDraft');

/** What an agent may supply. Nothing else is read from the request. */
export interface ZohoDraftInput {
  fromAddress?: unknown;
  toAddress?: unknown;
  ccAddress?: unknown;
  bccAddress?: unknown;
  subject?: unknown;
  content?: unknown;
  mailFormat?: unknown;
  inReplyTo?: unknown;
  refHeader?: unknown;
  accountId?: unknown;
}

/** Why a draft could not be saved. */
export class ZohoDraftError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ZohoDraftError';
  }
}

/** Collaborators (tests inject). */
export interface ZohoDraftDeps {
  servers: () => Pick<RemoteMcpService, 'list'>;
  auth: () => Pick<RemoteMcpAuthService, 'usesOAuth' | 'getAccessToken'>;
  fetchImpl: FetchLike;
}

const defaultDeps: ZohoDraftDeps = {
  servers: () => RemoteMcpService.getInstance(),
  auth: () => RemoteMcpAuthService.getInstance(),
  fetchImpl: fetch as unknown as FetchLike,
};

const TEXT_FIELDS = ['fromAddress', 'toAddress', 'ccAddress', 'bccAddress', 'subject', 'content', 'inReplyTo', 'refHeader'] as const;

/**
 * Build the `body` argument for the draft call. `mode` is set last and is
 * not read from the input.
 *
 * @param input - Agent-supplied fields
 * @returns The Zoho request body
 * @throws ZohoDraftError when from/to are missing
 */
export function buildDraftBody(input: ZohoDraftInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of TEXT_FIELDS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) body[key] = v;
  }
  if (input.mailFormat === 'plaintext' || input.mailFormat === 'html') body.mailFormat = input.mailFormat;
  if (!body.fromAddress || !body.toAddress) throw new ZohoDraftError('fromAddress and toAddress are required.', 400);
  body.mode = 'draft';
  return body;
}

/**
 * Pull an account id for an address out of a getMailAccounts result.
 *
 * @param data - Parsed tool result (shape tolerated: array, or `{ data: [...] }`)
 * @param address - The From address
 * @returns accountId or undefined
 */
export function findAccountId(data: unknown, address: string): string | undefined {
  const root = data as { data?: unknown } | unknown[] | null;
  const list = Array.isArray(root) ? root : Array.isArray((root as { data?: unknown })?.data) ? ((root as { data: unknown[] }).data) : [];
  const wanted = address.trim().toLowerCase();
  for (const acc of list as Array<Record<string, unknown>>) {
    if (acc && JSON.stringify(acc).toLowerCase().includes(`"${wanted}"`) && acc.accountId != null) return String(acc.accountId);
  }
  return undefined;
}

/**
 * Save a draft in a Zoho mailbox. Never sends.
 *
 * @param input - Agent-supplied fields (see {@link ZohoDraftInput})
 * @param deps - Collaborators (tests)
 * @returns The Zoho reply text for the draft
 * @throws ZohoDraftError
 */
export async function saveZohoDraft(input: ZohoDraftInput, deps: ZohoDraftDeps = defaultDeps): Promise<{ accountId: string; result: unknown }> {
  const body = buildDraftBody(input);
  const servers = await deps.servers().list();
  const server: RemoteMcpServer | undefined = servers.find((s) => s.provider === 'zoho') ?? servers.find((s) => s.id === 'zoho');
  if (!server) throw new ZohoDraftError('No Zoho connector is set up on this machine.', 404);

  const oauth = await deps.auth().usesOAuth(server.id);
  let token = oauth ? await deps.auth().getAccessToken(server.id) : null;
  if (oauth && !token) throw new ZohoDraftError('Zoho needs the owner to sign in once (see Connections).', 503);

  let sessionId: string | null = null;
  let nextId = 1;
  let retried = false;

  const rpc = async (method: string, params: Record<string, unknown> | undefined, notification = false): Promise<unknown> => {
    const id = notification ? undefined : nextId++;
    const headers: Record<string, string> = { ...(server.headers ?? {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const payload = { jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) };
    let res = await deps.fetchImpl(server.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(C.ZOHO_DRAFT_TIMEOUT_MS) });
    if (res.status === 401 && oauth && !retried) {
      retried = true;
      token = await deps.auth().getAccessToken(server.id, { force: true });
      if (!token) throw new ZohoDraftError('Zoho needs the owner to sign in once (see Connections).', 503);
      headers.Authorization = `Bearer ${token}`;
      res = await deps.fetchImpl(server.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(C.ZOHO_DRAFT_TIMEOUT_MS) });
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    if (notification) return undefined;
    if (res.status < 200 || res.status >= 300) throw new ZohoDraftError(`Zoho answered ${res.status}.`, 502);
    const reply = parseRpcBody(res.headers.get('content-type') ?? '', text, id as number);
    if (!reply) throw new ZohoDraftError('Zoho gave a reply that was not MCP.', 502);
    if (reply.error) throw new ZohoDraftError(`Zoho returned an error: ${String(reply.error.message ?? reply.error.code)}`, 502);
    return reply.result;
  };

  const toolText = (result: unknown): string => {
    const content = (result as { content?: Array<{ text?: unknown }> } | undefined)?.content;
    return Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('') : '';
  };

  try {
    await rpc('initialize', { protocolVersion: C.PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'crewly', version: '1.0.0' } });
    await rpc('notifications/initialized', undefined, true).catch(() => undefined);

    let accountId = typeof input.accountId === 'string' && /^\d+$/.test(input.accountId) ? input.accountId : undefined;
    if (!accountId) {
      const accounts = await rpc('tools/call', { name: C.ZOHO_ACCOUNTS_TOOL, arguments: {} });
      let parsed: unknown;
      try { parsed = JSON.parse(toolText(accounts)); } catch { parsed = undefined; }
      accountId = findAccountId(parsed, String(body.fromAddress));
      if (!accountId) throw new ZohoDraftError(`No Zoho account found for ${String(body.fromAddress)}. Pass accountId, or check the address.`, 404);
    }

    const result = await rpc('tools/call', { name: C.ZOHO_DRAFT_TOOL, arguments: { body, path_variables: { accountId } } });
    if ((result as { isError?: boolean } | undefined)?.isError) throw new ZohoDraftError(`Zoho refused the draft: ${toolText(result).slice(0, 300)}`, 502);
    logger.info('Zoho draft saved', { from: body.fromAddress, to: body.toAddress });
    return { accountId, result: toolText(result) };
  } catch (err) {
    if (err instanceof ZohoDraftError) throw err;
    const raw = err instanceof Error ? (err.name === 'TimeoutError' ? 'Zoho did not answer in time.' : err.message) : String(err);
    throw new ZohoDraftError(scrubUrl(raw, server.url), 502);
  }
}
