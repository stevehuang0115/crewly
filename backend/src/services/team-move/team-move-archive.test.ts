import * as fs from 'node:fs/promises';
import { emptyTriggerStore } from './team-move.fixture.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { TeamMoveArchiver, type ArchiveDeps } from './team-move-archive.js';

/** Archive and rollback against real stores are covered in team-move.integration.test.ts; here the edges. */
describe('TeamMoveArchiver edges', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'move-arch-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const archiver = (teams: unknown[] = []): { a: TeamMoveArchiver; stop: jest.Mock } => {
    const stop = jest.fn();
    const deps = {
      triggers: emptyTriggerStore(),
      home,
      storage: { getTeams: async () => teams, saveTeam: jest.fn(), detachTeamForMove: jest.fn(), getScheduledMessages: async () => [], saveScheduledMessage: jest.fn(), deleteScheduledMessage: jest.fn() },
      runtime: { stopTeam: stop, startTeam: jest.fn() },
      pool: { read: async () => ({ workItems: [] }), removeWorkItems: async () => 0, addWorkItems: async () => 0 },
      decisions: { list: async () => [], setStatus: jest.fn() },
      slack: { unlink: async () => null, adopt: async () => false },
    } as unknown as ArchiveDeps;
    return { a: new TeamMoveArchiver(deps), stop };
  };

  it('has nothing to archive when the team is not on this machine', async () => {
    const { a, stop } = archiver([]);
    expect(await a.archive('move-edge-0000001', 'ghost')).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it('has nothing to restore when nothing was archived', async () => {
    expect(await archiver().a.restore('move-edge-0000002')).toEqual({ restored: false, started: false });
    expect(await archiver().a.readMeta('move-edge-0000002')).toBeNull();
    expect(await archiver().a.purgeExpired()).toEqual([]);
  });
});
