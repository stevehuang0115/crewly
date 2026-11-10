import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SharedChannelCursorStore } from './shared-channel-cursor.store.js';

describe('SharedChannelCursorStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sc-cursor-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists cursors across instances', () => {
    const a = SharedChannelCursorStore.inDir(dir, 'c.json');
    expect(a.get('l1')).toBeUndefined();
    a.set('l1', 'm5');
    expect(SharedChannelCursorStore.inDir(dir, 'c.json').get('l1')).toBe('m5');
    expect(JSON.parse(readFileSync(join(dir, 'c.json'), 'utf-8'))).toEqual({ l1: 'm5' });
  });

  it('starts empty from a corrupt or odd file', () => {
    writeFileSync(join(dir, 'c.json'), '{nope');
    expect(SharedChannelCursorStore.inDir(dir, 'c.json').get('l1')).toBeUndefined();
    writeFileSync(join(dir, 'd.json'), JSON.stringify({ a: 1, b: 'x' }));
    const s = SharedChannelCursorStore.inDir(dir, 'd.json');
    expect(s.get('a')).toBeUndefined();
    expect(s.get('b')).toBe('x');
  });

  it('never throws when the directory cannot be written', () => {
    const s = new SharedChannelCursorStore(join(dir, 'f.json', 'x', 'c.json'));
    writeFileSync(join(dir, 'f.json'), 'file');
    expect(() => s.set('l', 'm')).not.toThrow();
    expect(s.get('l')).toBe('m');
  });
});
