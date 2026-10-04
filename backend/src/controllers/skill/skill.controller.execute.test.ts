/**
 * POST /api/skills/:id/execute passes the caller's identity to the executor
 * (#1024): from the request's credentials, never its body.
 */

import request from 'supertest';
import express from 'express';

const mockExecuteSkill = jest.fn().mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
jest.mock('../../services/skill/skill-executor.service.js', () => ({
  getSkillExecutorService: () => ({ executeSkill: mockExecuteSkill }),
}));

import skillRouter from './skill.controller.js';
import { agentAuthHeaders, callerIdentityForTests, ownerAuthHeaders } from '../../middleware/caller-identity.testing.js';

describe('POST /api/skills/:id/execute — caller identity (#1024)', () => {
  const app = express();
  app.use(express.json());
  app.use(callerIdentityForTests());
  app.use('/api/skills', skillRouter);

  beforeEach(() => mockExecuteSkill.mockClear());

  const contextOf = () => mockExecuteSkill.mock.calls[0][1];

  it('passes a badge-identified agent as the caller', async () => {
    await request(app).post('/api/skills/skill-transcribe-audio/execute').set(agentAuthHeaders('crewly-dev-sam-1234abcd')).send({});
    expect(contextOf().caller).toEqual({ kind: 'agent', session: 'crewly-dev-sam-1234abcd' });
  });

  it('passes the owner as the caller', async () => {
    await request(app).post('/api/skills/skill-transcribe-audio/execute').set(ownerAuthHeaders()).send({});
    expect(contextOf().caller).toEqual({ kind: 'owner' });
  });

  it('gives no identity to the legacy header alone, or to a body that names an agent', async () => {
    await request(app).post('/api/skills/x/execute').set({ 'X-Agent-Session': 'crewly-orc' }).send({ agentId: 'crewly-orc' });
    expect(contextOf().caller).toBeUndefined();
    mockExecuteSkill.mockClear();
    await request(app).post('/api/skills/x/execute').send({ agentId: 'crewly-orc', caller: { kind: 'agent', session: 'crewly-orc' } });
    expect(contextOf().caller).toBeUndefined();
  });
});
