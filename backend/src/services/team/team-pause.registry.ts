/**
 * Paused teams — the in-memory index every automation path consults
 * (specs/2026-10-04-team-pause.md).
 *
 * The pause itself is stored on the team (`Team.paused`, persisted in the
 * team's config.json), so it survives restarts. This module keeps a
 * synchronous index of it — team id → pause, and every session name a
 * member of a paused team may run under → team — because most of the gates
 * (the reconciler's wake rule, the queued-message wake, the dispatcher's
 * target planning) only have a session name and must not await storage.
 *
 * The index is rebuilt from storage: {@link syncPausedTeams} runs on every
 * `StorageService.getTeams()` read and at boot, and {@link notePausedTeam}
 * on every save. A pause whose `until` has passed counts as resumed at once,
 * before the auto-resume sweep clears it from storage.
 *
 * Module-level and dependency-free (types and two utils only), so the team
 * controller, the storage service and the services can share it without
 * import cycles.
 *
 * @module services/team/team-pause.registry
 */

import type { Team, TeamMember, TeamPauseState } from '../../types/index.js';
import { deriveMemberSessionName } from '../../utils/member-session-name.utils.js';

/** What the gates need to know about a paused team. */
export interface PausedTeamInfo {
	teamId: string;
	teamName: string;
	/** GitHub repository for issues while paused (`owner/name`), when configured */
	issueRepo?: string;
	pause: TeamPauseState;
	/** Every session name a member may run under (session, agent id, derived name) */
	sessions: string[];
	/** Member display names */
	memberNames: string[];
}

const pausedTeams = new Map<string, PausedTeamInfo>();
const teamOfSession = new Map<string, string>();
/** Every known team (id → name, archived), for the owner's Slack commands */
const knownTeams = new Map<string, { name: string; archived: boolean }>();

/**
 * Whether a pause is in force at `now` (set, and its `until` not reached).
 *
 * @param pause - The team's pause, if any
 * @param now - Clock (ms)
 * @returns True while paused
 *
 * @example
 * isPauseActive({ pausedAt: '…', by: 'owner', until: '2099-01-01T00:00:00Z' }) // true
 */
export function isPauseActive(pause: TeamPauseState | null | undefined, now: number = Date.now()): boolean {
	if (!pause || !pause.pausedAt) return false;
	if (!pause.until) return true;
	const until = Date.parse(pause.until);
	return Number.isNaN(until) || until > now;
}

/**
 * Whether a team object is paused now. Prefer this where the team is at
 * hand: it reads the team itself, not the index.
 *
 * @param team - Team (only `paused` is read)
 * @param now - Clock (ms)
 * @returns True while paused
 */
export function isTeamPausedNow(team: Pick<Team, 'paused'> | null | undefined, now: number = Date.now()): boolean {
	return isPauseActive(team?.paused, now);
}

/**
 * Every session name a member may run under: its live session, its
 * permanent agent id, and the name the controller derives on start.
 *
 * @param teamName - Team display name
 * @param member - Member
 * @returns Distinct, non-empty session names
 */
export function memberSessionKeys(teamName: string, member: Pick<TeamMember, 'sessionName' | 'agentId' | 'name' | 'id'>): string[] {
	const keys = [member.sessionName, member.agentId, member.id ? deriveMemberSessionName(teamName, member.name, member.id) : undefined];
	return [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))];
}

/**
 * Build the index entry for a team (whether or not it is paused).
 *
 * @param team - Team with a pause
 * @returns Entry
 */
function entryOf(team: Team): PausedTeamInfo {
	const sessions = new Set<string>();
	for (const m of team.members ?? []) for (const k of memberSessionKeys(team.name, m)) sessions.add(k);
	return {
		teamId: team.id,
		teamName: team.name || team.id,
		...(team.issueRepo ? { issueRepo: team.issueRepo } : {}),
		pause: team.paused as TeamPauseState,
		sessions: [...sessions],
		memberNames: (team.members ?? []).map((m) => m.name).filter(Boolean),
	};
}

/**
 * Remove a team from the index.
 *
 * @param teamId - Team
 */
function forget(teamId: string): void {
	const prev = pausedTeams.get(teamId);
	if (!prev) return;
	for (const s of prev.sessions) if (teamOfSession.get(s) === teamId) teamOfSession.delete(s);
	pausedTeams.delete(teamId);
}

/**
 * Update the index for one team (after a save). A team that is not paused
 * is removed from it.
 *
 * @param team - The saved team
 */
export function notePausedTeam(team: Team | null | undefined): void {
	if (!team?.id) return;
	knownTeams.set(team.id, { name: team.name || team.id, archived: !!team.archived });
	forget(team.id);
	if (!team.paused) return;
	const entry = entryOf(team);
	pausedTeams.set(team.id, entry);
	for (const s of entry.sessions) teamOfSession.set(s, team.id);
}

/**
 * Forget a deleted team.
 *
 * @param teamId - Deleted team
 */
