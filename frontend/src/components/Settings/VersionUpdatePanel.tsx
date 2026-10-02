/**
 * VersionUpdatePanel — the owner's Upgrade and Restart controls
 * (Settings → System; specs/2026-10-01-upgrade-restart-controls.md).
 *
 * Shows the running version and the latest on npm, how this machine was
 * installed and what brings Crewly back after a restart, then two buttons:
 * **Upgrade to x.y.z** (npm global installs only) and **Restart**, each with
 * a "When idle (recommended) / Now" choice in a confirm dialog. While an
 * action runs it shows progress, keeps going while the backend is away
 * (polling `/health`), and ends on "Restarted" / "Upgraded to x.y.z".
 *
 * Laid out to work on a phone over the LAN: one column, full-width buttons.
 *
 * @module components/Settings/VersionUpdatePanel
 */

import React, { useState } from 'react';
import { ArrowUpCircle, CheckCircle2, GitBranch, Loader2, RefreshCw, RotateCcw, Server } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { StatusLabel } from '@crewly/ui/StatusLabel';
import { CollapsibleSection } from '@crewly/ui/CollapsibleSection';
import { Button } from '@crewly/ui/Button';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Modal, ModalFooter } from '@crewly/ui/Modal';
import { useSystemControl, type SystemControlPhase } from '../../hooks/useSystemControl';
import { INSTALL_KIND_LABELS, WHEN_OPTIONS } from '../../constants/system-control.constants';
import type { SystemActionKind, SystemActionRecord, SystemActionWhen, UpdateStatus } from '../../types/system-control.types';

/**
 * Local time for a timestamp.
 *
 * @param iso - ISO time
 * @returns e.g. "10:42:05"
 */
