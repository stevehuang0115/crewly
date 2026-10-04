/**
 * Tests for the owner's autopilot speed DM command: parsing (en / zh),
 * owner-only, unknown projects passed on to the orc, and the reply (with the
 * Rush cost warning).
 */
import {
	createAutopilotSpeedInterceptor,
	findProjectByRef,
	parseAutopilotSpeedCommand,
	RUSH_COST_WARNING,
	speedModeReply,
	type AutopilotSpeedCommandDeps,
} from './autopilot-speed-command.js';
import { resolveTicketAutopilotSettings, type AutopilotSpeedMode } from '../../types/ticket-autopilot.types.js';
import type { TicketAutopilotStatus } from './ticket-autopilot.service.js';
import type { SlackIncomingMessage } from '../../types/slack.types.js';

/** A status as updateSettings returns it (the parts the reply reads). */
function status(stored: Record<string, unknown>, name = 'CE'): TicketAutopilotStatus {
	return { project: { id: 'p-ce', name, path: '/x' }, settings: resolveTicketAutopilotSettings(stored) } as unknown as TicketAutopilotStatus;
}

describe('parseAutopilotSpeedCommand', () => {
	it.each([
		['set CE to rush', 'CE', 'rush', false],
		['Set CE to Chill.', 'CE', 'chill', false],
		['set CE autopilot to normal', 'CE', 'normal', false],
		["set CE's autopilot to rush mode", 'CE', 'rush', false],
		['switch CE to chill', 'CE', 'chill', false],
		['put CE in rush mode', 'CE', 'rush', false],
		['set project Steam Fun to rush', 'Steam Fun', 'rush', true],
		['CE rush', 'CE', 'rush', false],
		['CE chill', 'CE', 'chill', false],
		['CE chill mode', 'CE', 'chill', false],
		['<@U123> please set CE to rush', 'CE', 'rush', false],
		['CE 切到 rush', 'CE', 'rush', false],
		['CE切到rush', 'CE', 'rush', false],
		['把 CE 切换到 chill', 'CE', 'chill', false],
		['CE 改成 正常', 'CE', 'normal', false],
		['CE 调成冲刺模式', 'CE', 'rush', false],
		['项目 CE 切到 慢速', 'CE', 'chill', true],
		['CE 佛系', 'CE', 'chill', false],
	] as Array<[string, string, AutopilotSpeedMode, boolean]>)('%s', (text, target, mode, explicitProject) => {
		expect(parseAutopilotSpeedCommand(text)).toEqual({ target, mode, explicitProject });
	});

	it.each([
		'',
		'rush',
		'set CE to turbo',
		'please rush the deploy',
		'how is CE doing',
		'set CE to rush\nand tell me',
		'CE is normal',
	])('ignores %j', (text) => {
		// "CE is normal" parses with target "CE is" — no such project, so it is left to the orc.
		const cmd = parseAutopilotSpeedCommand(text);
		if (cmd) expect(findProjectByRef([{ id: 'p-ce', name: 'CE' }], cmd.target)).toBeNull();
	});
});

describe('speedModeReply', () => {
	it('Rush switch-on: what it does, the explicit budget kept, and the one-line cost warning', () => {
		const text = speedModeReply(status({ enabled: true, dailyBudgetTokens: 50_000_000, speedMode: 'rush' }), 'normal');
		expect(text).toContain('CE is on Rush now (was Normal)');
		expect(text).toContain('at most 12 a day');
		expect(text).toContain('(your setting, unchanged)');
		expect(text).toContain(RUSH_COST_WARNING);
	});

	it('no warning when not switching to Rush; mode budget, explicit replan cap and an off autopilot are said', () => {
		const text = speedModeReply(status({ enabled: false, speedMode: 'chill', replansPerDay: 2 }), 'normal');
		expect(text).toContain('CE is on Chill now (was Normal)');
		expect(text).toContain('(the Chill default)');
		expect(text).toContain('Your replans-per-day setting (2) still caps replans.');
		expect(text).toContain('The autopilot is off on CE');
		expect(text).not.toContain('Cost warning');
		expect(speedModeReply(status({ enabled: true, speedMode: 'rush' }), 'rush')).toMatch(/^CE is already on Rush/);
		expect(speedModeReply(status({ enabled: true, speedMode: 'rush' }), 'rush')).not.toContain('Cost warning');
	});
});

describe('createAutopilotSpeedInterceptor', () => {
	const flush = () => new Promise((r) => setTimeout(r, 0));
	let replies: string[];
	let setMode: jest.Mock;
	let scope: 'orc' | 'agent' | null;
	let mode: AutopilotSpeedMode;

	function deps(): AutopilotSpeedCommandDeps {
		return {
			ownerDmScope: () => scope,
			replyTargetOf: () => 'dm',
			reply: async (text) => {
				replies.push(text);
			},
			knownProjects: () => [
				{ id: 'p-ce', name: 'CE' },
				{ id: 'p-sf', name: 'Steam Fun' },
			],
			currentMode: async () => mode,
			setMode,
		};
	}
	const msg = (text: string, extra: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage => ({ text, channelId: 'D1', userId: 'U-owner', ...extra }) as SlackIncomingMessage;

	beforeEach(() => {
		replies = [];
		scope = 'orc';
		mode = 'normal';
		setMode = jest.fn(async (_id: string, m: AutopilotSpeedMode) => status({ enabled: true, dailyBudgetTokens: 50_000_000, speedMode: m }));
	});

	it('the owner in the orc DM switches a project (by name, case-insensitive) and is answered', async () => {
		const intercept = createAutopilotSpeedInterceptor(deps());
		expect(intercept(msg('set ce to rush'))).toBe(true);
		await flush();
		await flush();
		expect(setMode).toHaveBeenCalledWith('p-ce', 'rush');
		expect(replies[0]).toContain('CE is on Rush now (was Normal)');
		expect(replies[0]).toContain('Cost warning');
		expect(intercept(msg('Steam Fun 切到 chill'))).toBe(true);
		await flush();
		expect(setMode).toHaveBeenLastCalledWith('p-sf', 'chill');
	});

	it('owner-only: another person, an agent DM or a file message is never consumed', () => {
		const intercept = createAutopilotSpeedInterceptor(deps());
		scope = null;
		expect(intercept(msg('set CE to rush'))).toBe(false);
		scope = 'agent';
		expect(intercept(msg('set CE to rush'))).toBe(false);
		scope = 'orc';
		expect(intercept(msg('set CE to rush', { hasFiles: true }))).toBe(false);
		expect(setMode).not.toHaveBeenCalled();
	});

	it('an unknown target goes on to the orc, unless "project" was said', async () => {
		const intercept = createAutopilotSpeedInterceptor(deps());
		expect(intercept(msg('let us rush'))).toBe(false);
		expect(intercept(msg('set the deploy to normal'))).toBe(false);
		expect(intercept(msg('set project Nope to rush'))).toBe(true);
		await flush();
		expect(replies[0]).toBe('No project named "Nope". Projects: CE, Steam Fun.');
		expect(setMode).not.toHaveBeenCalled();
	});

	it('a failed switch is answered, not swallowed', async () => {
		setMode.mockRejectedValue(new Error('disk full'));
		const intercept = createAutopilotSpeedInterceptor(deps());
		expect(intercept(msg('CE chill'))).toBe(true);
		await flush();
		await flush();
		expect(replies[0]).toBe("Couldn't switch CE to Chill: disk full");
	});
});
