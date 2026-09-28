/**
 * Tests for ticket folder locking and id allocation — including concurrent
 * writers in one process and writers that share only the lockfile (a second
 * copy of the module, standing in for a second process).
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { allocateTicketId, derivePrefix, readCounter, withTicketFolderLock } from './ticket-folder-lock.js';

describe('ticket-folder-lock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-tickets-lock-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('derives a prefix from the project name', () => {
    expect(derivePrefix('crewly')).toBe('CREW');
    expect(derivePrefix('Steam Fun Portal')).toBe('SFP');
    expect(derivePrefix('my-app')).toBe('MA');
    expect(derivePrefix('中文项目')).toBe('T');
  });

  it('allocates sequential ids and persists the counter', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await withTicketFolderLock(dir, () => allocateTicketId(dir, 'crewly')));
    expect(ids).toEqual(['CREW-1', 'CREW-2', 'CREW-3']);
    expect(await readCounter(dir)).toEqual({ prefix: 'CREW', next: 4 });
  });

  it('keeps the prefix fixed once allocated, even if the project is renamed', async () => {
    await withTicketFolderLock(dir, () => allocateTicketId(dir, 'crewly'));
    expect(await withTicketFolderLock(dir, () => allocateTicketId(dir, 'Renamed Project'))).toBe('CREW-2');
  });

  it('never reuses a number that arrived with a merge (file present, counter behind)', async () => {
    await fs.writeFile(path.join(dir, 'CREW-40-from-a-branch.md'), '---\n---\n');
    await fs.writeFile(path.join(dir, '.counter.json'), JSON.stringify({ prefix: 'CREW', next: 3 }));
    expect(await withTicketFolderLock(dir, () => allocateTicketId(dir, 'crewly'))).toBe('CREW-41');
  });

  it('gives unique ids to many concurrent callers in one process', async () => {
    const ids = await Promise.all(
      Array.from({ length: 25 }, () => withTicketFolderLock(dir, () => allocateTicketId(dir, 'crewly'))),
    );
    expect(new Set(ids).size).toBe(25);
  });

  it('gives unique ids to writers that share only the lockfile (second module copy = second process)', async () => {
    let other: typeof import('./ticket-folder-lock.js') | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      other = require('./ticket-folder-lock');
    });
    expect(other).toBeDefined();
    const mine = Array.from({ length: 10 }, () =>
      withTicketFolderLock(dir, async () => {
        const id = await allocateTicketId(dir, 'crewly');
        await fs.writeFile(path.join(dir, `${id}-x.md`), '');
        return id;
      }),
    );
    const theirs = Array.from({ length: 10 }, () =>
      other!.withTicketFolderLock(dir, async () => {
        const id = await other!.allocateTicketId(dir, 'crewly');
        await fs.writeFile(path.join(dir, `${id}-y.md`), '');
        return id;
      }),
    );
    const ids = await Promise.all([...mine, ...theirs]);
    expect(new Set(ids).size).toBe(20);
  });

  it('waits for a lock held elsewhere, then proceeds', async () => {
    await fs.mkdir(dir, { recursive: true });
    const lock = path.join(dir, '.lock');
    await fs.writeFile(lock, 'other-process');
    let ran = false;
    const pending = withTicketFolderLock(dir, async () => {
      ran = true;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(ran).toBe(false);
    await fs.unlink(lock);
    await pending;
    expect(ran).toBe(true);
  });

  it('takes over a stale lock left by a crashed writer', async () => {
    const lock = path.join(dir, '.lock');
    await fs.writeFile(lock, 'crashed');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    await expect(withTicketFolderLock(dir, async () => 'ok')).resolves.toBe('ok');
  });

  it('releases the lock when the critical section throws, and writes the folder .gitignore', async () => {
    await expect(withTicketFolderLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(fs.access(path.join(dir, '.lock'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toContain('.lock');
  });

  it('treats a corrupt counter as absent', async () => {
    await fs.writeFile(path.join(dir, '.counter.json'), '{nope');
    expect(await readCounter(dir)).toBeNull();
  });
});
