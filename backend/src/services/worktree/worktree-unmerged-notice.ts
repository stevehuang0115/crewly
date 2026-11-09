/**
 * Unmerged-worktree notice — the janitor keeps a worktree whose commits never
 * reached the default branch, and until now it did so silently. Such work piles
 * up on disk and, worse, gets deployed from branches that never reach main.
 * This module decides who is told, what they are told, and remembers that they
 * were told (once per worktree per `UNMERGED_NOTICE_INTERVAL_MS`).
 *
 * The owner is never told directly: the lead of the team that owns the
 * worktree is (the orchestrator when no team can be found).
 *
 * @module services/worktree/worktree-unmerged-notice
 */

import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';
import { formatBytes } from './worktree-janitor.git.js';
import { heldWorktreeNoticeLine, type HeldTicketMatch } from '../project-tickets/ticket-hold.js';

/** Facts about one kept, unmerged worktree. */
export interface UnmergedWorktreeFacts {
	/** Worktree path */
	path: string;
	/** Branch, or null when HEAD is detached */
	branch: string | null;
	/** Commits reachable from HEAD but not from the default branch */
	commitsNotOnMain: number;
	/** The default ref the commits were counted against (e.g. `origin/main`) */
	defaultRef: string;
	/** True when the branch exists on origin with all of these commits */
	pushed: boolean;
	/** Size on disk in bytes, or null when unknown */
	sizeBytes: number | null;
}

/** Persisted state: worktree path -> epoch ms of the last notice. */
export type UnmergedNoticeState = Record<string, number>;

/**
 * Whether a worktree may be reported now.
 *
 * @param state - Notice state
 * @param worktreePath - Worktree path
 * @param newestCommitMs - Epoch ms of the newest commit, or null when unknown
 * @param now - Current epoch ms
 * @returns True when the newest commit is old enough and the worktree was not reported within the interval
 */
export function shouldNotifyUnmerged(
	state: UnmergedNoticeState,
	worktreePath: string,
	newestCommitMs: number | null,
	now: number,
): boolean {
	if (newestCommitMs === null || now - newestCommitMs < WORKTREE_JANITOR_CONSTANTS.UNMERGED_NOTICE_MIN_AGE_MS) return false;
	const last = state[worktreePath];
	return last === undefined || now - last >= WORKTREE_JANITOR_CONSTANTS.UNMERGED_NOTICE_INTERVAL_MS;
}

/**
 * Drop entries too old to matter, so the state file does not grow forever.
 *
 * @param state - Notice state
 * @param now - Current epoch ms
 * @returns A pruned copy
 */
export function pruneUnmergedState(state: UnmergedNoticeState, now: number): UnmergedNoticeState {
	const out: UnmergedNoticeState = {};
	for (const [p, at] of Object.entries(state)) {
		if (now - at < WORKTREE_JANITOR_CONSTANTS.UNMERGED_NOTICE_INTERVAL_MS) out[p] = at;
	}
	return out;
}

/**
 * The short plain-English message to a team lead. When a ticket put this
 * work on hold, the notice says so and asks only for the close — never
 * "merge it" (crewly#1369: the plain notice became a new ticket and a
 * "merge?" card although the owner had said "do not merge").
 *
 * @param f - Worktree facts
 * @param hold - The held ticket naming this branch / worktree, if any
 * @returns Message text
 */
export function buildUnmergedNotice(f: UnmergedWorktreeFacts, hold?: HeldTicketMatch | null): string {
	const branch = f.branch ? `branch ${f.branch}` : 'detached HEAD (no branch)';
	const pushed = f.branch ? (f.pushed ? 'pushed' : 'NOT pushed') : 'NOT pushed (no branch)';
	const size = f.sizeBytes !== null ? `, ${formatBytes(f.sizeBytes)} on disk` : '';
	const n = f.commitsNotOnMain;
	if (hold) {
		return (
			`Worktree with unmerged work: ${f.path} (${branch}) has ${n} commit${n === 1 ? '' : 's'} not on ${f.defaultRef}, ${pushed}${size}. ` +
			heldWorktreeNoticeLine(hold)
		);
	}
	return (
		`Worktree with unmerged work: ${f.path} (${branch}) has ${n} commit${n === 1 ? '' : 's'} not on ${f.defaultRef}, ${pushed}${size}. ` +
		'Please merge it to main (or tell me why to drop it), make sure main matches what is live, then remove the worktree.'
	);
}

/**
 * Session names to tell about a worktree: the first lead (with a session) of
 * the first team on the project that holds it.
 *
 * @param repoMain - Main worktree path of the repo
 * @param worktreePath - The worktree
 * @returns Session names, empty when no team / lead is found
 */
export async function defaultResolveLeadSessions(repoMain: string, worktreePath: string): Promise<string[]> {
	try {
		const { StorageService } = await import('../core/storage.service.js');
		const { getTeamLeads } = await import('../../utils/team.utils.js');
		const { canonicalPath, isPathInside } = await import('./worktree-janitor.git.js');
		const storage = StorageService.getInstance();
		const main = canonicalPath(repoMain);
		const projects = (await storage.getProjects()).filter((p) => {
			if (!p?.path) return false;
			const pp = canonicalPath(p.path);
			return pp === main || isPathInside(worktreePath, pp);
		});
		if (projects.length === 0) return [];
		const ids = new Set(projects.map((p) => p.id));
		const teams = (await storage.getTeams()).filter((t) => !t.archived && (t.projectIds ?? []).some((id) => ids.has(id)));
		for (const team of teams) {
			const lead = getTeamLeads(team).find((m) => m.sessionName);
			if (lead?.sessionName) return [lead.sessionName];
		}
	} catch {
		// storage unavailable — caller falls back to the orchestrator
	}
	return [];
}
