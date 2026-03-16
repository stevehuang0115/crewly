/**
 * Hook for consuming real-time execution events via WebSocket.
 *
 * Listens to team_member_status_changed, team_activity_updated,
 * orchestrator_status_changed, and queue lifecycle events, normalizing
 * them into a unified FeedEvent stream with automatic deduplication.
 *
 * @module components/ExecutionFeed/useExecutionFeed
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { webSocketService } from '../../services/websocket.service';
import type { FeedEvent, FeedEventType } from './types';

/** Default maximum events kept in state */
const DEFAULT_MAX_EVENTS = 50;

/** Counter for generating unique IDs */
let idCounter = 0;

/**
 * Generate a locally-unique event ID.
 *
 * @returns Unique string ID
 */
function nextId(): string {
	return `feed-${Date.now()}-${++idCounter}`;
}

/**
 * Hook that aggregates real-time WebSocket events into a FeedEvent list.
 *
 * @param maxEvents - Maximum events to retain (oldest are evicted)
 * @returns Object with events array and a clearEvents function
 *
 * @example
 * ```tsx
 * const { events, clearEvents } = useExecutionFeed(50);
 * ```
 */
export function useExecutionFeed(maxEvents: number = DEFAULT_MAX_EVENTS) {
	const [events, setEvents] = useState<FeedEvent[]>([]);
	const maxRef = useRef(maxEvents);
	maxRef.current = maxEvents;

	/** Push a new event, evicting the oldest when over capacity. */
	const pushEvent = useCallback((event: FeedEvent) => {
		setEvents((prev) => {
			const next = [event, ...prev];
			return next.length > maxRef.current ? next.slice(0, maxRef.current) : next;
		});
	}, []);

	/** Remove all events. */
	const clearEvents = useCallback(() => setEvents([]), []);

	// ---- WebSocket listeners ----

	useEffect(() => {
		/**
		 * Handle team_member_status_changed events.
		 */
		const handleMemberStatus = (payload: {
			sessionName?: string;
			name?: string;
			role?: string;
			agentStatus?: string;
			workingStatus?: string;
		}) => {
			const name = payload.name || payload.sessionName || 'Agent';
			const status = payload.agentStatus || payload.workingStatus || 'unknown';
			const type: FeedEventType = status === 'error' ? 'error' : 'agent_status';

			pushEvent({
				id: nextId(),
				type,
				source: name,
				title: `${name} is now ${status}`,
				detail: payload.role ? `Role: ${payload.role}` : undefined,
				timestamp: new Date().toISOString(),
				agentStatus: payload.agentStatus as FeedEvent['agentStatus'],
			});
		};

		/**
		 * Handle orchestrator_status_changed events.
		 */
		const handleOrchestratorStatus = (payload: {
			agentStatus?: string;
			status?: string;
			running?: boolean;
		}) => {
			const status = payload.agentStatus || payload.status || (payload.running ? 'active' : 'inactive');
			pushEvent({
				id: nextId(),
				type: 'system',
				source: 'Orchestrator',
				title: `Orchestrator is now ${status}`,
				timestamp: new Date().toISOString(),
				agentStatus: status as FeedEvent['agentStatus'],
			});
		};

		/**
		 * Handle queue lifecycle events (message enqueued → completed/failed).
		 */
		const handleQueueEvent = (eventName: string) => (payload: {
			sessionName?: string;
			messageId?: string;
			snippet?: string;
		}) => {
			const label = eventName.replace('queue:', '').replace(/_/g, ' ');
			pushEvent({
				id: nextId(),
				type: eventName.includes('failed') ? 'error' : 'message',
				source: payload.sessionName || 'Queue',
				title: `Message ${label}`,
				detail: payload.snippet ? payload.snippet.slice(0, 120) : undefined,
				timestamp: new Date().toISOString(),
			});
		};

		/**
		 * Handle team_activity_updated events (comprehensive updates).
		 */
		const handleTeamActivity = (payload: {
			members?: Array<{
				name?: string;
				sessionName?: string;
				agentStatus?: string;
				currentTask?: string;
			}>;
		}) => {
			if (!payload.members) return;
			for (const member of payload.members) {
				if (!member.agentStatus) continue;
				pushEvent({
					id: nextId(),
					type: 'task_update',
					source: member.name || member.sessionName || 'Agent',
					title: member.currentTask
						? `Working on: ${member.currentTask}`
						: `Status: ${member.agentStatus}`,
					timestamp: new Date().toISOString(),
					agentStatus: member.agentStatus as FeedEvent['agentStatus'],
				});
			}
		};

		// Register listeners
		webSocketService.on('team_member_status_changed', handleMemberStatus);
		webSocketService.on('orchestrator_status_changed', handleOrchestratorStatus);
		webSocketService.on('team_activity_updated', handleTeamActivity);

		const queueEvents = [
			'queue:message_enqueued',
			'queue:message_processing',
			'queue:message_completed',
			'queue:message_failed',
		];
		const queueHandlers = queueEvents.map((name) => {
			const handler = handleQueueEvent(name);
			webSocketService.on(name, handler);
			return { name, handler };
		});

		return () => {
			webSocketService.off('team_member_status_changed', handleMemberStatus);
			webSocketService.off('orchestrator_status_changed', handleOrchestratorStatus);
			webSocketService.off('team_activity_updated', handleTeamActivity);
			for (const { name, handler } of queueHandlers) {
				webSocketService.off(name, handler);
			}
		};
	}, [pushEvent]);

	return { events, clearEvents };
}
