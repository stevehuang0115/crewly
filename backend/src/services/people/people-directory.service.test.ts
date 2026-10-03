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
	let env: NodeJS.ProcessEnv;
	let bots: string[];
	let directory: PeopleDirectoryService;
	const file = (): string => path.join(dir, 'people.json');

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-'));
		owner = 'UOWNER01';
		env = {};
		bots = ['UBOTDEV1'];
		directory = new PeopleDirectoryService({
			filePath: file(),
			getOwnerSlackUserId: () => owner,
			isBot: (id) => bots.includes(id),
			env,
			now: () => Date.UTC(2026, 9, 3),
		});
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('always lists the owner first, as "owner", with their known Slack ids', () => {
		expect(directory.list()).toEqual([expect.objectContaining({ id: 'owner', role: 'owner', slackUserIds: ['UOWNER01'] })]);
		owner = null;
		expect(directory.list()[0]).toMatchObject({ id: 'owner', role: 'owner' });
		expect(directory.list()[0]).not.toHaveProperty('slackUserIds');
		expect(directory.ownerId()).toBe('owner');
	});

	it('recognises the owner by Slack id or "owner", and maps both to "owner"', () => {
		expect(directory.isOwner('UOWNER01')).toBe(true);
		expect(directory.isOwner('owner')).toBe(true);
		expect(directory.isOwner('UINFO001')).toBe(false);
		expect(directory.roleOf('UOWNER01')).toBe('owner');
		expect(directory.canonicalId('UOWNER01')).toBe('owner');
		expect(directory.canonicalId('UINFO001')).toBe('UINFO001');
	});

	describe('Slack credentials from env / no installer known', () => {
		beforeEach(() => {
			owner = null;
		});

		it("without any owner Slack id, the owner's Slack messages would be a member's — SLACK_OWNER_USER_ID fixes that", () => {
			expect(directory.roleOf('UOWNER01')).toBe('member');
			env['SLACK_OWNER_USER_ID'] = ' UOWNER01 , UOWNER02,bad ';
			expect(directory.ownerSlackUserIds()).toEqual(['UOWNER01', 'UOWNER02']);
			expect(directory.roleOf('UOWNER01')).toBe('owner');
			expect(directory.canonicalId('UOWNER02')).toBe('owner');
		});

		it('the owner can mark their Slack id as their own in Settings › People', () => {
			directory.noteSeen('UOWNER01', 'Ina');
			expect(directory.get('UOWNER01')).toMatchObject({ role: 'member' });
			expect(directory.upsert('UOWNER01', { role: 'owner' })).toMatchObject({ id: 'owner', role: 'owner', name: 'Ina', slackUserIds: ['UOWNER01'] });
			expect(directory.isOwner('UOWNER01')).toBe(true);
			// No member row for the owner remains.
			expect(directory.list().map((p) => p.id)).toEqual(['owner']);
			expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).ownerSlackUserIds).toEqual(['UOWNER01']);
		});
	});

	it("never adds the owner's Slack id as a member, and takes their name for the owner row", () => {
		directory.noteSeen('UOWNER01', 'Ina');
		expect(directory.list()).toEqual([expect.objectContaining({ id: 'owner', name: 'Ina' })]);
	});

	it('a row from before the owner was always "owner" (keyed by their Slack id) folds into the owner row', () => {
		fs.writeFileSync(file(), JSON.stringify({ people: [{ id: 'UOWNER01', name: 'Ina', role: 'owner', source: 'owner', createdAt: '', updatedAt: '' }] }));
		expect(directory.list()).toEqual([expect.objectContaining({ id: 'owner', name: 'Ina', role: 'owner' })]);
		expect(directory.get('UOWNER01')).toMatchObject({ id: 'owner', name: 'Ina' });
	});

	it('bots are never people: not added, refused, and removed from the file on load', () => {
		directory.noteSeen('UBOTDEV1', 'Dev bot');
		expect(directory.get('UBOTDEV1')).toBeNull();
		expect(() => directory.upsert('UBOTDEV1', { role: 'member' })).toThrow(PeopleDirectoryError);
		fs.writeFileSync(
			file(),
			JSON.stringify({ people: [{ id: 'UBOTDEV2', role: 'member', source: 'auto' }, { id: 'UINFO001', role: 'member', source: 'auto' }] }),
		);
		bots.push('UBOTDEV2');
		expect(directory.list().map((p) => p.id)).toEqual(['owner', 'UINFO001']);
		expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).people.map((p: { id: string }) => p.id)).toEqual(['UINFO001']);
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
		expect(directory.upsert('UOWNER01', { name: 'Ina' })).toMatchObject({ id: 'owner', name: 'Ina', role: 'owner' });
		expect(() => directory.upsert('UOWNER01', { role: 'member' })).toThrow(PeopleDirectoryError);
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
		expect(directory.list().map((p) => p.id)).toEqual(['owner', 'USTEVE01']);
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
