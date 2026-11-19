import {
	RuntimeConsentService,
	formatConsentAskDm,
	formatConsentDoneDm,
	formatConsentFailedDm,
	isReplyToAsk,
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

describe('RuntimeConsentService across machines', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	/**
	 * A sibling relay fake.
	 *
	 * @param sent - How many machines a forward reaches
	 * @param has - Whether the account has other machines
	 * @returns The fake
	 */
	const relay = (sent = 1, has = true) => ({ hasSiblings: jest.fn(() => has), forward: jest.fn(async () => sent) });

	it('passes an answer on when it is not waiting itself, and consumes it', async () => {
		const siblings = relay();
		const { service, sent } = make({ siblings, newId: () => 'f1' });
		const target = { channelId: 'DOWNER', threadTs: '9' };
		expect(service.handleOwnerReply('accept bypass', target)).toBe(true);
		await flush();
		expect(siblings.forward).toHaveBeenCalledWith({ id: 'f1', reply: 'accept', target, inThread: false });
		service.handleSiblingAck('f1');
		jest.advanceTimersByTime(10 * 60 * 1000);
		await flush();
		expect(sent).toHaveLength(0);
	});

	it('tells the owner when no machine confirms', async () => {
		const { service, sent } = make({ siblings: relay(), newId: () => 'f2' });
		service.handleOwnerReply('同意跳过权限', { channelId: 'DOWNER' });
		await flush();
		expect(sent).toHaveLength(0);
		jest.advanceTimersByTime(91_000);
		await flush();
		expect(sent).toEqual([{ text: expect.stringContaining('None of your computers is waiting'), target: { channelId: 'DOWNER' } }]);
	});

	it('tells the owner at once when the answer could be sent to nobody', async () => {
		const { service, sent } = make({ siblings: relay(0) });
		service.handleOwnerReply('accept bypass');
		await flush();
		expect(sent).toHaveLength(1);
		jest.advanceTimersByTime(10 * 60 * 1000);
		await flush();
		expect(sent).toHaveLength(1);
	});

	it('leaves the message to the orchestrator on a single-machine account or for other text', () => {
		const alone = relay(0, false);
		expect(make({ siblings: alone }).service.handleOwnerReply('accept bypass')).toBe(false);
		const siblings = relay();
		expect(make({ siblings }).service.handleOwnerReply('同意')).toBe(false);
		expect(siblings.forward).not.toHaveBeenCalled();
	});

	it('answers locally, without forwarding, when it is the one waiting', async () => {
		const siblings = relay();
		const { service, accept } = make({ siblings });
		await service.request('crewly-orc');
		service.handleOwnerReply('accept bypass');
		await flush();
		expect(accept).toHaveBeenCalledTimes(1);
		expect(siblings.forward).not.toHaveBeenCalled();
	});

	it('takes a forwarded answer only while it is waiting', async () => {
		const { service, accept, resume, sent } = make();
		expect(service.handleSiblingReply('accept', { channelId: 'DOWNER', threadTs: '9' })).toBe(false);
		await service.request('crewly-orc');
		expect(service.handleSiblingReply('accept', { channelId: 'DOWNER', threadTs: '9' })).toBe(true);
		await flush();
		expect(accept).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledWith(['crewly-orc']);
		expect(sent[sent.length - 1].target).toEqual({ channelId: 'DOWNER', threadTs: '9' });
	});

	it('takes a forwarded decline', async () => {
		const { service, accept } = make();
		await service.request('crewly-orc');
		expect(service.handleSiblingReply('decline')).toBe(true);
		expect(accept).not.toHaveBeenCalled();
		expect(service.isPending()).toBe(false);
	});

	it('survives a relay that throws', async () => {
		const { service, sent } = make({
			siblings: {
				hasSiblings: () => true,
				forward: async () => {
					throw new Error('cloud down');
				},
			},
		});
		expect(service.handleOwnerReply('accept bypass')).toBe(true);
		await flush();
		expect(sent[0].text).toContain('None of your computers is waiting');
		const broken = make({
			siblings: {
				hasSiblings: () => {
					throw new Error('x');
				},
				forward: async () => 0,
			},
		});
		expect(broken.service.handleOwnerReply('accept bypass')).toBe(false);
	});
});

describe('two machines waiting at once', () => {
	/**
	 * A service whose question landed at a known place.
	 *
	 * @param channelId - DM channel of the question
	 * @param messageTs - Timestamp of the question
	 * @returns The service and its fakes
	 */
	async function asked(channelId: string, messageTs: string) {
		const siblings = { hasSiblings: jest.fn(() => true), forward: jest.fn(async () => 1) };
		const made = make({ siblings });
		(made.notifier as unknown as Record<string, unknown>)['sendToOwnerTracked'] = jest.fn(async (text: string) => {
			made.sent.push({ text, target: null });
			return { delivery: { channelId }, messageTs };
		});
		await made.service.request('crewly-orc');
		return { ...made, siblings };
	}

	it('isReplyToAsk: only a reply in another thread is refused', () => {
		const ask = { channelId: 'DMAC', messageTs: '10' };
		expect(isReplyToAsk(ask, { channelId: 'DMAC', threadTs: '10' }, true)).toBe(true);
		expect(isReplyToAsk(ask, { channelId: 'DMASTER', threadTs: '20' }, true)).toBe(false);
		expect(isReplyToAsk(ask, { channelId: 'DMAC', threadTs: '99' }, true)).toBe(false);
		expect(isReplyToAsk(ask, { channelId: 'DMAC', threadTs: '99' }, false)).toBe(true);
		expect(isReplyToAsk(null, { channelId: 'X', threadTs: '1' }, true)).toBe(true);
		expect(isReplyToAsk(ask, null, true)).toBe(true);
	});

	it("a reply under another machine's question is passed on, not applied here", async () => {
		const { service, accept, siblings } = await asked('DMAC', '10');
		const windowsThread = { channelId: 'DMASTER', threadTs: '20' };
		expect(service.handleOwnerReply('accept bypass', windowsThread, true)).toBe(true);
		await flush();
		expect(accept).not.toHaveBeenCalled();
		expect(siblings.forward).toHaveBeenCalledWith(expect.objectContaining({ reply: 'accept', target: windowsThread, inThread: true }));
		expect(service.isPending()).toBe(true);
	});

	it('a reply under its own question, or outside any thread, is applied here', async () => {
		const own = await asked('DMAC', '10');
		expect(own.service.handleOwnerReply('accept bypass', { channelId: 'DMAC', threadTs: '10' }, true)).toBe(true);
		await flush();
		expect(own.accept).toHaveBeenCalledTimes(1);
		expect(own.siblings.forward).not.toHaveBeenCalled();

		const top = await asked('DMAC', '10');
		expect(top.service.handleOwnerReply('accept bypass', { channelId: 'DMAC', threadTs: '77' }, false)).toBe(true);
		await flush();
		expect(top.accept).toHaveBeenCalledTimes(1);
	});

	it("a forwarded reply from another machine's thread is not taken", async () => {
		const { service, accept } = await asked('DMASTER', '20');
		expect(service.handleSiblingReply('accept', { channelId: 'DMASTER', threadTs: '30' }, true)).toBe(false);
		expect(service.handleSiblingReply('accept', { channelId: 'DMASTER', threadTs: '20' }, true)).toBe(true);
		await flush();
		expect(accept).toHaveBeenCalledTimes(1);
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
