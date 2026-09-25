/**
 * Tests for the `crewly onboard` first-run steps: starter choice, first task
 * (backend or pending), and the Cloud / Slack phone links.
 */

jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy(
		{},
		{
			get: () => {
				const fn = (s: string) => s;
				return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
			},
		},
	),
}));

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { OnboardingStateStore } from '../../../backend/src/services/onboarding/onboarding-state.store.js';
import type { TeamTemplate } from '../utils/templates.js';
import {
	askFirstTask,
	buildConnectLinks,
	chooseStarter,
	deliverFirstTask,
	printConnectSteps,
	readConnectState,
	recordBlankChoice,
	reportFirstTask,
	starterSuggestions,
	stepHeader,
} from './onboard-checklist.js';

type Starter = TeamTemplate & { onboarding: NonNullable<TeamTemplate['onboarding']> };

/** A starter template. */
function starter(id: string, order: number, recommended: boolean): Starter {
	return {
		id,
		name: id.toUpperCase(),
		description: 'd',
		members: [{ name: 'Lead', role: 'generalist', systemPrompt: 'p' }],
		onboarding: { order, recommended, label: `L${order}`, tagline: 't', suggestions: [`${id}-1`, `${id}-2`, `${id}-3`] },
	};
}

/** Asker that replays answers. */
function answers(...list: string[]) {
	let i = 0;
	return jest.fn(async () => list[i++] ?? '');
}

