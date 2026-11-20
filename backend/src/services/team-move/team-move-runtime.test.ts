import { StorageService } from '../core/storage.service.js';
import { TeamMoveDriver } from './team-move-driver.service.js';
import { adoptAdhocMappingInFile, createTeamMoveDriver } from './team-move-runtime.js';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('createTeamMoveDriver', () => {
  it('composes a driver from the backend singletons; not signed in, it has nothing to poll', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'move-runtime-'));
    try {
      const driver = createTeamMoveDriver({ storage: new StorageService(home), relay: new EventEmitter() as never, home });
      expect(driver).toBeInstanceOf(TeamMoveDriver);
      expect(await driver.poll()).toBe(0);
      expect(await driver.listMoves()).toEqual([]);
      expect(await driver.housekeeping()).toEqual([]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('adoptAdhocMappingInFile (the Slack service is not running)', () => {
  const incoming = { teamId: 'adhoc:CSHARED', slackChannelId: 'CSHARED', slackChannelName: 'shared', chatChannelId: 'huddle-src', members: ['moved-a'] };
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'adopt-adhoc-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  const read = async () => (JSON.parse(await fs.readFile(path.join(home, 'slack-team-channels.json'), 'utf8')) as { mappings: Array<Record<string, unknown>> }).mappings;

  it('adds an unknown channel as it came', async () => {
    expect(await adoptAdhocMappingInFile(home, incoming)).toEqual({ chatChannelId: 'huddle-src', added: true });
    expect(await read()).toHaveLength(1);
  });

  it('keeps the channel the machine already maps and adds the arriving agents once', async () => {
    await fs.writeFile(path.join(home, 'slack-team-channels.json'), JSON.stringify({ version: 1, mappings: [{ ...incoming, chatChannelId: 'huddle-local', members: ['local-a'] }] }));
    expect(await adoptAdhocMappingInFile(home, incoming)).toEqual({ chatChannelId: 'huddle-local', added: false });
    expect(await adoptAdhocMappingInFile(home, incoming)).toEqual({ chatChannelId: 'huddle-local', added: false });
    const [m] = await read();
    expect(m!['members']).toEqual(['local-a', 'moved-a']);
  });

  it('ignores anything that is not an ad-hoc mapping', async () => {
    expect(await adoptAdhocMappingInFile(home, { ...incoming, teamId: 'team-1' })).toBeNull();
  });
});
