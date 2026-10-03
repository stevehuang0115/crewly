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

	it('a busy hold is reported once after BUSY_HOLD_NOTIFY_MS, and again only after a delivery', () => {
		service.noteBusyHold('ella', 9 * 60_000, 'first held');
		expect(deps.notify).not.toHaveBeenCalled();
		service.noteBusyHold('ella', 10 * 60_000, 'first held');
		service.noteBusyHold('ella', 12 * 60_000, 'first held');
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ sessionName: 'ella', state: 'busy', blockedForMs: 10 * 60_000, message: 'first held' }));
		service.noteDelivered('ella');
		service.noteBusyHold('ella', 11 * 60_000, 'later');
		expect(deps.notify).toHaveBeenCalledTimes(2);
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

});
