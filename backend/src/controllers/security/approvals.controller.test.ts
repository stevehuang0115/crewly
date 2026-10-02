/**
 * Tests for GET /api/security/approvals.
 */
import express from 'express';
import request from 'supertest';
import { registerSecurityRoutes } from './approvals.controller.js';
import type { ApprovalActivityDeps } from '../../services/security/approval-activity.service.js';

function app(makeDeps: () => Promise<ApprovalActivityDeps>): express.Express {
  const a = express();
  const router = express.Router();
  registerSecurityRoutes(router, makeDeps);
  a.use('/api', router);
  return a;
}

const deps = (): ApprovalActivityDeps => ({
  decisions: jest.fn(async () => []),
  browserHolds: async () => [],
  whatsappDrafts: async () => null,
  gmailHeld: () => [],
  nameOf: () => undefined,
});

describe('GET /api/security/approvals', () => {
  it('returns the activity for 7 days by default and 30 on request', async () => {
    const d = deps();
    const res = await request(app(async () => d)).get('/api/security/approvals');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { days: 7, asked: 0, blocked: { tracked: false } } });
    const res30 = await request(app(async () => d)).get('/api/security/approvals?days=30');
    expect(res30.body.data.days).toBe(30);
    expect(d.decisions).toHaveBeenCalled();
  });

  it('answers 500 with the error when the collaborators fail', async () => {
    const res = await request(app(async () => Promise.reject(new Error('boom')))).get('/api/security/approvals');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'boom' });
  });
});
