/**
 * One row of the run timeline: a turn of one agent, the owner's actions,
 * harness activity, or a stall. Collapsed it is one line (who, what, when,
 * counts); a click shows its events. Routine events (skill calls, token
 * lines, turn ends) are folded into one line until "Show all".
 *
 * @module components/TraceTimeline/TimelineGroupRow
 */

import React, { useState } from 'react';
import { CompactRow, StatusLabel } from '@crewly/ui';
import { Button } from '@crewly/ui/Button';
import type { TimelineGroup, TraceEvent } from '../../types/trace.types';
import { actorLabel, eventLabel, formatClock, formatDuration, formatTokenCount, formatUsd, ROUTINE_EVENT_TYPES, STALL_CAUSE_LABELS } from './traceFormat';

export interface TimelineGroupRowProps {
	group: TimelineGroup;
	/** Display name of an agent session */
	nameOf?: (session: string) => string;
	/** Clock for "today" in times (tests) */
	now?: Date;
}

/**
 * The owner-facing title of a group.
 *
 * @param group - Group
 * @param nameOf - Display name of a session
 * @returns "You → Ella", "Work item → Sam", "Stalled 2h — waiting on you"
 */
export function groupTitle(group: TimelineGroup, nameOf: (session: string) => string): string {
	if (group.kind === 'stall' && group.stall) {
		return `Stalled ${formatDuration(group.stall.ms)}${group.stall.ongoing ? ' and counting' : ''} — ${STALL_CAUSE_LABELS[group.stall.cause]}`;
	}
	if (group.kind === 'owner') return 'You';
	if (group.kind === 'system') return 'Crewly';
	const session = group.session;
	if (!session) return group.title;
	const name = nameOf(session);
	if (group.title === `${session} working`) return `${name} working`;
	if (group.title === `Harness → ${session}`) return `Crewly → ${name}`;
	const arrow = group.title.lastIndexOf(' → ');
	const source = arrow >= 0 ? group.title.slice(0, arrow) : group.title;
	return `${source === 'Owner' ? 'You' : source} → ${name}`;
}

/**
 * The quiet line under a group's title.
 *
 * @param group - Group
 * @param now - Clock
 * @returns "14:05–14:40 · 12 events · 3 skill calls · 34k tokens $0.12"
 */
export function groupMeta(group: TimelineGroup, now?: Date): string {
	const start = formatClock(group.start, now);
	const end = formatClock(group.end, now);
	const span = start === end ? start : `${start}–${end}`;
	if (group.kind === 'stall') return group.stall?.ongoing ? `since ${start}` : span;
	const parts = [span, `${group.counts.events} ${group.counts.events === 1 ? 'event' : 'events'}`];
	if (group.counts.skillCalls > 0) parts.push(`${group.counts.skillCalls} skill ${group.counts.skillCalls === 1 ? 'call' : 'calls'}`);
	if (group.tokens > 0) parts.push(`${formatTokenCount(group.tokens)} tokens ${formatUsd(group.costUsd)}`);
	return parts.join(' · ');
}

/**
 * One event line.
 *
 * @param props.event - Event
 * @param props.nameOf - Display name of a session
 * @param props.now - Clock
 * @returns A list item
 */
const EventLine: React.FC<{ event: TraceEvent; nameOf: (s: string) => string; now?: Date }> = ({ event, nameOf, now }) => {
	const actor = event.actor.kind === 'agent' && event.actor.session ? nameOf(event.actor.session) : actorLabel(event);
	return (
		<li className="flex min-w-0 gap-3 py-1.5 text-[13px]" data-testid="trace-event">
			<span className="w-12 shrink-0 font-mono text-[12px] text-text-3">{formatClock(event.ts, now)}</span>
			<span className="min-w-0 flex-1">
				<span className="font-semibold text-text">{eventLabel(event.type)}</span>
				<span className="text-text-3"> · {actor}</span>
				{(event.outcome === 'failed' || event.outcome === 'blocked') && (
					<StatusLabel className="ml-2" size="sm" tone={event.outcome === 'failed' ? 'danger' : 'attention'}>
						{event.outcome === 'failed' ? 'Failed' : 'Blocked'}
					</StatusLabel>
				)}
				<span className="block break-words text-text-2">{event.summary}</span>
			</span>
		</li>
	);
};

/**
 * Timeline row.
 *
 * @param props - {@link TimelineGroupRowProps}
 * @returns A list item
 */
export const TimelineGroupRow: React.FC<TimelineGroupRowProps> = ({ group, nameOf = (s) => s, now }) => {
	const [open, setOpen] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const isStall = group.kind === 'stall';
	const routine = group.events.filter((e) => ROUTINE_EVENT_TYPES.has(e.type));
	const shown = showAll ? group.events : group.events.filter((e) => !ROUTINE_EVENT_TYPES.has(e.type));
	const dot = isStall || group.outcome === 'blocked' ? 'bg-attention' : group.outcome === 'failed' ? 'bg-danger' : group.kind === 'owner' ? 'bg-primary' : 'bg-muted-dot';

	return (
		<li className={`list-none border-b border-border-soft last:border-b-0 ${isStall ? 'bg-attention-soft' : ''}`} data-testid={`trace-group-${group.id}`} data-kind={group.kind}>
			<CompactRow
				className="border-b-0"
				primary={<span className={isStall ? 'text-attention' : undefined}>{groupTitle(group, nameOf)}</span>}
				meta={isStall ? `${groupMeta(group, now)} · ${group.stall?.detail ?? ''}` : groupMeta(group, now)}
				leading={<span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dot}${group.stall?.ongoing ? ' animate-pulse' : ''}`} />}
				trailing={
					group.kind !== 'stall' && (group.counts.errors > 0 || group.counts.blocks > 0) ? (
						<span className="text-[12px]">
							{group.counts.errors > 0 && <span className="text-danger">{group.counts.errors} failed</span>}
							{group.counts.errors > 0 && group.counts.blocks > 0 && ' · '}
							{group.counts.blocks > 0 && <span className="text-attention">{group.counts.blocks} blocked</span>}
						</span>
					) : undefined
				}
				onClick={isStall ? undefined : () => setOpen((v) => !v)}
				data-testid={`trace-group-row-${group.id}`}
			/>
			{open && !isStall && (
				<div className="px-4 pb-3 sm:pl-12" data-testid={`trace-group-events-${group.id}`}>
					<ul className="divide-y divide-border-soft">
						{shown.map((e, i) => (
							<EventLine key={`${e.ts}-${i}`} event={e} nameOf={nameOf} now={now} />
						))}
					</ul>
					{routine.length > 0 && (
						<Button variant="link" size="xs" onClick={() => setShowAll((v) => !v)} data-testid={`trace-group-show-all-${group.id}`}>
							{showAll ? 'Hide routine events' : `Show all ${group.events.length} events (${routine.length} routine)`}
						</Button>
					)}
				</div>
			)}
		</li>
	);
};

TimelineGroupRow.displayName = 'TimelineGroupRow';
