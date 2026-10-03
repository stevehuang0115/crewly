/**
 * Tickets › Experiments: the experiment cards (specs/experiment-cards.md),
 * one compact row each; a row opens the card with its run timeline
 * (specs/2026-10-03-autonomy-metrics.md §UI).
 *
 * @module pages/Experiments
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, RefreshCw } from 'lucide-react';
import { CompactRow, StatusLabel, type StatusTone } from '@crewly/ui';
import { Button } from '@crewly/ui/Button';
import { EmptyState } from '@crewly/ui/EmptyState';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { LINKS } from '../constants/routes.constants';
import { fetchExperiments, type ExperimentCard } from '../services/experiments.service';

/**
 * Status word and tone of a card (the verdict once measured).
 *
 * @param e - Card
 * @returns Label and tone
 */
export function experimentStatus(e: Pick<ExperimentCard, 'status' | 'verdict'>): { label: string; tone: StatusTone } {
	if (e.status === 'done') {
		if (e.verdict === 'worked') return { label: 'Worked', tone: 'success' };
		if (e.verdict === 'didnt') return { label: "Didn't work", tone: 'danger' };
		return { label: 'Inconclusive', tone: 'attention' };
	}
	if (e.status === 'running') return { label: 'Measuring', tone: 'primary' };
	if (e.status === 'cancelled') return { label: 'Cancelled', tone: 'neutral' };
	return { label: 'Not shipped', tone: 'neutral' };
}

/**
 * What a card measures, in a few words.
 *
 * @param e - Card
 * @returns "CE organic clicks" or "gsc clicks · /faq"
 */
export function experimentMetricLabel(e: Pick<ExperimentCard, 'metric'>): string {
	if (e.metric.label) return e.metric.label;
	const filter = e.metric.page ?? e.metric.query ?? e.metric.event;
	return `${e.metric.source.toUpperCase()} ${e.metric.measure}${filter ? ` · ${filter}` : ''}`;
}

/** Experiments list. */
export const Experiments: React.FC = () => {
	const navigate = useNavigate();
	const [cards, setCards] = useState<ExperimentCard[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const list = await fetchExperiments();
			setCards([...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load experiments');
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	if (error) {
		return (
			<div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="experiments-error">
				<p className="text-sm text-danger">{error}</p>
				<Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void load()}>
					Retry
				</Button>
			</div>
		);
	}
	if (!cards) {
		return (
			<div className="flex justify-center py-10" data-testid="experiments-loading">
				<LoadingSpinner />
			</div>
		);
	}
	if (cards.length === 0) {
		return (
			<EmptyState
				icon={FlaskConical}
				title="No experiments yet"
				description="An agent attaches an experiment to a ticket that should move a number; it is measured automatically after the change ships."
				data-testid="experiments-empty"
			/>
		);
	}
	return (
		<ul className="overflow-hidden rounded-2xl bg-surface" data-testid="experiments-list">
			{cards.map((e) => {
				const status = experimentStatus(e);
				const meta = [e.id, experimentMetricLabel(e), e.ticket ? e.ticket.id : null, `${e.windowDays}-day window`].filter(Boolean).join(' · ');
				return (
					<li key={e.id} className="list-none">
						<CompactRow
							primary={e.title}
							meta={meta}
							trailing={<StatusLabel tone={status.tone}>{status.label}</StatusLabel>}
							onClick={() => navigate(LINKS.experiment(e.id))}
							data-testid={`experiment-row-${e.id}`}
						/>
					</li>
				);
			})}
		</ul>
	);
};

export default Experiments;
