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
	const parked: Array<[string, string, boolean]> = [];
	const queued: string[] = [];
	const down = new Set<string>();
	const answered = { value: false };
	const resumed: string[] = [];
	const redeliverResult: { value: TurnRedeliveryResult } = { value: { success: true } };
	const service = new InProcessTurnFailureService({
		redeliver: async (session, message) => {
			redelivered.push(`${session}:${message}`);
			return redeliverResult.value;
		},
		noteOwnerMessages: async (session, detail, opts) => {
			parked.push([session, detail, opts.needsCredit]);
			return 1;
		},
		isOwnerStopped: (session) => down.has(session),
		queueForAgent: (session, message) => void queued.push(`${session}:${message}`),
		answeredSince: () => answered.value,
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
	return { service, clock, timers, runTimers, redelivered, reports, parked, resumed, redeliverResult, queued, down, answered };
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
	const fail = async (h: ReturnType<typeof harness>, session: string, msg: string, err: unknown = new Error('No output generated.')) => {
		h.service.onTurnFailed(session, msg, err);
		await h.runTimers();
	};

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
		await fail(h, 'crewly-orc', MSG);
		await fail(h, 'crewly-orc', MSG);
		expect(h.redelivered).toHaveLength(1);
		expect(h.parked).toEqual([['crewly-orc', 'the model returned no output', false]]);
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0].sample).toBe(MSG);
		expect(h.reports[0].text).toBe(
			"The orchestrator's model run failed twice on the same message (the model returned no output). " +
				'The message was: "<owner@Orc> 帮我看看claude code是不是login变了？". ' +
				'Until this is fixed the orchestrator answers nothing; your own messages to it are kept and re-delivered once it works again. ' +
				'No further notices until it completes a run.',
		);
	});

	// Review B2: out of credit, every re-delivery failed again → ~40 notices a day.
	it('out of credit: no retry, one report for the whole episode, owner messages parked without timed retries', async () => {
		const h = harness();
		const err = Object.assign(new Error('No output generated.'), { usageLimitKind: 'billing' });
		for (let i = 0; i < 40; i += 1) await fail(h, 'crewly-orc', `msg ${i}`, err);
		expect(h.redelivered).toEqual([]);
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0].text).toContain("crewly-orc's model run failed (the model account is out of credit).");
		expect(h.parked.every(([, , needsCredit]) => needsCredit)).toBe(true);
		// Episode over once a run completes; the next failure is a new episode.
		h.service.onTurnSucceeded('crewly-orc');
		await fail(h, 'crewly-orc', 'later', err);
		expect(h.reports).toHaveLength(2);
	});

	it('the same message failing again later is not retried again', async () => {
		const h = harness();
		await fail(h, 'ella', 'x');
		await fail(h, 'ella', 'x');
		await fail(h, 'ella', 'x');
		expect(h.redelivered).toHaveLength(1);
		expect(h.reports).toHaveLength(1);
	});

	it('a stopped (or not running) agent: no retry, no "model run failed" report — the message waits for its next start', async () => {
		const h = harness();
		h.down.add('ella');
		await fail(h, 'ella', 'please send the PDF', new Error("Crewly Agent runtime for 'ella' is not initialized"));
		expect(h.redelivered).toEqual([]);
		expect(h.reports).toEqual([]);
		expect(h.queued).toEqual(['ella:please send the PDF']);

		const h2 = harness({ isRunning: () => false });
		await fail(h2, 'owen', 'hi');
		expect(h2.reports).toEqual([]);
		expect(h2.queued).toEqual(['owen:hi']);
	});

	it('an agent stopped before the retry: queued, not reported', async () => {
		const h = harness();
		h.service.onTurnFailed('ella', 'x', new Error('boom'));
		h.down.add('ella');
		await h.runTimers();
		expect(h.redelivered).toEqual([]);
		expect(h.queued).toEqual(['ella:x']);
		expect(h.reports).toEqual([]);
	});

	// Review H3: the retry must not answer twice.
	it('no retry when the failed turn already answered where the message came from', async () => {
		const h = harness();
		h.answered.value = true;
		await fail(h, 'ella', 'x');
		expect(h.redelivered).toEqual([]);
		expect(h.reports).toEqual([]);
	});

	it('a retry that cannot be delivered (agent still up) is reported once', async () => {
		const h = harness();
		h.redeliverResult.value = { success: false, error: 'input box holds text not written by Crewly' };
		await fail(h, 'ella', 'please send the PDF', new Error('worker exited'));
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0].text).toContain("ella's model run failed and the message could not be delivered to it again (worker exited; delivering it again failed: input box holds text not written by Crewly)");
	});

	it('a queued retry (runtime switch, cap, drain) is not reported', async () => {
		const h = harness();
		h.redeliverResult.value = { success: true, queued: true };
		await fail(h, 'ella', 'x', new Error('boom'));
		expect(h.reports).toEqual([]);
	});

	it('a successful turn after failures re-delivers the parked owner messages, once', async () => {
		const h = harness();
		h.service.onTurnSucceeded('crewly-orc');
		expect(h.resumed).toEqual([]);
		await fail(h, 'crewly-orc', 'm', new Error('x'));
		await fail(h, 'crewly-orc', 'm', new Error('x'));
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
