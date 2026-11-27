import { TEAM_ROSTER_CONSTANTS as C } from '../../constants.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import {
	buildRoster,
	clip,
	estimateRosterTokens,
	findOwnersFor,
	renderRoster,
	type RosterSources,
	type RosterTeam,
	type RosterTicket,
	type RosterWorkItem,
} from './team-roster.builder.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function member(name: string, role: string, extra: Partial<TeamMember> = {}): TeamMember {
	return {
		id: `m-${name}`,
		name,
		agentId: `${name.toLowerCase()}-agent`,
		sessionName: '',
		role,
		systemPrompt: '',
		agentStatus: 'inactive',
		workingStatus: 'idle',
		runtimeType: 'claude-code',
		createdAt: daysAgo(90),
		updatedAt: daysAgo(1),
		...extra,
	} as TeamMember;
}

function team(id: string, name: string, members: TeamMember[], extra: Partial<Team> = {}): Team {
	return { id, name, members, projectIds: [], createdAt: daysAgo(90), updatedAt: daysAgo(1), ...extra } as Team;
}

function ticket(id: string, title: string, status: string, extra: Partial<RosterTicket> = {}): RosterTicket {
	return { id, title, status, priority: 'P2', assignee: null, team: null, updatedAt: daysAgo(1), projectPath: '/p/ce', ...extra } as RosterTicket;
}

function wi(id: string, title: string, status: string, extra: Partial<RosterWorkItem> = {}): RosterWorkItem {
	return { id: `${id}-0000-0000`, title, status, target: undefined, createdAt: daysAgo(2), completedAt: undefined, statusChangedAt: undefined, metadata: {}, ...extra } as RosterWorkItem;
}

const PROJECTS: Project[] = [
	{ id: 'p-ce', name: 'CE', path: '/p/ce' },
	{ id: 'p-flop', name: 'Flopost', path: '/p/flopost' },
	{ id: 'p-shared', name: 'Shared', path: '/p/shared' },
] as Project[];

function sources(over: Partial<RosterSources> = {}): RosterSources {
	return { teams: [], projects: PROJECTS, tickets: [], workItems: [], now: NOW, ...over };
}

const OWEN = member('Owen', 'tech-lead');
const VERA = member('Vera', 'developer', { skills: ['data', 'backend'] });
const CE = team('t-ce', 'CE', [OWEN, VERA], {
	description: 'CareerEngine: visa probability product, data pipeline and web app for immigrants.',
	projectIds: ['p-ce'],
	leaderIds: [OWEN.id],
});
const PIA = member('Pia', 'product-manager');
const FLOP = team('t-flop', 'Flopost', [PIA, member('Dex', 'developer')], {
	description: 'Flopost product team: video editing engine and the flopost-video skill.',
	projectIds: ['p-flop'],
});

describe('clip', () => {
	it('collapses whitespace and marks a cut', () => {
		expect(clip('a  b\n c', 20)).toBe('a b c');
		expect(clip('abcdefghij', 5)).toBe('abcd…');
	});
});

describe('buildRoster — charter', () => {
	it('prefers the lead-written charter, then the description, then a derived one', () => {
		const withCharter = { ...CE, charter: 'Owns the CE product.' };
		const noDesc = team('t-x', 'Ops Crew', [member('Nora', 'ops')], { description: '', projectIds: ['p-flop'] });
		const rows = buildRoster(sources({ teams: [withCharter, FLOP, noDesc] }));
		const by = (n: string): RosterTeam => rows.find((r) => r.name === n)!;
		expect(by('CE')).toMatchObject({ charterSource: 'lead' });
		expect(by('CE').charter).toContain('Owns the CE product.');
		expect(by('Flopost')).toMatchObject({ charterSource: 'description' });
		expect(by('Ops Crew').charterSource).toBe('derived');
		expect(by('Ops Crew').charter).toContain('roles: ops');
		expect(by('Ops Crew').charter).toContain('projects: Flopost');
	});

	it('counts a short CJK description as a real one (characters, not words)', () => {
		const t = team('t-pm', 'property-management', [member('Nora', 'ops')], { description: '物业运营：租务、维修、账务' });
		expect(buildRoster(sources({ teams: [t] }))[0]).toMatchObject({ charterSource: 'description' });
	});

	it('keeps a too-short description at the head of the derived charter', () => {
		const t = team('t-s', 'Scribes', [member('Sam', 'writer')], { description: 'Scribes' });
		const row = buildRoster(sources({ teams: [t] }))[0];
		expect(row.charterSource).toBe('derived');
		expect(row.charter.startsWith('Scribes')).toBe(true);
	});

	it('adds owned domains, what the team takes and avoids, and a distinct mission', () => {
		const t = team('t-d', 'Docs', [member('Dee', 'writer')], {
			description: 'Documentation for the product and its API.',
			mission: 'Zero unanswered how-to questions',
			ownershipScope: { domains: ['docs', 'tutorials'], deliverables: [] },
			serviceContract: { accepts: ['doc requests'], avoids: ['code changes'], expectedOutput: [] },
		} as Partial<Team>);
		const charter = buildRoster(sources({ teams: [t] }))[0].charter;
		expect(charter).toContain('Owns: docs, tutorials.');
		expect(charter).toContain('Takes: doc requests.');
		expect(charter).toContain('Avoids: code changes.');
		expect(charter).toContain('Mission: Zero unanswered how-to questions');
	});

	it('skips archived and unnamed teams', () => {
		const rows = buildRoster(sources({ teams: [CE, { ...FLOP, archived: true }, { ...FLOP, id: 'x', name: '' }] }));
		expect(rows.map((r) => r.name)).toEqual(['CE']);
	});
});

