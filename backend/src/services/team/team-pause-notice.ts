/**
 * The Slack auto-reply for a paused agent (specs/2026-10-04-team-pause.md):
 * an @mention or DM of a paused team's agent does not wake it; a short
 * English line in the thread says why — at most once per thread.
 *
 * @module services/team/team-pause-notice
 */

import { TEAM_PAUSE_CONSTANTS } from '../../constants.js';
import { pausedRefusalMessage, type PausedTeamInfo } from './team-pause.registry.js';

/**
 * The auto-reply text.
 *
 * @param info - The paused team
 * @param agentName - Display name of the agent that was addressed
 * @param options - `toAgent`: the author is another agent (it gets the refusal: file an issue / tell the orc)
 * @returns Text
 *
 * @example
 * pausedSlackNotice(info, 'Leo') // 'Leo is on Crewly, which the owner has paused, so Leo won't pick this up. …'
 */
export function pausedSlackNotice(info: PausedTeamInfo, agentName: string, options: { toAgent?: boolean } = {}): string {
	if (options.toAgent) return pausedRefusalMessage(info);
	const until = info.pause.until ? ` (until ${info.pause.until})` : '';
	return (
		`${agentName} is on ${info.teamName}, which the owner has paused${until}, so ${agentName} won't pick this up. ` +
		`To bring the team back, DM the orc "resume ${info.teamName}".`
	);
}

/** Remembers which threads were already told (one notice per thread per team). */
export class PausedThreadNotices {
	private readonly told = new Set<string>();

	/**
	 * @param max - Threads remembered before the oldest are forgotten
	 */
	constructor(private readonly max: number = TEAM_PAUSE_CONSTANTS.SLACK_NOTICE_MEMORY) {}

	/**
	 * Claim the notice for a thread: true the first time, false after.
	 *
	 * @param channelId - Slack channel
	 * @param threadTs - Thread (root ts)
	 * @param teamId - Paused team
	 * @returns True when the notice should be posted now
	 */
	claim(channelId: string, threadTs: string | undefined, teamId: string): boolean {
		const key = `${channelId}:${threadTs ?? ''}:${teamId}`;
		if (this.told.has(key)) return false;
		this.told.add(key);
		if (this.told.size > this.max) {
			const oldest = this.told.values().next().value;
			if (oldest !== undefined) this.told.delete(oldest);
		}
		return true;
	}
}

/** Shared by the Slack paths so a thread is told once whichever path saw it. */
export const pausedThreadNotices = new PausedThreadNotices();
