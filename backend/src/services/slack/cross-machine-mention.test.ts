/**
 * Cross-machine mentions: add the thread's other-machine @names, or tell the
 * author nobody there got the post (CREW-860).
 */
import { describe, it, expect } from '@jest/globals';
import { CROSS_MACHINE_MENTION_CONSTANTS as C } from '../../constants.js';
import {
	addresses,
	planCrossMachineMention,
	remoteAgentsInThread,
	trailingAgentTurns,
	type RemoteRoomAgent,
	type ThreadTurn,
} from './cross-machine-mention.js';

const owen: RemoteRoomAgent = { name: 'Owen (CE)', agentSession: 'ce-owen-1', botUserId: 'UOWEN', machine: 'iriss-air' };
const lead: RemoteRoomAgent = { name: 'Lead', agentSession: 'ce-lead-1', botUserId: null, machine: 'iriss-air' };
const wren: RemoteRoomAgent = { name: 'Wren', agentSession: 'ce-wren-1', botUserId: null, machine: 'studio' };
const ROOM = [owen, lead, wren];

const human: ThreadTurn = { by: 'human' };
const ours: ThreadTurn = { by: 'agent' };
const fromOwen: ThreadTurn = { by: 'remote-agent', remoteSession: 'ce-owen-1' };

describe('addresses', () => {
	it('counts <@bot>, @Name anywhere (full or short) and a leading name', () => {
		expect(addresses('hi <@UOWEN> look', owen)).toBe(true);
		expect(addresses('can @owen check', owen)).toBe(true);
		expect(addresses('Lead, please send it', lead)).toBe(true);
		expect(addresses('ask Lead later', lead)).toBe(false);
		expect(addresses('email me at x@owenfoo.com', owen)).toBe(false);
	});
});

describe('remoteAgentsInThread', () => {
	it('is the other-machine agents that posted or were @-mentioned, never anyone else', () => {
		const got = remoteAgentsInThread(ROOM, [human, fromOwen, { by: 'agent', mentions: ['ce-lead-1', 'some-local-agent'] }]);
		expect(got.map((a) => a.name)).toEqual(['Owen (CE)', 'Lead']);
		expect(got).not.toContain(wren);
	});
});

describe('planCrossMachineMention (b: add the @names)', () => {
	it('adds the @name of the other-machine agents in the thread to a post that names none', () => {
		const plan = planCrossMachineMention('Here is the enquiry form.', ROOM, [human, fromOwen]);
		expect(plan.content).toBe('@Owen Here is the enquiry form.');
		expect(plan.added).toEqual([owen]);
		expect(plan.note).toContain('Added @Owen');
	});

	it('never adds an agent that is not in the thread', () => {
		const plan = planCrossMachineMention('done', ROOM, [human, fromOwen]);
		expect(plan.content).not.toContain('Wren');
		expect(plan.content).not.toContain('Lead');
	});

	it('leaves a post that already addresses an other-machine agent untouched and says nothing', () => {
		const plan = planCrossMachineMention('@Lead can you check this?', ROOM, [human, fromOwen]);
		expect(plan).toEqual({ content: '@Lead can you check this?', added: [], unreached: [], note: null });
	});

	it('does nothing when no other-machine agent is in the thread, or in the room (same-machine posts unchanged)', () => {
		expect(planCrossMachineMention('ok', ROOM, [human, ours]).note).toBeNull();
		expect(planCrossMachineMention('ok', ROOM, [human, ours]).content).toBe('ok');
		expect(planCrossMachineMention('ok', [], [human, fromOwen]).content).toBe('ok');
	});
});

describe('planCrossMachineMention (c: tell the author)', () => {
	it('says who it reached nobody of when the @name cannot be added (kill switch)', () => {
		const plan = planCrossMachineMention('Here is the form.', ROOM, [human, fromOwen], { [C.AUTO_ADD_ENV]: C.AUTO_ADD_OFF_VALUE });
		expect(plan.content).toBe('Here is the form.');
		expect(plan.unreached).toEqual([owen]);
		expect(plan.note).toContain('reached nobody on iriss-air');
		expect(plan.note).toContain('Owen (CE)');
		expect(plan.note).toContain('@name');
	});
});

describe('loop guard: no auto-forwarding storm', () => {
	it('stops adding @names after a run of agent turns with no human, and tells the author instead', () => {
		const run: ThreadTurn[] = [human, ...Array.from({ length: C.MAX_CONSECUTIVE_AGENT_TURNS }, () => fromOwen)];
		expect(trailingAgentTurns(run)).toBe(C.MAX_CONSECUTIVE_AGENT_TURNS);
		const plan = planCrossMachineMention('reply', ROOM, run);
		expect(plan.content).toBe('reply');
		expect(plan.added).toEqual([]);
		expect(plan.note).toContain('reached nobody');
	});

	it('still adds below the cap, and a human message resets the run', () => {
		const below: ThreadTurn[] = [human, ...Array.from({ length: C.MAX_CONSECUTIVE_AGENT_TURNS - 1 }, () => fromOwen)];
		expect(planCrossMachineMention('reply', ROOM, below).added).toEqual([owen]);
		const reset: ThreadTurn[] = [...Array.from({ length: 9 }, () => fromOwen), human, fromOwen];
		expect(planCrossMachineMention('reply', ROOM, reset).added).toEqual([owen]);
	});
});
