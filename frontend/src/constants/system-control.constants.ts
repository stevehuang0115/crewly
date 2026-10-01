/**
 * Upgrade / Restart controls (specs/2026-10-01-upgrade-restart-controls.md).
 *
 * Endpoints, polling cadence and the English labels the System settings
 * panel shows, kept in one place so components carry no magic values.
 *
 * @module constants/system-control.constants
 */

/** Owner-only status endpoint. */
export const UPDATE_STATUS_ENDPOINT = '/api/system/update-status';

/** Owner-only upgrade endpoint. */
export const UPGRADE_ENDPOINT = '/api/system/upgrade';

/** Owner-only restart endpoint. */
export const RESTART_ENDPOINT = '/api/system/restart';

/** Liveness probe used while the backend is down. */
export const HEALTH_ENDPOINT = '/health';

/** Where the controls live (the "Update available" chip links here). */
export const SYSTEM_SETTINGS_PATH = '/settings?tab=system';

/** Poll interval while an action is running or the backend is restarting (ms). */
export const PROGRESS_POLL_MS = 2000;

/** Request timeout for each poll (ms). */
export const PROGRESS_REQUEST_TIMEOUT_MS = 4000;

/**
 * Give up waiting for the backend to come back after this long (ms). The
 * drain alone can take 2 min and "when idle" waits happen before it goes away.
 */
export const RECONNECT_GIVE_UP_MS = 10 * 60 * 1000;

/** Remembers an in-flight action across a page reload (per browser, best-effort). */
export const PENDING_ACTION_STORAGE_KEY = 'crewly.systemControl.pending';

/** Settled outcomes newer than this are still shown when the page opens (ms). */
export const RECENT_OUTCOME_MS = 15 * 60 * 1000;

/** "When" choices shown in the confirm dialog. */
export const WHEN_OPTIONS = [
	{
		value: 'idle',
		label: 'When idle (recommended)',
		description: 'Waits until no agent is mid-turn (up to 30 minutes), then goes ahead.',
	},
	{
		value: 'now',
		label: 'Now',
		description: 'Starts right away. Agents mid-turn get up to 2 minutes to finish; anything cut off is picked up after the restart.',
	},
] as const;

/** Labels for install kinds. */
export const INSTALL_KIND_LABELS: Record<'npm-global' | 'dev-checkout' | 'other', string> = {
	'npm-global': 'Global npm install',
	'dev-checkout': 'Source checkout',
	other: 'Other install',
};
