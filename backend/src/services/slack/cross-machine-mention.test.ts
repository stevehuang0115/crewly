/**
 * Cross-machine mentions: tell the author who in the thread did not get the
 * post (CREW-860), without ever adding a tag to it (CREW-1318).
 */
import { describe, it, expect } from '@jest/globals';
import {
	addresses,
	planCrossMachineMention,
	remoteAgentsInThread,
	type RemoteRoomAgent,
	type ThreadTurn,
} from './cross-machine-mention.js';

const owen: RemoteRoomAgent = { name: 'Owen (CE)', agentSession: 'ce-owen-1', botUserId: 'UOWEN', machine: 'iriss-air' };
const lead: RemoteRoomAgent = { name: 'Lead', agentSession: 'ce-lead-1', botUserId: null, machine: 'iriss-air' }; // app-less
const wren: RemoteRoomAgent = { name: 'Wren', agentSession: 'ce-wren-1', botUserId: null, machine: 'studio' };
const ROOM = [owen, lead, wren];

const human: ThreadTurn = {};
const ours: ThreadTurn = { mentions: [] };
const fromOwen: ThreadTurn = { remoteSession: 'ce-owen-1' };

describe('addresses', () => {
	it('an agent with a bot is addressed by <@BOTID>, or by a unique @Name (it is linked to the bot)', () => {
		expect(addresses('hi <@UOWEN> look', owen, ROOM)).toBe(true);
		expect(addresses('can @owen check', owen, ROOM)).toBe(true);
		expect(addresses('Owen, please', owen, ROOM)).toBe(false); // an opening bare name is not linked
		expect(addresses('email me at x@owenfoo.com', owen, ROOM)).toBe(false);
	});

	it('a plain @Name that is ambiguous in the room will not be linked, so it does not count', () => {
		const owen2: RemoteRoomAgent = { name: 'Owen (Sales)', agentSession: 'sales-owen-1', botUserId: 'UOWEN2', machine: 'studio' };
		expect(addresses('@Owen look', owen, [owen, owen2])).toBe(false);
		expect(addresses('<@UOWEN> look', owen, [owen, owen2])).toBe(true);
	});

	it('a short name shared with a bot agent on THIS machine will not be linked either (two Ellas)', () => {
		const ella: RemoteRoomAgent = { name: 'Ella (Personal Assistant)', agentSession: 'pa-ella-1', botUserId: 'UELLAPA', machine: 'studio' };
		expect(addresses('@Ella hi', ella, [ella], ['Ella (Crewly Marketing)'])).toBe(false);
		expect(addresses('<@UELLAPA> hi', ella, [ella], ['Ella (Crewly Marketing)'])).toBe(true);
		expect(addresses('@Ella hi', ella, [ella], ['Sam (Crewly Marketing)'])).toBe(true);
	});

	it('an app-less agent is addressed by its plain name (@Name anywhere, or opening the text)', () => {
		expect(addresses('Lead, please send it', lead, ROOM)).toBe(true);
		expect(addresses('can @lead check', lead, ROOM)).toBe(true);
		expect(addresses('ask Lead later', lead, ROOM)).toBe(false);
	});
});

describe('remoteAgentsInThread', () => {
	it('is the other-machine agents that posted or were @-mentioned, never anyone else', () => {
		const got = remoteAgentsInThread(ROOM, [human, fromOwen, { mentions: ['ce-lead-1', 'some-local-agent'] }]);
		expect(got.map((a) => a.name)).toEqual(['Owen (CE)', 'Lead']);
		expect(got).not.toContain(wren);
	});
});

describe('planCrossMachineMention: tells the author, never edits the post', () => {
	it('returns no post text at all, so it cannot add a tag', () => {
		const plan = planCrossMachineMention('Here is the enquiry form.', ROOM, [human, fromOwen]);
		expect(Object.keys(plan).sort()).toEqual(['note', 'unreached']);
	});

	it('names the agents in the thread the post does not reach, with the tag that means exactly them', () => {
		const plan = planCrossMachineMention('Here is the form.', ROOM, [human, fromOwen, { remoteSession: 'ce-lead-1' }]);
		expect(plan.unreached).toEqual([owen, lead]);
		expect(plan.note).toContain('Posted as written. It tags nobody on ');
		expect(plan.note).toContain('Owen (CE): <@UOWEN>');
		expect(plan.note).toContain('Lead: @Lead');
		expect(plan.note).toContain('Nothing to do if it was not for them');
	});

	it('does not mention an agent that is not in the thread', () => {
		const plan = planCrossMachineMention('done', ROOM, [human, fromOwen]);
		expect(plan.note).not.toContain('Wren');
		expect(plan.note).not.toContain('Lead');
	});

	it('says nothing when the post already addresses an other-machine agent', () => {
		expect(planCrossMachineMention('@Lead can you check this?', ROOM, [human, fromOwen])).toEqual({ unreached: [], note: null });
	});

	it('says nothing when no other-machine agent is in the thread, or in the room', () => {
		expect(planCrossMachineMention('ok', ROOM, [human, ours]).note).toBeNull();
		expect(planCrossMachineMention('ok', [], [human, fromOwen]).note).toBeNull();
	});

	it('gives a namesake bot its own id, never the shared first name', () => {
		const ella: RemoteRoomAgent = { name: 'Ella (Personal Assistant)', agentSession: 'pa-ella-1', botUserId: 'UELLAPA', machine: 'studio' };
		const plan = planCrossMachineMention('@Ella please check', [ella], [human, { remoteSession: 'pa-ella-1' }], ['Ella (Crewly Marketing)']);
		expect(plan.note).toContain('Ella (Personal Assistant): <@UELLAPA>');
	});
});
