/**
 * Tests for grant sharing shapes, the local copy of Cloud's rule, and the
 * refusal message (issue #968).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GrantSharingError, mayUseGrant, notPermittedMessage, readNotPermitted, validateAuthorizedBy, validateSharing } from './grant-sharing.js';
import { PeopleDirectoryService, setPeopleDirectoryForTesting } from './people-directory.service.js';

describe('grant sharing', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-sharing-'));
		const people = new PeopleDirectoryService({ filePath: path.join(dir, 'people.json'), getOwnerSlackUserId: () => 'UOWNER01' });
		people.upsert('UINFO001', { name: 'Info' });
		people.upsert('UOWNER01', { name: 'Ina' });
		setPeopleDirectoryForTesting(people);
	});

	afterEach(() => {
		setPeopleDirectoryForTesting(null);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('validates sharing and owners', () => {
		expect(validateSharing({ mode: 'owner' })).toEqual({ mode: 'owner' });
		expect(validateSharing({ mode: 'members', people: ['UX0000001'] })).toEqual({ mode: 'members' });
		expect(validateSharing({ mode: 'people', people: ['USTEVE01', 'USTEVE01'] })).toEqual({ mode: 'people', people: ['USTEVE01'] });
		for (const bad of [null, [], { mode: 'everyone' }, { mode: 'people' }, { mode: 'people', people: ['nope'] }]) {
			expect(() => validateSharing(bad)).toThrow(GrantSharingError);
		}
		expect(validateAuthorizedBy('UINFO001')).toBe('UINFO001');
		// The owner's Slack id is sent as "owner".
		expect(validateAuthorizedBy('UOWNER01')).toBe('owner');
		expect(() => validateAuthorizedBy('x')).toThrow(GrantSharingError);
	});

	it("matches Cloud's rule: Steve is refused Info's private calendar, Info is not, a members-shared Drive works for all members", () => {
		const isOwner = (id: string) => id === 'UOWNER01' || id === 'owner';
		const steve = { id: 'USTEVE01', role: 'member' as const };
		const info = { id: 'UINFO001', role: 'member' as const };
		expect(mayUseGrant({ authorizedBy: 'UINFO001' }, steve, isOwner)).toBe(false);
		expect(mayUseGrant({ authorizedBy: 'UINFO001' }, info, isOwner)).toBe(true);
		expect(mayUseGrant({ authorizedBy: 'UINFO001', sharing: { mode: 'members' } }, steve, isOwner)).toBe(true);
		expect(mayUseGrant({ authorizedBy: 'UINFO001', sharing: { mode: 'members' } }, { id: 'UG1', role: 'guest' }, isOwner)).toBe(false);
		expect(mayUseGrant({}, { id: 'UOWNER01', role: 'owner' }, isOwner)).toBe(true);
		// A grant from before per-person access keeps working for members, not guests.
		expect(mayUseGrant({}, steve, isOwner)).toBe(true);
		expect(mayUseGrant({}, { id: 'UG1', role: 'guest' }, isOwner)).toBe(false);
		expect(mayUseGrant({ authorizedBy: 'owner' }, steve, isOwner)).toBe(false);
		expect(mayUseGrant({ authorizedBy: 'UOWNER01' }, { id: 'owner', role: 'owner' }, isOwner)).toBe(true);
	});

	it("says whose it is: \"Info's Google Calendar isn't shared with you\"", () => {
		expect(notPermittedMessage('Google Calendar', 'UINFO001')).toBe(
			"Info's Google Calendar isn't shared with you. Ask Info for what you need, or ask the Crewly owner to share it in Connections.",
		);
		expect(notPermittedMessage('Gmail', 'owner')).toBe("Ina's Gmail isn't shared with you. Ask Ina to share it in Connections.");
		expect(notPermittedMessage('Canva', null)).toBe("This Canva isn't shared with you. Ask the Crewly owner to share it in Connections.");
	});

	it("reads Cloud's refusal", () => {
		expect(readNotPermitted({ code: 'not_permitted', details: { authorizedBy: 'UINFO001' } })).toEqual({ authorizedBy: 'UINFO001' });
		expect(readNotPermitted({ error: 'not_permitted' })).toEqual({});
		expect(readNotPermitted({ code: 'not_connected' })).toBeNull();
		expect(readNotPermitted(null)).toBeNull();
	});
});
