/**
 * Tests for the orchestrator-onboarding controller.
 *
 * Covers the request-shape validation + happy paths for both routes.
 * The pure logic itself is tested in the corresponding service tests
 * (recommend-team.test.ts / materialize-team.test.ts) — these tests
 * focus on parsing, defaults, and error mapping.
 *
 * @module controllers/orchestrator-onboarding/orchestrator-onboarding.controller.test
 */

import express from 'express';
import request from 'supertest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import { createOrchestratorOnboardingRouter } from './orchestrator-onboarding.routes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orchestrator/onboarding', createOrchestratorOnboardingRouter());
  return app;
}

describe('POST /api/orchestrator/onboarding/recommend-team', () => {
  const app = makeApp();

  it('returns a valid recommendation for a well-shaped request', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/recommend-team')
      .send({
        industry: 'small Shopify skincare shop',
        scale: 'solo',
        tasks: [
          { name: 'weekly content', tier: 'yes-today' },
          { name: 'customer support', tier: 'yes-today' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.recommendation.templateId).toBe('dtc-viral-content-team');
    expect(res.body.recommendation.agents.length).toBe(2);
    expect(res.body.recommendation.source).toBe('hardcoded:ecommerce-content-support');
  });

  it('returns 400 when industry is missing', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/recommend-team')
      .send({ scale: 'solo', tasks: [] });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/industry/);
  });

  it('returns 400 for an unknown scale', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/recommend-team')
      .send({ industry: 'x', scale: 'huge', tasks: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scale/);
  });

  it('returns 400 for an unknown tier', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/recommend-team')
      .send({
        industry: 'x',
        scale: 'solo',
        tasks: [{ name: 't', tier: 'maybe-someday' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tier/);
  });

  it('returns 400 when tasks is not an array', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/recommend-team')
      .send({ industry: 'x', scale: 'solo', tasks: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tasks/);
  });
});

describe('POST /api/orchestrator/onboarding/materialize-team', () => {
  const app = makeApp();
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = path.join(
      os.tmpdir(),
      `materialize-route-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpRoot, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const sampleRec = {
    templateId: 'dtc-viral-content-team',
    agents: [
      {
        role: 'content-drafter',
        responsibilities: 'Drafts content.',
        skillIds: ['content-drafter'],
      },
      {
        role: 'support-triage',
        responsibilities: 'Triages support.',
        skillIds: ['support-triage'],
      },
    ],
    reasoning: 'because',
    source: 'hardcoded:ecommerce-content-support',
  };

  it('writes the team config + flag and returns 200', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/materialize-team')
      .send({
        recommendation: sampleRec,
        teamsDir: path.join(tmpRoot, 'teams'),
        projectFlagPath: path.join(tmpRoot, 'flag.json'),
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.result.onboardingComplete).toBe(true);
    expect(typeof res.body.result.teamId).toBe('string');

    const written = await fs.readFile(res.body.result.teamConfigPath, 'utf8');
    const parsed = JSON.parse(written);
    expect(parsed.templateId).toBe('dtc-viral-content-team');
    expect(parsed.members.length).toBe(2);

    const flag = JSON.parse(await fs.readFile(path.join(tmpRoot, 'flag.json'), 'utf8'));
    expect(flag.onboardingComplete).toBe(true);
  });

  it('returns 400 when recommendation is missing', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/materialize-team')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recommendation/);
  });

  it('returns 400 when recommendation.templateId is empty', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/materialize-team')
      .send({ recommendation: { ...sampleRec, templateId: '' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/templateId/);
  });

  it('returns 400 when recommendation.agents is empty', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/materialize-team')
      .send({ recommendation: { ...sampleRec, agents: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agents/);
  });
});

describe('POST /api/orchestrator/onboarding/materialize-team — CREWLY_HOME default resolution', () => {
  const app = makeApp();
  let tmpHome: string;
  const ORIGINAL_CREWLY_HOME = process.env.CREWLY_HOME;

  beforeEach(async () => {
    tmpHome = path.join(
      os.tmpdir(),
      `crewly-home-default-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpHome, { recursive: true });
    process.env.CREWLY_HOME = tmpHome;
  });

  afterEach(async () => {
    if (ORIGINAL_CREWLY_HOME === undefined) {
      delete process.env.CREWLY_HOME;
    } else {
      process.env.CREWLY_HOME = ORIGINAL_CREWLY_HOME;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  const sampleRec = {
    templateId: 'dtc-viral-content-team',
    agents: [
      {
        role: 'content-drafter',
        responsibilities: 'Drafts content.',
        skillIds: ['content-drafter'],
      },
    ],
    reasoning: 'because',
    source: 'hardcoded:ecommerce-content-support',
  };

  it('writes team config under CREWLY_HOME/teams when teamsDir is omitted', async () => {
    const res = await request(app)
      .post('/api/orchestrator/onboarding/materialize-team')
      .send({ recommendation: sampleRec });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.result.teamConfigPath.startsWith(path.join(tmpHome, 'teams') + path.sep)).toBe(
      true,
    );
    expect(res.body.result.projectFlagPath).toBe(path.join(tmpHome, 'onboarding-complete.json'));
  });
});
