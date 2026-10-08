/**
 * Hand remote MCP servers to an agent at launch.
 *
 * For each server whose `mcp:<id>` allowlist admits the agent's role, the
 * agent gets the backend's proxy (`<api>/api/connectors/remote-mcp/<id>/mcp`,
 * see remote-mcp-proxy.controller) rather than the server itself: the
 * server URL (Zoho's carries its key) and OAuth tokens never reach an agent
 * config. The only credential in the files is the agent's own identity
 * (`X-Agent-Session` + badge), which the proxy checks against the allowlist.
 *
 * | Runtime | How |
 * |---|---|
 * | Claude Code | `--mcp-config '<CREWLY_HOME>/runtime/remote-mcp/<session>/claude-mcp.json'` (adds to the project `.mcp.json`; no `--strict-mcp-config`) |
 * | Codex | `-c "mcp_servers.<id>.url=$(cat '<file>')"` (+ `http_headers`), so the secret never appears on the typed command line |
 * | Gemini CLI, Antigravity, OpenCode, crewly-agent | skipped with a log line |
 *
 * Every file is written under CREWLY_HOME with mode 0600 (directory 0700),
 * never into the project. The returned flags carry only file paths.
 *
 * @module services/connector/remote-mcp-launch.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService } from '../core/logger.service.js';
import { REMOTE_MCP_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { RemoteMcpService, writeSecretJson, type RemoteMcpServer } from './remote-mcp.service.js';
import { getLocalApiBaseUrl } from '../../utils/local-api-url.utils.js';
import { mintAgentBadge } from '../core/owner-auth.service.js';

const C = REMOTE_MCP_CONSTANTS;

/** Input for {@link buildRemoteMcpLaunchFlags}. */
export interface RemoteMcpLaunchInput {
  /** PTY session name. */
  sessionName: string;
  /** Agent role (decides the allowlists). */
  role: string;
  /** Runtime being launched. */
  runtimeType: string;
  /** Override CREWLY_HOME (tests). */
  crewlyHome?: string;
  /** Override the store (tests). */
  service?: RemoteMcpService;
  /** Override the backend base URL (tests). */
  apiBaseUrl?: string;
}

/** What {@link buildRemoteMcpLaunchFlags} decided. */
export interface RemoteMcpLaunchResult {
  /** Flags to add to the launch command (already shell-quoted). */
  flags: string[];
  /** Server ids handed to the agent. */
  servers: string[];
  /** Why nothing was added, when nothing was. */
  skipped?: 'no-servers' | 'unsupported-runtime' | 'error';
}

/**
 * Quote for a POSIX shell.
 *
 * @param value - Raw value
 * @returns Single-quoted value
 */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The per-session directory for launch files.
 *
 * @param crewlyHome - CREWLY_HOME
 * @param sessionName - PTY session name
 * @returns Absolute directory
 */
export function remoteMcpSessionDir(crewlyHome: string, sessionName: string): string {
  const safe = sessionName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
  return path.join(crewlyHome, C.RUNTIME_DIR, safe);
}

/**
 * The proxy URL an agent uses for a server.
 *
 * @param apiBaseUrl - Backend base, e.g. `http://localhost:8787`
 * @param id - Server id
 * @returns `<base>/api/connectors/remote-mcp/<id>/mcp`
 */
