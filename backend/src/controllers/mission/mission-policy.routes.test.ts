import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import express from 'express';
import request from 'supertest';
import { createMissionPolicyRouter } from './mission-policy.routes.js';
import { OKRCascadeService } from '../../services/v3/okr-cascade.service.js';
import { KRTrackingService } from '../../services/v3/kr-tracking.service.js';

describe('createMissionPolicyRouter', () => {
  it('should create a router with expected routes', () => {
    const router = createMissionPolicyRouter();
    expect(router).toBeDefined();
    const routes = (router as any).stack?.map((r: any) => r.route?.path).filter(Boolean) || [];
    expect(routes).toContain('/');
    expect(routes).toContain('/:id');
    expect(routes).toContain('/:id/policy');
  });

  it('registers PUT /:id for partial mission updates', () => {
    const router = createMissionPolicyRouter();
    const entries: Array<{ path: string; methods: Record<string, boolean> }> =
      (router as any).stack
        ?.map((r: any) => r.route)
        .filter(Boolean)
        .map((r: any) => ({ path: r.path, methods: r.methods })) ?? [];

    const putIdRoute = entries.find((e) => e.path === '/:id' && e.methods.put);
    expect(putIdRoute).toBeDefined();
  });

  it('registers the cascade decompose/approve/reject/proposals routes', () => {
    const router = createMissionPolicyRouter();
    const entries: Array<{ path: string; methods: Record<string, boolean> }> =
      (router as any).stack
        ?.map((r: any) => r.route)
        .filter(Boolean)
        .map((r: any) => ({ path: r.path, methods: r.methods })) ?? [];

    expect(entries.find((e) => e.path === '/:id/decompose-okr' && e.methods.post)).toBeDefined();
    expect(entries.find((e) => e.path === '/:id/proposals' && e.methods.get)).toBeDefined();
    expect(entries.find((e) => e.path === '/:id/approve' && e.methods.post)).toBeDefined();
    expect(entries.find((e) => e.path === '/:id/reject' && e.methods.post)).toBeDefined();
  });
});

/**
 * Integration tests for the cascade-aware create/update wiring. Each test runs
 * in an isolated temporary working directory so missions persist under a fresh
 * `.crewly/missions` folder.
 */
