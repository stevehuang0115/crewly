/**
 * Experiment card page (`/tickets/experiments/:id`): Overview (hypothesis,
 * metric, baseline, result, verdict, the card's own log) and Timeline (the
 * run trace the card belongs to, specs/2026-10-03-autonomy-metrics.md §UI).
 *
 * @module pages/ExperimentDetail
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FlaskConical, RefreshCw } from 'lucide-react';
import { PageHeader, StatusLabel, UnderlineTabs } from '@crewly/ui';
import { Button, IconButton } from '@crewly/ui/Button';
import { EmptyState } from '@crewly/ui/EmptyState';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { DETAIL_TABS, LINKS, type DetailTab } from '../constants/routes.constants';
import { useTabParam } from '../hooks/useTabParam';
import { fetchExperiment, type ExperimentAutopilotScope, type ExperimentCard, type ExperimentProcessSummary } from '../services/experiments.service';
import { formatDuration, formatUsd } from '../components/TraceTimeline/traceFormat';
import { TraceTimeline, formatClock } from '../components/TraceTimeline';
import { experimentMetricLabel, experimentStatus } from './Experiments';

/** Tab labels. */
const LABELS: Record<DetailTab, string> = { overview: 'Overview', timeline: 'Timeline' };

/**
 * A measurement's value.
 *
 * @param m - Baseline or result
 * @returns "1,240 (Sep 20–Oct 3)" or "—"
 */
function measurementText(m: ExperimentCard['baseline']): string {
	if (!m || m.total === null) return '—';
	const value = Number.isInteger(m.total) ? m.total.toLocaleString() : m.total.toFixed(3);
	return `${value} (${m.start} – ${m.end})`;
}

/**
 * A process summary as one line.
 *
 * @param p - Process numbers
 * @returns e.g. "6 shipped · 2 owner touches per ticket · stalls 2h · $1.50 per shipped ticket"
 */
export function processText(p: ExperimentProcessSummary | undefined): string {
	if (!p) return 'Not measured yet';
	return [
		`${p.ticketsShipped} shipped (${p.ticketsStarted} started)`,
		p.ownerTouchesPerTicket === null ? `${p.ownerTouches} owner touches` : `${p.ownerTouchesPerTicket} owner touches per ticket`,
		`stalls ${p.stalls === 0 ? 'none' : formatDuration(p.stallMs)}`,
		p.costPerShippedTicket === null ? `${formatUsd(p.costUsd)} spent` : `${formatUsd(p.costPerShippedTicket)} per shipped ticket`,
	].join(' · ');
}

/** The autopilot part of a card: other outcome metrics and the process before / after. */
const AutopilotScope: React.FC<{ scope: ExperimentAutopilotScope }> = ({ scope }) => (
	<section aria-labelledby="experiment-autopilot-heading" data-testid="experiment-autopilot">
		<h2 id="experiment-autopilot-heading" className="mb-2 text-[15px] font-bold text-text">
			Autopilot: {scope.projectName}
			{scope.label ? ` · ${scope.label}` : ''}
		</h2>
		<dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
			<dt className="text-text-2">Before</dt>
			<dd className="text-text">{processText(scope.processBaseline)}</dd>
			<dt className="text-text-2">During</dt>
			<dd className="text-text">{processText(scope.processResult)}</dd>
			{scope.outcomes.map((o, i) => (
				<React.Fragment key={i}>
					<dt className="text-text-2">{o.metric.label ?? `${o.metric.source} ${o.metric.measure}${o.metric.page ? ` ${o.metric.page}` : ''}`}</dt>
					<dd className="break-words text-text">{o.verdictReason ?? (o.lastError ? `Fetch failed: ${o.lastError}` : `${measurementText(o.baseline)} → ${measurementText(o.result)}`)}</dd>
				</React.Fragment>
			))}
		</dl>
	</section>
);

