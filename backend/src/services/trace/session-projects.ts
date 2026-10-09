/**
 * Which projects a session's teams work on, read synchronously from the
 * teams directory (the trace context decides on the delivery path, which is
 * not async). Cached for a short time; any read problem means "unknown",
 * and unknown never drops a trace link.
 *
 * @module services/trace/session-projects
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/** How long the teams read is reused (ms). */
const CACHE_TTL_MS = 30_000;

interface TeamLite {
	members?: Array<{ sessionName?: string; agentId?: string }>;
	projectIds?: string[];
}

/**
 * Build a resolver of session → project ids.
 *
 * @param teamsDir - Teams directory (default `<crewly home>/teams`)
 * @param now - Clock (ms)
 * @returns Resolver: the project ids of every team the session is a member of; null when the session is in no team or the teams cannot be read
 */
export function createSessionProjectResolver(
	teamsDir: string = path.join(getCrewlyHomePath(), 'teams'),
	now: () => number = () => Date.now(),
): (session: string) => string[] | null {
	let loadedAt = 0;
	let teams: TeamLite[] = [];
	return (session: string): string[] | null => {
		try {
			if (!session) return null;
			if (now() - loadedAt > CACHE_TTL_MS) {
				loadedAt = now();
				teams = [];
				if (existsSync(teamsDir)) {
					for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
						if (!entry.isDirectory()) continue;
						const file = path.join(teamsDir, entry.name, 'config.json');
						if (!existsSync(file)) continue;
						try {
							teams.push(JSON.parse(readFileSync(file, 'utf8')) as TeamLite);
						} catch {
							// unreadable team: skip it
						}
					}
				}
			}
			const mine = teams.filter((t) => (t.members ?? []).some((m) => m.sessionName === session || m.agentId === session));
			if (mine.length === 0) return null;
			return [...new Set(mine.flatMap((t) => t.projectIds ?? []))];
		} catch {
			return null;
		}
	};
}