describe('mission cascade routes (create/update round-trip)', () => {
  let app: express.Express;
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-cascade-'));
    process.chdir(tmpDir);
    app = express();
    app.use(express.json());
    app.use('/api/missions', createMissionPolicyRouter());
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a company-level mission with no parent (level defaults to company)', async () => {
    const res = await request(app)
      .post('/api/missions')
      .send({ id: 'co-1', objective: 'Company OKR', ownerTeamId: 't1' });
    expect(res.status).toBe(201);
    expect(res.body.data.level).toBe('company');
  });

  it('round-trips level + projectId + approval on create', async () => {
    await request(app).post('/api/missions').send({ id: 'co-1', objective: 'C', ownerTeamId: 't1' });
    await request(app)
      .post('/api/missions')
      .send({ id: 'team-1', objective: 'T', ownerTeamId: 't1', parentMissionId: 'co-1', level: 'team' });
    const res = await request(app).post('/api/missions').send({
      id: 'proj-1',
      objective: 'P',
      ownerTeamId: 't1',
      parentMissionId: 'team-1',
      level: 'project',
      projectId: 'project-xyz',
      approval: { state: 'pending_approval', proposedBy: 'agent-1' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.level).toBe('project');
    expect(res.body.data.projectId).toBe('project-xyz');

    const fetched = await request(app).get('/api/missions/proj-1');
    expect(fetched.body.data.projectId).toBe('project-xyz');
    expect(fetched.body.data.approval.state).toBe('pending_approval');
  });

  it('rejects a project-level mission whose parent is company (level mismatch)', async () => {
    await request(app).post('/api/missions').send({ id: 'co-1', objective: 'C', ownerTeamId: 't1' });
    const res = await request(app).post('/api/missions').send({
      id: 'bad-proj',
      objective: 'P',
      ownerTeamId: 't1',
      parentMissionId: 'co-1',
      level: 'project',
      projectId: 'p',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a project-level mission missing projectId', async () => {
    await request(app).post('/api/missions').send({ id: 'co-1', objective: 'C', ownerTeamId: 't1' });
    await request(app)
      .post('/api/missions')
      .send({ id: 'team-1', objective: 'T', ownerTeamId: 't1', parentMissionId: 'co-1', level: 'team' });
    const res = await request(app).post('/api/missions').send({
      id: 'proj-noid',
      objective: 'P',
      ownerTeamId: 't1',
      parentMissionId: 'team-1',
      level: 'project',
    });
    expect(res.status).toBe(400);
  });

  it('default-on-read migrates a parentless legacy mission to company/approved', async () => {
    // Finding 5: the read-migration now uses the canonical resolveMissionLevel
    // (deriveLevel-based) instead of a hardcoded 'team'. A PARENTLESS legacy
    // mission therefore resolves to 'company' (matching the cascade service).
    const dir = path.join(tmpDir, '.crewly', 'missions');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'legacy-1.json'),
      JSON.stringify({
        id: 'legacy-1',
        objective: 'Legacy',
        ownerTeamId: 't1',
        status: 'active',
        createdAt: new Date().toISOString(),
        successCriteria: [],
        activeProjectTaskIds: [],
      }),
    );
    const res = await request(app).get('/api/missions/legacy-1');
    expect(res.body.data.level).toBe('company');
    expect(res.body.data.approval.state).toBe('approved');
  });

  it('default-on-read migrates a one-parent legacy mission to team/approved', async () => {
    // A legacy (level-less) mission WITH one parent resolves to 'team' via the
    // parent-chain walk — preserving the team-level migration for nested docs.
    const dir = path.join(tmpDir, '.crewly', 'missions');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'legacy-co.json'),
      JSON.stringify({
        id: 'legacy-co',
        objective: 'Legacy company',
        ownerTeamId: 't1',
        status: 'active',
        createdAt: new Date().toISOString(),
        successCriteria: [],
        activeProjectTaskIds: [],
      }),
    );
    await fs.writeFile(
      path.join(dir, 'legacy-team.json'),
      JSON.stringify({
        id: 'legacy-team',
        objective: 'Legacy team',
        ownerTeamId: 't1',
        status: 'active',
        createdAt: new Date().toISOString(),
        successCriteria: [],
        activeProjectTaskIds: [],
        parentMissionId: 'legacy-co',
      }),
    );
    const res = await request(app).get('/api/missions/legacy-team');
    expect(res.body.data.level).toBe('team');
    expect(res.body.data.approval.state).toBe('approved');
  });

  it('PUT cannot mutate approval.state directly', async () => {
    await request(app)
      .post('/api/missions')
      .send({
        id: 'co-1',
        objective: 'C',
        ownerTeamId: 't1',
        approval: { state: 'pending_approval' },
      });
    const res = await request(app)
      .put('/api/missions/co-1')
      .send({ approval: { state: 'approved' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('approval.state');
  });

  // Regression (finding 2): a PUT carrying an `approval` object WITHOUT a
  // `state` key previously slipped past the guard and overwrote the existing
  // approval wholesale (the merge replaces, not deep-merges) — dropping
  // `approval.state` and quietly flipping an approved mission to
  // not-cascade-active. The whole `approval` key must be rejected and the
  // persisted state left intact.
  it('PUT rejects a stateless approval object and preserves approval.state', async () => {
    await request(app)
      .post('/api/missions')
      .send({
        id: 'co-1',
        objective: 'C',
        ownerTeamId: 't1',
        approval: { state: 'approved' },
      });

    const res = await request(app)
      .put('/api/missions/co-1')
      .send({ approval: { proposedBy: 'sneaky-agent' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('approval.state');

    // The persisted mission must still be approved (governance metadata intact).
    const fetched = await request(app).get('/api/missions/co-1');
    expect(fetched.body.data.approval.state).toBe('approved');
  });

  it('PUT rejects re-parenting that violates level adjacency', async () => {
    await request(app).post('/api/missions').send({ id: 'co-1', objective: 'C', ownerTeamId: 't1' });
    await request(app)
      .post('/api/missions')
      .send({ id: 'team-1', objective: 'T', ownerTeamId: 't1', parentMissionId: 'co-1', level: 'team' });
    // Try to make the company mission a child of a team (illegal).
    const res = await request(app)
      .put('/api/missions/co-1')
      .send({ level: 'company', parentMissionId: 'team-1' });
    expect(res.status).toBe(400);
  });
});

/**
 * Integration tests for the OKR cascade decompose/approve/reject/proposals
 * endpoints. Exercises the full propose → await-approval → decide flow through
 * the live {@link OKRCascadeService}.
 */
describe('OKR cascade decompose/approve/reject routes', () => {
  let app: express.Express;
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    OKRCascadeService.resetInstance();
    KRTrackingService.resetInstance();
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-cascade-okr-'));
    process.chdir(tmpDir);
    app = express();
    app.use(express.json());
    app.use('/api/missions', createMissionPolicyRouter());
    // Seed an approved company-level parent.
    await request(app).post('/api/missions').send({ id: 'co-1', objective: 'Company OKR', ownerTeamId: 't1' });
  });

  afterEach(async () => {
    OKRCascadeService.resetInstance();
    KRTrackingService.resetInstance();
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const childPayload = () => ({
    children: [
      {
        objective: 'Team OKR',
        currentStrategy: 'ship',
        successCriteria: ['done'],
        keyResults: [
          { title: 'Signups', metricType: 'number', baseline: 0, target: 50, unit: 'users' },
        ],
      },
    ],
  });

  it('POST /:id/decompose-okr creates pending children', async () => {
    const res = await request(app)
      .post('/api/missions/co-1/decompose-okr')
      .set('X-Agent-Session', 'tl-session')
      .send(childPayload());
    expect(res.status).toBe(201);
    expect(res.body.data.childLevel).toBe('team');
    expect(res.body.data.childMissionIds).toHaveLength(1);

    const childId = res.body.data.childMissionIds[0];
    const child = await request(app).get(`/api/missions/${childId}`);
    expect(child.body.data.approval.state).toBe('pending_approval');
    expect(child.body.data.approval.proposedBy).toBe('tl-session');
  });

  it('POST /:id/decompose-okr rejects a non-array children body', async () => {
    const res = await request(app).post('/api/missions/co-1/decompose-okr').send({});
    expect(res.status).toBe(400);
  });

  it('GET /:id/proposals lists pending children for the parent', async () => {
    await request(app).post('/api/missions/co-1/decompose-okr').send(childPayload());
    const res = await request(app).get('/api/missions/co-1/proposals');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('POST /:id/approve activates a pending child', async () => {
    const proposed = await request(app).post('/api/missions/co-1/decompose-okr').send(childPayload());
    const childId = proposed.body.data.childMissionIds[0];

    const res = await request(app)
      .post(`/api/missions/${childId}/approve`)
      .set('X-Agent-Session', 'steve')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.approval.state).toBe('approved');
    expect(res.body.data.approval.decidedBy).toBe('steve');
  });

  it('POST /:id/reject requires a reason and records it', async () => {
    const proposed = await request(app).post('/api/missions/co-1/decompose-okr').send(childPayload());
    const childId = proposed.body.data.childMissionIds[0];

    const noReason = await request(app).post(`/api/missions/${childId}/reject`).send({});
    expect(noReason.status).toBe(400);

    const res = await request(app)
      .post(`/api/missions/${childId}/reject`)
      .send({ reason: 'scope unclear' });
    expect(res.status).toBe(200);
    expect(res.body.data.approval.state).toBe('rejected');
    expect(res.body.data.approval.rejectionReason).toBe('scope unclear');
  });
});


describe('GET /:id/okr-summary/cascade (cross-level roll-up endpoint)', () => {
  let app: express.Express;
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-cascade-route-'));
    process.chdir(tmpDir);
    KRTrackingService.resetInstance();
    app = express();
    app.use(express.json());
    app.use('/api/missions', createMissionPolicyRouter());
  });

  afterEach(async () => {
    KRTrackingService.resetInstance();
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Create a KR on a mission and drive it to a percentage value. */
  async function seedKR(missionId: string, current: number): Promise<void> {
    const created = await request(app)
      .post(`/api/missions/${missionId}/key-results`)
      .send({ title: `KR ${missionId}`, metricType: 'percentage', baseline: 0, target: 100, unit: '%' });
    const krId = created.body.data.id as string;
    await request(app)
      .post(`/api/missions/${missionId}/key-results/${krId}/measure`)
      .send({ value: current, source: 'test' });
  }

  it('returns a recursive cascade summary with the expected shape', async () => {
    // company -> team (approved) -> nothing
    await request(app).post('/api/missions').send({ id: 'co-1', objective: 'Company', ownerTeamId: 't1' });
    await request(app).post('/api/missions').send({
      id: 'team-1',
      objective: 'Team',
      ownerTeamId: 't1',
      parentMissionId: 'co-1',
      level: 'team',
    });
    await seedKR('co-1', 40);
    await seedKR('team-1', 80);

    const res = await request(app).get('/api/missions/co-1/okr-summary/cascade');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.missionId).toBe('co-1');
    expect(data.level).toBe('company');
    expect(data.childMissionCount).toBe(1);
    expect(Array.isArray(data.children)).toBe(true);
    expect(data.children[0].missionId).toBe('team-1');
    expect(data.children[0].rolledUpProgress).toBe(80);
    // company roll-up = avg(40, 80) = 60
    expect(data.rolledUpProgress).toBe(60);
  });

  it('excludes pending children from the endpoint roll-up', async () => {
    await request(app).post('/api/missions').send({ id: 'co-1', objective: 'Company', ownerTeamId: 't1' });
    await request(app).post('/api/missions').send({
      id: 'team-approved',
      objective: 'Approved team',
      ownerTeamId: 't1',
      parentMissionId: 'co-1',
      level: 'team',
    });
    await request(app).post('/api/missions').send({
      id: 'team-pending',
      objective: 'Pending team',
      ownerTeamId: 't1',
      parentMissionId: 'co-1',
      level: 'team',
      approval: { state: 'pending_approval' },
    });
    await seedKR('co-1', 50);
    await seedKR('team-approved', 100);
    await seedKR('team-pending', 0);

    const res = await request(app).get('/api/missions/co-1/okr-summary/cascade');
    expect(res.status).toBe(200);
    expect(res.body.data.childMissionCount).toBe(1);
    // avg(50, 100) = 75 (pending excluded)
    expect(res.body.data.rolledUpProgress).toBe(75);
  });
});


/**
 * Regression (finding 5): the route read-migration and the OKRCascadeService
 * must resolve a level-less, parentless LEGACY mission to the SAME level via the
 * shared canonical resolver. A parentless legacy mission resolves to `company`
 * through BOTH paths (previously the service used 'company' while the route
 * read-migration hardcoded 'team', so the same doc resolved differently).
 */
describe('legacy level resolution is identical across route + service (finding 5)', () => {
  let app: express.Express;
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    OKRCascadeService.resetInstance();
    KRTrackingService.resetInstance();
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-cascade-level-'));
    process.chdir(tmpDir);
    app = express();
    app.use(express.json());
    app.use('/api/missions', createMissionPolicyRouter());
  });

  afterEach(async () => {
    OKRCascadeService.resetInstance();
    KRTrackingService.resetInstance();
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves a parentless level-less legacy mission to company through both paths', async () => {
    // Write a legacy mission file directly: no `level`, no parent, no approval.
    const dir = path.join(tmpDir, '.crewly', 'missions');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'legacy-co.json'),
      JSON.stringify({
        id: 'legacy-co',
        objective: 'Legacy company OKR',
        ownerTeamId: 't1',
        status: 'active',
        createdAt: new Date().toISOString(),
        successCriteria: [],
        activeProjectTaskIds: [],
      }),
    );

    // Path A — route read-migration.
    const fetched = await request(app).get('/api/missions/legacy-co');
    expect(fetched.body.data.level).toBe('company');

    // Path B — cascade service (legacy parent treated as approved => decomposes;
    // company + 1 === team proves the service also resolved it to company).
    const service = OKRCascadeService.getInstance();
    const result = await service.proposeDecomposition(
      'legacy-co',
      {
        children: [
          {
            objective: 'Team child',
            currentStrategy: 's',
            successCriteria: [],
            keyResults: [],
          },
        ],
      },
      'tl',
    );
    expect(result.childLevel).toBe('team');
  });
});
