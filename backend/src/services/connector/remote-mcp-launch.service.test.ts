/**
 * Tests for the launch-time injection of remote MCP servers: Claude Code
 * `--mcp-config`, Codex `-c mcp_servers.*`, role gating, 0600 files under
 * CREWLY_HOME, every server through the backend proxy (no server URL, key
 * or token in any launch file) and nothing secret on the command line.
 *
 * @module services/connector/remote-mcp-launch.service.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  buildClaudeMcpConfig,
  buildRemoteMcpLaunchFlags,
  remoteMcpProxyUrl,
  remoteMcpSessionDir,
  toTomlInlineTable,
} from './remote-mcp-launch.service.js';
import { verifyAgentBadge } from '../core/owner-auth.service.js';
import { RemoteMcpService } from './remote-mcp.service.js';
import { ConnectorAccessService } from './connector-access.service.js';
import { injectRuntimeFlags } from '../../utils/runtime-model-flags.utils.js';

const logs: unknown[][] = [];
jest.mock('../core/logger.service.js', () => {
  const log = (...args: unknown[]) => logs.push(args);
  return { LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: log, warn: log, debug: log, error: log }) }) } };
});

const ZOHO_URL = 'https://crm-600.zohomcp.com/mcp/SECRETKEY123/message';
const API = 'http://localhost:8787';

let home: string;
let access: ConnectorAccessService;
let service: RemoteMcpService;

beforeEach(async () => {
  logs.length = 0;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-mcp-launch-'));
  access = new ConnectorAccessService(home);
  service = new RemoteMcpService(home, access);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const launch = (runtimeType: string, role = 'developer', sessionName = 'team-dev-1') =>
  buildRemoteMcpLaunchFlags({ sessionName, role, runtimeType, crewlyHome: home, service, apiBaseUrl: API });

describe('Claude Code', () => {
  it('writes a 0600 --mcp-config file under CREWLY_HOME and passes only its path', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL, provider: 'zoho' });
    const result = await launch('claude-code');
    const file = path.join(remoteMcpSessionDir(home, 'team-dev-1'), 'claude-mcp.json');
    expect(result).toEqual({ flags: ['--mcp-config', `'${file}'`], servers: ['zoho'] });
    const config = JSON.parse(await fs.readFile(file, 'utf8')) as { mcpServers: { zoho: { type: string; url: string; headers: Record<string, string> } } };
    expect(config.mcpServers.zoho).toMatchObject({ type: 'http', url: `${API}/api/connectors/remote-mcp/zoho/mcp` });
    expect(config.mcpServers.zoho.headers['X-Agent-Session']).toBe('team-dev-1');
    expect(verifyAgentBadge(config.mcpServers.zoho.headers['X-Agent-Badge'])).toBe('team-dev-1');
    expect(await fs.readFile(file, 'utf8')).not.toContain('SECRETKEY');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(file.startsWith(home)).toBe(true);

    // Lands right after the binary, keeps the rest (no --strict-mcp-config).
    const cmd = injectRuntimeFlags('claude --dangerously-skip-permissions', 'claude-code', result.flags);
    expect(cmd).toBe(`claude --mcp-config '${file}' --dangerously-skip-permissions`);
    expect(cmd).not.toContain('SECRETKEY');
    expect(cmd).not.toContain('--strict-mcp-config');
  });

  it('never puts a server\'s own headers in the config (the proxy adds them)', () => {
    const config = buildClaudeMcpConfig([{ id: 'x', label: 'X', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer STATIC' }, createdAt: '' }], 's', API);
    expect(config.mcpServers.x.url).toBe(remoteMcpProxyUrl(API, 'x'));
    expect(JSON.stringify(config)).not.toContain('STATIC');
  });
});

describe('Codex', () => {
  it('passes -c overrides whose values the shell reads from 0600 files', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL });
    await service.add({ label: 'Other', url: 'https://other.dev/mcp', headers: { Authorization: 'Bearer TOK"EN' } });
    const result = await launch('codex-cli');
    expect(result.servers).toEqual(['zoho', 'other']);
    const flagStr = result.flags.join(' ');
    expect(flagStr).not.toContain('SECRETKEY');
    expect(flagStr).not.toContain('TOK');
    expect(result.flags.filter((f) => f === '-c')).toHaveLength(4);

    // What the shell hands Codex after expansion: proxy URLs + identity headers only.
    const argv = execFileSync('bash', ['-c', `for a in ${flagStr}; do printf '%s\\n' "$a"; done`], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    expect(argv.filter((a) => a !== '-c')).toEqual([
      `mcp_servers.zoho.url="${API}/api/connectors/remote-mcp/zoho/mcp"`,
      expect.stringMatching(/^mcp_servers\.zoho\.http_headers=\{ "X-Agent-Session" = "team-dev-1", "X-Agent-Badge" = ".+" \}$/),
      `mcp_servers.other.url="${API}/api/connectors/remote-mcp/other/mcp"`,
      expect.stringMatching(/^mcp_servers\.other\.http_headers=/),
    ]);
    expect(argv.join(' ')).not.toContain('TOK');
    const dir = remoteMcpSessionDir(home, 'team-dev-1');
    for (const f of await fs.readdir(dir)) expect((await fs.stat(path.join(dir, f))).mode & 0o777).toBe(0o600);

    const cmd = injectRuntimeFlags('codex -a never -s danger-full-access', 'codex-cli', result.flags);
    expect(cmd.startsWith(`codex ${flagStr} -a never`)).toBe(true);
  });

  it('builds TOML inline tables from headers', () => {
    expect(toTomlInlineTable({ 'X-A': 'b', C: 'd"e' })).toBe('{ "X-A" = "b", "C" = "d\\"e" }');
  });
});

describe('gating and skips', () => {
  it('adds nothing for a role outside the allowlist and clears stale files', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL });
    await launch('claude-code', 'developer');
    await access.setAllowedRoles('mcp:zoho', ['sales']);
    expect(await launch('claude-code', 'developer')).toEqual({ flags: [], servers: [], skipped: 'no-servers' });
    await expect(fs.stat(remoteMcpSessionDir(home, 'team-dev-1'))).rejects.toThrow();
    expect((await launch('claude-code', 'sales')).servers).toEqual(['zoho']);
  });

  it('adds nothing when there are no servers', async () => {
    expect(await launch('claude-code')).toEqual({ flags: [], servers: [], skipped: 'no-servers' });
  });

  it.each(['gemini-cli', 'antigravity-cli', 'opencode-cli', 'crewly-agent'])('skips %s with a log line', async (runtime) => {
    await service.add({ label: 'Zoho', url: ZOHO_URL });
    expect(await launch(runtime)).toEqual({ flags: [], servers: [], skipped: 'unsupported-runtime' });
    expect(JSON.stringify(logs)).toContain('not supported for this runtime');
  });

  it('never throws and never logs the URL', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL });
    const broken = { serversForRole: jest.fn().mockRejectedValue(new Error('disk')) } as unknown as RemoteMcpService;
    expect(await buildRemoteMcpLaunchFlags({ sessionName: 's', role: 'r', runtimeType: 'claude-code', crewlyHome: home, service: broken }))
      .toEqual({ flags: [], servers: [], skipped: 'error' });
    await launch('claude-code');
    await launch('codex-cli');
    expect(JSON.stringify(logs)).not.toContain('SECRETKEY');
  });

  it('sanitises the session name into a directory under CREWLY_HOME', () => {
    const dir = remoteMcpSessionDir(home, '../../etc');
    expect(path.dirname(dir)).toBe(path.join(home, 'runtime/remote-mcp'));
    expect(path.basename(dir)).not.toMatch(/^\./);
  });
});
