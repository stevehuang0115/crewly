/**
 * The metrics strip at the top of a run timeline: a few numbers readable at
 * a glance (wall, active, waiting on you, owner touches, rework, stalls,
 * cost), with the breakdowns behind "Details".
 *
 * One wrapping line on desktop, a 2-column grid on a phone.
 *
 * @module components/TraceTimeline/MetricsStrip
 */

import React from 'react';
import { CollapsibleSection, StatusLabel, type StatusTone } from '@crewly/ui';
import type { TraceMetrics, UsageBreakdown } from '../../types/trace.types';
import { formatDuration, formatTokenCount, formatUsd, OUTCOME_STATE_LABELS, STALL_CAUSE_LABELS } from './traceFormat';

export interface MetricsStripProps {
	metrics: TraceMetrics;
	/** Display name of an agent session (defaults to the session) */
	nameOf?: (session: string) => string;
}

/** One tile. */
interface Tile {
	id: string;
	label: string;
	value: string;
	/** Quiet second line */
	hint?: string;
	/** Attention colour when the number needs the owner's eye */
	attention?: boolean;
	title?: string;
}

/**
 * Tone of a run state.
 *
 * @param state - Outcome state
 * @returns Status tone
 */
export function outcomeTone(state: TraceMetrics['outcome']['state']): StatusTone {
	if (state === 'done') return 'success';
	if (state === 'failed') return 'danger';
	if (state === 'waiting_on_owner') return 'attention';
	if (state === 'in_progress') return 'primary';
	return 'neutral';
}

/**
 * Percent of the wall time.
 *
 * @param part - ms
 * @param wall - ms
 * @returns "38%" or undefined
 */
function pct(part: number, wall: number): string | undefined {
	return wall > 0 ? `${Math.round((part / wall) * 100)}% of the time` : undefined;
}

/**
 * The tiles.
 *
 * @param m - Metrics
 * @returns Tiles in display order
 */
export function metricTiles(m: TraceMetrics): Tile[] {
	const t = m.time;
	const ongoing = m.stalls.items.some((s) => s.ongoing);
	const touches = m.ownerTouches;
	const rework = m.rework;
	return [
		{ id: 'wall', label: 'Wall time', value: formatDuration(t.wallMs) },
		{ id: 'active', label: 'Agents working', value: formatDuration(t.activeMs), hint: pct(t.activeMs, t.wallMs), title: t.activeSource === 'inferred' ? 'Estimated from agent activity' : undefined },
		{ id: 'owner-wait', label: 'Waiting on you', value: formatDuration(t.waitingOwnerMs), hint: pct(t.waitingOwnerMs, t.wallMs), attention: t.waitingOwnerMs > 0 },
		{
			id: 'touches',
			label: 'Your touches',
			value: String(touches.total),
			title: `Answered ${touches.answered}, approved ${touches.approved}, sent back ${touches.sentBack}, corrected ${touches.corrected}, manual ${touches.manual}`,
		},
		{
			id: 'rework',
			label: 'Rework',
			value: String(rework.total),
			title: `Send-backs ${rework.sendBacks}, retries ${rework.retries}, failed verifications ${rework.failedVerifications}, subagent send-backs ${rework.subagentSendBacks}`,
			attention: rework.total > 0,
		},
		{
			id: 'stalls',
			label: 'Stalls',
			value: String(m.stalls.count),
			hint: m.stalls.count > 0 ? (ongoing ? 'one still going' : formatDuration(m.stalls.totalMs)) : undefined,
			attention: m.stalls.count > 0,
		},
		{ id: 'cost', label: 'Cost', value: formatUsd(m.usage.costUsd), hint: `${formatTokenCount(m.usage.totalTokens)} tokens` },
	];
}

/**
 * A breakdown line ("Ella 900k $2.50 · Orc 300k $0.91").
 *
 * @param rows - Agents or models
 * @param nameOf - Display name of a key
 * @returns Text
 */
function breakdownText(rows: ReadonlyArray<UsageBreakdown>, nameOf: (key: string) => string): string {
	return rows.length === 0 ? 'none' : rows.map((r) => `${nameOf(r.key)} ${formatTokenCount(r.totalTokens)} ${formatUsd(r.costUsd)}`).join(' · ');
}

