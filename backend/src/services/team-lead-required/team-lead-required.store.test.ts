/**
 * Tests for the team-lead-required store.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TeamLeadRequiredStore } from './team-lead-required.store.js';

describe('TeamLeadRequiredStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lead-required-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('keeps records in team-lead-required.json under the home', () => {
    const store = TeamLeadRequiredStore.inHome(dir);
    expect(store.get('t1')).toBeNull();
    store.set({ teamId: 't1', status: 'asked', updatedAt: '2026-11-26T00:00:00.000Z', decisionId: 'D-1', candidates: [{ memberId: 'm1', label: 'Pia' }] });
    expect(fs.existsSync(path.join(dir, 'team-lead-required.json'))).toBe(true);
    expect(TeamLeadRequiredStore.inHome(dir).get('t1')).toMatchObject({ status: 'asked', decisionId: 'D-1', candidates: [{ memberId: 'm1', label: 'Pia' }] });
    expect(Object.keys(store.all())).toEqual(['t1']);
  });

  it('deletes a record', () => {
    const store = TeamLeadRequiredStore.inHome(dir);
    store.set({ teamId: 't1', status: 'snoozed', updatedAt: 'x', snoozedUntil: 'y' });
    expect(store.delete('t1')).toBe(true);
    expect(store.delete('t1')).toBe(false);
    expect(store.get('t1')).toBeNull();
  });

  it('reads a broken file or a malformed record as absent', () => {
    const file = path.join(dir, 'team-lead-required.json');
    fs.writeFileSync(file, '{not json');
    const store = new TeamLeadRequiredStore(file);
    expect(store.all()).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ version: 1, teams: { a: { status: 'weird', updatedAt: 'x' }, b: { status: 'asked', updatedAt: 'x' } } }));
    expect(Object.keys(store.all())).toEqual(['b']);
    expect(store.get('b')?.teamId).toBe('b');
  });
});
