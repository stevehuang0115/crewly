/**
 * Dedicated agents (issue #968): an agent bound to one person works only for
 * them. When anyone else DMs it or @'s it, it does no work and is not woken —
 * it answers once with a polite decline that points to the team lead.
 *
 * The decision is made where a Slack message enters (the agent-DM and team
 * channel routers), before anything is recorded, dispatched or woken.
 * Messages from other agents are never declined: delegation still works.
 *
 * specs/2026-10-03-per-person-access.md
 *
 * @module services/people/dedicated-agent
 */

import type { Team, TeamMember } from '../../types/index.js';
import { getTeamLeads } from '../../utils/team.utils.js';
import { getPeopleDirectory, type PeopleDirectoryService } from './people-directory.service.js';

/** A message's sender, as far as the decision needs it. */
export interface DedicatedSender {
	/** Slack user id of the human who wrote it */
	slackUserId?: string | null;
	/** Set when another agent wrote it */
	authorAgentSession?: string | null;
}

/** The decision for one message to one agent. */
export type DedicatedDecision = { decline: false } | { decline: true; text: string };

/**
 * Whether a person id is the one an agent is dedicated to.
 *
 * @param dedicatedTo - The member's `dedicatedTo`
 * @param sender - Sender's Slack user id
 * @param people - Directory (owner matching)
 * @returns True when they are the same person
 */
export function isDedicatedPerson(dedicatedTo: string, sender: string, people: Pick<PeopleDirectoryService, 'isOwner'>): boolean {
	if (dedicatedTo === sender) return true;
	return people.isOwner(dedicatedTo) && people.isOwner(sender);
}

/**
 * The polite decline: who the agent works for, and where to go instead.
 *
 * @param member - The dedicated agent
 * @param team - Its team (for the lead), when known
 * @param senderSlackUserId - The person to answer
 * @param people - Directory (names)
 * @returns Slack mrkdwn text
 *
 * @example
 * ```ts
 * declineText(member, team, 'U0STEVE');
 * // "Hi <@U0STEVE>, I'm Info's personal assistant, so I can't take this on. For this, please ask Ella (team lead)."
 * ```
 */
export function declineText(
	member: Pick<TeamMember, 'id' | 'name' | 'dedicatedTo'>,
	team: Pick<Team, 'members' | 'leaderId' | 'leaderIds'> | null,
	senderSlackUserId: string,
	people: Pick<PeopleDirectoryService, 'displayName'> = getPeopleDirectory(),
): string {
	const owner = member.dedicatedTo ? people.displayName(member.dedicatedTo) : 'someone else';
	const whose = owner === 'the owner' ? "the owner's" : `${owner}'s`;
	const lead = team ? getTeamLeads(team as Team).find((m) => m.id !== member.id) : undefined;
	const pointer = lead ? `${lead.name} (team lead)` : 'the Orc (the orchestrator)';
	return `Hi <@${senderSlackUserId}>, I'm ${whose} personal assistant, so I can't take this on. For this, please ask ${pointer}.`;
}

/**
 * Decide whether an agent declines a message.
 *
 * @param member - The receiving agent (with its `dedicatedTo`)
 * @param team - Its team, when known
 * @param sender - Who wrote the message
 * @param people - Directory (default: the backend's)
 * @returns `{ decline: true, text }` for a human other than the agent's person
 */
export function dedicatedDecision(
	member: Pick<TeamMember, 'id' | 'name' | 'dedicatedTo'> | null | undefined,
	team: Pick<Team, 'members' | 'leaderId' | 'leaderIds'> | null,
	sender: DedicatedSender,
	people: Pick<PeopleDirectoryService, 'isOwner' | 'displayName'> = getPeopleDirectory(),
): DedicatedDecision {
	if (!member?.dedicatedTo) return { decline: false };
	if (sender.authorAgentSession) return { decline: false };
	const slackUserId = sender.slackUserId;
	if (!slackUserId) return { decline: false };
	if (isDedicatedPerson(member.dedicatedTo, slackUserId, people)) return { decline: false };
	return { decline: true, text: declineText(member, team, slackUserId, people) };
}

/** Where an agent's member record and team come from. */
export interface DedicatedLookup {
	getTeams(): Promise<Team[]>;
}

/**
 * The member record and team of an agent session.
 *
 * @param storage - Team storage
 * @param sessionName - Agent session
 * @returns Both, or null when the session is not a team member (the orchestrator, a smoke test)
 */
export async function findMemberWithTeam(storage: DedicatedLookup, sessionName: string): Promise<{ member: TeamMember; team: Team } | null> {
	try {
		for (const team of await storage.getTeams()) {
			const member = team.members?.find((m) => m.sessionName === sessionName);
			if (member) return { member, team };
		}
	} catch {
		// storage unavailable: no decision
	}
	return null;
}

/**
 * Decide for an agent session (looks the member up).
 *
 * @param storage - Team storage
 * @param sessionName - Receiving agent session
 * @param sender - Who wrote the message
 * @returns The decision (no decline when the agent is unknown or shared)
 */
export async function dedicatedDecisionFor(storage: DedicatedLookup, sessionName: string, sender: DedicatedSender): Promise<DedicatedDecision> {
	if (!sender.slackUserId || sender.authorAgentSession) return { decline: false };
	const found = await findMemberWithTeam(storage, sessionName);
	if (!found?.member.dedicatedTo) return { decline: false };
	try {
		return dedicatedDecision(found.member, found.team, sender);
	} catch {
		return { decline: false };
	}
}
