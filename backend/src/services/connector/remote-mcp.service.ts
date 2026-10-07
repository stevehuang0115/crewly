/**
 * Remote MCP servers — streamable-HTTP MCP servers the owner connects once
 * (Zoho MCP first, any other server the same way) and Crewly hands to every
 * agent whose role may use them.
 *
 * Stored at `<CREWLY_HOME>/remote-mcp-servers.json` with mode 0600. The URL
 * (Zoho's carries the server's API key) and any headers are secrets: they
 * are never logged, never returned in full by {@link toView}, and never
 * written into a project directory (a project `.mcp.json` would be
 * committed). Agents get them through per-session files under CREWLY_HOME
 * (see remote-mcp-launch.service).
 *
 * Each server is a gated connector `mcp:<id>` in
 * {@link ConnectorAccessService}: open to every agent until the owner picks
 * roles.
 *
 * @module services/connector/remote-mcp.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { REMOTE_MCP_CONSTANTS } from '../../constants.js';
import { ConnectorAccessService } from './connector-access.service.js';

const C = REMOTE_MCP_CONSTANTS;

/** Catalog preset a server was added from. */
export type RemoteMcpProvider = 'zoho' | 'custom';

/** One stored server (secrets included — never send this to a client). */
export interface RemoteMcpServer {
  /** Stable id; also the MCP server name agents see and the `mcp:<id>` access key. */
  id: string;
  /** Owner-facing name. */
  label: string;
  /** Streamable-HTTP endpoint (secret). */
  url: string;
  /** Extra request headers (secret values). */
  headers?: Record<string, string>;
  /** Catalog preset. */
  provider?: RemoteMcpProvider;
  /** ISO time it was added. */
  createdAt: string;
}

/** What the API returns: no secrets. */
export interface RemoteMcpServerView {
  id: string;
  label: string;
  provider: RemoteMcpProvider;
  /** Scheme + host only, e.g. `https://crm-123.zohomcp.com/…`. */
  urlMasked: string;
  /** Header names (values withheld). */
  headerNames: string[];
  createdAt: string;
  /** Key of its role allowlist in connector access. */
  connectorId: string;
}

/** Input for {@link RemoteMcpService.add}. */
export interface AddRemoteMcpInput {
  label: string;
  url: string;
  headers?: Record<string, string>;
  provider?: string;
}

/** A validation failure the API turns into a 400. */
export class RemoteMcpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteMcpValidationError';
  }
}

/**
 * The connector-access id of a server.
 *
 * @param id - Server id
 * @returns `mcp:<id>`
 */
export function remoteMcpConnectorId(id: string): string {
  return `${C.CONNECTOR_PREFIX}${id}`;
}

/**
 * Show a URL without its secret parts: scheme and host only.
 *
 * @param url - Stored URL
 * @returns e.g. `https://crm-123.zohomcp.com/…`, or `(hidden)` when it does not parse
 */
export function maskRemoteMcpUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '(hidden)';
  }
}

/**
 * Validate a server URL: https (http only for localhost), no whitespace,
 * quotes or backslashes (it is embedded in launch files), bounded length.
 *
 * @param raw - Pasted URL
 * @returns The trimmed URL
 * @throws RemoteMcpValidationError when it is not usable (message never echoes the URL)
 */
export function validateRemoteMcpUrl(raw: unknown): string {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) throw new RemoteMcpValidationError('Paste the server URL.');
  if (url.length > C.MAX_URL_LENGTH) throw new RemoteMcpValidationError('That URL is too long.');
  if (/[\s"'`\\<>]/.test(url) || /[\u0000-\u001f\u007f]/.test(url)) {
    throw new RemoteMcpValidationError('That URL contains spaces or quotes — paste only the URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteMcpValidationError('That is not a valid URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new RemoteMcpValidationError('The URL must start with https://');
  }
  return url;
}

/**
 * Validate optional headers: token-shaped names, single-line values.
 *
 * @param raw - Headers object or undefined
 * @returns Clean headers, or undefined when none
 * @throws RemoteMcpValidationError on a bad name or value
 */
export function validateRemoteMcpHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RemoteMcpValidationError('headers must be an object of name → value.');
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) throw new RemoteMcpValidationError(`Header name "${name.slice(0, 64)}" is not valid.`);
    if (typeof value !== 'string' || /[\r\n\u0000]/.test(value) || value.length > 4096) {
      throw new RemoteMcpValidationError(`Header "${name}" needs a single-line text value.`);
    }
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Clean a label.
 *
 * @param raw - Label input
 * @returns Trimmed label
 * @throws RemoteMcpValidationError when empty
 */
export function normalizeRemoteMcpLabel(raw: unknown): string {
  const label = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim().slice(0, C.MAX_LABEL_LENGTH);
  if (!label) throw new RemoteMcpValidationError('Give the server a name.');
  return label;
}

/**
 * Derive an id (MCP server name) from a label: lowercase slug, unique.
 *
 * @param label - Label
 * @param taken - Ids already in use
 * @returns e.g. `zoho`, `zoho-2`
 */
export function deriveRemoteMcpId(label: string, taken: Set<string>): string {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!base || !/^[a-z0-9]/.test(base)) base = 'mcp';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Turn a stored server into its API shape.
 *
 * @param server - Stored server
 * @returns The view (no URL, no header values)
 */
export function toView(server: RemoteMcpServer): RemoteMcpServerView {
  return {
    id: server.id,
    label: server.label,
    provider: server.provider ?? 'custom',
    urlMasked: maskRemoteMcpUrl(server.url),
    headerNames: Object.keys(server.headers ?? {}),
    createdAt: server.createdAt,
    connectorId: remoteMcpConnectorId(server.id),
  };
}

