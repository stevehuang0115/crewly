/**
 * Tests for RemoteMcpService — the 0600 store, masking, validation, ids and
 * role gating through connector access.
 *
 * @module services/connector/remote-mcp.service.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  RemoteMcpService,
  RemoteMcpValidationError,
  deriveRemoteMcpId,
  maskRemoteMcpUrl,
  remoteMcpConnectorId,
  toView,
  validateRemoteMcpHeaders,
  validateRemoteMcpUrl,
} from './remote-mcp.service.js';
import { ConnectorAccessService } from './connector-access.service.js';

const logs: unknown[][] = [];
jest.mock('../core/logger.service.js', () => {
  const log = (...args: unknown[]) => logs.push(args);
  return { LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: log, warn: log, debug: log, error: log }) }) } };
});

const ZOHO_URL = 'https://crm-60012345.zohomcp.com/mcp/SECRETKEY0123456789/message';

let home: string;
let access: ConnectorAccessService;
let service: RemoteMcpService;

beforeEach(async () => {
  logs.length = 0;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-mcp-'));
  access = new ConnectorAccessService(home);
  service = new RemoteMcpService(home, access);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('masking', () => {
  it('keeps only scheme and host', () => {
    expect(maskRemoteMcpUrl(ZOHO_URL)).toBe('https://crm-60012345.zohomcp.com/…');
    expect(maskRemoteMcpUrl('not a url')).toBe('(hidden)');
  });

  it('toView never carries the URL or header values', async () => {
    const s = await service.add({ label: 'Zoho', url: ZOHO_URL, headers: { Authorization: 'Bearer TOPSECRET' }, provider: 'zoho' });
    const view = toView(s);
    expect(view).toEqual({
      id: 'zoho',
      label: 'Zoho',
      provider: 'zoho',
      urlMasked: 'https://crm-60012345.zohomcp.com/…',
      headerNames: ['Authorization'],
      createdAt: s.createdAt,
      connectorId: 'mcp:zoho',
    });
    expect(JSON.stringify(view)).not.toContain('SECRETKEY');
    expect(JSON.stringify(view)).not.toContain('TOPSECRET');
  });
});

describe('store', () => {
  it('writes the file with mode 0600 and round-trips', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL, provider: 'zoho' });
    const stat = await fs.stat(service.getFilePath());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(service.getFilePath()).toBe(path.join(home, 'remote-mcp-servers.json'));
    const reloaded = new RemoteMcpService(home, access);
    expect((await reloaded.list()).map((s) => s.url)).toEqual([ZOHO_URL]);
  });

  it('never logs the URL or header values', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL, headers: { 'X-Key': 'TOPSECRET' } });
    await service.rename('zoho', 'Zoho CRM');
    await service.remove('zoho');
    const text = JSON.stringify(logs);
    expect(text).not.toContain('SECRETKEY');
    expect(text).not.toContain('TOPSECRET');
  });

  it('derives unique ids from labels and keeps the id on rename', async () => {
    const a = await service.add({ label: 'Zoho', url: ZOHO_URL });
    const b = await service.add({ label: 'Zoho', url: 'https://desk-1.zohomcp.com/mcp/K2/message' });
    expect([a.id, b.id]).toEqual(['zoho', 'zoho-2']);
    const renamed = await service.rename('zoho-2', '  Zoho   Desk ');
    expect(renamed).toMatchObject({ id: 'zoho-2', label: 'Zoho Desk' });
    expect(await service.rename('missing', 'x')).toBeUndefined();
  });

  it('refuses a duplicate URL', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL });
    await expect(service.add({ label: 'Again', url: ZOHO_URL })).rejects.toThrow(RemoteMcpValidationError);
  });

  it('removes a server and its allowlist', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL });
    await access.setAllowedRoles('mcp:zoho', ['ops']);
    expect(await service.remove('zoho')).toBe(true);
    expect(await service.list()).toEqual([]);
    expect(await access.list()).toEqual({});
    expect(await service.remove('zoho')).toBe(false);
  });

  it('treats a corrupt file as empty', async () => {
    await fs.writeFile(service.getFilePath(), '{oops', 'utf8');
    expect(await service.list()).toEqual([]);
  });

  it('serialises concurrent adds', async () => {
    await Promise.all([
      service.add({ label: 'A', url: 'https://a.example.com/mcp' }),
      service.add({ label: 'B', url: 'https://b.example.com/mcp' }),
    ]);
    expect((await service.list()).map((s) => s.id).sort()).toEqual(['a', 'b']);
  });
});

describe('validation', () => {
  it('accepts https and localhost http only', () => {
    expect(validateRemoteMcpUrl(`  ${ZOHO_URL} `)).toBe(ZOHO_URL);
    expect(validateRemoteMcpUrl('http://localhost:8080/mcp')).toBe('http://localhost:8080/mcp');
    expect(() => validateRemoteMcpUrl('http://example.com/mcp')).toThrow('https://');
    expect(() => validateRemoteMcpUrl('')).toThrow('Paste');
    expect(() => validateRemoteMcpUrl('https://x.com/a b')).toThrow('spaces or quotes');
    expect(() => validateRemoteMcpUrl('https://x.com/"$(id)"')).toThrow('spaces or quotes');
    expect(() => validateRemoteMcpUrl('nope')).toThrow('not a valid URL');
  });

  it('never echoes the URL in an error', () => {
    try {
      validateRemoteMcpUrl('http://secret-host.example.com/mcp/SECRETKEY');
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRETKEY');
    }
  });

  it('validates headers', () => {
    expect(validateRemoteMcpHeaders(undefined)).toBeUndefined();
    expect(validateRemoteMcpHeaders({})).toBeUndefined();
    expect(validateRemoteMcpHeaders({ Authorization: 'Bearer x' })).toEqual({ Authorization: 'Bearer x' });
    expect(() => validateRemoteMcpHeaders({ 'Bad Name': 'x' })).toThrow(RemoteMcpValidationError);
    expect(() => validateRemoteMcpHeaders({ A: 'x\ny' })).toThrow(RemoteMcpValidationError);
    expect(() => validateRemoteMcpHeaders(['x'])).toThrow(RemoteMcpValidationError);
  });

  it('derives a safe id from any label', () => {
    expect(deriveRemoteMcpId('Zoho CRM + Mail!', new Set())).toBe('zoho-crm-mail');
    expect(deriveRemoteMcpId('日本', new Set())).toBe('mcp');
    expect(deriveRemoteMcpId('日本', new Set(['mcp']))).toBe('mcp-2');
  });
});

describe('role gating', () => {
  it('is open by default and follows the mcp:<id> allowlist', async () => {
    await service.add({ label: 'Zoho', url: ZOHO_URL });
    await service.add({ label: 'Other', url: 'https://other.example.com/mcp' });
    expect((await service.serversForRole('developer')).map((s) => s.id)).toEqual(['zoho', 'other']);

    await access.setAllowedRoles(remoteMcpConnectorId('zoho'), ['sales']);
    expect((await service.serversForRole('developer')).map((s) => s.id)).toEqual(['other']);
    expect((await service.serversForRole('sales')).map((s) => s.id)).toEqual(['zoho', 'other']);
    expect((await service.serversForRole('orchestrator')).map((s) => s.id)).toEqual(['other']);
    // An empty role is not the owner.
    expect((await service.serversForRole('')).map((s) => s.id)).toEqual(['other']);
  });
});
