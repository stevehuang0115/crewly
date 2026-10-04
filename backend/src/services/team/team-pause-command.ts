/**
 * Pause / resume a team from the owner's DM with the orc
 * (specs/2026-10-04-team-pause.md). The owner is usually away from the
 * machine, so the Slack DM is the main control. Handled by the backend as
 * an owner command — never by the orc's LLM — and only for the owner's own
 * messages in their DM with the orc:
 *
 * - `pause <team>` / `pause team <team>`
 * - `pause <team> for 3d` (`m`, `h`, `d`, `w`; also `3 days`, `2 hours`)
 * - `pause <team> until 2026-10-10` (anything `Date.parse` reads)
 * - `pause <team> because <reason>` / `pause <team>: <reason>`
 * - `resume <team>` / `unpause <team>`
 * - Chinese aliases: `暂停 <team>`, `恢复 <team>`, `取消暂停 <team>`
 *
 * A message is consumed only when its target names a team (or it says
 * `pause team <x>` explicitly); anything else goes on to the orc. Replies are
 * English (harness text rule).
 *
 * @module services/team/team-pause-command
 */

import type { SlackIncomingMessage } from '../../types/slack.types.js';
import type { Team } from '../../types/index.js';
import { findTeamByRef } from './team-pause.service.js';

/** A parsed command. `target` is the team as typed. */
export type TeamPauseCommand =
	| { kind: 'pause'; target: string; explicitTeam: boolean; reason?: string; until?: string; forMs?: number }
	| { kind: 'resume'; target: string; explicitTeam: boolean };

const UNIT_MS: Record<string, number> = {
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
	w: 604_800_000,
	week: 604_800_000,
	weeks: 604_800_000,
};

/**
 * Normalise a message for matching.
 *
 * @param text - Raw text
 * @returns Mentions, emphasis and trailing punctuation removed; whitespace collapsed
 */
