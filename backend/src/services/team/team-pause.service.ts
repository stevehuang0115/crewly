/**
 * Pause and resume a team (specs/2026-10-04-team-pause.md).
 *
 * The owner pauses a team — from the dashboard, the API or a DM to the orc —
 * when its work is handled elsewhere for a while (the Crewly product team
 * while a separate harness session works on the harness). While paused:
 *
 * - its members are not started by automation (the start path refuses
 *   unless the owner asks), and automation does not route work to it;
 * - other agents do not see it, and an agent that targets it is told to
 *   file a GitHub issue (or tell the orc) instead.
 *
 * Pausing stores `Team.paused`, stops the running members the way stop-team
 * does, and unassigns work that has not started: queued WorkItems go back to
 * the unassigned pool (the router picks a decider that is not paused), and
 * backlog / ready tickets lose their assignee. Running work stays where it
 * is, for the owner to see. Resuming clears the pause; an `until` time
 * resumes the team by itself ({@link TeamPauseService.sweepExpired}).
 *
 * @module services/team/team-pause.service
 */

import type { Team, TeamMember, TeamPauseState } from '../../types/index.js';
import { TEAM_PAUSE_CONSTANTS } from '../../constants.js';
import { listExpiredPauses, memberSessionKeys, notePausedTeam } from './team-pause.registry.js';
import { clearOwnerStopped } from '../agent/owner-stopped.registry.js';

/** A refused pause / resume (HTTP status + English message). */
export class TeamPauseError extends Error {
	/**
	 * @param status - HTTP status (400 bad input, 404 unknown team)
	 * @param message - Reason
	 */
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'TeamPauseError';
	}
}

/** Pause options. */
export interface PauseTeamInput {
	reason?: string;
	/** ISO time (or anything `Date.parse` reads) the pause ends by itself */
	until?: string;
}

/** What a pause did. */
export interface PauseTeamOutcome {
	team: Team;
	/** The team was already paused (reason / until updated) */
	alreadyPaused: boolean;
	/** Members whose running session was stopped */
	stopped: string[];
	/** Members whose session could not be stopped */
	stopFailed: Array<{ member: string; error: string }>;
	/** Queued WorkItems unassigned */
	releasedWorkItems: string[];
	/** Tickets unassigned (or put back to ready) */
	releasedTickets: string[];
}

/** What a resume did. */
export interface ResumeTeamOutcome {
	team: Team;
	/** The team was not paused */
	wasPaused: boolean;
	/** The pause ran out (`until`), not an owner action */
	auto: boolean;
}

/** Collaborators. */
export interface TeamPauseServiceDeps {
	storage: { getTeams(): Promise<Team[]>; saveTeam(team: Team): Promise<void> };
	/** Stop one member's running session, the way stop-team does */
	stopMember: (team: Team, member: TeamMember) => Promise<{ success: boolean; error?: string }>;
	/** Unassign queued (unstarted) WorkItems targeting these sessions; returns their ids */
	releaseWorkItems?: (sessions: ReadonlySet<string>, team: Team) => Promise<string[]>;
	/** Unassign unstarted tickets assigned to these sessions; returns `<project>/<id>` refs */
	releaseTickets?: (sessions: ReadonlySet<string>, team: Team) => Promise<string[]>;
	/** Tell the owner (auto-resume); best effort */
	notifyOwner?: (text: string) => Promise<unknown>;
	logger?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
	now?: () => number;
}

/**
 * Find a team by id, by name (case-insensitive), or by a unique name prefix.
 *
 * @param teams - Every team
 * @param ref - What the owner typed
 * @returns The team, or null
 */
export function findTeamByRef(teams: readonly Team[], ref: string): Team | null {
	const want = String(ref ?? '').trim().toLowerCase().replace(/^team\s+/, '');
	if (!want) return null;
	const live = teams.filter((t) => !t.archived);
	const exact =
		teams.find((t) => t.id === ref) ??
		live.find((t) => (t.name ?? '').toLowerCase() === want) ??
		live.find((t) => (t.name ?? '').toLowerCase().replace(/\s+team$/, '') === want);
	if (exact) return exact;
	const prefix = live.filter((t) => (t.name ?? '').toLowerCase().startsWith(want));
	return prefix.length === 1 ? prefix[0] : null;
}

/**
 * Every session name a team's members may run under.
 *
 * @param team - Team
 * @returns Sessions
 */
export function teamSessionKeys(team: Team): Set<string> {
	const out = new Set<string>();
	for (const m of team.members ?? []) for (const k of memberSessionKeys(team.name, m)) out.add(k);
	return out;
}

/** The team pause service. */
export class TeamPauseService {
	private timer: ReturnType<typeof setInterval> | null = null;

	/**
	 * @param deps - Collaborators
	 */
	constructor(private readonly deps: TeamPauseServiceDeps) {}

	/**
	 * Resolve a team reference or throw 404.
	 *
	 * @param ref - Team id or name
	 * @returns The stored team
	 */
	async resolveTeam(ref: string): Promise<Team> {
		const teams = await this.deps.storage.getTeams();
		const team = findTeamByRef(teams, ref);
		if (!team) throw new TeamPauseError(404, `No team named "${ref}". Teams: ${teams.filter((t) => !t.archived).map((t) => t.name).join(', ') || 'none'}.`);
		return team;
	}