describe('buildRoster — members, leads and flags', () => {
	it('names leads, specialties, projects, channel and parent team', () => {
		const child = team('t-child', 'CE Data', [member('Dan', 'developer')], { parentTeamId: CE.id });
		const rows = buildRoster(sources({ teams: [CE, child], channels: new Map([[CE.id, 'pro-ce']]) }));
		const ce = rows.find((r) => r.name === 'CE')!;
		expect(ce.leads).toEqual(['Owen']);
		expect(ce.projects).toEqual(['CE']);
		expect(ce.channel).toBe('pro-ce');
		expect(ce.members.find((m) => m.name === 'Vera')!.specialties).toEqual(['data', 'backend']);
		expect(rows.find((r) => r.name === 'CE Data')!.parent).toBe('CE');
	});

	it('reads a stated focus out of the member brief, skipping the role itself', () => {
		const luna = member('Luna', 'content-strategist', { systemPrompt: 'You are Luna. Strengths: long-form thought leadership, narrative arcs. Always cite sources.' });
		const row = buildRoster(sources({ teams: [team('t-m', 'Marketing', [luna], { description: 'Marketing org for content and distribution.' })] }))[0];
		expect(row.members[0].specialties).toEqual(['long-form thought leadership, narrative arcs']);
	});

	it('flags a paused team only while the pause is active', () => {
		const paused = { ...CE, paused: { pausedAt: daysAgo(1), by: 'owner' as const } };
		const lapsed = { ...FLOP, paused: { pausedAt: daysAgo(3), by: 'owner' as const, until: daysAgo(1) } };
		const rows = buildRoster(sources({ teams: [paused, lapsed] }));
		expect(rows.find((r) => r.name === 'CE')!.paused).toBe(true);
		expect(rows.find((r) => r.name === 'Flopost')!.paused).toBe(false);
	});
});

