import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SharedChannelTrialStore } from './shared-channel-trial.store.js';

describe('SharedChannelTrialStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sc-trial-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('counts approved sends per link and keeps them across instances', () => {
    const a = SharedChannelTrialStore.inDir(dir, 't.json');
    expect(a.approvedCount('l1')).toBe(0);
    expect(a.noteApproved('l1')).toBe(1);
    expect(a.noteApproved('l1')).toBe(2);
    expect(a.noteApproved('l2')).toBe(1);
    const b = SharedChannelTrialStore.inDir(dir, 't.json');
    expect(b.approvedCount('l1')).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, 't.json'), 'utf-8'))).toEqual({ l1: 2, l2: 1 });
  });

  it('ignores a corrupt file and odd values', () => {
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(SharedChannelTrialStore.inDir(dir, 'bad.json').approvedCount('l1')).toBe(0);
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ a: 'x', b: -1, c: 3.7 }));
    const s = SharedChannelTrialStore.inDir(dir, 'odd.json');
    expect(s.approvedCount('a')).toBe(0);
    expect(s.approvedCount('b')).toBe(0);
    expect(s.approvedCount('c')).toBe(3);
  });

  it('never throws when the file cannot be written', () => {
    writeFileSync(join(dir, 'f'), 'file');
    const s = new SharedChannelTrialStore(join(dir, 'f', 'x', 't.json'));
    expect(() => s.noteApproved('l')).not.toThrow();
    expect(s.approvedCount('l')).toBe(1);
  });
});
