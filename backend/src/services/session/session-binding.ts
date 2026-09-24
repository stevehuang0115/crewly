/**
 * Session binding — which persisted session names are still launchable.
 *
 * The team config is the source of truth for a member's session name
 * (`member.sessionName`, the "binding"). Runtime state (session-state.json)
 * is only a cache of what was running, and it goes stale: when a member is
 * renamed, startTeamMember derives a new session name from the new display
 * name, and the entry under the old name used to stay behind. Startup
 * auto-restore and the Resume dialog then relaunched the member under that
 * stale name, running it twice under two names (2026-09-23,
 * `crewly-marketing-self-watch-scribe-45506487` vs `crewly-marketing-dana-45506487`).
 *
 * Rule: a persisted entry that claims a team (it has a teamId or memberId)
 * is launchable only under a name some member is bound to. If the entry's
 * memberId names a member bound to a different name, it is relaunched under
 * that bound name. Otherwise it is unbound and must not be offered or
 * launched. Entries that claim no team (orchestrator, ad-hoc sessions) are
 * left alone.
 *
 * @module services/session/session-binding
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { PersistedSessionInfo } from './session-state-persistence.js';

/** The slice of a team this module reads. */
export interface BindingTeam {
	id: string;
	members: ReadonlyArray<{ id: string; sessionName?: string }>;
}

/** A member's binding. */
export interface SessionBinding {
	teamId: string;
	memberId: string;
}

/** Result of resolving persisted sessions against the team config. */
export interface ResolvedPersistedSessions {
	/**
	 * Entries safe to launch or offer, with `name` rewritten to the member's
	 * bound name where the entry was stale but its memberId resolved.
	 */
	launchable: PersistedSessionInfo[];
	/** Names that claim a team but match no binding. Never launch these. */
	unbound: string[];
	/** Stale names that were rewritten to a bound name (old → new). */
	rebound: Array<{ from: string; to: string }>;
}

/**
 * Index every member's bound session name.
 *
 * @param teams - Teams from the team config.
 * @returns bound sessionName → { teamId, memberId }; members with no name are skipped.
 */
export function collectSessionBindings(teams: ReadonlyArray<BindingTeam>): Map<string, SessionBinding> {
	const bindings = new Map<string, SessionBinding>();
	for (const team of teams) {
		for (const member of team.members ?? []) {
			if (member.sessionName) {
				bindings.set(member.sessionName, { teamId: team.id, memberId: member.id });
			}
		}
	}
	return bindings;
}

/**
 * Index members by id to their bound session name.
 *
 * @param teams - Teams from the team config.
 * @returns memberId → bound sessionName (only members that have one).
 */
function collectMemberBindings(teams: ReadonlyArray<BindingTeam>): Map<string, string> {
	const byMember = new Map<string, string>();
	for (const team of teams) {
		for (const member of team.members ?? []) {
			if (member.sessionName) byMember.set(member.id, member.sessionName);
		}
	}
	return byMember;
}

/**
 * Whether a persisted entry claims to belong to a team member.
 *
 * @param info - Persisted session entry.
 * @returns true when it carries a teamId or memberId.
 */
export function claimsTeam(info: Pick<PersistedSessionInfo, 'teamId' | 'memberId'>): boolean {
	return !!(info.teamId || info.memberId);
}

/**
 * Split persisted sessions into launchable and unbound, per the module rule.
 *
 * @param sessions - Entries from session-state.json.
 * @param teams - Teams from the team config (the bindings).
 * @returns launchable entries (possibly renamed to the bound name), unbound names, and renames.
 *
 * @example
 * ```ts
 * const { launchable, unbound } = resolvePersistedSessions(state.sessions, await storage.getTeams());
 * for (const name of unbound) persistence.unregisterSession(name);
 * ```
 */
export function resolvePersistedSessions(
	sessions: ReadonlyArray<PersistedSessionInfo>,
	teams: ReadonlyArray<BindingTeam>,
): ResolvedPersistedSessions {
	const bindings = collectSessionBindings(teams);
	const byMember = collectMemberBindings(teams);
	const launchable: PersistedSessionInfo[] = [];
	const unbound: string[] = [];
	const rebound: Array<{ from: string; to: string }> = [];
	const taken = new Set<string>();

	// Pass 1: entries already under a bound name (or claiming no team) win.
	const pending: PersistedSessionInfo[] = [];
	for (const info of sessions) {
		if (!claimsTeam(info) || bindings.has(info.name)) {
			if (taken.has(info.name)) continue;
			taken.add(info.name);
			const binding = bindings.get(info.name);
			launchable.push(binding ? { ...info, teamId: binding.teamId, memberId: binding.memberId } : { ...info });
		} else {
			pending.push(info);
		}
	}

	// Pass 2: stale names. Rebind through memberId if possible, but never
	// start a second copy of a member whose bound name is already launchable.
	for (const info of pending) {
		const boundName = info.memberId ? byMember.get(info.memberId) : undefined;
		const binding = boundName ? bindings.get(boundName) : undefined;
		if (boundName && binding && !taken.has(boundName)) {
			taken.add(boundName);
			launchable.push({ ...info, name: boundName, teamId: binding.teamId, memberId: binding.memberId });
			rebound.push({ from: info.name, to: boundName });
		}
		// Either way the stale name itself is dead.
		unbound.push(info.name);
	}

	return { launchable, unbound, rebound };
}

