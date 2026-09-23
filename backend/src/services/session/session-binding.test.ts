/**
 * Tests for session-binding: persisted session entries are launchable only
 * under a name the team config binds a member to.
 *
 * The fixture mirrors the 2026-09-23 incident: member 45506487 was renamed
 * from "Self-Watch Scribe" to "Dana"; session-state.json kept an entry under
 * the old name (teamId set, memberId lost) beside the bound one.
 *
 * @module services/session/session-binding.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import {
	claimsTeam,
	collectSessionBindings,
	removeCrewlyAgentFile,
	resolvePersistedSessions,
	selectAutoRestoreSessions,
	type BindingTeam,
} from './session-binding.js';
import { SessionStatePersistence, type PersistedSessionInfo } from './session-state-persistence.js';
import { RUNTIME_TYPES } from '../../constants.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn(() => ({
			createComponentLogger: jest.fn(() => ({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			})),
		})),
	},
}));

const TEAM_ID = '03bf7d62-06a9-4888-b5f6-a368d34b2f10';
const DANA_ID = '45506487-1b63-4f81-a9fd-77053d69e181';
const BOUND = 'crewly-marketing-dana-45506487';
const STALE = 'crewly-marketing-self-watch-scribe-45506487';

const TEAMS: BindingTeam[] = [
	{
		id: TEAM_ID,
		members: [
			{ id: DANA_ID, sessionName: BOUND },
			{ id: 'luna-id', sessionName: 'crewly-marketing-luna-40e6e251' },
			{ id: 'stopped-id', sessionName: '' },
		],
	},
];

function entry(overrides: Partial<PersistedSessionInfo>): PersistedSessionInfo {
	return {
		name: 'x',
		cwd: '/proj',
		command: '/bin/zsh',
		args: [],
		runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
		role: 'content-strategist',
		...overrides,
	};
}

/** The incident's session-state.json, as written to disk. */
const INCIDENT_STATE = {
	version: 1,
	savedAt: '2026-09-23T22:00:00.000Z',
	sessions: [
		entry({ name: 'crewly-orc', role: 'orchestrator' }),
		entry({ name: BOUND, teamId: TEAM_ID, memberId: DANA_ID, claudeSessionId: 'bound-conv' }),
		entry({ name: 'crewly-marketing-luna-40e6e251', teamId: TEAM_ID }),
		entry({ name: STALE, teamId: TEAM_ID, claudeSessionId: 'stale-conv' }),
	],
};

describe('resolvePersistedSessions', () => {
	it('drops a team entry whose name no member is bound to (the incident fixture)', () => {
		const r = resolvePersistedSessions(INCIDENT_STATE.sessions, TEAMS);

		expect(r.launchable.map((s) => s.name)).toEqual(['crewly-orc', BOUND, 'crewly-marketing-luna-40e6e251']);
		expect(r.launchable.map((s) => s.name)).not.toContain(STALE);
		expect(r.unbound).toEqual([STALE]);
		expect(r.rebound).toEqual([]);
	});

	it('launches the member under its bound name, carrying its own conversation id', () => {
		const r = resolvePersistedSessions(INCIDENT_STATE.sessions, TEAMS);
		const dana = r.launchable.filter((s) => s.memberId === DANA_ID);
		expect(dana).toHaveLength(1);
		expect(dana[0]).toMatchObject({ name: BOUND, teamId: TEAM_ID, claudeSessionId: 'bound-conv' });
	});

	it('fills in teamId/memberId from the binding for a bound entry that lost them', () => {
		const r = resolvePersistedSessions(INCIDENT_STATE.sessions, TEAMS);
		expect(r.launchable.find((s) => s.name === 'crewly-marketing-luna-40e6e251')).toMatchObject({
			teamId: TEAM_ID,
			memberId: 'luna-id',
		});
	});

	it('rebinds a stale entry to the bound name through its memberId when the bound one is not persisted', () => {
		const r = resolvePersistedSessions(
			[entry({ name: STALE, teamId: TEAM_ID, memberId: DANA_ID, claudeSessionId: 'c1' })],
			TEAMS,
		);
		expect(r.launchable).toEqual([
			expect.objectContaining({ name: BOUND, memberId: DANA_ID, teamId: TEAM_ID, claudeSessionId: 'c1' }),
		]);
		expect(r.unbound).toEqual([STALE]);
		expect(r.rebound).toEqual([{ from: STALE, to: BOUND }]);
	});

	it('never yields two launches for one member (bound entry wins over a stale one with the same memberId)', () => {
		const r = resolvePersistedSessions(
			[
				entry({ name: STALE, teamId: TEAM_ID, memberId: DANA_ID }),
				entry({ name: BOUND, teamId: TEAM_ID, memberId: DANA_ID }),
			],
			TEAMS,
		);
		expect(r.launchable.map((s) => s.name)).toEqual([BOUND]);
		expect(r.unbound).toEqual([STALE]);
	});

	it('drops an entry that only has a memberId of a member that no longer exists', () => {
		const r = resolvePersistedSessions([entry({ name: 'gone-1', memberId: 'deleted-member' })], TEAMS);
		expect(r.launchable).toEqual([]);
		expect(r.unbound).toEqual(['gone-1']);
	});

	it('keeps sessions that claim no team (orchestrator, ad-hoc) even though no member binds them', () => {
		const r = resolvePersistedSessions([entry({ name: 'crewly-orc', role: 'orchestrator' })], TEAMS);
		expect(r.launchable.map((s) => s.name)).toEqual(['crewly-orc']);
		expect(r.unbound).toEqual([]);
	});

	it('treats every team entry as unbound when there are no teams', () => {
		const r = resolvePersistedSessions(INCIDENT_STATE.sessions, []);
		expect(r.launchable.map((s) => s.name)).toEqual(['crewly-orc']);
		expect(r.unbound).toEqual([BOUND, 'crewly-marketing-luna-40e6e251', STALE]);
	});
});

