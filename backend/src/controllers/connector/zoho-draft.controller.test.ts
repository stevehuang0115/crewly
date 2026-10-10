/**
 * Tests for POST /connectors/zoho/draft: agents only, role-gated, ignores `mode`.
 *
 * @module controllers/connector/zoho-draft.controller.test
 */

import request from 'supertest';
import express from 'express';
import { ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';
import { saveZohoDraftHandler, zohoDraftDeps } from './zoho-draft.controller.js';

jest.mock('../../services/core/logger.service.js', () => ({ LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) } }));
jest.mock('../../services/core/storage.service.js', () => ({
  StorageService: { getInstance: () => ({ findMemberBySessionName: async () => ({ member: { role: 'sales' } }) }) },
}));

const app = express();
app.use(ownerUnlessAgentForTests);
app.use(express.json());
app.post('/draft', saveZohoDraftHandler);

const save = jest.fn();
let allowed = true;
beforeEach(() => {
  save.mockReset().mockResolvedValue({ accountId: '1', result: 'ok' });
  allowed = true;
  zohoDraftDeps.save = save;
  zohoDraftDeps.zohoId = async () => 'zoho';
  zohoDraftDeps.isAllowed = async () => allowed;
});

it('refuses the owner/anonymous with 403', async () => {
  const res = await request(app).post('/draft').send({ fromAddress: 'a@b.c', toAddress: 'd@e.f' });
  expect(res.status).toBe(403);
  expect(save).not.toHaveBeenCalled();
});

it('saves a draft for an agent, replying drafted:true sent:false', async () => {
  const res = await request(app).post('/draft').set('X-Agent-Session', 's1').send({ fromAddress: 'a@b.c', toAddress: 'd@e.f', mode: 'send' });
  expect(res.status).toBe(202);
  expect(res.body).toMatchObject({ success: true, drafted: true, sent: false });
  expect(save).toHaveBeenCalledTimes(1);
});

it('refuses a role that may not use Zoho', async () => {
  allowed = false;
  const res = await request(app).post('/draft').set('X-Agent-Session', 's1').send({ fromAddress: 'a@b.c', toAddress: 'd@e.f' });
  expect(res.status).toBe(403);
  expect(save).not.toHaveBeenCalled();
});
