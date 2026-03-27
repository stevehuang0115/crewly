/**
 * ExecutionFeed — Real-time streaming activity feed.
 *
 * Displays a live-updating list of agent activities, status changes,
 * and system events sourced from the backend WebSocket.
 *
 * @module components/ExecutionFeed/ExecutionFeed
 */

import React, { useRef, useEffect } from 'react';
import { useExecutionFeed } from './useExecutionFeed';
import type { ExecutionFeedProps, FeedEvent, FeedEventType } from './types';
import './ExecutionFeed.css';

/** Map event types to a Tailwind-friendly dot color class. */
const DOT_COLOR: Record<FeedEventType, string> = {
	agent_status: 'bg-emerald-400',
	task_update: 'bg-blue-400',
	message: 'bg-primary',
	system: 'bg-amber-400',
	error: 'bg-red-400',
};

/** Human-friendly label for event types. */
const TYPE_LABEL: Record<FeedEventType, string> = {
	agent_status: 'Agent',
	task_update: 'Task',
	message: 'Message',
	system: 'System',
	error: 'Error',
};

/**
 * Format an ISO timestamp into a short local time string (HH:MM:SS).
 *
 * @param iso - ISO 8601 timestamp
 * @returns Formatted time string
 */
function formatTime(iso: string): string {
	try {
		return new Date(iso).toLocaleTimeString([], {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	} catch {
		return '';
	}
}

/**
 * Single feed entry row.
 */
const FeedEntry: React.FC<{ event: FeedEvent }> = ({ event }) => {
	const isActive =
		event.agentStatus === 'active' || event.agentStatus === 'busy';
	const dotColor = DOT_COLOR[event.type] || 'bg-gray-400';

	return (
		<div
			className="feed-entry flex items-start gap-3 px-4 py-2.5 border-b border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
			data-testid="feed-entry"
		>
			{/* Status dot */}
			<span
				className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor} ${isActive ? 'feed-pulse' : ''}`}
			/>

			{/* Content */}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wide">
						{TYPE_LABEL[event.type]}
					</span>
					<span className="text-xs text-[var(--color-text-muted)]">
						{formatTime(event.timestamp)}
					</span>
				</div>
				<p className="text-sm text-[var(--color-text-primary)] truncate">
					{event.title}
				</p>
				{event.detail && (
					<p className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
						{event.detail}
					</p>
				)}
			</div>
		</div>
	);
};

/**
 * Empty state shown when no events have arrived yet.
 */
const EmptyState: React.FC = () => (
	<div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-muted)]">
		<svg
			className="h-10 w-10 mb-3 opacity-40"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M13 10V3L4 14h7v7l9-11h-7z"
			/>
		</svg>
		<p className="text-sm">Waiting for live events&hellip;</p>
	</div>
);

/**
 * Real-time execution feed that streams agent activities from the backend.
 *
 * @param props - Component props
 * @returns React element
 *
 * @example
 * ```tsx
 * <ExecutionFeed maxEvents={100} className="h-96" />
 * ```
 */
export const ExecutionFeed: React.FC<ExecutionFeedProps> = ({
	maxEvents = 50,
	className = '',
}) => {
	const { events, clearEvents } = useExecutionFeed(maxEvents);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to top when new events arrive (newest first)
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = 0;
		}
	}, [events.length]);

	return (
		<div
			className={`flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden ${className}`}
			data-testid="execution-feed"
		>
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
				<div className="flex items-center gap-2">
					<span className="h-2 w-2 rounded-full bg-emerald-400 feed-pulse" />
					<h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
						Execution Feed
					</h3>
					{events.length > 0 && (
						<span className="text-xs text-[var(--color-text-muted)]">
							({events.length})
						</span>
					)}
				</div>
				{events.length > 0 && (
					<button
						onClick={clearEvents}
						className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
						data-testid="feed-clear"
					>
						Clear
					</button>
				)}
			</div>

			{/* Feed list */}
			<div
				ref={scrollRef}
				className="feed-scroll flex-1 overflow-y-auto"
			>
				{events.length === 0 ? (
					<EmptyState />
				) : (
					events.map((event) => (
						<FeedEntry key={event.id} event={event} />
					))
				)}
			</div>
		</div>
	);
};

export default ExecutionFeed;
