import {
	RuntimeConsentService,
	formatConsentAskDm,
	formatConsentDoneDm,
	formatConsentFailedDm,
	getRuntimeConsentService,
	parseConsentReply,
	setRuntimeConsentServiceForTesting,
	type RuntimeConsentDeps,
} from './runtime-consent.service.js';
import type { BypassConsentResult } from './bypass-consent-acceptor.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

const HOUR = 60 * 60 * 1000;

/** Let queued promise callbacks run. */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

/**
 * A service with fakes.
 *
 * @param overrides - Dependency overrides
 * @returns The service, its fakes and a clock setter
 */
function make(overrides: Partial<RuntimeConsentDeps> = {}) {
	let clock = 1_000_000;
	const sent: Array<{ text: string; target: unknown }> = [];
	const notifier = {
		sendToOwner: jest.fn(async (text: string, target?: unknown) => {
			sent.push({ text, target: target ?? null });
			return true as const;
		}),
		isAvailable: jest.fn(() => true),
	};
	const accept = jest.fn(async (): Promise<BypassConsentResult> => ({ outcome: 'accepted', detail: 'consent_answered' }));
	const resume = jest.fn(async (names: readonly string[]) => ({ resumed: [...names], failed: [] as string[] }));
	const service = new RuntimeConsentService({ notifier, accept, resume, machineName: () => 'DESKTOP-1', now: () => clock, ...overrides });
	return { service, notifier, accept, resume, sent, advance: (ms: number) => (clock += ms) };
}

describe('parseConsentReply', () => {
	it.each(['accept bypass', 'Accept Bypass.', 'accept bypass permissions mode', 'Yes, I accept', 'I accept', '同意跳过权限', '「同意跳过权限」', '接受跳过权限模式'])('takes %s as accept', (text) => {
		expect(parseConsentReply(text)).toBe('accept');
	});

	it.each(['decline bypass', 'No, exit', '不同意跳过权限', '拒绝跳过权限', '不接受跳过权限模式'])('takes %s as decline', (text) => {
		expect(parseConsentReply(text)).toBe('decline');
	});

	it.each(['同意', 'yes', 'ok', 'accept', '好的', 'I accept the plan', 'should I accept bypass?', ''])('leaves %s alone', (text) => {
		expect(parseConsentReply(text)).toBeNull();
	});
});

describe('consent DMs', () => {
	it('say what the mode means and how to answer', () => {
		const dm = formatConsentAskDm('DESKTOP-1', 3);
		expect(dm).toContain('DESKTOP-1');
		expect(dm).toContain('3 agents are waiting');
		expect(dm).toContain('without asking each time');
		expect(dm).toContain('`accept bypass`');
		expect(dm).toContain('`decline bypass`');
		expect(formatConsentAskDm('m', 1)).toContain('An agent is waiting');
	});

	it('report what started', () => {
		expect(formatConsentDoneDm('m', { resumed: ['crewly-orc'], failed: ['ella-1'] })).toMatch(/Started: crewly-orc\.\nCould not start: ella-1\./);
		expect(formatConsentDoneDm('m', { resumed: [], failed: [] })).toContain('Start the team again');
		expect(formatConsentFailedDm('m')).toContain('claude --dangerously-skip-permissions');
	});
});

