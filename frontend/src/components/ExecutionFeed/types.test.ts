import { describe, it, expect } from 'vitest';
import type { FeedEvent, FeedEventType, ExecutionFeedProps } from './types';

describe('ExecutionFeed types', () => {
	it('FeedEvent can be constructed with required fields', () => {
		const event: FeedEvent = {
			id: 'test-1',
			type: 'agent_status',
			source: 'Sam',
			title: 'Sam is now active',
			timestamp: new Date().toISOString(),
		};
		expect(event.id).toBe('test-1');
		expect(event.type).toBe('agent_status');
	});

	it('FeedEvent supports all event types', () => {
		const types: FeedEventType[] = [
			'agent_status',
			'task_update',
			'message',
			'system',
			'error',
		];
		for (const t of types) {
			const event: FeedEvent = {
				id: `test-${t}`,
				type: t,
				source: 'test',
				title: 'test',
				timestamp: new Date().toISOString(),
			};
			expect(event.type).toBe(t);
		}
	});

	it('FeedEvent supports optional fields', () => {
		const event: FeedEvent = {
			id: 'test-2',
			type: 'task_update',
			source: 'Leo',
			title: 'Working on F15',
			detail: 'Frontend component',
			timestamp: new Date().toISOString(),
			agentStatus: 'busy',
		};
		expect(event.detail).toBe('Frontend component');
		expect(event.agentStatus).toBe('busy');
	});

	it('ExecutionFeedProps defaults are optional', () => {
		const props: ExecutionFeedProps = {};
		expect(props.maxEvents).toBeUndefined();
		expect(props.className).toBeUndefined();
	});
});
