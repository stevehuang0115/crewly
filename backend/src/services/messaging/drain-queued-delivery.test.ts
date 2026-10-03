/**
 * Tests for the restart-drain gate on the direct write paths (crewly#1015 §6).
 */

import { queueIfRestartDraining } from './drain-queued-delivery.js';

describe('queueIfRestartDraining', () => {
	it('lets the write through when delivery is not paused', () => {
		const enqueue = jest.fn();
		expect(queueIfRestartDraining('owen', 'hello', { isPaused: () => false, enqueue })).toBeNull();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('queues the message and answers 202-style while the shutdown drain runs', () => {
		const enqueue = jest.fn();
		const held = queueIfRestartDraining('owen', 'hello', { isPaused: () => true, enqueue });
		expect(enqueue).toHaveBeenCalledWith('owen', 'hello', {});
		expect(held).toEqual({
			success: true,
			queued: true,
			restartDrain: true,
			message: '[RESTART_DRAIN] Message queued for delivery after the restart',
		});
	});

	it('keeps the WorkItem id of a held brief (crewly#1015 review)', () => {
		const enqueue = jest.fn();
		queueIfRestartDraining('owen', 'brief', { isPaused: () => true, enqueue, workItemId: ' wi-1 ' });
		expect(enqueue).toHaveBeenCalledWith('owen', 'brief', { workItemId: 'wi-1' });
	});

	it('delivers when the pause check itself fails', () => {
		const enqueue = jest.fn();
		expect(
			queueIfRestartDraining('owen', 'hello', {
				isPaused: () => {
					throw new Error('not wired');
				},
				enqueue,
			}),
		).toBeNull();
		expect(enqueue).not.toHaveBeenCalled();
	});
});