/** Experiment card page. */
export const ExperimentDetail: React.FC = () => {
	const { id = '' } = useParams<{ id: string }>();
	const [tab, setTab] = useTabParam(DETAIL_TABS);
	const [card, setCard] = useState<ExperimentCard | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setCard(await fetchExperiment(id));
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load the experiment');
		} finally {
			setLoading(false);
		}
	}, [id]);

	useEffect(() => {
		void load();
	}, [load]);

	const breadcrumb = (
		<nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
			<Link to={LINKS.ticketsBoard()} className="text-text-2 hover:text-text">
				Tickets
			</Link>
			<span className="text-text-3">/</span>
			<Link to={LINKS.experiments()} className="text-text-2 hover:text-text" data-testid="experiment-detail-back">
				Experiments
			</Link>
		</nav>
	);

	if (loading && !card) {
		return (
			<div className="flex h-64 items-center justify-center" data-testid="experiment-detail-loading">
				<LoadingSpinner />
			</div>
		);
	}
	if (error || !card) {
		return (
			<div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-4 sm:p-6" data-testid="experiment-detail-error">
				<PageHeader className="mb-0" eyebrow={breadcrumb} title="Experiment" />
				<EmptyState
					icon={FlaskConical}
					title="Experiment not found"
					description={error ?? undefined}
					action={
						<Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void load()}>
							Retry
						</Button>
					}
				/>
			</div>
		);
	}

	const status = experimentStatus(card);
	const traceId = card.traceId.startsWith('tr-') ? card.traceId : null;
	return (
		<div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-4 sm:p-6" data-testid="experiment-detail">
			<PageHeader
				className="mb-0"
				eyebrow={breadcrumb}
				title={card.title}
				subtitle={`${card.id} · ${experimentMetricLabel(card)} · ${card.windowDays}-day window · by ${card.createdBy}`}
				actions={<IconButton icon={RefreshCw} variant="ghost" aria-label="Refresh" onClick={() => void load()} loading={loading} />}
				tabs={
					<UnderlineTabs
						aria-label="Experiment views"
						idPrefix="experiment"
						value={tab}
						onChange={(v) => setTab(v as DetailTab)}
						tabs={DETAIL_TABS.map((t) => ({ value: t, label: LABELS[t] }))}
					/>
				}
			/>
			{tab === 'timeline' ? (
				<div role="tabpanel" id="experiment-panel-timeline" aria-labelledby="experiment-tab-timeline" data-testid="experiment-panel-timeline">
					<TraceTimeline traceId={traceId} refParam="experimentId" refId={card.id} />
				</div>
			) : (
				<div role="tabpanel" id="experiment-panel-overview" aria-labelledby="experiment-tab-overview" className="flex flex-col gap-6" data-testid="experiment-panel-overview">
					<div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-text-2">
						<StatusLabel tone={status.tone}>{status.label}</StatusLabel>
						{card.ticket && <span>Ticket {card.ticket.id}</span>}
						{card.dueAt && card.status === 'running' && <span>Measured after {card.dueAt.slice(0, 10)}</span>}
					</div>
					<section aria-labelledby="experiment-hypothesis-heading">
						<h2 id="experiment-hypothesis-heading" className="mb-2 text-[15px] font-bold text-text">
							Hypothesis
						</h2>
						<p className="whitespace-pre-wrap text-sm leading-relaxed text-text">{card.hypothesis}</p>
					</section>
					<dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm" data-testid="experiment-results">
						<dt className="text-text-2">Baseline</dt>
						<dd className="text-text">{measurementText(card.baseline)}</dd>
						<dt className="text-text-2">Result</dt>
						<dd className="text-text">{measurementText(card.result)}</dd>
						<dt className="text-text-2">Verdict</dt>
						<dd className="text-text">{card.verdict ? `${status.label}${card.verdictReason ? ` — ${card.verdictReason}` : ''}` : 'Not measured yet'}</dd>
						{card.lastError && (
							<>
								<dt className="text-text-2">Last error</dt>
								<dd className="break-words text-danger">{card.lastError}</dd>
							</>
						)}
					</dl>
					{card.autopilot && <AutopilotScope scope={card.autopilot} />}
					<section aria-labelledby="experiment-log-heading">
						<h2 id="experiment-log-heading" className="mb-2 text-[15px] font-bold text-text">
							Card log
						</h2>
						<ol className="flex flex-col gap-1.5 text-[13px]" data-testid="experiment-card-log">
							{[...card.timeline].reverse().map((entry, i) => (
								<li key={`${entry.at}-${i}`} className="flex gap-3">
									<span className="w-28 shrink-0 text-text-3">{formatClock(entry.at)}</span>
									<span className="min-w-0 break-words text-text">
										<span className="font-semibold">{entry.event.replace(/_/g, ' ')}</span>
										{entry.detail ? <span className="text-text-2"> — {entry.detail}</span> : null}
									</span>
								</li>
							))}
						</ol>
					</section>
				</div>
			)}
		</div>
	);
};

ExperimentDetail.displayName = 'ExperimentDetail';

export default ExperimentDetail;