export function noteTeamDeleted(teamId: string): void {
	forget(teamId);
	knownTeams.delete(teamId);
}

/**
 * Every team the index has seen (id and name), archived ones excluded.
 *
 * @returns Teams
 */
export function listKnownTeams(): Array<{ id: string; name: string }> {
	return [...knownTeams.entries()].filter(([, t]) => !t.archived).map(([id, t]) => ({ id, name: t.name }));
}

/**
 * Rebuild the index from a full team list (a storage read, boot).
 *
 * @param teams - Every stored team
 */
export function syncPausedTeams(teams: readonly Team[]): void {
	pausedTeams.clear();
	teamOfSession.clear();
	knownTeams.clear();
	for (const team of teams) notePausedTeam(team);
}

/**
 * The paused team with this id, if its pause is in force.
 *
 * @param teamId - Team id
 * @param now - Clock (ms)
 * @returns Info, or null
 */
export function pausedTeamById(teamId: string | null | undefined, now: number = Date.now()): PausedTeamInfo | null {
	if (!teamId) return null;
	const entry = pausedTeams.get(teamId);
	return entry && isPauseActive(entry.pause, now) ? entry : null;
}

/**
 * Whether the team with this id is paused now.
 *
 * @param teamId - Team id
 * @returns True while paused
 */
export function isTeamIdPaused(teamId: string | null | undefined): boolean {
	return pausedTeamById(teamId) !== null;
}

/**
 * The paused team a session belongs to, if its pause is in force.
 *
 * @param session - Agent session (or agent id)
 * @param now - Clock (ms)
 * @returns Info, or null
 */
export function pausedTeamOfSession(session: string | null | undefined, now: number = Date.now()): PausedTeamInfo | null {
	if (!session) return null;
	const teamId = teamOfSession.get(session);
	return teamId ? pausedTeamById(teamId, now) : null;
}

/**
 * Whether a session belongs to a paused team.
 *
 * @param session - Agent session (or agent id)
 * @returns True while its team is paused
 *
 * @example
 * if (isSessionPaused(wi.target)) return false; // do not dispatch
 */
export function isSessionPaused(session: string | null | undefined): boolean {
	return pausedTeamOfSession(session) !== null;
}

/**
 * The paused team named by an id, a name (case-insensitive) or a member
 * session — whatever an agent typed.
 *
 * @param ref - Team id, team name, or member session
 * @returns Info, or null
 */
export function pausedTeamByRef(ref: string | null | undefined): PausedTeamInfo | null {
	if (!ref) return null;
	const byId = pausedTeamById(ref) ?? pausedTeamOfSession(ref);
	if (byId) return byId;
	const want = ref.trim().toLowerCase();
	for (const entry of pausedTeams.values()) {
		if (entry.teamName.toLowerCase() === want && isPauseActive(entry.pause)) return entry;
	}
	return null;
}

/**
 * Every team paused now.
 *
 * @param now - Clock (ms)
 * @returns Infos
 */
export function listPausedTeams(now: number = Date.now()): PausedTeamInfo[] {
	return [...pausedTeams.values()].filter((e) => isPauseActive(e.pause, now));
}

/**
 * Teams whose pause has an `until` that has passed (still stored as paused).
 *
 * @param now - Clock (ms)
 * @returns Infos due for auto-resume
 */
export function listExpiredPauses(now: number = Date.now()): PausedTeamInfo[] {
	return [...pausedTeams.values()].filter((e) => !isPauseActive(e.pause, now));
}

/**
 * The refusal an agent gets when it targets a paused team (English: harness
 * text rule).
 *
 * @param info - The paused team
 * @param options - `callerIsOrc`: the orchestrator asked (it tells the owner, not itself)
 * @returns Message
 *
 * @example
 * pausedRefusalMessage({ teamName: 'Crewly', issueRepo: 'stevehuang0115/crewly' })
 * // 'Crewly is paused by the owner. File a GitHub issue instead: `gh issue create -R stevehuang0115/crewly --title "…" --body "…"`'
 */
export function pausedRefusalMessage(
	info: Pick<PausedTeamInfo, 'teamName' | 'issueRepo'> & { pause?: TeamPauseState },
	options: { callerIsOrc?: boolean } = {},
): string {
	const until = info.pause?.until ? ` until ${info.pause.until}` : '';
	const head = `${info.teamName} is paused by the owner${until}.`;
	if (info.issueRepo) {
		return `${head} File a GitHub issue instead: \`gh issue create -R ${info.issueRepo} --title "<short title>" --body "<what is needed and why>"\``;
	}
	return options.callerIsOrc
		? `${head} Do not hand it work or wake it. If this cannot wait until the owner resumes it, tell the owner.`
		: `${head} Do not hand it work. Tell the orc what you need instead.`;
}

/** Clear the index (tests only). */
export function resetTeamPauseRegistryForTesting(): void {
	pausedTeams.clear();
	teamOfSession.clear();
	knownTeams.clear();
}