describe('buildRoster — work attribution', () => {
	it('puts tickets under their team by team id, team name, assignee session, or the only team on the project', () => {
		const rows = buildRoster(
			sources({
				teams: [CE, FLOP],
				tickets: [
					ticket('CE-1', 'by team id', 'in_progress', { team: 't-ce' }),
					ticket('CE-2', 'by team name', 'ready', { team: 'flopost' }),
					ticket('CE-3', 'by assignee', 'review', { assignee: 'vera-agent', projectPath: '/p/other' }),
					ticket('CE-4', 'by only team on project', 'ready', { projectPath: '/p/ce' }),
					ticket('X-1', 'nobody owns it', 'ready', { projectPath: '/p/nowhere' }),
				],
			}),
		);
		const ce = rows.find((r) => r.name === 'CE')!;
		const flop = rows.find((r) => r.name === 'Flopost')!;
		expect(ce.open.map((w) => w.ref).sort()).toEqual(['CE-1', 'CE-3', 'CE-4']);
		expect(flop.open.map((w) => w.ref)).toEqual(['CE-2']);
		expect(ce.open.find((w) => w.ref === 'CE-3')!.who).toBe('Vera');
	});

	it('does not guess an owner when several teams share the project', () => {
		const a = team('a', 'A', [member('Al', 'developer')], { projectIds: ['p-shared'] });
		const b = team('b', 'B', [member('Bo', 'developer')], { projectIds: ['p-shared'] });
		const rows = buildRoster(sources({ teams: [a, b], tickets: [ticket('S-1', 'unowned', 'ready', { projectPath: '/p/shared' })] }));
		expect(rows.every((r) => r.open.length === 0)).toBe(true);
	});

	it('orders open work by what is moving, lists only recent done work, and counts backlog', () => {
		const rows = buildRoster(
			sources({
				teams: [CE],
				tickets: [
					ticket('CE-1', 'waiting', 'ready'),
					ticket('CE-2', 'moving', 'in_progress'),
					ticket('CE-3', 'finished this week', 'done', { updatedAt: daysAgo(2) }),
					ticket('CE-4', 'finished long ago', 'done', { updatedAt: daysAgo(20) }),
					ticket('CE-5', 'someday', 'backlog'),
					ticket('CE-6', 'dropped', 'cancelled'),
				],
			}),
		);
		const ce = rows[0];
		expect(ce.open.map((w) => w.ref)).toEqual(['CE-2', 'CE-1']);
		expect(ce.recentDone.map((w) => w.ref)).toEqual(['CE-3']);
		expect(ce.backlog).toBe(1);
		expect(ce.history).toEqual(expect.arrayContaining(['finished long ago']));
		expect(ce.history).not.toContain('dropped');
	});

	it('attributes WorkItems by target session or metadata.teamId, skips chores, counts routine runs', () => {
		const rows = buildRoster(
			sources({
				teams: [CE, FLOP],
				workItems: [
					wi('aaaaaaaa', 'Draft the visa explainer', 'running', { target: 'vera-agent' }),
					wi('bbbbbbbb', 'Plan the launch video', 'queued', { metadata: { teamId: 't-flop' } }),
					wi('cccccccc', 'Ship pricing page', 'verified', { target: 'owen-agent', completedAt: daysAgo(1) }),
					wi('dddddddd', 'Verify: Ship pricing page', 'queued', { target: 'owen-agent', type: 'review' }),
					wi('eeeeeeee', 'Retry 1/3: Draft the visa explainer', 'queued', { target: 'vera-agent', parentWorkItemId: 'aaaaaaaa' }),
					wi('ffffffff', 'Follow-up for the owner (TKT-9): soon', 'queued', { target: 'vera-agent' }),
					wi('99999999', 'Nightly metrics post', 'done', { target: 'vera-agent', completedAt: daysAgo(1), metadata: { origin: { kind: 'trigger' } } }),
				],
			}),
		);
		const ce = rows.find((r) => r.name === 'CE')!;
		expect(ce.open.map((w) => w.title)).toEqual(['Draft the visa explainer']);
		expect(ce.open[0]).toMatchObject({ ref: 'aaaaaaaa', who: 'Vera' });
		expect(ce.recentDone.map((w) => w.title)).toEqual(['Ship pricing page']);
		expect(ce.routineRuns).toBe(1);
		expect(rows.find((r) => r.name === 'Flopost')!.open.map((w) => w.title)).toEqual(['Plan the launch video']);
	});

	it('lets a ticket stand for the WorkItem linked to it', () => {
		const rows = buildRoster(
			sources({
				teams: [CE],
				tickets: [ticket('CE-7', 'Fix the login', 'in_progress', { team: 't-ce' })],
				workItems: [wi('11111111', 'Fix the login (delegated)', 'running', { target: 'vera-agent', metadata: { projectTicket: { id: 'CE-7', projectPath: '/p/ce' } } })],
			}),
		);
		expect(rows[0].open.map((w) => w.ref)).toEqual(['CE-7']);
	});

	it('drops the leading [Tag] from request-born titles and cuts long ones', () => {
		const rows = buildRoster(sources({ teams: [CE], tickets: [ticket('CE-8', `[Research] ${'x'.repeat(200)}`, 'ready', { team: 't-ce' })] }));
		expect(rows[0].open[0].title.startsWith('xxx')).toBe(true);
		expect(rows[0].open[0].title.length).toBeLessThanOrEqual(C.TITLE_MAX_CHARS);
	});

	it('sorts the busiest team first', () => {
		const rows = buildRoster(sources({ teams: [FLOP, CE], tickets: [ticket('CE-1', 'a', 'in_progress', { team: 't-ce' }), ticket('CE-2', 'b', 'ready', { team: 't-ce' })] }));
		expect(rows.map((r) => r.name)).toEqual(['CE', 'Flopost']);
	});
});

