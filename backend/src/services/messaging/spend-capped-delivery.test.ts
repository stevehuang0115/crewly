/**
 * Tests for the daily token cap gate of the direct write paths (#937).
 *
 * @module services/messaging/spend-capped-delivery.test
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { queueIfSpendCapped } from './spend-capped-delivery.js';
import { setSpendCapGate, type SpendStop } from '../spend/spend-cap.gate.js';
import { SubAgentMessageQueue } from './sub-agent-message-queue.service.js';

describe('queueIfSpendCapped', () => {
	const stop: SpendStop = { session: 'ella-1', scope: 'team', capTokens: 50_000_000, usedTokens: 51_000_000, teamName: 'CE' };

	afterEach(() => {
		setSpendCapGate(null);
		SubAgentMessageQueue.getInstance().dequeueAll('ella-1');
	});

	it('returns null and queues nothing when no gate is wired', () => {
		const enqueue = jest.fn();
		expect(queueIfSpendCapped('ella-1', 'hi', enqueue)).toBeNull();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('returns null for an agent that is not capped', () => {
		setSpendCapGate({ stopOf: () => null });
		const enqueue = jest.fn();
		expect(queueIfSpendCapped('ella-1', 'hi', enqueue)).toBeNull();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('queues the message for a capped agent and returns the /deliver [SPEND_CAP] text', () => {
		setSpendCapGate({ stopOf: (s) => (s === 'ella-1' ? stop : null), displayNameOf: () => 'Ella' });
		const enqueue = jest.fn();

		const result = queueIfSpendCapped('ella-1', 'review PR #42', enqueue);

		expect(enqueue).toHaveBeenCalledWith('ella-1', 'review PR #42');
		expect(result).toEqual({
			success: true,
			queued: true,
			spendCapped: true,
			message: '[SPEND_CAP] Ella is stopped: team CE hit its daily token cap (50M tokens); message queued',
		});
	});

	it('uses the persistent SubAgentMessageQueue by default (the queue the cap release flushes)', () => {
		setSpendCapGate({ stopOf: () => stop });

		queueIfSpendCapped('ella-1', 'held for the cap');

		expect(SubAgentMessageQueue.getInstance().hasPending('ella-1')).toBe(true);
		expect(SubAgentMessageQueue.getInstance().dequeueAll('ella-1').map((m) => m.data)).toEqual(['held for the cap']);
	});

	it('lets the agent run when the gate throws', () => {
		setSpendCapGate({
			stopOf: () => {
				throw new Error('broken');
			},
		});
		expect(queueIfSpendCapped('ella-1', 'hi', jest.fn())).toBeNull();
	});
});
