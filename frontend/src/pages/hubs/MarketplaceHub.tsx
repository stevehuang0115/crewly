/**
 * Marketplace (specs/2026-10-02-ui-redesign.md §Marketplace): Browse and
 * Installed (former Settings › Skills), in `?tab=`.
 *
 * Interim container: each tab renders the existing screen unchanged so
 * every old screen stays reachable while the Marketplace redesign is built.
 * The Marketplace page work replaces the panels (and this note).
 *
 * @module pages/hubs/MarketplaceHub
 */
import React from 'react';
import { PageHeader, UnderlineTabs } from '@crewly/ui';
import Marketplace from '../Marketplace';
import { SkillsTab } from '../../components/Settings/SkillsTab';
import { useTabParam } from '../../hooks/useTabParam';
import { MARKETPLACE_TABS, type MarketplaceTab } from '../../constants/routes.constants';

const LABELS: Record<MarketplaceTab, string> = { browse: 'Browse', installed: 'Installed' };

/** Marketplace page with its two tabs. */
export const MarketplaceHub: React.FC = () => {
	const [tab, setTab] = useTabParam(MARKETPLACE_TABS);
	return (
		<div>
			<PageHeader
				title="Marketplace"
				subtitle="Skills, roles and tools for your crew"
				tabs={
					<UnderlineTabs
						aria-label="Marketplace views"
						idPrefix="marketplace"
						value={tab}
						onChange={(v) => setTab(v as MarketplaceTab)}
						tabs={MARKETPLACE_TABS.map((id) => ({ value: id, label: LABELS[id] }))}
					/>
				}
			/>
			<div role="tabpanel" id={`marketplace-panel-${tab}`} aria-labelledby={`marketplace-tab-${tab}`} data-testid={`marketplace-panel-${tab}`}>
				{tab === 'browse' && <Marketplace />}
				{tab === 'installed' && <SkillsTab />}
			</div>
		</div>
	);
};

export default MarketplaceHub;