/**
 * Reads and writes the remote MCP server store.
 */
export class RemoteMcpService {
  private static instance: RemoteMcpService | null = null;
  private readonly logger: ComponentLogger;
  private readonly filePath: string;
  private readonly access: () => ConnectorAccessService;
  private writeChain: Promise<unknown> = Promise.resolve();

  /**
   * @param crewlyHome - Override the home directory (tests)
   * @param access - Connector access service (tests)
   */
  constructor(crewlyHome?: string, access?: ConnectorAccessService) {
    this.logger = LoggerService.getInstance().createComponentLogger('RemoteMcp');
    this.filePath = path.join(crewlyHome || getCrewlyHomePath(), C.STORE_FILE);
    this.access = () => access ?? ConnectorAccessService.getInstance();
  }

  static getInstance(): RemoteMcpService {
    if (!RemoteMcpService.instance) RemoteMcpService.instance = new RemoteMcpService();
    return RemoteMcpService.instance;
  }

  /** Reset the singleton (tests). */
  static resetInstance(): void {
    RemoteMcpService.instance = null;
  }

  /** Absolute path of the store file. */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Every stored server, with secrets. Unreadable entries are dropped.
   *
   * @returns Servers in the order they were added
   */
  async list(): Promise<RemoteMcpServer[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.error('Remote MCP store is not valid JSON — treating it as empty', { file: this.filePath });
      return [];
    }
    const servers = (parsed as { servers?: unknown })?.servers;
    if (!Array.isArray(servers)) return [];
    return servers.filter((s): s is RemoteMcpServer =>
      !!s && typeof s.id === 'string' && C.ID_PATTERN.test(s.id) && typeof s.url === 'string' && typeof s.label === 'string');
  }

  /**
   * One server, with secrets.
   *
   * @param id - Server id
   * @returns The server or undefined
   */
  async get(id: string): Promise<RemoteMcpServer | undefined> {
    return (await this.list()).find((s) => s.id === id);
  }

  /**
   * Add a server.
   *
   * @param input - Label, URL, optional headers and provider
   * @returns The stored server
   * @throws RemoteMcpValidationError on bad input or a full store
   */
  async add(input: AddRemoteMcpInput): Promise<RemoteMcpServer> {
    const label = normalizeRemoteMcpLabel(input.label);
    const url = validateRemoteMcpUrl(input.url);
    const headers = validateRemoteMcpHeaders(input.headers);
    const provider: RemoteMcpProvider = input.provider === 'zoho' ? 'zoho' : 'custom';
    return this.mutate(async (servers) => {
      if (servers.length >= C.MAX_SERVERS) throw new RemoteMcpValidationError(`At most ${C.MAX_SERVERS} servers.`);
      if (servers.some((s) => s.url === url)) throw new RemoteMcpValidationError('That server is already connected.');
      const id = deriveRemoteMcpId(label, new Set(servers.map((s) => s.id)));
      const server: RemoteMcpServer = { id, label, url, ...(headers ? { headers } : {}), provider, createdAt: new Date().toISOString() };
      this.logger.info('Remote MCP server added', { id, provider, host: maskRemoteMcpUrl(url) });
      return { servers: [...servers, server], result: server };
    });
  }

  /**
   * Rename a server (its id, and so its MCP name and allowlist, stay).
   *
   * @param id - Server id
   * @param label - New label
   * @returns The updated server, or undefined when there is none
   */
  async rename(id: string, label: string): Promise<RemoteMcpServer | undefined> {
    const clean = normalizeRemoteMcpLabel(label);
    return this.mutate(async (servers) => {
      const idx = servers.findIndex((s) => s.id === id);
      if (idx < 0) return { servers, result: undefined };
      const next = [...servers];
      next[idx] = { ...next[idx], label: clean };
      this.logger.info('Remote MCP server renamed', { id });
      return { servers: next, result: next[idx] };
    });
  }

  /**
   * Remove a server and its allowlist.
   *
   * @param id - Server id
   * @returns True when it existed
   */
  async remove(id: string): Promise<boolean> {
    const removed = await this.mutate(async (servers) => {
      const next = servers.filter((s) => s.id !== id);
      return { servers: next, result: next.length !== servers.length };
    });
    if (removed) {
      await this.access().removeRule(remoteMcpConnectorId(id));
      this.logger.info('Remote MCP server removed', { id });
    }
    return removed;
  }

  /**
   * Servers an agent role may use (its `mcp:<id>` allowlist passes).
   *
   * @param role - Agent role
   * @returns Allowed servers, with secrets
   */
  async serversForRole(role: string): Promise<RemoteMcpServer[]> {
    const servers = await this.list();
    const out: RemoteMcpServer[] = [];
    for (const s of servers) {
      // An empty role must not read as "the owner" here: launch always has one.
      if (await this.access().isAllowed(remoteMcpConnectorId(s.id), role || 'unknown')) out.push(s);
    }
    return out;
  }

  /**
   * Serialised read-modify-write; the file is written 0600.
   *
   * @param fn - Change to apply
   * @returns The change's result
   */
  private async mutate<T>(fn: (servers: RemoteMcpServer[]) => Promise<{ servers: RemoteMcpServer[]; result: T }>): Promise<T> {
    const run = this.writeChain.then(async () => {
      const { servers, result } = await fn(await this.list());
      await writeSecretJson(this.filePath, { servers });
      return result;
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }
}

/**
 * Write JSON readable only by the owner (0600), atomically.
 *
 * @param filePath - Destination
 * @param data - JSON value
 */
export async function writeSecretJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
