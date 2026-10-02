/**
 * Tests for the people directory (issue #968).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PeopleDirectoryError, PeopleDirectoryService, cleanPersonName, isPersonId, isPersonRole } from './people-directory.service.js';

describe('PeopleDirectoryService', () => {
	let dir: string;
	let owner: string | null;
	let directory: PeopleDirectoryService;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-'));
		owner = 'UOWNER01';
		directory = new PeopleDirectoryService({ filePath: path.join(dir, 'people.json'), getOwnerSlackUserId: () => owner, now: () => Date.UTC(2026, 9, 3) });
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('always lists the owner first, as owner', () => {
		expect(directory.list()).toEqual([expect.objectContaining({ id: 'UOWNER01', role: 'owner' })]);
		owner = null;
		expect(directory.list()[0]).toMatchObject({ id: 'owner', role: 'owner' });
		expect(directory.ownerId()).toBe('owner');
	});

	it('recognises the owner by Slack id or the placeholder', () => {
		expect(directory.isOwner('UOWNER01')).toBe(true);
		expect(directory.isOwner('owner')).toBe(true);
		expect(directory.isOwner('UINFO001')).toBe(false);
		expect(directory.roleOf('UOWNER01')).toBe('owner');
	});

	it('adds a Slack user who messages an agent as a member, fills a missing name, never changes a role', () => {
		directory.noteSeen('UINFO001');
		expect(directory.get('UINFO001')).toMatchObject({ role: 'member', source: 'auto' });
		directory.noteSeen('UINFO001', '  Info   Wang ');
		expect(directory.get('UINFO001')?.name).toBe('Info Wang');
		directory.upsert('UINFO001', { role: 'guest' });
		directory.noteSeen('UINFO001', 'Someone Else');
		expect(directory.get('UINFO001')).toMatchObject({ role: 'guest', name: 'Info Wang' });
		directory.noteSeen('not-a-slack-id', 'x');
		expect(directory.list()).toHaveLength(2);
	});

	it('an unknown person is a member; displayName falls back to the id or "the owner"', () => {
		expect(directory.roleOf('UNOBODY01')).toBe('member');
		expect(directory.displayName('UNOBODY01')).toBe('UNOBODY01');
		owner = null;
		expect(directory.displayName('owner')).toBe('the owner');
	});

	it('the owner edits people; invalid edits are refused', () => {
		expect(directory.upsert('USTEVE01', { name: 'Steve', role: 'member' })).toMatchObject({ id: 'USTEVE01', name: 'Steve', role: 'member', source: 'owner' });
		expect(directory.upsert('UOWNER01', { name: 'Ina' })).toMatchObject({ id: 'UOWNER01', name: 'Ina', role: 'owner' });
		expect(() => directory.upsert('UOWNER01', { role: 'member' })).toThrow(PeopleDirectoryError);
		expect(() => directory.upsert('USTEVE01', { role: 'owner' })).toThrow(PeopleDirectoryError);
		expect(() => directory.upsert('bad id', { name: 'x' })).toThrow(PeopleDirectoryError);
		expect(() => directory.upsert('USTEVE01', { role: 'admin' })).toThrow(PeopleDirectoryError);
		expect(directory.upsert('USTEVE01', { name: null })).not.toHaveProperty('name');
	});

	it('removes people but never the owner', () => {
		directory.noteSeen('USTEVE01', 'Steve');
		expect(directory.remove('USTEVE01')).toBe(true);
		expect(directory.remove('USTEVE01')).toBe(false);
		expect(() => directory.remove('UOWNER01')).toThrow(PeopleDirectoryError);
	});

	it('survives a corrupt file and drops invalid rows', () => {
		fs.writeFileSync(path.join(dir, 'people.json'), 'not json');
		expect(directory.list()).toHaveLength(1);
		fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify({ people: [{ id: 'USTEVE01', role: 'member' }, { id: 'x', role: 'member' }, { id: 'UINFO001', role: 'boss' }] }));
		expect(directory.list().map((p) => p.id)).toEqual(['UOWNER01', 'USTEVE01']);
	});
});

describe('people helpers', () => {
	it('validates ids, roles and names', () => {
		expect(isPersonId('U0123ABCD')).toBe(true);
		expect(isPersonId('owner')).toBe(true);
		expect(isPersonId('u123')).toBe(false);
		expect(isPersonRole('guest')).toBe(true);
		expect(isPersonRole('admin')).toBe(false);
		expect(cleanPersonName('  a  b ')).toBe('a b');
		expect(cleanPersonName('   ')).toBeUndefined();
		expect(cleanPersonName('x'.repeat(200))).toHaveLength(80);
	});
});
