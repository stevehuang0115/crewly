/**
 * "Update available" chip for the header / sidebar. Links to the Upgrade
 * controls in Settings → System.
 *
 * @module components/System/UpdateAvailableChip
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpCircle } from 'lucide-react';
import clsx from 'clsx';
import { SYSTEM_SETTINGS_PATH } from '../../constants/system-control.constants';

/** Props for {@link UpdateAvailableChip}. */
export interface UpdateAvailableChipProps {
	/** Latest version on npm */
	latestVersion: string | null;
	/** Called after the link is followed (e.g. close the mobile drawer) */
	onNavigate?: () => void;
	/** Extra classes */
	className?: string;
}

/**
 * Small pill linking to the Upgrade controls.
 *
 * @param props - {@link UpdateAvailableChipProps}
 * @returns The chip
 */
export const UpdateAvailableChip: React.FC<UpdateAvailableChipProps> = ({ latestVersion, onNavigate, className }) => (
	<Link
		to={SYSTEM_SETTINGS_PATH}
		onClick={onNavigate}
		title={latestVersion ? `Crewly ${latestVersion} is available — open the upgrade controls` : 'Open the upgrade controls'}
		className={clsx(
			'inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/20 transition-colors whitespace-nowrap',
			className,
		)}
		data-testid="update-available-chip"
	>
		<ArrowUpCircle className="w-3 h-3" aria-hidden="true" />
		Update available
	</Link>
);

export default UpdateAvailableChip;
