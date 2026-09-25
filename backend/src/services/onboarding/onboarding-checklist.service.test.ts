/**
 * Tests for the onboarding checklist service: step states derived from real
 * state, starters, the starter team, the first task and dismissal.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { Team } from '../../types/index.js';
import type { TeamTemplate } from '../../types/team-template.types.js';
import { TemplateService } from '../template/template.service.js';
import { OnboardingStateStore } from './onboarding-state.store.js';
import {
	OnboardingChecklistService,
	OnboardingError,
	buildFirstTaskMessage,
	buildTokenPageSignInUrl,
	toSessionSlug,
	type OnboardingChecklistDeps,
} from './onboarding-checklist.service.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'config', 'templates');
const NOW = new Date('2026-09-25T08:00:00.000Z');

/** A saved team. */
function team(id: string, templateId?: string): Team {
	return {
		id,
		name: `Team ${id}`,
		members: [],
		projectIds: [],
		createdAt: NOW.toISOString(),
		updatedAt: NOW.toISOString(),
		...(templateId ? { templateId } : {}),
	} as Team;
}

describe('OnboardingChecklistService', () => {
	let home: string;
	let teams: Team[];
	let deps: OnboardingChecklistDeps;
	let service: OnboardingChecklistService;
	const send = jest.fn();

	beforeEach(() => {
		home = mkdtempSync(path.join(tmpdir(), 'crewly-onboarding-checklist-'));
		TemplateService.clearInstance();
		teams = [];
		send.mockReset();
		send.mockResolvedValue({ conversationId: 'conv-1', forwarded: true, queued: true, error: null });
		deps = {
			store: new OnboardingStateStore(home),
			getHarnessState: jest.fn(async () => ({ orcHarness: 'claude-code', installed: true, loginState: 'logged_in' as const })),
			listTeams: jest.fn(async () => teams),
			saveTeam: jest.fn(async (t: Team) => {
				teams.push(t);
			}),
			templates: () => TemplateService.getInstance(TEMPLATES_DIR),
			getOrcHarness: jest.fn(async () => 'codex-cli'),
			hasOwnerMessage: jest.fn(() => false),
			getCloudState: jest.fn(() => ({ connected: false, tier: null })),
			isSlackConnected: jest.fn(() => false),
			sendToOrchestrator: send,
			now: () => NOW,
		};
		service = new OnboardingChecklistService(deps);
	});

	afterEach(() => {
		TemplateService.clearInstance();
		rmSync(home, { recursive: true, force: true });
	});

	/** Step `done` values by id. */
	async function doneMap(): Promise<Record<string, boolean>> {
		const list = await service.getChecklist();
		return Object.fromEntries(list.steps.map((s) => [s.id, s.done]));
	}

	describe('getChecklist', () => {
		it('lists the five steps in order', async () => {
			const list = await service.getChecklist();
			expect(list.steps.map((s) => s.id)).toEqual(['harness', 'team', 'first_task', 'cloud', 'slack']);
			expect(list.total).toBe(5);
			expect(list.doneCount).toBe(1);
			expect(list.allDone).toBe(false);
			expect(list.dismissed).toBe(false);
		});

		it('harness: done when recorded, installed and not logged out', async () => {
			expect((await doneMap()).harness).toBe(true);
			(deps.getHarnessState as jest.Mock).mockResolvedValue({ orcHarness: 'claude-code', installed: true, loginState: 'unknown' });
			expect((await doneMap()).harness).toBe(true);
			(deps.getHarnessState as jest.Mock).mockResolvedValue({ orcHarness: 'claude-code', installed: true, loginState: 'logged_out' });
			expect((await doneMap()).harness).toBe(false);
			(deps.getHarnessState as jest.Mock).mockResolvedValue({ orcHarness: 'claude-code', installed: false, loginState: null });
			expect((await doneMap()).harness).toBe(false);
			(deps.getHarnessState as jest.Mock).mockResolvedValue({ orcHarness: null, installed: false, loginState: null });
			expect((await doneMap()).harness).toBe(false);
		});

		it('team: done when a team exists or Blank was chosen', async () => {
			expect((await doneMap()).team).toBe(false);
			teams.push(team('t1', 'personal-assistant-team'));
			const list = await service.getChecklist();
			const step = list.steps.find((s) => s.id === 'team');
			expect(step?.done).toBe(true);
			expect(step?.detail).toEqual({ teams: [{ id: 't1', name: 'Team t1', templateId: 'personal-assistant-team' }], blank: false });
			teams.length = 0;
			await service.createStarterTeam('blank');
			expect((await doneMap()).team).toBe(true);
		});

		it('first_task: done when the owner wrote anywhere or setup sent one', async () => {
			expect((await doneMap()).first_task).toBe(false);
			(deps.hasOwnerMessage as jest.Mock).mockReturnValue(true);
			expect((await doneMap()).first_task).toBe(true);
			(deps.hasOwnerMessage as jest.Mock).mockReturnValue(false);
			await service.sendFirstTask('Plan my week');
			expect((await doneMap()).first_task).toBe(true);
		});

		it('cloud and slack: read live', async () => {
			(deps.getCloudState as jest.Mock).mockReturnValue({ connected: true, tier: 'pro' });
			(deps.isSlackConnected as jest.Mock).mockReturnValue(true);
			const list = await service.getChecklist();
			expect(list.steps.find((s) => s.id === 'cloud')).toMatchObject({ done: true, detail: { connected: true, tier: 'pro' } });
			expect(list.steps.find((s) => s.id === 'slack')).toEqual({ id: 'slack', done: true, detail: { connected: true, cloudConnected: true } });
		});

		it('cloud: offers the phone sign-in that ends on the portal token page', async () => {
			const list = await service.getChecklist();
			const cloud = list.steps.find((s) => s.id === 'cloud');
			expect(cloud?.detail).toMatchObject({ connected: false, tokenPageSignInUrl: buildTokenPageSignInUrl() });
		});

		it('a failing source reads as not done with an error, the rest still returns', async () => {
			(deps.getHarnessState as jest.Mock).mockRejectedValue(new Error('probe failed'));
			(deps.listTeams as jest.Mock).mockRejectedValue(new Error('disk'));
			(deps.hasOwnerMessage as jest.Mock).mockImplementation(() => {
				throw new Error('db');
			});
			(deps.isSlackConnected as jest.Mock).mockImplementation(() => {
				throw new Error('slack');
			});
			(deps.getCloudState as jest.Mock).mockImplementation(() => {
				throw new Error('cloud');
			});
			const list = await service.getChecklist();
			expect(list.steps.every((s) => !s.done)).toBe(true);
			expect(list.steps.map((s) => s.detail.error)).toEqual(['probe failed', 'disk', 'db', 'cloud', 'slack']);
		});

		it('all done', async () => {
			teams.push(team('t1'));
			(deps.hasOwnerMessage as jest.Mock).mockReturnValue(true);
			(deps.getCloudState as jest.Mock).mockReturnValue({ connected: true, tier: 'free' });
			(deps.isSlackConnected as jest.Mock).mockReturnValue(true);
			const list = await service.getChecklist();
			expect(list.allDone).toBe(true);
			expect(list.doneCount).toBe(5);
		});
	});

	describe('listStarters', () => {
		it('lists Personal Assistant (recommended), Marketing, then Blank, each with 3 suggestions', () => {
			const starters = service.listStarters();
			expect(starters.map((s) => s.id)).toEqual(['personal-assistant-team', 'growth-marketing-team', 'blank']);
			expect(starters.map((s) => s.recommended)).toEqual([true, false, false]);
			for (const s of starters) expect(s.suggestions).toHaveLength(3);
			expect(starters[0].members).toEqual([
				{ name: 'Assistant', role: 'generalist' },
				{ name: 'Researcher', role: 'researcher' },
			]);
			expect(starters[2].members).toEqual([]);
		});

		it('expands counted roles into numbered members', () => {
			const template = {
				id: 'x',
				name: 'X',
				description: 'd',
				roles: [{ role: 'developer', defaultName: 'Dev', count: 2 }],
				onboarding: { order: 1, recommended: true, label: 'x', tagline: 't', suggestions: ['a', 'b', 'c'] },
			} as unknown as TeamTemplate;
			const custom = new OnboardingChecklistService({
				...deps,
				templates: () => ({ listOnboardingStarters: () => [template], getTemplate: () => template, createTeamFromTemplate: () => null }),
			});
			expect(custom.listStarters()[0].members).toEqual([
				{ name: 'Dev1', role: 'developer' },
				{ name: 'Dev2', role: 'developer' },
			]);
		});
	});

	describe('createStarterTeam', () => {
		it('creates the team on the orc harness with session names from the template id', async () => {
			const result = await service.createStarterTeam('personal-assistant-team');
			expect(result.created).toBe(true);
			expect(result.team?.name).toBe('Personal Assistant');
			expect(result.team?.templateId).toBe('personal-assistant-team');
			expect(result.team?.members.map((m) => m.runtimeType)).toEqual(['codex-cli', 'codex-cli']);
			expect(result.team?.members[0].sessionName).toMatch(/^personal-assistant-team-assistant-[0-9a-f]{8}$/);
			expect(result.team?.members[0].systemPrompt).toMatch(/personal assistant/);
			expect(deps.saveTeam).toHaveBeenCalledTimes(1);
		});

		it('defaults to Claude Code when no orc harness is recorded', async () => {
			(deps.getOrcHarness as jest.Mock).mockResolvedValue(null);
			const result = await service.createStarterTeam('growth-marketing-team');
			expect(result.team?.members.every((m) => m.runtimeType === 'claude-code')).toBe(true);
		});

		it('is idempotent per template (a double tap makes one team)', async () => {
			const first = await service.createStarterTeam('personal-assistant-team');
			const second = await service.createStarterTeam('personal-assistant-team');
			expect(second.created).toBe(false);
			expect(second.team?.id).toBe(first.team?.id);
			expect(deps.saveTeam).toHaveBeenCalledTimes(1);
		});

		it('records Blank without creating a team', async () => {
			expect(await service.createStarterTeam('blank')).toEqual({ starterId: 'blank', team: null, created: false });
			expect(deps.saveTeam).not.toHaveBeenCalled();
			expect((await deps.store.read()).blankChosenAt).toBe(NOW.toISOString());
		});

		it('refuses a template that is not a starter, and unknown ids', async () => {
			await expect(service.createStarterTeam('research-team')).rejects.toMatchObject({ code: 'unknown_starter' });
			await expect(service.createStarterTeam('nope')).rejects.toBeInstanceOf(OnboardingError);
		});
	});

	describe('sendFirstTask', () => {
		it('hands the task to the orchestrator for the team and records it', async () => {
			teams.push(team('t1'));
			const result = await service.sendFirstTask('  Plan my week  ', 't1');
			expect(send).toHaveBeenCalledWith(buildFirstTaskMessage('Plan my week', { id: 't1', name: 'Team t1' }), {
				source: 'onboarding_first_task',
				teamId: 't1',
			});
			expect(result).toEqual({ forwarded: true, queued: true, conversationId: 'conv-1', teamId: 't1', sentAt: NOW.toISOString(), message: null });
			expect((await deps.store.read()).firstTask).toEqual({ sentAt: NOW.toISOString(), teamId: 't1', conversationId: 'conv-1' });
		});

		it('without a team goes to the orchestrator itself', async () => {
			await service.sendFirstTask('Hello');
			expect(send).toHaveBeenCalledWith(buildFirstTaskMessage('Hello', null), { source: 'onboarding_first_task' });
		});

		it('does not record a task the orchestrator did not get', async () => {
			send.mockResolvedValue({ conversationId: 'c', forwarded: false, queued: false, error: 'Orchestrator is not running.' });
			const result = await service.sendFirstTask('Hello');
			expect(result.forwarded).toBe(false);
			expect(result.message).toBe('Orchestrator is not running.');
			expect((await deps.store.read()).firstTask).toBeNull();
		});

		it('validates the text and the team', async () => {
			await expect(service.sendFirstTask('   ')).rejects.toMatchObject({ code: 'invalid_task' });
			await expect(service.sendFirstTask(42)).rejects.toMatchObject({ code: 'invalid_task' });
			await expect(service.sendFirstTask('x'.repeat(4001))).rejects.toMatchObject({ code: 'invalid_task' });
			await expect(service.sendFirstTask('Hi', 'missing')).rejects.toMatchObject({ code: 'unknown_team' });
			expect(send).not.toHaveBeenCalled();
		});
	});

	describe('pending first task (typed in the CLI while the backend was down)', () => {
		it('is stored, shown as pending, delivered once and cleared', async () => {
			teams.push(team('t1'));
			await service.queuePendingFirstTask('  Plan my week ', 't1');
			const before = await service.getChecklist();
			expect(before.steps.find((s) => s.id === 'first_task')?.detail).toMatchObject({ pending: true });
			const result = await service.deliverPendingFirstTask();
			expect(result?.teamId).toBe('t1');
			expect(send).toHaveBeenCalledTimes(1);
			expect((await deps.store.read()).pendingFirstTask).toBeNull();
			expect(await service.deliverPendingFirstTask()).toBeNull();
		});

		it('goes to the orchestrator when its team is gone', async () => {
			await service.queuePendingFirstTask('Plan my week', 'gone');
			expect((await service.deliverPendingFirstTask())?.teamId).toBeNull();
		});

		it('stays pending when delivery fails', async () => {
			send.mockResolvedValue({ conversationId: null, forwarded: false, queued: false, error: 'down' });
			await service.queuePendingFirstTask('Plan my week', null);
			await service.deliverPendingFirstTask();
			expect((await deps.store.read()).pendingFirstTask?.text).toBe('Plan my week');
		});

		it('rejects an empty task', async () => {
			await expect(service.queuePendingFirstTask('  ', null)).rejects.toMatchObject({ code: 'invalid_task' });
		});
	});

	describe('setDismissed', () => {
		it('hides and shows the card, keeping the first dismissal time', async () => {
			expect((await service.setDismissed(true)).dismissedAt).toBe(NOW.toISOString());
			expect((await service.setDismissed(true)).dismissed).toBe(true);
			expect((await service.setDismissed(false)).dismissed).toBe(false);
		});
	});
});

describe('helpers', () => {
	it('toSessionSlug keeps ASCII letters and digits', () => {
		expect(toSessionSlug('Personal Assistant!')).toBe('personal-assistant');
		expect(toSessionSlug('个人助理')).toBe('');
	});

	it('buildFirstTaskMessage names the team and keeps the owner words last', () => {
		const message = buildFirstTaskMessage(' Plan my week ', { id: 't1', name: 'Personal Assistant' });
		const lines = message.split('\n');
		expect(lines[0]).toBe('[初始设置 · 第一件事]');
		expect(lines[1]).toContain('Personal Assistant');
		expect(lines[1]).toContain('t1');
		expect(lines[lines.length - 1]).toBe('Plan my week');
		expect(buildFirstTaskMessage('Hi', null)).toBe('[初始设置 · 第一件事]\n\nHi');
	});

	it('buildTokenPageSignInUrl starts Google sign-in on Cloud and returns to the token page', () => {
		const url = new URL(buildTokenPageSignInUrl());
		expect(url.pathname).toBe('/api/cloud/google/start');
		expect(url.searchParams.get('redirect')).toMatch(/\/cloud\/cli-token$/);
	});
});