describe('estimateRosterTokens', () => {
	it('counts each CJK character as a token and Latin text at four characters per token', () => {
		expect(estimateRosterTokens('abcdefgh')).toBe(2);
		expect(estimateRosterTokens('物业运营')).toBe(4);
		expect(estimateRosterTokens('')).toBe(0);
	});
});

describe('renderRoster', () => {
	function many(n: number): RosterTeam[] {
		const mk = (i: number): Team => team(`t${i}`, `Team ${i}`, [member(`Lead${i}`, 'team-leader'), member(`Worker${i}`, 'developer', { skills: ['alpha', 'beta'] })], { description: `Team ${i} owns the ${'long charter text about many things '.repeat(8)}`, projectIds: ['p-ce'] });
		const tickets = Array.from({ length: n * 4 }, (_, i) => ticket(`T-${i}`, `Ticket number ${i} about something specific`, i % 2 ? 'in_progress' : 'done', { team: `t${i % n}` }));
		return buildRoster(sources({ teams: Array.from({ length: n }, (_, i) => mk(i)), tickets }));
	}

	it('returns nothing without teams', () => {
		expect(renderRoster([])).toBe('');
	});

	it('shows the heading, routing rule, lead, members, projects and work lines', () => {
		const md = renderRoster(buildRoster(sources({ teams: [CE], tickets: [ticket('CE-1', 'Fix login', 'in_progress', { team: 't-ce' }), ticket('CE-2', 'Ship map', 'done', { team: 't-ce' })], channels: new Map([[CE.id, 'pro-ce']]) })));
		expect(md.startsWith(C.HEADING)).toBe(true);
		expect(md).toContain('find-owner-for');
		expect(md).toContain('### CE — lead Owen · #pro-ce');
		expect(md).toContain('Members: Owen (tech-lead); Vera (developer: data, backend)');
		expect(md).toContain('Projects: CE');
		expect(md).toContain('Now: CE-1 Fix login');
		expect(md).toContain('Done 7d: CE-2 Ship map');
	});

	it('marks derived charters and paused teams', () => {
		const t = team('t-p', 'Quiet', [member('Q', 'ops')], { description: '', paused: { pausedAt: daysAgo(1), by: 'owner' } });
		const md = renderRoster(buildRoster(sources({ teams: [t] })));
		expect(md).toContain('(derived; the lead has not written a charter)');
		expect(md).toContain('PAUSED (owner): do not hand it work');
	});

	it('stays under the budget by dropping detail tier by tier, and keeps the busiest teams', () => {
		const rows = many(12);
		const full = renderRoster(rows, 1_000_000);
		const budget = Math.floor(estimateRosterTokens(full) / 2);
		const md = renderRoster(rows, budget);
		expect(estimateRosterTokens(md)).toBeLessThanOrEqual(budget);
		expect(md).toContain(rows[0].name);
	});

	it('names the teams it had to leave out when even the leanest tier does not fit', () => {
		const rows = many(30);
		const md = renderRoster(rows, 700);
		expect(estimateRosterTokens(md)).toBeLessThanOrEqual(700);
		expect(md).toContain('Not detailed (budget):');
		expect(md).toContain('`team-roster`');
		expect(md).toContain(`### ${rows[0].name}`);
		expect(md).not.toContain(`### ${rows[29].name}`);
	});

	it('always shows at least the busiest team, even under an absurd budget', () => {
		const rows = many(5);
		expect(renderRoster(rows, 10)).toContain(`### ${rows[0].name}`);
	});

	it('renders the default prompt budget for a realistic workspace', () => {
		const md = renderRoster(many(14));
		expect(estimateRosterTokens(md)).toBeLessThanOrEqual(C.PROMPT_MAX_TOKENS);
	});
});

