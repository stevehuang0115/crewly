/**
 * Marketplace (specs/2026-10-02-ui-redesign.md §Marketplace): Browse,
 * Installed (former Settings › Skills) and Submissions, in `?tab=`.
 *
 * Item details live at `/marketplace/:id` (MarketplaceDetail), which a
 * Browse row opens.
 *
 * @module pages/hubs/MarketplaceHub
 */
import React, { useEffect, useState } from 'react';
import { PageHeader, UnderlineTabs } from '@crewly/ui';
import Marketplace from '../Marketplace';
import { InstalledSkills } from '../../components/Marketplace/InstalledSkills';
import { useTabParam } from '../../hooks/useTabParam';
import { fetchSubmissions } from '../../services/marketplace.service';
import { MARKETPLACE_TABS, type MarketplaceTab } from '../../constants/routes.constants';

const LABELS: Record<MarketplaceTab, string> = { browse: 'Browse', installed: 'Installed', submissions: 'Submissions' };

/** Marketplace page with its three tabs. */
export const MarketplaceHub: React.FC = () => {
	const [tab, setTab] = useTabParam(MARKETPLACE_TABS);
	const [installedCount, setInstalledCount] = useState<number | undefined>(undefined);
	const [pendingCount, setPendingCount] = useState<number | undefined>(undefined);

	// The pending-review pill must show before the Submissions tab is opened.
	useEffect(() => {
		let cancelled = false;
		fetchSubmissions('pending')
			.then((subs) => {
				if (!cancelled) setPendingCount(subs.filter((s) => s.status === 'pending').length);
			})
			.catch(() => {
				// The count is a hint; the tab still works without it.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const count = (id: MarketplaceTab): { count?: number; attention?: boolean } => {
		if (id === 'installed' && installedCount !== undefined) return { count: installedCount };
		if (id === 'submissions' && pendingCount) return { count: pendingCount, attention: true };
		return {};
	};

	return (
		<div className="max-w-5xl">
			<PageHeader
				title="Marketplace"
				subtitle="Browse and install skills, roles, tools and models, and manage the ones you have"
				tabs={
					<UnderlineTabs
						aria-label="Marketplace views"
						idPrefix="marketplace"
						value={tab}
						onChange={(v) => setTab(v as MarketplaceTab)}
						tabs={MARKETPLACE_TABS.map((id) => ({ value: id, label: LABELS[id], ...count(id) }))}
					/>
				}
			/>
			<div role="tabpanel" id={`marketplace-panel-${tab}`} aria-labelledby={`marketplace-tab-${tab}`} data-testid={`marketplace-panel-${tab}`}>
				{tab === 'browse' && <Marketplace view="browse" />}
				{tab === 'installed' && <InstalledSkills onCountChange={setInstalledCount} />}
				{tab === 'submissions' && <Marketplace view="submissions" onPendingCount={setPendingCount} />}
			</div>
		</div>
	);
};

export default MarketplaceHub;