	/**
	 * Pause a team: store the pause, stop its running members, unassign its
	 * unstarted work. Pausing a paused team updates its reason / until.
	 *
	 * @param ref - Team id or name
	 * @param input - Reason and until
	 * @returns What was done
	 * @throws TeamPauseError on bad input or an unknown team
	 */
	async pause(ref: string, input: PauseTeamInput = {}): Promise<PauseTeamOutcome> {
		const now = this.now();
		const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
		if (reason.length > TEAM_PAUSE_CONSTANTS.MAX_REASON_LENGTH) {
			throw new TeamPauseError(400, `reason is too long (max ${TEAM_PAUSE_CONSTANTS.MAX_REASON_LENGTH} characters)`);
		}
		let until: string | undefined;
		if (input.until !== undefined && input.until !== null && String(input.until).trim() !== '') {
			const at = Date.parse(String(input.until));
			if (Number.isNaN(at)) throw new TeamPauseError(400, `until is not a date/time: ${String(input.until)}`);
			if (at <= now) throw new TeamPauseError(400, 'until must be in the future');
			until = new Date(at).toISOString();
		}

		const team = await this.resolveTeam(ref);
		const alreadyPaused = !!team.paused;
		const pause: TeamPauseState = {
			pausedAt: team.paused?.pausedAt ?? new Date(now).toISOString(),
			by: 'owner',
			...(reason ? { reason } : {}),
			...(until ? { until } : {}),
		};
		(team as { paused?: TeamPauseState }).paused = pause;
		(team as { updatedAt: string }).updatedAt = new Date(now).toISOString();
		// Saved (and indexed) before anything is stopped: from here on no
		// automation may start a member again behind the stop.
		await this.deps.storage.saveTeam(team);
		notePausedTeam(team);
		this.deps.logger?.info('Team paused by the owner', { teamId: team.id, team: team.name, reason: reason || undefined, until });

		const stopped: string[] = [];
		const stopFailed: Array<{ member: string; error: string }> = [];
		for (const member of team.members ?? []) {
			if (!member.sessionName) continue;
			const res = await this.deps.stopMember(team, member).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
			if (res.success) stopped.push(member.name);
			else stopFailed.push({ member: member.name, error: res.error ?? 'stop failed' });
		}

		const sessions = teamSessionKeys(team);
		const releasedWorkItems = await this.release('WorkItems', () => this.deps.releaseWorkItems?.(sessions, team), team);
		const releasedTickets = await this.release('tickets', () => this.deps.releaseTickets?.(sessions, team), team);
		if (releasedWorkItems.length > 0 || releasedTickets.length > 0) {
			this.deps.logger?.info('Unstarted work of a paused team unassigned', { team: team.name, workItems: releasedWorkItems, tickets: releasedTickets });
		}
		return { team, alreadyPaused, stopped, stopFailed, releasedWorkItems, releasedTickets };
	}

	/**
	 * Resume a team. Its members are not started: they start when there is
	 * work for them or the owner starts them, as before the pause.
	 *
	 * @param ref - Team id or name
	 * @param options - `auto`: the pause ran out
	 * @returns What was done
	 * @throws TeamPauseError(404) for an unknown team
	 */
	async resume(ref: string, options: { auto?: boolean } = {}): Promise<ResumeTeamOutcome> {
		const team = await this.resolveTeam(ref);
		const wasPaused = !!team.paused;
		if (wasPaused) {
			delete (team as { paused?: TeamPauseState }).paused;
			(team as { updatedAt: string }).updatedAt = new Date(this.now()).toISOString();
			await this.deps.storage.saveTeam(team);
			notePausedTeam(team);
			// Back under the normal rules: work queued for them may start them again.
			for (const s of teamSessionKeys(team)) clearOwnerStopped(s);
			this.deps.logger?.info(options.auto ? 'Team pause ran out — resumed' : 'Team resumed by the owner', { teamId: team.id, team: team.name });
		}
		return { team, wasPaused, auto: !!options.auto };
	}

	/**
	 * Resume every team whose `until` has passed, and tell the owner.
	 *
	 * @returns Names of the teams resumed
	 */
	async sweepExpired(): Promise<string[]> {
		const due = listExpiredPauses(this.now());
		const resumed: string[] = [];
		for (const info of due) {
			try {
				const out = await this.resume(info.teamId, { auto: true });
				if (!out.wasPaused) continue;
				resumed.push(out.team.name);
				if (this.deps.notifyOwner) {
					await Promise.resolve(this.deps.notifyOwner(`${out.team.name} is no longer paused: the pause ran until ${info.pause.until}.`)).catch(() => undefined);
				}
			} catch (err) {
				this.deps.logger?.warn('Auto-resume failed', { teamId: info.teamId, error: err instanceof Error ? err.message : String(err) });
			}
		}
		return resumed;
	}

	/** Start the auto-resume sweep (runs once now, then every minute). */
	start(): void {
		if (this.timer) return;
		void this.sweepExpired().catch(() => undefined);
		this.timer = setInterval(() => void this.sweepExpired().catch(() => undefined), TEAM_PAUSE_CONSTANTS.AUTO_RESUME_SWEEP_MS);
		this.timer.unref?.();
	}

	/** Stop the sweep. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * Run one release step; a failure is logged, never thrown.
	 *
	 * @param what - For the log
	 * @param fn - The step
	 * @param team - Team
	 * @returns Released ids
	 */
	private async release(what: string, fn: () => Promise<string[]> | undefined, team: Team): Promise<string[]> {
		try {
			return (await fn()) ?? [];
		} catch (err) {
			this.deps.logger?.warn(`Could not unassign the paused team's ${what}`, { team: team.name, error: err instanceof Error ? err.message : String(err) });
			return [];
		}
	}

	/** @returns Clock (ms) */
	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}
}

let instance: TeamPauseService | null = null;

/**
 * The wired service.
 *
 * @returns Service, or null before the server wired it
 */
export function getTeamPauseService(): TeamPauseService | null {
	return instance;
}

/**
 * Install (or clear) the service.
 *
 * @param service - Service, null to clear (tests)
 */
export function setTeamPauseService(service: TeamPauseService | null): void {
	instance?.stop();
	instance = service;
}