describe('findOwnersFor', () => {
	const MARKETING = team('t-mk', 'Crewly Marketing', [member('Ella', 'team-leader'), member('Luna', 'content-strategist', { systemPrompt: 'Strengths: LinkedIn posts, newsletters, long-form writing.' })], {
		description: 'Marketing: content strategy, social distribution, sales and newsletters.',
		leaderIds: ['m-Ella'],
	});
	const THINK = team('t-tt', 'Think Tank', [member('Atlas', 'team-leader'), member('Sage', 'researcher')], {
		description: 'Research team: deep-dive analysis on industry, market and technical questions.',
		leaderIds: ['m-Atlas'],
	});
	const PROP = team('t-pm', 'property-management', [member('Nora', 'ops')], { description: '物业运营：租务、维修、账务' });
	const rows = (): RosterTeam[] =>
		buildRoster(
			sources({
				teams: [CE, FLOP, MARKETING, THINK, PROP],
				tickets: [ticket('CE-1', 'Fix visa login redirect', 'in_progress', { team: 't-ce', assignee: 'vera-agent' })],
			}),
		);

	it('routes a request to the team whose charter fits, handing it to the lead', () => {
		const [top] = findOwnersFor(rows(), 'Please research the competitors in the AI market');
		expect(top).toMatchObject({ team: 'Think Tank', handTo: 'Atlas' });
		expect(top.matched).toEqual(expect.arrayContaining(['research', 'market']));
	});

	it('uses recent ticket titles: the ticket owner wins a request about that work', () => {
		const [top] = findOwnersFor(rows(), 'the visa login redirect is broken again');
		expect(top).toMatchObject({ team: 'CE', handTo: 'Owen' });
	});

	it('suggests the member whose own skills or work fit as the likely doer', () => {
		const [top] = findOwnersFor(rows(), 'draft the LinkedIn post');
		expect(top).toMatchObject({ team: 'Crewly Marketing', handTo: 'Ella', likelyDoer: 'Luna' });
	});

	it('takes a named member or team as a strong signal', () => {
		expect(findOwnersFor(rows(), 'ask Sage about it')[0]).toMatchObject({ team: 'Think Tank', likelyDoer: 'Sage' });
		expect(findOwnersFor(rows(), 'what is Flopost doing')[0].team).toBe('Flopost');
	});

	it('matches CJK requests and ignores filler characters', () => {
		const hits = findOwnersFor(rows(), '查一下租客的维修账单');
		expect(hits[0].team).toBe('property-management');
		expect(hits[0].matched).not.toContain('的');
	});

	it('returns nothing for filler-only, empty or unmatched requests', () => {
		expect(findOwnersFor(rows(), 'can you please do it')).toEqual([]);
		expect(findOwnersFor(rows(), '   ')).toEqual([]);
		expect(findOwnersFor(rows(), 'zzzqqq xyzzy')).toEqual([]);
		expect(findOwnersFor([], 'research')).toEqual([]);
	});

	it('flags a close call as ambiguous and a clear winner as not', () => {
		const twins = buildRoster(
			sources({
				teams: [
					team('a', 'Video Studio A', [member('Ann', 'team-leader')], { description: 'Makes promo video content for launches.', leaderIds: ['m-Ann'] }),
					team('b', 'Video Studio B', [member('Bob', 'team-leader')], { description: 'Makes promo video content for launches.', leaderIds: ['m-Bob'] }),
				],
			}),
		);
		const close = findOwnersFor(twins, 'promo video for the launch');
		expect(close[0].ambiguous).toBe(true);
		expect(close[1].ambiguous).toBe(true);
		expect(findOwnersFor(rows(), 'research the market')[0].ambiguous).toBe(false);
	});

	it('flags a paused team so the orchestrator does not hand it work', () => {
		const paused = buildRoster(sources({ teams: [{ ...THINK, paused: { pausedAt: daysAgo(1), by: 'owner' } }] }));
		expect(findOwnersFor(paused, 'research the market')[0].paused).toBe(true);
	});

	it('caps the number of candidates', () => {
		expect(findOwnersFor(rows(), 'team market video visa research', 2).length).toBeLessThanOrEqual(2);
		expect(findOwnersFor(rows(), 'team market video visa research', 100).length).toBeLessThanOrEqual(C.FIND_MAX_LIMIT);
	});

	it('falls back to a member when the team has no lead', () => {
		const solo = buildRoster(sources({ teams: [team('s', 'Solo', [member('Sol', 'developer')], { description: 'Builds the solo widget service for partners.' })] }));
		expect(findOwnersFor(solo, 'widget service')[0].handTo).toBe('Sol');
	});
});

describe('a team with no members yet', () => {
	it('is built, rendered and searched without needing a first member', () => {
		const empty = team('t-new', 'Studio', [], { description: 'Video studio team for editing work.' });
		const roster = buildRoster(sources({ teams: [CE, empty] }));

		expect(roster.find((t) => t.name === 'Studio')).toMatchObject({ members: [], leads: [] });
		expect(renderRoster(roster)).toContain('Studio');
		expect(findOwnersFor(roster, 'video studio editing')[0]).toMatchObject({ team: 'Studio', handTo: 'Studio' });
	});
});
