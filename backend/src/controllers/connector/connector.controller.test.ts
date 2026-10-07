/**
 * Tests for the connector access API and the route gate.
 *
 * @module controllers/connector/connector.controller.test
 */

import request from 'supertest';
import express, { type Application } from 'express';
import { createConnectorRouter } from './connector.routes.js';
import { requireConnectorAccess } from './connector.controller.js';
import { ConnectorAccessService } from '../../services/connector/connector-access.service.js';
import { RemoteMcpService } from '../../services/connector/remote-mcp.service.js';
import { ActingForService, currentActor, setActingForForTesting } from '../../services/people/acting-for.service.js';

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));
jest.mock('../../utils/agent-caller.utils.js', () => ({ resolveAgentCaller: jest.fn() }));

import { resolveAgentCaller } from '../../utils/agent-caller.utils.js';
import { ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';

const mockCaller = resolveAgentCaller as jest.MockedFunction<typeof resolveAgentCaller>;

let app: Application;
let access: { list: jest.Mock; allowedRoles: jest.Mock; setAllowedRoles: jest.Mock; isAllowed: jest.Mock };

beforeEach(() => {
  access = {
    list: jest.fn().mockResolvedValue({}),
    allowedRoles: jest.fn().mockResolvedValue([]),
    setAllowedRoles: jest.fn(async (id: string, roles: string[]) => ({ allowedRoles: roles })),
    isAllowed: jest.fn().mockResolvedValue(true),
  };
  jest.spyOn(ConnectorAccessService, 'getInstance').mockReturnValue(access as unknown as ConnectorAccessService);
  mockCaller.mockResolvedValue({});

  app = express();
  app.use(ownerUnlessAgentForTests);
  app.use(express.json());
  app.use('/api/connectors', createConnectorRouter());
  app.use('/api/canva', requireConnectorAccess('canva'), (_req, res) => res.json({ success: true, data: 'design' }));
});

afterEach(() => jest.restoreAllMocks());

describe('GET /api/connectors/access', () => {
  it('always lists the gated connectors, defaulting to an empty (open) allowlist', async () => {
    const res = await request(app).get('/api/connectors/access');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ 'google-workspace': { allowedRoles: [] }, canva: { allowedRoles: [] }, 'microsoft-todo': { allowedRoles: [] } });
  });

  it('returns stored rules, including for connectors outside the gated list', async () => {
    access.list.mockResolvedValue({ canva: { allowedRoles: ['ops'] }, notion: { allowedRoles: ['support'] } });
    const res = await request(app).get('/api/connectors/access');
    expect(res.body.data).toEqual({
      'google-workspace': { allowedRoles: [] },
      canva: { allowedRoles: ['ops'] },
      'microsoft-todo': { allowedRoles: [] },
      notion: { allowedRoles: ['support'] },
    });
  });
});

describe('GET /api/connectors/access — remote MCP servers', () => {
  it('adds an mcp:<id> entry per remote MCP server, open by default', async () => {
    jest.spyOn(RemoteMcpService, 'getInstance').mockReturnValue({
      list: jest.fn().mockResolvedValue([{ id: 'zoho', label: 'Zoho', url: 'https://x.zohomcp.com/mcp/K/message', createdAt: '' }]),
    } as unknown as RemoteMcpService);
    access.list.mockResolvedValue({ 'mcp:zoho': { allowedRoles: ['sales'] } });
    const res = await request(app).get('/api/connectors/access');
    expect(res.body.data['mcp:zoho']).toEqual({ allowedRoles: ['sales'] });
    expect(JSON.stringify(res.body)).not.toContain('zohomcp');
  });
});

describe('PUT /api/connectors/access/:connectorId', () => {
  it('stores the allowlist and accepts an empty array as "every agent"', async () => {
    const res = await request(app).put('/api/connectors/access/canva').send({ allowedRoles: ['ops', 'team-leader'] });
    expect(res.body).toEqual({ success: true, data: { connectorId: 'canva', allowedRoles: ['ops', 'team-leader'] } });
    expect(access.setAllowedRoles).toHaveBeenCalledWith('canva', ['ops', 'team-leader']);
    await request(app).put('/api/connectors/access/canva').send({ allowedRoles: [] });
    expect(access.setAllowedRoles).toHaveBeenLastCalledWith('canva', []);
  });

  it('400s without an array', async () => {
    const res = await request(app).put('/api/connectors/access/canva').send({ allowedRoles: 'ops' });
    expect(res.status).toBe(400);
    expect(access.setAllowedRoles).not.toHaveBeenCalled();
  });
});

describe('requireConnectorAccess', () => {
  it('lets an allowed caller through', async () => {
    mockCaller.mockResolvedValue({ session: 'a-dev', role: 'developer' });
    const res = await request(app).get('/api/canva/designs');
    expect(res.status).toBe(200);
    expect(access.isAllowed).toHaveBeenCalledWith('canva', 'developer');
  });

  it('refuses a caller off the allowlist with 403 and names the allowed roles', async () => {
    mockCaller.mockResolvedValue({ session: 'a-dev', role: 'developer' });
    access.isAllowed.mockResolvedValue(false);
    access.allowedRoles.mockResolvedValue(['ops', 'support']);
    const res = await request(app).get('/api/canva/designs');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('connector_forbidden');
    expect(res.body.message).toContain('developer');
    expect(res.body.hint).toContain('ops, support');
  });

  it('never locks the owner out when the check itself fails', async () => {
    mockCaller.mockRejectedValue(new Error('storage down'));
    const res = await request(app).get('/api/canva/designs');
    expect(res.status).toBe(200);
  });
});

describe('requireConnectorAccess — runs the request as the person it is for (issue #968)', () => {
  afterEach(() => setActingForForTesting(null));

  it('a call from an agent carries the person that agent acts for; the dashboard carries the owner', async () => {
    const people = { isOwner: (id: string) => id === 'owner', ownerId: () => 'owner', roleOf: (id: string) => (id === 'owner' ? 'owner' : 'member'), displayName: (id: string) => id };
    // tests/setup.ts gives each test file its own throwaway CREWLY_HOME; a root
    // path like /nonexistent is writable when tests run as root.
    const actingFor = new ActingForService({ filePath: `${process.env.CREWLY_HOME}/acting-for.json`, people: () => people as never });
    actingFor.record('dev-1', 'UINFO001', 'slack');
    setActingForForTesting(actingFor);
    const seen: Array<string | null> = [];
    const probe = express();
    probe.use(ownerUnlessAgentForTests);
    probe.use('/x', requireConnectorAccess('canva'), (_req, res) => {
      seen.push(currentActor()?.id ?? null);
      res.json({ ok: true });
    });

    mockCaller.mockResolvedValueOnce({ session: 'dev-1', role: 'developer' });
    await request(probe).get('/x');
    mockCaller.mockResolvedValueOnce({});
    await request(probe).get('/x');
    expect(seen).toEqual(['UINFO001', 'owner']);
  });
});