/**
 * Metrics strip.
 *
 * @param props - {@link MetricsStripProps}
 * @returns The strip and its collapsed details
 */
export const MetricsStrip: React.FC<MetricsStripProps> = ({ metrics, nameOf = (s) => s }) => {
	const tiles = metricTiles(metrics);
	const m = metrics;
	const stallCauses = Object.entries(m.stalls.byCause)
		.filter(([, n]) => n > 0)
		.map(([cause, n]) => `${STALL_CAUSE_LABELS[cause as keyof typeof STALL_CAUSE_LABELS]} ${n}`)
		.join(' · ');
	const iv = m.interventions;
	return (
		<section aria-label="Run metrics" data-testid="trace-metrics-strip">
			<div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-2">
				<StatusLabel tone={outcomeTone(m.outcome.state)} data-testid="trace-outcome">
					{OUTCOME_STATE_LABELS[m.outcome.state]}
				</StatusLabel>
				{m.outcome.experiment?.verdict && <span>Experiment: {m.outcome.experiment.verdict === 'didnt' ? "didn't work" : m.outcome.experiment.verdict}</span>}
				{m.outcome.workItems.total > 0 && (
					<span>
						{m.outcome.workItems.done} of {m.outcome.workItems.total} runs done
						{m.outcome.workItems.failed > 0 ? ` · ${m.outcome.workItems.failed} failed` : ''}
					</span>
				)}
			</div>
			<dl className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-3">
				{tiles.map((tile) => (
					<div
						key={tile.id}
						title={tile.title}
						className={`min-w-0 rounded-2xl px-3 py-2 sm:min-w-[7.5rem] ${tile.attention ? 'bg-attention-soft' : 'bg-surface'}`}
						data-testid={`trace-metric-${tile.id}`}
					>
						<dt className="truncate text-[12px] text-text-2">{tile.label}</dt>
						<dd className={`text-[15px] font-bold leading-snug ${tile.attention ? 'text-attention' : 'text-text'}`}>{tile.value}</dd>
						{tile.hint && <dd className="truncate text-[12px] text-text-3">{tile.hint}</dd>}
					</div>
				))}
			</dl>
			<CollapsibleSection className="mt-2" unmountWhenClosed title="Details" summary="Touches, rework, interventions, cost by agent and model" data-testid="trace-metrics-details">
				<dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[auto_1fr]">
					<dt className="text-text-2">Your touches</dt>
					<dd className="text-text">
						answered {m.ownerTouches.answered} · approved {m.ownerTouches.approved} · sent back {m.ownerTouches.sentBack} · corrected {m.ownerTouches.corrected} · manual {m.ownerTouches.manual}
					</dd>
					<dt className="text-text-2">Rework</dt>
					<dd className="text-text">
						send-backs {m.rework.sendBacks} · retries {m.rework.retries} · failed verifications {m.rework.failedVerifications} · subagent send-backs {m.rework.subagentSendBacks}
					</dd>
					<dt className="text-text-2">Crewly stepped in</dt>
					<dd className="text-text">
						nudges {iv.nudges} · redeliveries {iv.redeliveries} · wakes {iv.wakes} · corrections {iv.corrections} · guard blocks {iv.guardBlocks} · misroutes {iv.misroutes}
					</dd>
					<dt className="text-text-2">Time</dt>
					<dd className="text-text">
						working {formatDuration(m.time.activeMs)} · waiting on you {formatDuration(m.time.waitingOwnerMs)} · waiting on agents {formatDuration(m.time.waitingAgentMs)} · idle {formatDuration(m.time.idleMs)}
					</dd>
					<dt className="text-text-2">Stalls</dt>
					<dd className="text-text">
						{m.stalls.count === 0 ? `none longer than ${m.stalls.thresholdMinutes}m` : `${stallCauses} (longer than ${m.stalls.thresholdMinutes}m)`}
					</dd>
					<dt className="text-text-2">By agent</dt>
					<dd className="text-text">{breakdownText(m.usage.byAgent, nameOf)}</dd>
					<dt className="text-text-2">By model</dt>
					<dd className="break-words text-text">{breakdownText(m.usage.byModel, (k) => k)}</dd>
				</dl>
			</CollapsibleSection>
		</section>
	);
};

MetricsStrip.displayName = 'MetricsStrip';
