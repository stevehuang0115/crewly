/**
 * Types for the real-time Execution Feed component.
 *
 * @module components/ExecutionFeed/types
 */

/** Event categories for visual styling and filtering */
export type FeedEventType =
	| 'agent_status'
	| 'task_update'
	| 'message'
	| 'system'
	| 'error';

/** Individual feed entry */
export interface FeedEvent {
	/** Unique identifier */
	id: string;
	/** Event category */
	type: FeedEventType;
	/** Agent or source name */
	source: string;
	/** Human-readable summary */
	title: string;
	/** Optional detail text */
	detail?: string;
	/** ISO timestamp */
	timestamp: string;
	/** Agent status if applicable */
	agentStatus?: 'active' | 'inactive' | 'activating' | 'idle' | 'busy';
}

/** Props for the ExecutionFeed component */
export interface ExecutionFeedProps {
	/** Maximum number of events to display (default: 50) */
	maxEvents?: number;
	/** Optional CSS class name */
	className?: string;
}
