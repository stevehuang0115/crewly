/**
 * Tests for ConnectorAccessService — default-open behaviour, allowlist
 * round-trip, normalisation and the owner bypass.
 *
 * @module services/connector/connector-access.service.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConnectorAccessService } from './connector-access.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

let home: string;
let service: ConnectorAccessService;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-access-'));
  service = new ConnectorAccessService(home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  ConnectorAccessService.resetInstance();
});

describe('default (no file)', () => {
  it('is open to every agent and to the owner', async () => {
    expect(await service.list()).toEqual({});
    expect(await service.allowedRoles('canva')).toEqual([]);
    expect(await service.isAllowed('canva', 'developer')).toBe(true);
    expect(await service.isAllowed('canva', undefined)).toBe(true);
  });
});

describe('allowlist', () => {
  it('stores, normalises and enforces the roles', async () => {
    const rule = await service.setAllowedRoles('google-workspace', [' Ops ', 'team-leader', 'ops', '']);
    expect(rule).toEqual({ allowedRoles: ['ops', 'team-leader'] });

    expect(await service.isAllowed('google-workspace', 'ops')).toBe(true);
    expect(await service.isAllowed('google-workspace', 'OPS')).toBe(true);
    expect(await service.isAllowed('google-workspace', 'developer')).toBe(false);
    // The orchestrator is a role like any other — it can be left out on purpose.
    expect(await service.isAllowed('google-workspace', 'orchestrator')).toBe(false);
    // The owner (no agent session) is never gated.
    expect(await service.isAllowed('google-workspace', undefined)).toBe(true);
    // Other connectors are untouched.
    expect(await service.isAllowed('canva', 'developer')).toBe(true);
  });

  it('survives a reload and an empty list reopens the connector', async () => {
    await service.setAllowedRoles('canva', ['support']);
    const reloaded = new ConnectorAccessService(home);
    expect(await reloaded.allowedRoles('canva')).toEqual(['support']);
    expect(await reloaded.isAllowed('canva', 'developer')).toBe(false);

    await reloaded.setAllowedRoles('canva', []);
    expect(await new ConnectorAccessService(home).isAllowed('canva', 'developer')).toBe(true);
  });

  it('tolerates a corrupt or half-typed file', async () => {
    await fs.writeFile(path.join(home, 'connector-access.json'), JSON.stringify({ canva: { allowedRoles: 'ops' }, google: {} }), 'utf8');
    const s = new ConnectorAccessService(home);
    expect(await s.list()).toEqual({ canva: { allowedRoles: [] }, google: { allowedRoles: [] } });
    expect(await s.isAllowed('canva', 'developer')).toBe(true);
  });

  it('invalidate() drops the cache so an external edit is picked up', async () => {
    await service.setAllowedRoles('canva', ['ops']);
    await fs.writeFile(path.join(home, 'connector-access.json'), JSON.stringify({ canva: { allowedRoles: ['support'] } }), 'utf8');
    expect(await service.allowedRoles('canva')).toEqual(['ops']); // cached
    service.invalidate();
    expect(await service.allowedRoles('canva')).toEqual(['support']);
  });
});
