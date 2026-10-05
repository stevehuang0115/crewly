/**
 * Tests for InputBlockedRetryService (crewly#1014 review #3).
 */

import { InputBlockedRetryService, type InputBlockedRetryDeps } from './input-blocked-retry.service.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
		}),
	},
}));

describe('InputBlockedRetryService', () => {
	let clock: number;
	let service: InputBlockedRetryService;
	let deps: jest.Mocked<InputBlockedRetryDeps>;
	let queued: boolean;
	let idle: boolean;

	beforeEach(() => {
		jest.useFakeTimers();
		clock = 0;
		queued = true;
		idle = true;
		service = new InputBlockedRetryService(() => clock);
		deps = {
			hasQueued: jest.fn((_s: string) => queued),
			isIdle: jest.fn((_s: string) => idle),
			flush: jest.fn(async (_s: string) => {
				// The guard refuses again while blocked.
				service.noteRefusal('ella', { state: 'foreign', inputLength: 16, message: '[CHAT:c1] hi' });
			}),
			notify: jest.fn(async (_n: Parameters<InputBlockedRetryDeps['notify']>[0]) => undefined),
		};
		service.setDeps(deps);
	});

	afterEach(() => {
		service.stop();
		jest.useRealTimers();
	});

	const advance = async (ms: number): Promise<void> => {
		clock += ms;
		await jest.advanceTimersByTimeAsync(ms);
	};

	it('a busy hold is reported once after BUSY_HOLD_NOTIFY_MS, and again only after a delivery and the 30 min cooldown', () => {
		service.noteBusyHold('ella', 9 * 60_000, 'first held');
		expect(deps.notify).not.toHaveBeenCalled();
		service.noteBusyHold('ella', 10 * 60_000, 'first held');
		service.noteBusyHold('ella', 12 * 60_000, 'first held');
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ sessionName: 'ella', state: 'busy', blockedForMs: 10 * 60_000, message: 'first held' }));
		service.noteDelivered('ella');
		clock += 30 * 60_000;
		service.noteBusyHold('ella', 11 * 60_000, 'later');
		expect(deps.notify).toHaveBeenCalledTimes(2);
	});

	describe('at most one alert per agent per 30 min (2026-10-05)', () => {
		it('a busy hold after every delivery does not alert every time', () => {
			for (let i = 0; i < 5; i++) {
				service.noteBusyHold('crewly-orc', 10 * 60_000, `held ${i}`);
				service.noteDelivered('crewly-orc');
				clock += 5 * 60_000;
			}
			expect(deps.notify).toHaveBeenCalledTimes(1);
			clock += 10 * 60_000; // 35 min after the first alert
			service.noteBusyHold('crewly-orc', 10 * 60_000, 'later');
			expect(deps.notify).toHaveBeenCalledTimes(2);
		});

		it('the cooldown is per agent', () => {
			service.noteBusyHold('crewly-orc', 10 * 60_000, 'a');
			service.noteBusyHold('ella', 10 * 60_000, 'b');
			expect(deps.notify).toHaveBeenCalledTimes(2);
		});

		it('a "needs you" alert still goes out once after a "busy" one; nothing more in the window', () => {
			service.noteBusyHold('ella', 10 * 60_000, 'held');
			service.noteStuckInput('ella', 17, 11 * 60_000);
			service.noteCircuitOpen('ella', { state: 'foreign', inputLength: 52, refusals: 31, blockedForMs: 5 * 60_000 });
			service.noteBusyHold('ella', 10 * 60_000, 'held');
			expect(deps.notify.mock.calls.map((c) => c[0].state)).toEqual(['busy', 'stuck']);
		});

		it('a "busy" alert does not follow a "needs you" one in the window', () => {
			service.noteStuckInput('ella', 17, 11 * 60_000);
			service.noteBusyHold('ella', 10 * 60_000, 'held');
			expect(deps.notify.mock.calls.map((c) => c[0].state)).toEqual(['stuck']);
		});
	});

	it('reports stuck input in an idle agent\'s box (content length only)', () => {
		service.noteStuckInput('ella', 17, 11 * 60_000);
		expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ sessionName: 'ella', state: 'stuck', inputLength: 17, blockedForMs: 11 * 60_000 }));
	});

	it('retries on a timer with backoff while the agent is idle and messages are queued', async () => {
		service.noteRefusal('ella', { state: 'foreign', inputLength: 16, message: '[CHAT:c1] hi' });
		await advance(15_000);
		expect(deps.flush).toHaveBeenCalledTimes(1);
		await advance(30_000);
		expect(deps.flush).toHaveBeenCalledTimes(2);
		await advance(60_000);
		expect(deps.flush).toHaveBeenCalledTimes(3);
		await advance(120_000);
		expect(deps.flush).toHaveBeenCalledTimes(4);
	});

	it('does not flush into a busy agent, but keeps trying', async () => {
		idle = false;
		service.noteRefusal('ella', { state: 'unknown', inputLength: 16, message: 'hi' });
		await advance(15_000);
		expect(deps.flush).not.toHaveBeenCalled();
		idle = true;
		await advance(30_000);
		expect(deps.flush).toHaveBeenCalledTimes(1);
	});

	it('tells the owner once, after five refusals or five minutes — the kind of content, never the text', async () => {
		service.noteRefusal('ella', { state: 'foreign', inputLength: 31, message: '[CHAT:c1] hi' });
		expect(deps.notify).not.toHaveBeenCalled();
		await advance(15_000 + 30_000 + 60_000 + 120_000); // four more refusals → five
		expect(deps.notify).toHaveBeenCalledTimes(1);
		const notice = deps.notify.mock.calls[0][0];
		expect(notice).toMatchObject({ sessionName: 'ella', state: 'foreign', message: '[CHAT:c1] hi' });
		expect(notice.inputLength).toBe(16);
		expect(JSON.stringify(notice)).not.toContain('half-typed');
		await advance(10 * 60_000);
		expect(deps.notify).toHaveBeenCalledTimes(1);
	});

	it('a successful delivery ends the episode; an empty queue stops the timer', async () => {
		service.noteRefusal('ella', { state: 'foreign', inputLength: 16, message: 'hi' });
		service.noteDelivered('ella');
		expect(service.isBlocked('ella')).toBe(false);
		await advance(15_000);
		expect(deps.flush).not.toHaveBeenCalled();

		service.noteRefusal('bob', { state: 'foreign', inputLength: 16, message: 'hi' });
		queued = false;
		await advance(15_000);
		expect(deps.flush).not.toHaveBeenCalled();
		expect(service.isBlocked('bob')).toBe(false);
	});


	describe('circuit open (crewly#1028)', () => {
		const info = { state: 'foreign', inputLength: 52, refusals: 31, blockedForMs: 5 * 60_000 };

		it('tells the owner once, naming the agent, with what blocked it', () => {
			service.noteCircuitOpen('ce-vera', info);
			service.noteCircuitOpen('ce-vera', info);
			expect(deps.notify).toHaveBeenCalledTimes(1);
			expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ sessionName: 'ce-vera', state: 'circuit-open', blockedState: 'foreign', inputLength: 52, refusals: 31 }));
		});

		it('one blocked box is one alert: not again when the refusal episode was already reported, nor after it', async () => {
			for (let i = 0; i < 5; i++) service.noteRefusal('ella', { state: 'foreign', inputLength: 16, message: '[CHAT:c1] hi' });
			await Promise.resolve();
			expect(deps.notify).toHaveBeenCalledTimes(1);
			service.noteCircuitOpen('ella', info);
			expect(deps.notify).toHaveBeenCalledTimes(1);

			service.noteCircuitOpen('bob', info);
			for (let i = 0; i < 6; i++) service.noteRefusal('bob', { state: 'foreign', inputLength: 16, message: 'm' });
			await Promise.resolve();
			expect(deps.notify.mock.calls.filter((c) => c[0].sessionName === 'bob')).toHaveLength(1);
		});

		it('a delivery ends the episode: the next opening alerts again (after the 30 min cooldown)', () => {
			service.noteCircuitOpen('ce-vera', info);
			service.noteDelivered('ce-vera');
			service.noteCircuitOpen('ce-vera', info);
			expect(deps.notify).toHaveBeenCalledTimes(1);
			service.noteDelivered('ce-vera');
			clock += 30 * 60_000;
			service.noteCircuitOpen('ce-vera', info);
			expect(deps.notify).toHaveBeenCalledTimes(2);
		});
	});
});
