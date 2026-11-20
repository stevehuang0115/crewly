import express from 'express';
import request from 'supertest';
import { TeamMoveBlockedError } from '../../services/team-move/team-move-exporter.js';
import { TeamMoveSecretScanError } from '../../services/team-move/team-move-secret-scan.js';
import { TeamMoveCloudError } from '../../services/team-move/team-move-cloud.client.js';
import { createTeamMovesRouter, isMoveApproval, type MachineView } from './team-move.controller.js';

// The caller kind comes from a test header; the real middleware needs the full server.
jest.mock('../../middleware/caller-identity.middleware.js', () => ({
  getCallerIdentity: (req: { headers: Record<string, string> }) => ({ kind: req.headers['x-test-caller'] === 'agent' ? 'agent' : 'owner' }),
  requireOwner: (req: { headers: Record<string, string> }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    req.headers['x-test-caller'] === 'agent' ? res.status(403).json({ success: false, error: 'owner only' }) : next(),
}));

const machines: MachineView[] = [
  { instanceId: 'me', name: 'Mac', online: true, isLocal: true, canReceive: true },
  { instanceId: 'air-id', name: 'Air', online: true, isLocal: false, canReceive: true },
  { instanceId: 'old-id', name: 'Old', online: true, isLocal: false, canReceive: false, crewlyVersion: '1.20.100' },
];

describe('isMoveApproval', () => {
  it('takes a short plain yes, in the words the owner actually used', () => {
    for (const yes of ['好', '好的', '可以', '确认，好的，开始搬。', '确认', 'ok', 'Yes, move it', '行', '同意搬，批准，开始吧。', 'go ahead']) {
      expect(isMoveApproval(yes)).toBe(true);
    }
  });

  it('never takes a question, a refusal, or a long message that merely opens with yes', () => {
    for (const no of ['', '可以吗', '好的？', '先等一下', '不用搬了', 'ok but wait', "don't", '好的，我看了你的计划，里面第三步有问题，等我想想再说，另外那个仓库的事也要确认一下再定下来怎么处理']) {
      expect(isMoveApproval(no)).toBe(false);
    }
  });
});

describe('team moves routes', () => {
  const driver = {
    listMoves: jest.fn(),
    getMove: jest.fn(),
    startMove: jest.fn(),
    rollbackMove: jest.fn(),
    checkRepos: jest.fn(),
    preview: jest.fn(),
    sourcePreflight: jest.fn(),
  };
  let owner: string[];

  const app = (driverOrNull: unknown = driver) => {
    const a = express();
    a.use(express.json());
    a.use(
      '/api/team-moves',
      createTeamMovesRouter({
        driver: () => driverOrNull as never,
        teams: async () => [{ id: 't1', name: 'CE' }],
        machines: async () => machines,
        recentOwnerMessages: () => owner,
      }),
    );
    return a;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    owner = [];
  });

  it('lists the machines it can move to', async () => {
    const res = await request(app()).get('/api/team-moves/machines');
    expect(res.body.data.machines).toHaveLength(3);
    expect(res.body.data.hints).toEqual([expect.stringContaining('Update Crewly on Old')]);
  });

  it('refuses a target that cannot receive a team yet and says to update it', async () => {
    const res = await request(app()).post('/api/team-moves').send({ teamName: 'ce', targetName: 'old' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Update Crewly on Old/);
    expect(driver.startMove).not.toHaveBeenCalled();
  });

  it('lists moves and one move', async () => {
    driver.listMoves.mockResolvedValue([{ moveId: 'm' }]);
    driver.getMove.mockResolvedValue({ move: { moveId: 'move-aaaaaaaa' }, journal: [] });
    expect((await request(app()).get('/api/team-moves')).body.data.moves).toEqual([{ moveId: 'm' }]);
    expect((await request(app()).get('/api/team-moves/move-aaaaaaaa')).body.data.move.moveId).toBe('move-aaaaaaaa');
    expect((await request(app()).get('/api/team-moves/..%2Fx')).status).toBe(400);
  });

  it('answers 503 until the machine is signed in to Cloud', async () => {
    const res = await request(app(null)).get('/api/team-moves');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/sign in/);
  });

  it('starts a move by team and machine name for the owner', async () => {
    driver.startMove.mockResolvedValue({ moveId: 'move-aaaaaaaa' });
    const res = await request(app()).post('/api/team-moves').send({ teamName: 'ce', targetName: 'air' });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ moveId: 'move-aaaaaaaa', target: 'Air' });
    expect(driver.startMove).toHaveBeenCalledWith({ teamId: 't1', targetInstanceId: 'air-id', allowDirty: false, skipFlagged: false, carryChanges: false });
  });

  it('answers 404 with the machine names when the target is unknown, and never moves to itself', async () => {
    const res = await request(app()).post('/api/team-moves').send({ teamName: 'CE', targetName: 'Mac' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/can receive a team: Air$/);
    expect((await request(app()).post('/api/team-moves').send({ teamName: 'Nope', targetName: 'Air' })).status).toBe(404);
  });

  it('lets the orchestrator start a move only after the owner said yes in chat', async () => {
    driver.startMove.mockResolvedValue({ moveId: 'move-aaaaaaaa' });
    const asAgent = (a: express.Express) => request(a).post('/api/team-moves').set('x-test-caller', 'agent').send({ teamName: 'CE', targetName: 'Air' });
    const refused = await asAgent(app());
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('owner_approval_required');
    owner = ['should we move CE to the Air?'];
    expect((await asAgent(app())).status).toBe(403);
    owner = ['yes, go ahead'];
    expect((await asAgent(app())).status).toBe(202);
  });

  it('tells the owner what to push when work is unpushed', async () => {
    driver.startMove.mockRejectedValue(new TeamMoveBlockedError(['App (/p): 2 commits not pushed on main']));
    const res = await request(app()).post('/api/team-moves').send({ teamName: 'CE', targetName: 'Air' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'unpushed_work', repos: ['App (/p): 2 commits not pushed on main'] });
  });

  it('maps secret-scan and Cloud errors', async () => {
    driver.startMove.mockRejectedValueOnce(new TeamMoveSecretScanError([{ path: 'a.md', matches: 1 }]));
    const a = await request(app()).post('/api/team-moves').send({ teamName: 'CE', targetName: 'Air' });
    expect(a.status).toBe(422);
    expect(a.body.findings).toEqual(['a.md']);
    driver.startMove.mockRejectedValueOnce(new TeamMoveCloudError('target offline', 409, 'target_offline'));
    const b = await request(app()).post('/api/team-moves').send({ teamName: 'CE', targetName: 'Air' });
    expect(b).toMatchObject({ status: 409 });
    expect(b.body.code).toBe('target_offline');
    driver.startMove.mockRejectedValueOnce(new Error('boom'));
    expect((await request(app()).post('/api/team-moves').send({ teamName: 'CE', targetName: 'Air' })).status).toBe(500);
  });

  it('checks repositories and previews without sending anything', async () => {
    driver.checkRepos.mockResolvedValue({ repos: [], blocking: [] });
    expect((await request(app()).post('/api/team-moves/check').send({ teamName: 'CE' })).body.data.blocking).toEqual([]);
    driver.preview.mockResolvedValue({ encryptedBytes: 10 });
    const res = await request(app()).post('/api/team-moves/preview').send({ teamName: 'CE' });
    expect(res.body.data).toEqual({ encryptedBytes: 10 });
    expect(driver.preview).toHaveBeenCalledWith(expect.objectContaining({ teamId: 't1', allowDirty: true }));
    expect((await request(app()).post('/api/team-moves/check').send({ teamName: 'Nope' })).status).toBe(404);
  });

  it('serves the preflight to the owner only, for a team by id or name, with the owner\'s options', async () => {
    driver.sourcePreflight.mockResolvedValue({ teamId: 't1', repos: [] });
    const res = await request(app()).post('/api/team-moves/preflight').send({ teamName: 'ce', carryChanges: true, quick: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ teamId: 't1', repos: [] });
    expect(driver.sourcePreflight).toHaveBeenCalledWith({ teamId: 't1', carryChanges: true, quick: true, force: false });
    await request(app()).post('/api/team-moves/preflight').send({ teamId: 't1' });
    expect(driver.sourcePreflight).toHaveBeenLastCalledWith({ teamId: 't1', carryChanges: false, quick: false, force: false });
    expect((await request(app()).post('/api/team-moves/preflight').send({ teamName: 'Nope' })).status).toBe(404);
    expect((await request(app()).post('/api/team-moves/preflight').set('x-test-caller', 'agent').send({ teamName: 'CE' })).status).toBe(403);
    expect((await request(app(null)).post('/api/team-moves/preflight').send({ teamName: 'CE' })).status).toBe(503);
  });

  it('passes "carry uncommitted changes" on when starting a move', async () => {
    driver.startMove.mockResolvedValue({ moveId: 'move-aaaaaaaa' });
    const res = await request(app()).post('/api/team-moves').send({ teamName: 'CE', targetName: 'Air', carryChanges: true, skipFlagged: true });
    expect(res.status).toBe(202);
    expect(driver.startMove).toHaveBeenCalledWith({ teamId: 't1', targetInstanceId: 'air-id', allowDirty: false, skipFlagged: true, carryChanges: true });
  });

  it('rolls back for the owner only', async () => {
    driver.rollbackMove.mockResolvedValue(undefined);
    expect((await request(app()).post('/api/team-moves/move-aaaaaaaa/rollback')).status).toBe(200);
    expect(driver.rollbackMove).toHaveBeenCalledWith('move-aaaaaaaa');
    expect((await request(app()).post('/api/team-moves/move-aaaaaaaa/rollback').set('x-test-caller', 'agent')).status).toBe(403);
    expect((await request(app()).post('/api/team-moves/bad/rollback')).status).toBe(400);
  });
});