export function remoteMcpProxyUrl(apiBaseUrl: string, id: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}/api/connectors/remote-mcp/${encodeURIComponent(id)}${C.PROXY_SUFFIX}`;
}

/**
 * Headers that identify the agent to the proxy.
 *
 * @param sessionName - Agent session
 * @returns `X-Agent-Session` and `X-Agent-Badge`
 */
export function proxyIdentityHeaders(sessionName: string): Record<string, string> {
  return { 'X-Agent-Session': sessionName, 'X-Agent-Badge': mintAgentBadge(sessionName) };
}

/**
 * Claude Code's `--mcp-config` body: every server through the proxy.
 *
 * @param servers - Allowed servers
 * @param sessionName - Agent session (identity headers)
 * @param apiBaseUrl - Backend base URL
 * @returns `{ mcpServers: { <id>: { type: 'http', url: <proxy>, headers } } }`
 */
export function buildClaudeMcpConfig(servers: RemoteMcpServer[], sessionName: string, apiBaseUrl: string): { mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> } {
  const mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> = {};
  for (const s of servers) {
    mcpServers[s.id] = { type: 'http', url: remoteMcpProxyUrl(apiBaseUrl, s.id), headers: proxyIdentityHeaders(sessionName) };
  }
  return { mcpServers };
}

/**
 * A TOML inline table of headers (JSON strings are valid TOML basic strings).
 *
 * @param headers - Header map
 * @returns e.g. `{ "Authorization" = "Bearer x" }`
 */
export function toTomlInlineTable(headers: Record<string, string>): string {
  const parts = Object.entries(headers).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * Write a 0600 text file.
 *
 * @param file - Destination
 * @param body - Content
 */
async function writeSecretText(file: string, body: string): Promise<void> {
  await fs.writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/**
 * Write the launch files for one agent and return the flags that load them.
 * Never throws: on any failure the agent launches without remote MCP and
 * the error is logged (without secrets).
 *
 * @param input - Session, role, runtime
 * @returns Flags and the server ids handed over
 */
export async function buildRemoteMcpLaunchFlags(input: RemoteMcpLaunchInput): Promise<RemoteMcpLaunchResult> {
  const logger = LoggerService.getInstance().createComponentLogger('RemoteMcpLaunch');
  const { sessionName, role, runtimeType } = input;
  const crewlyHome = input.crewlyHome || getCrewlyHomePath();
  const apiBaseUrl = input.apiBaseUrl || getLocalApiBaseUrl();
  const dir = remoteMcpSessionDir(crewlyHome, sessionName);
  try {
    const servers = await (input.service ?? RemoteMcpService.getInstance()).serversForRole(role);
    // Start clean: a server removed or a role narrowed since the last launch must be gone.
    await fs.rm(dir, { recursive: true, force: true });
    if (servers.length === 0) return { flags: [], servers: [], skipped: 'no-servers' };
    const ids = servers.map((s) => s.id);

    if (runtimeType !== RUNTIME_TYPES.CLAUDE_CODE && runtimeType !== RUNTIME_TYPES.CODEX_CLI) {
      logger.info('Remote MCP servers: not supported for this runtime — skipped', { sessionName, runtimeType, servers: ids });
      return { flags: [], servers: [], skipped: 'unsupported-runtime' };
    }

    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);

    if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
      const file = path.join(dir, C.CLAUDE_CONFIG_FILE);
      await writeSecretJson(file, buildClaudeMcpConfig(servers, sessionName, apiBaseUrl));
      logger.info('Remote MCP servers: added via --mcp-config', { sessionName, role, servers: ids });
      return { flags: ['--mcp-config', shq(file)], servers: ids };
    }

    const flags: string[] = [];
    const headersToml = toTomlInlineTable(proxyIdentityHeaders(sessionName));
    for (const s of servers) {
      const urlFile = path.join(dir, `codex-${s.id}-url.toml`);
      await writeSecretText(urlFile, JSON.stringify(remoteMcpProxyUrl(apiBaseUrl, s.id)));
      flags.push('-c', `"mcp_servers.${s.id}.url=$(cat ${shq(urlFile)})"`);
      const headersFile = path.join(dir, `codex-${s.id}-headers.toml`);
      await writeSecretText(headersFile, headersToml);
      flags.push('-c', `"mcp_servers.${s.id}.http_headers=$(cat ${shq(headersFile)})"`);
    }
    logger.info('Remote MCP servers: added via codex -c mcp_servers', { sessionName, role, servers: ids });
    return { flags, servers: ids };
  } catch (err) {
    logger.error('Remote MCP servers: could not prepare launch files — launching without them', {
      sessionName,
      runtimeType,
      error: err instanceof Error ? err.message : String(err),
    });
    return { flags: [], servers: [], skipped: 'error' };
  }
}