function formatTime(iso: string | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/**
 * Progress line for a running action.
 *
 * @param phase - Panel phase
 * @param action - Current action
 * @returns Text
 */
export function describeProgress(phase: SystemControlPhase, action: SystemActionRecord | null): string {
	if (phase === 'reconnecting') {
		return action?.kind === 'upgrade'
			? `Crewly is restarting into ${action.toVersion ?? 'the new version'}. This page updates when it is back.`
			: 'Crewly is restarting. This page updates when it is back.';
	}
	if (!action) return 'Working…';
	switch (action.status) {
		case 'waiting-idle':
			return action.waitingFor && action.waitingFor.length > 0
				? `Waiting for ${action.waitingFor.length} agent${action.waitingFor.length === 1 ? '' : 's'} to finish: ${action.waitingFor.join(', ')}`
				: 'Waiting until no agent is mid-turn…';
		case 'installing':
			return `Installing ${action.toVersion ?? 'the new version'}…`;
		case 'restarting':
			return 'Restarting… agents finish their current turn first.';
		default:
			return action.message;
	}
}

/**
 * Outcome line once the new process answers.
 *
 * @param action - Settled action
 * @param status - Fresh status
 * @returns Text
 */
export function describeOutcome(action: SystemActionRecord | null, status: UpdateStatus | null): string {
	const version = status?.currentVersion ?? action?.resultVersion ?? null;
	if (action?.kind === 'upgrade') {
		return `Upgraded to ${version ?? action.toVersion}. Restarted at ${formatTime(action.completedAt ?? status?.startedAt)}.`;
	}
	return `Restarted at ${formatTime(action?.completedAt ?? status?.startedAt)}${version ? ` — running v${version}` : ''}.`;
}

/** Props of the confirm dialog. */
interface ConfirmActionDialogProps {
	kind: SystemActionKind | null;
	status: UpdateStatus | null;
	onCancel: () => void;
	onConfirm: (when: SystemActionWhen) => void;
	submitting: boolean;
}

/**
 * Confirm dialog with the "when" choice.
 *
 * @param props - {@link ConfirmActionDialogProps}
 * @returns Dialog
 */
const ConfirmActionDialog: React.FC<ConfirmActionDialogProps> = ({ kind, status, onCancel, onConfirm, submitting }) => {
	const [when, setWhen] = useState<SystemActionWhen>('idle');
	if (!kind) return null;
	const busy = status?.busyAgents ?? [];
	const title = kind === 'upgrade' ? `Upgrade Crewly to ${status?.latestVersion}?` : 'Restart Crewly?';
	const relaunchNote =
		status?.relaunch === 'replacement'
			? 'Nothing on this machine relaunches Crewly by itself, so it starts a new copy before this one exits.'
			: 'Crewly comes back on its own after it exits.';
	return (
		<Modal isOpen onClose={onCancel} title={title} size="md" data-testid="system-action-dialog">
			<div className="space-y-4">
				<p className="text-sm text-text-2">
					{kind === 'upgrade'
						? `Installs ${status?.latestVersion} from npm, then restarts Crewly (currently ${status?.currentVersion}).`
						: 'Stops Crewly gracefully and starts it again.'}{' '}
					{relaunchNote} Agents that were cut off pick their message up again after the restart.
				</p>
				{busy.length > 0 && (
					<p className="text-sm text-attention" data-testid="system-action-dialog-busy">
						{busy.length} agent{busy.length === 1 ? ' is' : 's are'} mid-turn: {busy.map((b) => b.session).join(', ')}
					</p>
				)}
				<fieldset className="space-y-2">
					<legend className="text-sm font-medium text-text mb-1">When</legend>
					{WHEN_OPTIONS.map((opt) => (
						<label
							key={opt.value}
							className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${
								when === opt.value ? 'border-primary bg-primary/5' : 'border-border-dark hover:bg-background-dark'
							}`}
						>
							<input
								type="radio"
								name="system-action-when"
								value={opt.value}
								checked={when === opt.value}
								onChange={() => setWhen(opt.value)}
								className="mt-1"
								data-testid={`system-action-when-${opt.value}`}
							/>
							<span>
								<span className="block text-sm font-medium text-text">{opt.label}</span>
								<span className="block text-xs text-text-2">{opt.description}</span>
							</span>
						</label>
					))}
				</fieldset>
			</div>
			<ModalFooter>
				<Button variant="secondary" size="sm" onClick={onCancel} disabled={submitting} data-testid="system-action-cancel">
					Cancel
				</Button>
				<Button
					variant={kind === 'upgrade' ? 'primary' : 'warning'}
					size="sm"
					loading={submitting}
					onClick={() => onConfirm(when)}
					data-testid="system-action-confirm"
				>
					{kind === 'upgrade' ? 'Upgrade' : 'Restart'}
				</Button>
			</ModalFooter>
		</Modal>
	);
};

/**
 * Version, update and restart controls.
 *
 * @returns Panel
 */
export const VersionUpdatePanel: React.FC = () => {
	const { phase, status, action, error, reload, start, dismiss } = useSystemControl();
	const [confirmKind, setConfirmKind] = useState<SystemActionKind | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [checking, setChecking] = useState(false);

	const running = phase === 'working' || phase === 'reconnecting';

	const handleConfirm = async (when: SystemActionWhen): Promise<void> => {
		if (!confirmKind) return;
		setSubmitting(true);
		await start(confirmKind, when);
		setSubmitting(false);
		setConfirmKind(null);
	};

	const handleCheck = async (): Promise<void> => {
		setChecking(true);
		await reload(true);
		setChecking(false);
	};

	if (phase === 'loading') {
		return (
			<section data-testid="version-update-panel">
				<div className="flex items-center gap-3 text-sm text-text-2">
					<LoadingSpinner size="sm" /> Loading version info…
				</div>
			</section>
		);
	}

	const isDev = status?.installKind === 'dev-checkout';
	const busy = status?.busyAgents ?? [];

	return (
		<section data-testid="version-update-panel" id="version-and-restart" aria-labelledby="version-and-restart-heading">
			<div className="flex flex-col gap-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 id="version-and-restart-heading" className="text-[15px] font-semibold text-text flex items-center gap-2">
							<Server className="w-4 h-4 shrink-0 text-text-2" aria-hidden="true" /> Version &amp; restart
						</h2>
						<p className="text-[13px] text-text-2 mt-0.5">Upgrade or restart Crewly on this machine.</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						icon={RefreshCw}
						onClick={handleCheck}
						loading={checking}
						disabled={running}
						data-testid="system-check-updates"
					>
						<span className="hidden sm:inline">Check for updates</span>
					</Button>
				</div>

				{status && (
					<dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
						<div>
							<dt className="text-text-2">Running</dt>
							<dd className="flex flex-wrap items-center gap-2 text-text font-medium tabular-nums" data-testid="system-current-version">
								v{status.currentVersion ?? 'unknown'}
								{isDev ? (
									<StatusLabel tone="neutral" size="sm">
										Source checkout
									</StatusLabel>
								) : status.updateAvailable ? (
									<StatusLabel tone="primary" size="sm" data-testid="system-update-badge">
										Update available
									</StatusLabel>
								) : status.latestVersion ? (
									<StatusLabel tone="success" size="sm" data-testid="system-uptodate-badge">
										Up to date
									</StatusLabel>
								) : null}
							</dd>
						</div>
						<div>
							<dt className="text-text-2">On npm</dt>
							<dd className="text-text font-medium tabular-nums" data-testid="system-latest-version">
								{status.latestVersion ? `Latest: ${status.latestVersion}` : 'Latest: unknown'}
							</dd>
						</div>
						<div className="sm:col-span-2">
							<dt className="text-text-2">Agents mid-turn</dt>
							<dd className="text-text" data-testid="system-busy-agents">
								{busy.length === 0 ? 'None' : busy.map((b) => b.session).join(', ')}
							</dd>
						</div>
					</dl>
				)}
				{status && (
					<CollapsibleSection title="Details" summary="How Crewly is installed and what brings it back after a restart" data-testid="system-details">
						<dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
							<div>
								<dt className="text-text-2">Installed as</dt>
								<dd className="text-text break-all">
									{INSTALL_KIND_LABELS[status.installKind]}
									{status.packageRoot && <span className="block text-xs text-text-2">{status.packageRoot}</span>}
								</dd>
							</div>
							<div>
								<dt className="text-text-2">After a restart</dt>
								<dd className="text-text" data-testid="system-supervisor">
									{status.supervisor.detail}
								</dd>
							</div>
						</dl>
					</CollapsibleSection>
				)}

				{error && (
					<Alert variant="error" size="sm" onClose={dismiss} data-testid="system-control-error">
						{error}
					</Alert>
				)}

				{running && (
					<div
						className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm text-text"
						role="status"
						aria-live="polite"
						data-testid="system-progress"
						data-phase={phase}
					>
						<Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin text-primary" />
						<div className="min-w-0">
							<div className="font-medium">
								{phase === 'reconnecting' ? 'Reconnecting…' : action?.kind === 'upgrade' ? `Upgrading to ${action.toVersion}` : 'Restarting'}
							</div>
							<div className="text-text-2 break-words">{describeProgress(phase, action)}</div>
						</div>
					</div>
				)}

				{phase === 'done' && (
					<Alert variant="success" size="sm" icon={CheckCircle2} onClose={dismiss} data-testid="system-done">
						{describeOutcome(action, status)}
					</Alert>
				)}
				{phase === 'failed' && (
					<Alert variant="error" size="sm" onClose={dismiss} data-testid="system-failed">
						{action?.message ?? 'The action did not finish.'}
					</Alert>
				)}
				{phase === 'gave-up' && (
					<Alert variant="warning" size="sm" onClose={dismiss} data-testid="system-gave-up">
						Crewly has not come back after 10 minutes. Check the machine (for example `crewly status`, or the logs in
						~/.crewly/logs).
					</Alert>
				)}

				{status && !running && (
					<div className="flex flex-col sm:flex-row gap-3">
						{isDev ? (
							<Alert variant="info" size="sm" icon={GitBranch} className="flex-1" data-testid="system-dev-checkout">
								{status.upgradeBlockedReason}
							</Alert>
						) : (
							<div className="flex-1 flex flex-col gap-1">
								<Button
									variant="primary"
									icon={ArrowUpCircle}
									fullWidth
									disabled={!status.canUpgrade}
									onClick={() => setConfirmKind('upgrade')}
									data-testid="system-upgrade-button"
								>
									{status.updateAvailable && status.latestVersion ? `Upgrade to ${status.latestVersion}` : 'Upgrade'}
								</Button>
								{!status.canUpgrade && status.upgradeBlockedReason && (
									<span className="text-xs text-text-2" data-testid="system-upgrade-reason">
										{status.upgradeBlockedReason}
									</span>
								)}
							</div>
						)}
						<div className="flex-1 flex flex-col gap-1">
							<Button
								variant="secondary"
								icon={RotateCcw}
								fullWidth
								disabled={!status.canRestart}
								onClick={() => setConfirmKind('restart')}
								data-testid="system-restart-button"
							>
								Restart
							</Button>
							{!status.canRestart && status.restartBlockedReason && (
								<span className="text-xs text-text-2" data-testid="system-restart-reason">
									{status.restartBlockedReason}
								</span>
							)}
						</div>
					</div>
				)}
			</div>

			<ConfirmActionDialog
				key={confirmKind ?? 'closed'}
				kind={confirmKind}
				status={status}
				submitting={submitting}
				onCancel={() => setConfirmKind(null)}
				onConfirm={(when) => void handleConfirm(when)}
			/>
		</section>
	);
};

export default VersionUpdatePanel;
