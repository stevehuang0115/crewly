/**
 * Tests for dedicated agents (issue #968).
 */

import { dedicatedDecision, dedicatedDecisionFor, declineText, findMemberWithTeam, isDedicatedPerson } from './dedicated-agent.js';
import type { Team, TeamMember } from '../../types/index.js';

const people = {
	isOwner: (id: string) => id === 'UOWNER01' || id === 'owner',
	displayName: (id: string) => ({ UINFO001: 'Info', UOWNER01: 'Ina' } as Record<string, string>)[id] ?? (id === 'owner' ? 'the owner' : id),
};

function member(partial: Partial<TeamMember>): TeamMember {
	return { id: 'm', name: 'Agent', sessionName: 'agent-1', role: 'developer', ...partial } as TeamMember;
}

const assistant = member({ id: 'm-assist', name: 'Pia', sessionName: 'pia-1', dedicatedTo: 'UINFO001' });
const lead = member({ id: 'm-lead', name: 'Ella', sessionName: 'ella-1', role: 'team-leader' });
const team = { id: 't1', name: 'Core', members: [assistant, lead], leaderIds: ['m-lead'] } as unknown as Team;

describe('dedicated agents', () => {
	it('works for its person, declines anyone else with a pointer to the team lead', () => {
		expect(dedicatedDecision(assistant, team, { slackUserId: 'UINFO001' }, people)).toEqual({ decline: false });
		expect(dedicatedDecision(assistant, team, { slackUserId: 'USTEVE01' }, people)).toEqual({
			decline: true,
			text: "Hi <@USTEVE01>, I'm Info's personal assistant, so I can't take this on. For this, please ask Ella (team lead).",
		});
	});

	it('never declines another agent, a message with no person, or a shared agent', () => {
		expect(dedicatedDecision(assistant, team, { slackUserId: 'USTEVE01', authorAgentSession: 'ella-1' }, people).decline).toBe(false);
		expect(dedicatedDecision(assistant, team, {}, people).decline).toBe(false);
		expect(dedicatedDecision(lead, team, { slackUserId: 'USTEVE01' }, people).decline).toBe(false);
		expect(dedicatedDecision(null, team, { slackUserId: 'USTEVE01' }, people).decline).toBe(false);
	});

	it('an agent dedicated to the owner matches the owner by Slack id or placeholder', () => {
		expect(isDedicatedPerson('owner', 'UOWNER01', people)).toBe(true);
		expect(isDedicatedPerson('UOWNER01', 'UINFO001', people)).toBe(false);
		const ownersAgent = member({ dedicatedTo: 'owner' });
		expect(dedicatedDecision(ownersAgent, null, { slackUserId: 'UOWNER01' }, people).decline).toBe(false);
	});

	it('points to the orchestrator when the team has no other lead', () => {
		expect(declineText(assistant, null, 'USTEVE01', people)).toBe(
			"Hi <@USTEVE01>, I'm Info's personal assistant, so I can't take this on. For this, please ask the Orc (the orchestrator).",
		);
		const soloLead = member({ id: 'solo', dedicatedTo: 'owner', role: 'team-leader' });
		expect(declineText(soloLead, { members: [soloLead], leaderIds: ['solo'] } as unknown as Team, 'USTEVE01', people)).toContain("the owner's personal assistant");
	});

	it('looks the agent up by session', async () => {
		const storage = { getTeams: async () => [team] };
		expect((await findMemberWithTeam(storage, 'pia-1'))?.member.id).toBe('m-assist');
		expect(await findMemberWithTeam(storage, 'nobody')).toBeNull();
		expect(await findMemberWithTeam({ getTeams: async () => Promise.reject(new Error('down')) }, 'pia-1')).toBeNull();
		expect((await dedicatedDecisionFor(storage, 'ella-1', { slackUserId: 'USTEVE01' })).decline).toBe(false);
		expect((await dedicatedDecisionFor(storage, 'pia-1', {})).decline).toBe(false);
	});
});