function norm(text: string): string {
	return text
		.replace(/<@[A-Z0-9]+>/g, '')
		.replace(/[`*_]/g, '')
		.replace(/[\s.。!！~～]+$/u, '')
		.replace(/^(?:please|pls|请)\s*/iu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Parse a pause / resume command.
 *
 * @param text - Message text
 * @returns The command, or null when the message is not one
 *
 * @example
 * parseTeamPauseCommand('pause Crewly for 3d because harness work moved') // { kind: 'pause', target: 'Crewly', forMs: 259200000, reason: 'harness work moved', explicitTeam: false }
 * parseTeamPauseCommand('resume team Crewly') // { kind: 'resume', target: 'Crewly', explicitTeam: true }
 */
export function parseTeamPauseCommand(text: string | undefined): TeamPauseCommand | null {
	if (!text) return null;
	const t = norm(text);
	if (!t || t.includes('\n')) return null;

	let m = /^(?:resume|unpause|un-pause)\s+(team\s+)?(.+)$/i.exec(t) ?? /^(?:恢复|取消暂停)\s*(团队)?\s*(.+)$/u.exec(t);
	if (m) {
		const target = m[2].trim().replace(/^the\s+/i, '').replace(/\s+team$/i, '');
		return target ? { kind: 'resume', target, explicitTeam: !!m[1] } : null;
	}

	m = /^pause\s+(team\s+)?(.+)$/i.exec(t) ?? /^暂停\s*(团队)?\s*(.+)$/u.exec(t);
	if (!m) return null;
	let rest = m[2].trim();
	const explicitTeam = !!m[1];
	let reason: string | undefined;
	// A colon starts a reason only when no "until <time>" could contain it.
	const why =
		/^(.+?)(?:\s+because\s+|\s+reason:?\s+|\s+因为\s*)(.+)$/i.exec(rest) ??
		(/\b(?:until|till|til)\b/i.test(rest) ? null : /^(.+?)\s*[:：]\s*(.+)$/.exec(rest));
	if (why) {
		rest = why[1].trim();
		reason = why[2].trim();
	}
	let until: string | undefined;
	let forMs: number | undefined;
	const dur = /^(.+?)\s+for\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(rest);
	const till = /^(.+?)\s+(?:until|till|til)\s+(.+)$/i.exec(rest);
	if (dur && UNIT_MS[dur[3].toLowerCase()]) {
		rest = dur[1].trim();
		forMs = Number(dur[2]) * UNIT_MS[dur[3].toLowerCase()];
	} else if (till) {
		rest = till[1].trim();
		until = till[2].trim();
	}
	const target = rest.replace(/^the\s+/i, '').replace(/\s+team$/i, '').trim();
	if (!target) return null;
	return { kind: 'pause', target, explicitTeam, ...(reason ? { reason } : {}), ...(until ? { until } : {}), ...(forMs ? { forMs } : {}) };
}

/** What the interceptor needs. */
export interface TeamPauseCommandDeps {
	/** `orc` when the message is the owner writing in their DM with the orc (see SlackReloginDmService.ownerDmScope) */
	ownerDmScope: (message: SlackIncomingMessage) => 'orc' | 'agent' | null;
	/** Reply target for the message */
	replyTargetOf: (message: SlackIncomingMessage) => unknown;
	/** Send a reply to the owner */
	reply: (text: string, target: unknown) => Promise<unknown>;
	/** Known teams, synchronously (the pause registry's index) */
	knownTeams: () => Array<{ id: string; name: string }>;
	pause: (teamId: string, input: { reason?: string; until?: string }) => Promise<{ team: Team; alreadyPaused: boolean; stopped: string[]; stopFailed: Array<{ member: string; error: string }>; releasedWorkItems: string[]; releasedTickets: string[] }>;
	resume: (teamId: string) => Promise<{ team: Team; wasPaused: boolean }>;
	onError?: (err: unknown) => void;
	now?: () => number;
}

/**
 * Run a parsed command and build the owner's reply.
 *
 * @param cmd - Command
 * @param teamId - Resolved team
 * @param deps - Collaborators
 * @returns Reply text
 */
export async function runTeamPauseCommand(cmd: TeamPauseCommand, teamId: string, deps: TeamPauseCommandDeps): Promise<string> {
	if (cmd.kind === 'resume') {
		const out = await deps.resume(teamId);
		return out.wasPaused
			? `${out.team.name} is resumed. Its members start again when there is work for them, or when you start them.`
			: `${out.team.name} was not paused.`;
	}
	const now = deps.now?.() ?? Date.now();
	const until = cmd.forMs ? new Date(now + cmd.forMs).toISOString() : cmd.until;
	const out = await deps.pause(teamId, { ...(cmd.reason ? { reason: cmd.reason } : {}), ...(until ? { until } : {}) });
	const parts = [
		`${out.team.name} is ${out.alreadyPaused ? 'still ' : ''}paused${out.team.paused?.until ? ` until ${out.team.paused.until}` : ''}.`,
		'No automation will wake it, and other agents are told to file a GitHub issue' +
			(out.team.issueRepo ? ` in ${out.team.issueRepo}` : ' (no issue repo set: they tell the orc)') +
			' instead of handing it work.',
	];
	if (out.stopped.length > 0) parts.push(`Stopped: ${out.stopped.join(', ')}.`);
	if (out.stopFailed.length > 0) parts.push(`Could not stop: ${out.stopFailed.map((f) => `${f.member} (${f.error})`).join(', ')}.`);
	const released = out.releasedWorkItems.length + out.releasedTickets.length;
	if (released > 0) parts.push(`Unassigned ${released} item(s) that had not started.`);
	parts.push(`Say "resume ${out.team.name}" to undo.`);
	return parts.join(' ');
}

/**
 * The Slack bridge interceptor for the owner's orc DM.
 *
 * @param deps - Collaborators
 * @returns Interceptor: true when the message was a pause / resume command (consumed)
 */
export function createTeamPauseInterceptor(deps: TeamPauseCommandDeps): (message: SlackIncomingMessage) => boolean {
	return (message) => {
		if (message.hasFiles) return false;
		if (deps.ownerDmScope(message) !== 'orc') return false;
		const cmd = parseTeamPauseCommand(message.text);
		if (!cmd) return false;
		const teams = deps.knownTeams();
		const team = findTeamByRef(teams.map((t) => ({ id: t.id, name: t.name, members: [], projectIds: [], createdAt: '', updatedAt: '' })), cmd.target);
		const target = deps.replyTargetOf(message);
		if (!team) {
			// "pause team X" is unmistakably a command: answer it. Anything else
			// ("pause the deploy") is the orc's.
			if (!cmd.explicitTeam) return false;
			void deps
				.reply(`No team named "${cmd.target}". Teams: ${teams.map((t) => t.name).join(', ') || 'none'}.`, target)
				.catch((err) => deps.onError?.(err));
			return true;
		}
		void runTeamPauseCommand(cmd, team.id, deps)
			.then((text) => deps.reply(text, target))
			.catch((err) => {
				deps.onError?.(err);
				return deps.reply(`Couldn't ${cmd.kind} ${team.name}: ${err instanceof Error ? err.message : String(err)}`, target).catch(() => undefined);
			});
		return true;
	};
}
