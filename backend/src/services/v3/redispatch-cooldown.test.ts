/**
 * Shared re-push cooldown of WorkItemDispatchSubscriber.redispatchOutcome (CREW-821).
 *
 * The reconciler, the autopilot stall check, the ticket nudge and auto-claim
 * each re-push a brief on their own clock. After one write landed, another
 * wrote the same brief to the same agent about a minute later (WI 967ecc23,
 * three pairs on 2026-11-20). These tests run two "callers" through the real
 * dispatcher and count the writes the agent receives.
 *
 * @module services/v3/redispatch-cooldown.test
 */

import axios from 'axios';
import { WorkItemDispatchSubscriber } from './workitem-dispatch.subscriber.js';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import { createWorkItem } from '../../types/v2/index.js';
import { REDISPATCH_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
		}),
	},
}));

const TARGET = 'crewly-product-team-max-358c7cb7';

/**
 * Builds a queued WorkItem for the target.
 *
 * @param id - WorkItem id
 * @param target - Agent session
 * @returns The WorkItem
 */
function makeWorkItem(id: string, target = TARGET): WorkItem {
	return { ...createWorkItem({ type: 'delegate', owner: 'team_lead', title: 'Start after the deploy', target }), id, status: 'queued' };
}

describe('redispatchOutcome shared cooldown (CREW-821)', () => {
	beforeEach(() => {
		WorkItemDispatchSubscriber.resetInstance();
		SubAgentMessageQueue.resetInstance();
		mockedAxios.post.mockReset();
		mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
	});

	afterEach(() => {
		jest.restoreAllMocks();
		WorkItemDispatchSubscriber.resetInstance();
		SubAgentMessageQueue.resetInstance();
	});

	it('two callers re-pushing the same WorkItem within the window write once; the second gets waiting', async () => {
		const d = WorkItemDispatchSubscriber.getInstance();
		const wi = makeWorkItem('wi-1');

		const reconciler = await d.redispatchOutcome(wi);
		const autopilot = await d.redispatchOutcome(wi);

		expect(reconciler.status).toBe('delivered');
		expect(autopilot.status).toBe('waiting');
		expect(mockedAxios.post).toHaveBeenCalledTimes(1);
	});

	it('the plain boolean redispatch is held the same way', async () => {
		const d = WorkItemDispatchSubscriber.getInstance();
		const wi = makeWorkItem('wi-1');
		expect(await d.redispatch(wi)).toBe(true);
		expect(await d.redispatch(wi)).toBe(false);
		expect(mockedAxios.post).toHaveBeenCalledTimes(1);
	});

	it('a re-push after the window goes through', async () => {
		const d = WorkItemDispatchSubscriber.getInstance();
		const wi = makeWorkItem('wi-1');
		const t0 = Date.now();
		const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
		expect((await d.redispatchOutcome(wi)).status).toBe('delivered');

		now.mockReturnValue(t0 + REDISPATCH_CONSTANTS.COOLDOWN_MS - 1_000);
		expect((await d.redispatchOutcome(wi)).status).toBe('waiting');

		now.mockReturnValue(t0 + REDISPATCH_CONSTANTS.COOLDOWN_MS + 1_000);
		expect((await d.redispatchOutcome(wi)).status).toBe('delivered');
		expect(mockedAxios.post).toHaveBeenCalledTimes(2);
	});

	it('a different WorkItem, or the same one for another agent, is not held', async () => {
		const d = WorkItemDispatchSubscriber.getInstance();
		expect((await d.redispatchOutcome(makeWorkItem('wi-1'))).status).toBe('delivered');
		expect((await d.redispatchOutcome(makeWorkItem('wi-2'))).status).toBe('delivered');
		expect((await d.redispatchOutcome(makeWorkItem('wi-1', 'another-agent'))).status).toBe('delivered');
		expect(mockedAxios.post).toHaveBeenCalledTimes(3);
	});

	it('a failed write does not start the cooldown, so the next caller can try', async () => {
		const d = WorkItemDispatchSubscriber.getInstance();
		const wi = makeWorkItem('wi-1');
		mockedAxios.post.mockRejectedValue(new Error('terminal write failed'));
		expect(dispatchWroteStatus(await d.redispatchOutcome(wi))).toBe(false);

		mockedAxios.post.mockReset();
		mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
		expect((await d.redispatchOutcome(wi)).status).toBe('delivered');
	});

	it('a first delivery is not held by the cooldown, and does not start it', async () => {
		const d = WorkItemDispatchSubscriber.getInstance();
		const wi = makeWorkItem('wi-1');
		expect((await d.dispatchOutcome(wi)).status).toBe('delivered');
		// The first delivery is not a re-push: the first re-push right after it still goes out.
		expect((await d.redispatchOutcome(wi)).status).toBe('delivered');
		expect(mockedAxios.post).toHaveBeenCalledTimes(2);
	});
});

/**
 * Whether an outcome wrote to the agent.
 *
 * @param outcome - Dispatch outcome
 * @returns True for delivered or queued
 */
function dispatchWroteStatus(outcome: { status: string }): boolean {
	return outcome.status === 'delivered' || outcome.status === 'queued';
}