describe('RuntimeConsentService', () => {
	it('asks once; later agents join the same question', async () => {
		const { service, sent } = make();
		const [first, second] = await Promise.all([service.request('crewly-orc'), service.request('ella-1')]);
		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(sent).toHaveLength(1);
		expect(service.isPending()).toBe(true);
	});

	it('does nothing without Slack', async () => {
		const offline = make();
		offline.notifier.isAvailable.mockReturnValue(false);
		expect(await offline.service.request('crewly-orc')).toBe(false);
		expect(offline.sent).toHaveLength(0);
		expect(await make({ notifier: null }).service.request('crewly-orc')).toBe(false);
	});

	it('drops the question when the DM could not be delivered', async () => {
		const { service, notifier } = make();
		notifier.sendToOwner.mockResolvedValueOnce(false as never);
		expect(await service.request('crewly-orc')).toBe(false);
		expect(service.isPending()).toBe(false);
	});

	it('ignores replies when nothing was asked, and unrelated text when asked', async () => {
		const { service, accept } = make();
		expect(service.handleOwnerReply('accept bypass')).toBe(false);
		await service.request('crewly-orc');
		expect(service.handleOwnerReply('同意')).toBe(false);
		expect(service.handleOwnerReply('what is this?')).toBe(false);
		expect(accept).not.toHaveBeenCalled();
	});

	it('accepts on the owner reply, starts every waiting agent and answers in the same conversation', async () => {
		const { service, accept, resume, sent } = make();
		await service.request('crewly-orc');
		await service.request('ella-1');
		const target = { channelId: 'DORC', threadTs: '5' };
		expect(service.handleOwnerReply('Accept bypass', target)).toBe(true);
		// A repeat while it is being applied is swallowed, not applied twice.
		expect(service.handleOwnerReply('accept bypass', target)).toBe(true);
		await flush();
		expect(accept).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledWith(['crewly-orc', 'ella-1']);
		expect(sent[sent.length - 1]).toEqual({ text: expect.stringContaining('Started: crewly-orc, ella-1.'), target });
		expect(service.isPending()).toBe(false);
	});

	it('starts the agents when the consent was already accepted', async () => {
		const { service, resume } = make({ accept: async () => ({ outcome: 'not_shown', detail: 'consent_not_shown' }) });
		await service.request('crewly-orc');
		service.handleOwnerReply('同意跳过权限');
		await flush();
		expect(resume).toHaveBeenCalledWith(['crewly-orc']);
	});

	it('gives the manual steps when the screen could not be answered', async () => {
		const { service, resume, sent } = make({ accept: async () => ({ outcome: 'failed', detail: 'claude_not_found' }) });
		await service.request('crewly-orc');
		service.handleOwnerReply('accept bypass');
		await flush();
		expect(resume).not.toHaveBeenCalled();
		expect(sent[sent.length - 1].text).toContain('I could not accept');
	});

	it('treats a throwing acceptor or resumer as a failure, not a crash', async () => {
		const thrown = make({
			accept: async () => {
				throw new Error('boom');
			},
		});
		await thrown.service.request('crewly-orc');
		thrown.service.handleOwnerReply('accept bypass');
		await flush();
		expect(thrown.sent[thrown.sent.length - 1].text).toContain('I could not accept');

		const noStart = make({
			resume: async () => {
				throw new Error('no backend');
			},
		});
		await noStart.service.request('ella-1');
		noStart.service.handleOwnerReply('accept bypass');
		await flush();
		expect(noStart.sent[noStart.sent.length - 1].text).toContain('Could not start: ella-1');
	});

	it('leaves the agents stopped on decline', async () => {
		const { service, accept, sent } = make();
		await service.request('crewly-orc');
		expect(service.handleOwnerReply('不同意跳过权限')).toBe(true);
		await flush();
		expect(accept).not.toHaveBeenCalled();
		expect(sent[sent.length - 1].text).toContain('stay stopped');
		expect(service.isPending()).toBe(false);
	});

	it('does not ask again when the consent shows right after it was answered', async () => {
		const { service, sent, advance } = make();
		await service.request('crewly-orc');
		service.handleOwnerReply('accept bypass');
		await flush();
		const before = sent.length;
		expect(await service.request('crewly-orc')).toBe(false);
		expect(await service.request('ella-1')).toBe(false);
		expect(sent).toHaveLength(before + 1);
		expect(sent[sent.length - 1].text).toContain('I could not accept');
		advance(2 * HOUR);
		expect(await service.request('crewly-orc')).toBe(true);
	});

	it('stops taking replies for a question left unanswered for a day', async () => {
		const { service, accept, advance } = make();
		await service.request('crewly-orc');
		advance(25 * HOUR);
		expect(service.handleOwnerReply('accept bypass')).toBe(false);
		expect(accept).not.toHaveBeenCalled();
	});

	it('late-bound notifier and resumer are used', async () => {
		const { notifier, resume } = make();
		const service = new RuntimeConsentService({ accept: async () => ({ outcome: 'accepted', detail: '' }), machineName: () => 'm' });
		expect(await service.request('a')).toBe(false);
		service.setNotifier(notifier);
		service.setResumer(resume);
		expect(await service.request('a')).toBe(true);
		service.handleOwnerReply('i accept');
		await flush();
		expect(resume).toHaveBeenCalledWith(['a']);
	});
});

describe('getRuntimeConsentService', () => {
	it('returns one instance, replaceable in tests', () => {
		const mine = new RuntimeConsentService();
		setRuntimeConsentServiceForTesting(mine);
		expect(getRuntimeConsentService()).toBe(mine);
		setRuntimeConsentServiceForTesting(null);
		expect(getRuntimeConsentService()).not.toBe(mine);
		setRuntimeConsentServiceForTesting(null);
	});
});
