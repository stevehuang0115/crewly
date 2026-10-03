/**
 * Tests for the acting-for record (issue #968).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActingForService, actingForHeaders, actorCacheSuffix, currentActor, runAsActor } from './acting-for.service.js';
import { PeopleDirectoryService } from './people-directory.service.js';

describe('ActingForService', () => {
	let dir: string;
	let people: PeopleDirectoryService;
	let service: ActingForService;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acting-for-'));
		people = new PeopleDirectoryService({
			filePath: path.join(dir, 'people.json'),
			getOwnerSlackUserId: () => 'UOWNER01',
			isBot: (id) => id === 'UBOTDEV1' || id === 'UMASTER1',
			env: {},
		});
		people.upsert('UGUEST01', { name: 'Gus', role: 'guest' });
		service = new ActingForService({ filePath: path.join(dir, 'acting-for.json'), people: () => people });
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('a Slack message makes the agent act for its sender; a dashboard message for the owner', () => {
		service.recordHumanMessage('dev-1', 'UINFO001');
		expect(service.get('dev-1')).toMatchObject({ personId: 'UINFO001', source: 'slack' });
		expect(service.actorFor('dev-1')).toEqual({ id: 'UINFO001', role: 'member', name: 'UINFO001' });
		// The sender is now in the directory.
		expect(people.get('UINFO001')).toMatchObject({ role: 'member' });

		service.recordHumanMessage('dev-1', null);
		expect(service.actorFor('dev-1')).toEqual({ id: 'owner', role: 'owner', name: 'the owner' });
	});

	it("the owner's own Slack message is stored and sent as \"owner\", never as their Slack id", () => {
		service.recordHumanMessage('dev-1', 'UOWNER01');
		expect(service.get('dev-1')).toMatchObject({ personId: 'owner', source: 'slack' });
		expect(service.actorFor('dev-1')).toEqual({ id: 'owner', role: 'owner', name: 'the owner' });
		// The owner is not added to the directory as a member.
		expect(people.list().map((p) => p.id)).toEqual(['owner', 'UGUEST01']);
	});

	it('no agent session (the dashboard) and an agent without a record act for the owner', () => {
		expect(service.actorFor(undefined).id).toBe('owner');
		expect(service.actorFor('never-seen').role).toBe('owner');
	});

	it("a bot's message is never recorded as a person, nor added to the directory", () => {
		service.recordHumanMessage('dev-1', 'UINFO001');
		service.recordHumanMessage('dev-1', 'UBOTDEV1');
		expect(service.get('dev-1')).toMatchObject({ personId: 'UINFO001', source: 'slack' });
		expect(people.get('UBOTDEV1')).toBeNull();
		// A record an earlier version left pointing at a bot reads as the owner.
		service.record('dev-2', 'UMASTER1', 'slack');
		expect(service.actorFor('dev-2').id).toBe('owner');
	});

	it('a message an agent wrote passes on that agent\'s person, or leaves the target alone', () => {
		service.recordHumanMessage('lead-1', 'UINFO001');
		service.recordHumanMessage('dev-1', 'UGUEST01');
		service.inheritFromAgent('dev-1', 'lead-1');
		expect(service.get('dev-1')).toMatchObject({ personId: 'UINFO001', source: 'agent' });
		// An agent on another machine (no record here): unchanged.
		service.inheritFromAgent('dev-1', 'remote-agent');
		expect(service.get('dev-1')?.personId).toBe('UINFO001');
		service.inheritFromAgent('fresh', 'remote-agent');
		expect(service.get('fresh')).toBeNull();
	});

	it('a scheduled or system turn acts for the owner, not the last human', () => {
		service.recordHumanMessage('crewly-orc', 'UINFO001');
		service.recordSystemTurn('crewly-orc');
		expect(service.get('crewly-orc')).toMatchObject({ personId: 'owner', source: 'system' });
		expect(service.actorFor('crewly-orc')).toMatchObject({ id: 'owner', role: 'owner' });
		// The next human message takes over again.
		service.recordHumanMessage('crewly-orc', 'UINFO001');
		expect(service.actorFor('crewly-orc').id).toBe('UINFO001');
	});

	it('a guest is reported as a guest', () => {
		service.recordHumanMessage('dev-1', 'UGUEST01');
		expect(service.actorFor('dev-1')).toEqual({ id: 'UGUEST01', role: 'guest', name: 'Gus' });
	});

	it('an agent asked by another agent acts for the same person', () => {
		service.recordHumanMessage('lead-1', 'UINFO001');
		service.inherit('dev-2', 'lead-1');
		expect(service.get('dev-2')).toMatchObject({ personId: 'UINFO001', source: 'agent' });
		// From an agent with no record: the owner.
		service.inherit('dev-3', 'nobody');
		expect(service.get('dev-3')?.personId).toBe('owner');
		service.inherit('dev-2', 'dev-2');
		expect(service.get('dev-2')?.personId).toBe('UINFO001');
	});

	it('is kept across a restart', () => {
		service.recordHumanMessage('dev-1', 'UINFO001');
		service.recordSystemTurn('crewly-orc');
		const again = new ActingForService({ filePath: path.join(dir, 'acting-for.json'), people: () => people });
		expect(again.get('dev-1')?.personId).toBe('UINFO001');
		expect(again.get('crewly-orc')?.source).toBe('system');
		again.clear();
		expect(again.get('dev-1')).toBeNull();
	});
});

describe('actor context', () => {
	it('is empty outside a connector request, and set inside one (also across awaits)', async () => {
		expect(currentActor()).toBeNull();
		expect(actingForHeaders()).toEqual({});
		expect(actorCacheSuffix()).toBe('');
		const actor = { id: 'UINFO001', role: 'member' as const, name: 'Info' };
		await runAsActor(actor, async () => {
			await new Promise((r) => setImmediate(r));
			expect(currentActor()).toEqual(actor);
			expect(actingForHeaders()).toEqual({ 'X-Crewly-Acting-For': 'UINFO001', 'X-Crewly-Acting-For-Role': 'member' });
			expect(actorCacheSuffix()).toBe('\0UINFO001');
		});
		expect(currentActor()).toBeNull();
	});
});
