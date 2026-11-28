import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EntryStoreShrinkError, withEntryStore, writeEntryStore } from './entry-store.writer.js';

const entry = (id: string) => ({ id, text: `text ${id}` });

describe('writeEntryStore', () => {
  let dir: string;
  let file: string;
  const stored = async (name = file) => JSON.parse(await fs.readFile(name, 'utf-8'));
  const seed = (...ids: string[]) => fs.writeFile(file, JSON.stringify(ids.map(entry)));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'entry-store-'));
    file = path.join(dir, 'store.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a missing store', async () => {
    await writeEntryStore(file, [entry('a')]);
    expect(await stored()).toEqual([entry('a')]);
    expect(await fs.readdir(dir)).toEqual(['store.json']);
  });

  it('keeps the previous version when it writes', async () => {
    await seed('a');
    await writeEntryStore(file, [entry('a'), entry('b')]);
    expect(await stored()).toHaveLength(2);
    expect(await stored(`${file}.bak`)).toEqual([entry('a')]);
  });

  it.each([
    ['an empty list', []],
    ['only new entries (a caller that loaded nothing)', [entry('x'), entry('y'), entry('z'), entry('w')]],
    ['one entry short', [entry('a'), entry('b')]],
  ])('refuses %s and leaves the file as it was', async (_what, next) => {
    await seed('a', 'b', 'c');
    const before = await fs.readFile(file, 'utf-8');

    await expect(writeEntryStore(file, next)).rejects.toBeInstanceOf(EntryStoreShrinkError);

    expect(await fs.readFile(file, 'utf-8')).toBe(before);
    expect(await fs.readdir(dir)).toEqual(['store.json']);
  });

  it('refuses to drop entries that have no id', async () => {
    await fs.writeFile(file, JSON.stringify([{ text: '1' }, { text: '2' }]));
    await expect(writeEntryStore(file, [])).rejects.toBeInstanceOf(EntryStoreShrinkError);
  });

  it('allows exactly the removal the caller names', async () => {
    await seed('a', 'b', 'c');
    await writeEntryStore(file, [entry('b'), entry('c'), entry('d')], { removing: ['a'] });
    expect((await stored()).map((e: { id: string }) => e.id)).toEqual(['b', 'c', 'd']);
    expect((await fs.readdir(dir)).sort()).toEqual(['store.json', 'store.json.bak']);

    await expect(writeEntryStore(file, [entry('d')], { removing: ['b'] })).rejects.toBeInstanceOf(EntryStoreShrinkError);
  });

  it('keeps a dated copy of a removal of several entries', async () => {
    await seed('a', 'b', 'c');
    await writeEntryStore(file, [entry('c')], { removing: ['a', 'b'] });
    await writeEntryStore(file, [entry('c'), entry('d')]);

    const dated = (await fs.readdir(dir)).filter((n) => n.startsWith('store.json.before-removal-'));
    expect(dated).toHaveLength(1);
    expect(await stored(path.join(dir, dated[0]!))).toHaveLength(3);
  });

  it('sets aside a file that is not a list before replacing it', async () => {
    await fs.writeFile(file, '{"broken":');
    await writeEntryStore(file, [entry('a')]);
    const aside = (await fs.readdir(dir)).filter((n) => n.startsWith('store.json.corrupt-'));
    expect(await fs.readFile(path.join(dir, aside[0]!), 'utf-8')).toBe('{"broken":');
  });

  it('writes nothing when the store cannot be read', async () => {
    await fs.mkdir(file);
    await expect(writeEntryStore(file, [entry('a')])).rejects.toThrow(/EISDIR/);
  });

  it('serialises read-modify-write so no add is lost', async () => {
    await seed();
    const add = (id: string) =>
      withEntryStore(file, async () => {
        const list = await stored();
        await writeEntryStore(file, [...list, entry(id)]);
      });
    await Promise.all(['a', 'b', 'c', 'd'].map(add));
    expect(await stored()).toHaveLength(4);
  });
});
