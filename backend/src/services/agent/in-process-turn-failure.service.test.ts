/**
 * Tests for failed in-process turns (crewly#1015 §2).
 */

import { IN_PROCESS_TURN_FAILURE_CONSTANTS as C } from '../../constants.js';
import { InProcessTurnFailureService, describeTurnError, type InProcessTurnFailureDeps, type TurnRedeliveryResult } from './in-process-turn-failure.service.js';

const MSG = '[CHAT:a721f48d] <owner@Orc>\n\n帮我看看claude code是不是login变了？';

function harness(over: Partial<InProcessTurnFailureDeps> = {}) {
	const clock = { t: 1_000_000 };
	const timers: Array<() => void> = [];
	const redelivered: string[] = [];
	const reports: Array<{ session: string; text: string; sample: string }> = [];
	const parked: Array<[string, string]> = [];
	const resumed: string[] = [];
	const redeliverResult: { value: TurnRedeliveryResult } = { value: { success: true } };
	const service = new InProcessTurnFailureService({
		redeliver: async (session, message) => {
			redelivered.push(`${session}:${message}`);
			return redeliverResult.value;
		},
		noteOwnerMessages: async (session, detail) => {
			parked.push([session, detail]);
			return 1;
		},
		resumeOwnerMessages: async (session) => {
			resumed.push(session);
			return 1;
		},
		report: (session, text, sample) => reports.push({ session, text, sample }),
		now: () => clock.t,
		setTimer: (fn) => {
			timers.push(fn);
			return null;
		},
		...over,
	});
	const runTimers = async (): Promise<void> => {
		const due = timers.splice(0);
		for (const fn of due) fn();
		await new Promise((r) => setImmediate(r));
	};
	return { service, clock, timers, runTimers, redelivered, reports, parked, resumed, redeliverResult };
}

describe('describeTurnError', () => {
	it('names the usage-limit kind the runtime recognised', () => {
		expect(describeTurnError(Object.assign(new Error('No output generated.'), { usageLimitKind: 'billing' }))).toBe('the model account is out of credit');
		expect(describeTurnError(Object.assign(new Error('x'), { usageLimitKind: 'usage_limit' }))).toBe("the model's usage limit was reached");
		expect(describeTurnError(Object.assign(new Error('x'), { usageLimitKind: 'transient' }))).toBe('the model provider is rate-limiting');
	});

	it('says what a bare "No output generated" means, and clips anything else', () => {
		expect(describeTurnError(new Error('No output generated. Check the stream for errors.'))).toBe('the model returned no output');
		expect(describeTurnError(new Error('worker exited'))).toBe('worker exited');
		expect(describeTurnError(new Error('e'.repeat(500))).length).toBeLessThanOrEqual(C.ERROR_CHARS + 1);
		expect(describeTurnError(undefined)).toBe('unknown error');
	});
});

describe('InProcessTurnFailureService', () => {
	it('first failure: the same message is delivered once more after a delay, nobody is told yet', async () => {
		const h = harness();
		h.service.onTurnFailed('crewly-orc', MSG, new Error('No output generated.'));
		expect(h.redelivered).toEqual([]);
		await h.runTimers();
		expect(h.redelivered).toEqual([`crewly-orc:${MSG}`]);
		expect(h.reports).toEqual([]);
		expect(h.parked).toEqual([]);
	});

	it('second failure of the same message: owner messages parked and the failure reported', async () => {
		const h = harness({ displayName: (s) => (s === 'crewly-orc' ? 'The orchestrator' : s) });
		const err = Object.assign(new Error('No output generated.'), { usageLimitKind: 'billing' });
		h.service.onTurnFailed('crewly-orc', MSG, err);
		await h.runTimers();
		h.service.onTurnFailed('crewly-orc', MSG, err);
		await h.runTimers();
		expect(h.redelivered).toHaveLength(1);
		expect(h.parked).toEqual([['crewly-orc', 'the model account is out of credit']]);
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0].session).toBe('crewly-orc');
		expect(h.reports[0].sample).toBe(MSG);
		expect(h.reports[0].text).toBe(
			"The orchestrator's model run failed twice on the same message (the model account is out of credit). " +
				'The message was: "<owner@Orc> 帮我看看claude code是不是login变了？". ' +
				'Until this is fixed the orchestrator answers nothing; your own messages to it are kept and re-delivered.',
		);
	});

	it('a retry that cannot be delivered is reported at once', async () => {
		const h = harness();
		h.redeliverResult.value = { success: false, error: 'Crewly Agent runtime for ella is not initialized' };
		h.service.onTurnFailed('ella', 'please send the PDF', new Error('worker exited'));
		await h.runTimers();
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0].text).toContain('worker exited; the retry could not be delivered: Crewly Agent runtime for ella is not initialized');
		expect(h.reports[0].text).toContain('anything else sent to ella needs sending again');
	});

	it('a queued retry (runtime switch, cap, drain) is not reported', async () => {
		const h = harness();
		h.redeliverResult.value = { success: true, queued: true };
		h.service.onTurnFailed('ella', 'x', new Error('boom'));
		await h.runTimers();
		expect(h.reports).toEqual([]);
	});

	it('80 failures are a handful of notices: one per cooldown, counting what failed in between', async () => {
		const h = harness();
		const fail = async (i: number) => {
			h.service.onTurnFailed('crewly-orc', `msg ${i}`, new Error('No output generated.'));
			await h.runTimers();
			h.service.onTurnFailed('crewly-orc', `msg ${i}`, new Error('No output generated.'));
			await h.runTimers();
		};
		for (let i = 0; i < 5; i += 1) await fail(i);
		expect(h.reports).toHaveLength(1);
		h.clock.t += C.NOTICE_COOLDOWN_MS;
		await fail(99);
		expect(h.reports).toHaveLength(2);
		expect(h.reports[1].text).toContain('4 more failed run(s) since the last notice.');
		// Owner messages are parked on every final failure (the watchdog notes each message once).
		expect(h.parked).toHaveLength(6);
	});

	it('a successful turn after failures re-delivers the parked owner messages, once', async () => {
		const h = harness();
		h.service.onTurnSucceeded('crewly-orc');
		expect(h.resumed).toEqual([]);
		h.service.onTurnFailed('crewly-orc', 'm', new Error('x'));
		await h.runTimers();
		h.service.onTurnFailed('crewly-orc', 'm', new Error('x'));
		await h.runTimers();
		h.service.onTurnSucceeded('crewly-orc');
		h.service.onTurnSucceeded('crewly-orc');
		await new Promise((r) => setImmediate(r));
		expect(h.resumed).toEqual(['crewly-orc']);
	});

	it('the retry budget is per message and expires', async () => {
		const h = harness();
		h.service.onTurnFailed('ella', 'a', new Error('x'));
		h.service.onTurnFailed('ella', 'b', new Error('x'));
		expect(h.timers).toHaveLength(2);
		h.clock.t += C.ATTEMPT_TTL_MS + 1;
		h.service.onTurnFailed('ella', 'a', new Error('x'));
		expect(h.timers).toHaveLength(3);
		expect(h.reports).toEqual([]);
	});
});