describe('onboard-checklist', () => {
	let lines: string[];
	const log = (line: string): void => {
		lines.push(line);
	};
	let home: string;

	beforeEach(() => {
		lines = [];
		home = mkdtempSync(path.join(tmpdir(), 'crewly-onboard-checklist-'));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it('stepHeader counts seven steps', () => {
		expect(stepHeader(4, 'First team')).toBe('  Step 4/7: First team');
	});

	describe('chooseStarter', () => {
		const starters = [starter('pa', 1, true), starter('mkt', 2, false)];

		it('Enter picks the recommended starter', async () => {
			const ask = answers('');
			const choice = await chooseStarter(ask, starters, log);
			expect(choice).toEqual({ kind: 'template', template: starters[0] });
			expect(ask).toHaveBeenCalledWith(expect.stringContaining('Enter choice (1-3) [1]'));
			expect(lines.join('\n')).toContain('recommended');
		});

		it('picks by number, and the last number is Blank', async () => {
			expect(await chooseStarter(answers('2'), starters, log)).toEqual({ kind: 'template', template: starters[1] });
			expect(await chooseStarter(answers('3'), starters, log)).toEqual({ kind: 'blank' });
			expect(await chooseStarter(answers('blank'), starters, log)).toEqual({ kind: 'blank' });
		});

		it('re-asks on invalid input', async () => {
			const ask = answers('9', 'x', '2');
			expect(await chooseStarter(ask, starters, log)).toEqual({ kind: 'template', template: starters[1] });
			expect(ask).toHaveBeenCalledTimes(3);
		});

		it('defaults to the first starter when none is recommended, and to Blank when there are none', async () => {
			expect(await chooseStarter(answers(''), [starter('a', 1, false)], log)).toMatchObject({ kind: 'template' });
			expect(await chooseStarter(answers(''), [], log)).toEqual({ kind: 'blank' });
		});
	});

	it('recordBlankChoice stores the first Blank choice', async () => {
		const store = new OnboardingStateStore(home);
		await recordBlankChoice(store, new Date('2026-09-25T00:00:00.000Z'));
		await recordBlankChoice(store, new Date('2026-09-26T00:00:00.000Z'));
		expect((await store.read()).blankChosenAt).toBe('2026-09-25T00:00:00.000Z');
	});

	it('starterSuggestions uses the template, or the Blank examples', () => {
		expect(starterSuggestions(starter('pa', 1, true))).toEqual(['pa-1', 'pa-2', 'pa-3']);
		expect(starterSuggestions(null)).toHaveLength(3);
	});

	describe('askFirstTask', () => {
		const suggestions = ['one', 'two', 'three'];

		it('returns typed text, a suggestion by number, or null on Enter', async () => {
			expect(await askFirstTask(answers('  Book a dentist  '), suggestions, log)).toBe('Book a dentist');
			expect(await askFirstTask(answers('3'), suggestions, log)).toBe('three');
			expect(await askFirstTask(answers(''), suggestions, log)).toBeNull();
		});

		it('re-asks on an out-of-range number or an over-long task', async () => {
			const ask = answers('7', 'x'.repeat(4001), 'ok');
			expect(await askFirstTask(ask, suggestions, log)).toBe('ok');
			expect(ask).toHaveBeenCalledTimes(3);
		});
	});

	describe('deliverFirstTask', () => {
		it('posts to the running backend', async () => {
			const http = jest.fn(async () => ({ status: 201, body: { success: true, data: { queued: true } } }));
			const outcome = await deliverFirstTask('Plan my week', 'pa', { isRunning: async () => true, http, baseUrl: 'http://localhost:1' });
			expect(outcome).toEqual({ status: 'sent', queued: true });
			expect(http).toHaveBeenCalledWith('POST', 'http://localhost:1/api/onboarding/first-task', { text: 'Plan my week', teamId: 'pa' });
		});

		it('omits a null team', async () => {
			const http = jest.fn(async () => ({ status: 201, body: { success: true, data: {} } }));
			await deliverFirstTask('Hi', null, { isRunning: async () => true, http, baseUrl: 'http://x' });
			expect(http).toHaveBeenCalledWith('POST', 'http://x/api/onboarding/first-task', { text: 'Hi' });
		});

		it('reports a backend refusal or a network error', async () => {
			const refused = jest.fn(async () => ({ status: 503, body: { success: false, error: 'Orchestrator is not running.' } }));
			expect(await deliverFirstTask('Hi', null, { isRunning: async () => true, http: refused })).toEqual({ status: 'failed', message: 'Orchestrator is not running.' });
			const broken = jest.fn(async () => {
				throw new Error('ECONNRESET');
			});
			expect(await deliverFirstTask('Hi', null, { isRunning: async () => true, http: broken })).toEqual({ status: 'failed', message: 'ECONNRESET' });
			const empty = jest.fn(async () => ({ status: 500, body: null }));
			expect(await deliverFirstTask('Hi', null, { isRunning: async () => true, http: empty })).toEqual({ status: 'failed', message: 'HTTP 500' });
		});

		it('keeps the task for the backend when it is not running', async () => {
			const store = new OnboardingStateStore(home);
			const outcome = await deliverFirstTask(' Plan my week ', 'pa', {
				isRunning: async () => false,
				store,
				now: () => new Date('2026-09-25T00:00:00.000Z'),
			});
			expect(outcome).toEqual({ status: 'pending' });
			expect((await store.read()).pendingFirstTask).toEqual({ text: 'Plan my week', teamId: 'pa', createdAt: '2026-09-25T00:00:00.000Z' });
		});
	});

	it('reportFirstTask explains each outcome', () => {
		reportFirstTask({ status: 'sent', queued: true }, log);
		reportFirstTask({ status: 'sent', queued: false }, log);
		reportFirstTask({ status: 'pending' }, log);
		reportFirstTask({ status: 'failed', message: 'nope' }, log);
		const text = lines.join('\n');
		expect(text).toContain('as soon as it is running');
		expect(text).toContain('Sent to the orchestrator.');
		expect(text).toContain('when Crewly starts');
		expect(text).toContain('Could not send it: nope');
	});

	describe('connect links', () => {
		it('builds setup links that carry the step and the API token', () => {
			const links = buildConnectLinks('192.168.1.5', 8787, 'tok en');
			expect(links.cloudSetupUrl).toBe('http://192.168.1.5:8787/setup?step=cloud&token=tok+en');
			expect(links.slackSetupUrl).toBe('http://192.168.1.5:8787/setup?step=slack&token=tok+en');
			const signIn = new URL(links.cloudSignInUrl);
			expect(signIn.pathname).toBe('/api/cloud/google/start');
			expect(signIn.searchParams.get('redirect')).toMatch(/\/cloud\/cli-token$/);
		});

		it('omits the token when there is none', () => {
			expect(buildConnectLinks('h', 1, null).cloudSetupUrl).toBe('http://h:1/setup?step=cloud');
		});

		it('prints links, or done marks', () => {
			const links = buildConnectLinks('h', 1, null);
			printConnectSteps(links, null, log);
			expect(lines.join('\n')).toContain(links.cloudSignInUrl);
			expect(lines.join('\n')).toContain(links.cloudSetupUrl);
			expect(lines.join('\n')).toContain('crewly cloud login');
			expect(lines.join('\n')).not.toContain('--no-browser');
			expect(lines.join('\n')).toContain(links.slackSetupUrl);
			lines = [];
			printConnectSteps(links, { cloud: true, slack: true }, log);
			expect(lines.join('\n')).toContain('Crewly Cloud connected');
			expect(lines.join('\n')).not.toContain(links.slackSetupUrl);
		});
	});

	describe('readConnectState', () => {
		it('is null when the backend is not running', async () => {
			expect(await readConnectState({ isRunning: async () => false })).toBeNull();
		});

		it('reads Cloud and Slack from the checklist', async () => {
			const http = jest.fn(async () => ({
				status: 200,
				body: { data: { steps: [{ id: 'cloud', done: true }, { id: 'slack', done: false }] } },
			}));
			expect(await readConnectState({ isRunning: async () => true, http, baseUrl: 'http://x' })).toEqual({ cloud: true, slack: false });
			expect(http).toHaveBeenCalledWith('GET', 'http://x/api/onboarding/checklist');
		});

		it('is null on an unexpected answer or an error', async () => {
			expect(await readConnectState({ isRunning: async () => true, http: async () => ({ status: 404, body: null }) })).toBeNull();
			expect(
				await readConnectState({
					isRunning: async () => true,
					http: async () => {
						throw new Error('down');
					},
				}),
			).toBeNull();
		});
	});
});