describe('selectAutoRestoreSessions (startup relaunch)', () => {
	const baseline = INCIDENT_STATE.sessions.filter((s) => s.role !== 'orchestrator');

	it('never relaunches the stale name, even when a pending WorkItem targets it', () => {
		const sel = selectAutoRestoreSessions({
			sessions: baseline,
			teams: TEAMS,
			targets: new Set([STALE, BOUND, 'crewly-marketing-luna-40e6e251']),
		});
		expect(sel.sessions.map((s) => s.name)).toEqual([BOUND, 'crewly-marketing-luna-40e6e251']);
		expect(sel.unbound).toEqual([STALE]);
	});

	it('relaunches a renamed member under its bound name, counting work that still targets the old name', () => {
		const sel = selectAutoRestoreSessions({
			sessions: [entry({ name: STALE, teamId: TEAM_ID, memberId: DANA_ID })],
			teams: TEAMS,
			targets: new Set([STALE]),
		});
		expect(sel.sessions).toEqual([expect.objectContaining({ name: BOUND, memberId: DANA_ID })]);
		expect(sel.rebound).toEqual([{ from: STALE, to: BOUND }]);
	});

	it('keeps the work gate: a bound session with no pending WorkItem is skipped', () => {
		const sel = selectAutoRestoreSessions({ sessions: baseline, teams: TEAMS, targets: new Set([BOUND]) });
		expect(sel.sessions.map((s) => s.name)).toEqual([BOUND]);
		expect(sel.skippedNoWork).toEqual(['crewly-marketing-luna-40e6e251']);
	});

	it('pool unreadable: skips the work gate but still never relaunches the stale name', () => {
		const sel = selectAutoRestoreSessions({ sessions: baseline, teams: TEAMS, targets: null });
		expect(sel.sessions.map((s) => s.name)).toEqual([BOUND, 'crewly-marketing-luna-40e6e251']);
		expect(sel.skippedNoWork).toEqual([]);
	});

	it('teams unreadable: relaunches only sessions that claim no team', () => {
		const sel = selectAutoRestoreSessions({
			sessions: [...baseline, entry({ name: 'adhoc-1' })],
			teams: null,
			targets: null,
		});
		expect(sel.sessions.map((s) => s.name)).toEqual(['adhoc-1']);
		expect(sel.unbound).toEqual([BOUND, 'crewly-marketing-luna-40e6e251', STALE]);
	});
});

describe('resolving a session-state.json fixture file', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(tmpdir(), 'crewly-binding-'));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('the stale name read from disk is not launchable; the member resolves only to its bound name', async () => {
		const file = path.join(dir, 'session-state.json');
		await fs.writeFile(file, JSON.stringify(INCIDENT_STATE));
		const state = await new SessionStatePersistence(file).loadState();
		expect(state?.sessions).toHaveLength(4);

		const r = resolvePersistedSessions(state?.sessions ?? [], TEAMS);
		const names = r.launchable.map((s) => s.name);
		expect(names).not.toContain(STALE);
		expect(names.filter((n) => n.endsWith('-45506487'))).toEqual([BOUND]);
	});
});

describe('helpers', () => {
	it('collectSessionBindings skips members without a session name', () => {
		const b = collectSessionBindings(TEAMS);
		expect(b.get(BOUND)).toEqual({ teamId: TEAM_ID, memberId: DANA_ID });
		expect(b.has('')).toBe(false);
		expect(b.size).toBe(2);
	});

	it('claimsTeam', () => {
		expect(claimsTeam({ teamId: 't' })).toBe(true);
		expect(claimsTeam({ memberId: 'm' })).toBe(true);
		expect(claimsTeam({})).toBe(false);
	});
});

describe('removeCrewlyAgentFile', () => {
	let project: string;
	beforeEach(async () => {
		project = await fs.mkdtemp(path.join(tmpdir(), 'crewly-agentfile-'));
		await fs.mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(project, { recursive: true, force: true });
	});

	const file = (name: string) => path.join(project, '.claude', 'agents', `${name}.md`);

	it('removes the agent file Crewly generated for the session', async () => {
		await fs.writeFile(file(STALE), `---\nname: "${STALE}"\ndescription: "content-strategist agent for Crewly orchestration"\n---\n\nprompt`);
		expect(await removeCrewlyAgentFile(project, STALE)).toBe(true);
		await expect(fs.access(file(STALE))).rejects.toThrow();
	});

	it('leaves a hand-written agent file alone', async () => {
		await fs.writeFile(file('my-agent'), '---\nname: my-agent\ndescription: mine\n---\n');
		expect(await removeCrewlyAgentFile(project, 'my-agent')).toBe(false);
		await expect(fs.access(file('my-agent'))).resolves.toBeUndefined();
	});

	it('is a no-op for a missing file, a missing project path, or a path-like name', async () => {
		expect(await removeCrewlyAgentFile(project, 'nope')).toBe(false);
		expect(await removeCrewlyAgentFile(undefined, STALE)).toBe(false);
		expect(await removeCrewlyAgentFile(project, '../escape')).toBe(false);
	});
});
