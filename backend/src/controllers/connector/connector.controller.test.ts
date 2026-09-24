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

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));
jest.mock('../../utils/agent-caller.utils.js', () => ({ resolveAgentCaller: jest.fn() }));

import { resolveAgentCaller } from '../../utils/agent-caller.utils.js';

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
