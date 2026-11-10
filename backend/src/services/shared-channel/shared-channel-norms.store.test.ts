import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SharedChannelNormsStore } from './shared-channel-norms.store.js';

describe('SharedChannelNormsStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sc-norms-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty norm for an unknown link', () => {
    expect(SharedChannelNormsStore.inDir(dir, 'n.json').get('l1')).toEqual({ norm: '', allow: [], updatedAt: '' });
  });

  it('sets fields, keeps the ones left out, and persists privately', () => {
    const s = new SharedChannelNormsStore(join(dir, 'n.json'), () => Date.parse('2026-11-10T10:00:00.000Z'));
    const first = s.set('l1', { norm: 'Printer partner', allow: ['wiki_notes', 'money'] });
    expect(first.before).toEqual({ norm: '', allow: [], updatedAt: '' });
    expect(first.after).toEqual({ norm: 'Printer partner', allow: ['money', 'wiki_notes'], updatedAt: '2026-11-10T10:00:00.000Z' });
    const second = s.set('l1', { allow: [] });
    expect(second.after.norm).toBe('Printer partner');
    expect(second.after.allow).toEqual([]);
    const again = SharedChannelNormsStore.inDir(dir, 'n.json');
    expect(again.get('l1')).toMatchObject({ norm: 'Printer partner', allow: [] });
    expect(statSync(join(dir, 'n.json')).mode & 0o777).toBe(0o600);
  });

  it('adds allowances without duplicates', () => {
    const s = SharedChannelNormsStore.inDir(dir, 'n.json');
    s.set('l1', { allow: ['money'] });
    const r = s.addAllowances('l1', ['contact_details', 'money']);
    expect(r.before.allow).toEqual(['money']);
    expect(r.after.allow).toEqual(['money', 'contact_details']);
  });

  it('reads a corrupt or odd file as no norms (never looser)', () => {
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(SharedChannelNormsStore.inDir(dir, 'bad.json').get('l1').allow).toEqual([]);
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ a: 'x', b: { norm: 3, allow: ['secret', 'money'] } }));
    const s = SharedChannelNormsStore.inDir(dir, 'odd.json');
    expect(s.get('a')).toEqual({ norm: '', allow: [], updatedAt: '' });
    expect(s.get('b')).toEqual({ norm: '', allow: ['money'], updatedAt: '' });
    expect(JSON.parse(readFileSync(join(dir, 'odd.json'), 'utf-8')).a).toBe('x');
  });

  it('throws when the file cannot be written, keeping the old norm', () => {
    writeFileSync(join(dir, 'f'), 'file');
    const s = new SharedChannelNormsStore(join(dir, 'f', 'x', 'n.json'));
    expect(() => s.set('l', { allow: ['money'] })).toThrow();
    expect(s.get('l').allow).toEqual([]);
  });

  it('hands out copies', () => {
    const s = SharedChannelNormsStore.inDir(dir, 'n.json');
    s.set('l1', { allow: ['money'] });
    s.get('l1').allow.push('code_blocks');
    expect(s.get('l1').allow).toEqual(['money']);
  });
});