/** Which persisted sessions startup auto-restore relaunches, and why the rest are skipped. */
export interface AutoRestoreSelection {
	/** Sessions to relaunch, each under a bound name (or claiming no team). */
	sessions: PersistedSessionInfo[];
	/** Stale names that are never relaunched. */
	unbound: string[];
	/** Stale names relaunched under the member's bound name instead. */
	rebound: Array<{ from: string; to: string }>;
	/** Bound sessions skipped because no pending WorkItem targets them. */
	skippedNoWork: string[];
}

/**
 * Choose the persisted sessions startup auto-restore relaunches.
 *
 * 1. Bindings: team sessions launch only under the name the team config binds
 *    the member to (see resolvePersistedSessions). If the teams could not be
 *    read (`teams === null`), only sessions that claim no team are kept: a
 *    stale name must never be launched just because the config was unreadable.
 * 2. Work gate: only sessions targeted by a pending WorkItem are relaunched.
 *    A rebound session also counts work that still targets its old name. If
 *    the pool could not be read (`targets === null`), the gate is skipped
 *    (the pre-existing safety valve: better to over-restore than strand work).
 *
 * @param input - Persisted sessions (orchestrator/auditor already removed),
 *   the teams (or null), and the names targeted by pending WorkItems (or null).
 * @returns The sessions to relaunch and the reasons others were dropped.
 */
export function selectAutoRestoreSessions(input: {
	sessions: ReadonlyArray<PersistedSessionInfo>;
	teams: ReadonlyArray<BindingTeam> | null;
	targets: ReadonlySet<string> | null;
}): AutoRestoreSelection {
	let bound: PersistedSessionInfo[];
	let unbound: string[];
	let rebound: Array<{ from: string; to: string }>;
	if (input.teams === null) {
		bound = input.sessions.filter((s) => !claimsTeam(s)).map((s) => ({ ...s }));
		unbound = input.sessions.filter((s) => claimsTeam(s)).map((s) => s.name);
		rebound = [];
	} else {
		({ launchable: bound, unbound, rebound } = resolvePersistedSessions(input.sessions, input.teams));
	}

	if (input.targets === null) {
		return { sessions: bound, unbound, rebound, skippedNoWork: [] };
	}
	const targets = input.targets;
	const oldName = new Map(rebound.map((r) => [r.to, r.from]));
	const hasWork = (s: PersistedSessionInfo) => targets.has(s.name) || targets.has(oldName.get(s.name) ?? '');
	return {
		sessions: bound.filter(hasWork),
		unbound,
		rebound,
		skippedNoWork: bound.filter((s) => !hasWork(s)).map((s) => s.name),
	};
}

/** Marker Crewly writes into the frontmatter of the agent files it generates. */
const CREWLY_AGENT_FILE_MARKER = 'agent for Crewly orchestration';

/**
 * Delete the Claude Code agent file Crewly generated for a session
 * (`{projectPath}/.claude/agents/{sessionName}.md`). That file is what lists
 * the session as a launchable agent. Only a file carrying Crewly's own
 * frontmatter marker is removed; a hand-written agent is left alone.
 *
 * @param projectPath - Project the session ran in.
 * @param sessionName - Session whose agent file to remove.
 * @returns true if a file was removed.
 */
export async function removeCrewlyAgentFile(projectPath: string | undefined, sessionName: string): Promise<boolean> {
	if (!projectPath || !sessionName || sessionName.includes('/') || sessionName.includes('..')) return false;
	const file = path.join(projectPath, '.claude', 'agents', `${sessionName}.md`);
	try {
		const head = (await fs.readFile(file, 'utf8')).slice(0, 512);
		if (!head.startsWith('---') || !head.includes(CREWLY_AGENT_FILE_MARKER)) return false;
		await fs.unlink(file);
		return true;
	} catch {
		return false;
	}
}
