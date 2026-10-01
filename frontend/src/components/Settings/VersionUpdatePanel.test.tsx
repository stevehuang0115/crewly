/**
 * VersionUpdatePanel tests — every state the owner can see: up to date,
 * update available, source checkout, in progress, reconnecting, done.
 * The API client is mocked; nothing restarts.
 *
 * @module components/Settings/VersionUpdatePanel.test
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/system-control.service', () => ({
	fetchUpdateStatus: vi.fn(),
	startSystemAction: vi.fn(),
	isBackendUp: vi.fn(),
}));

import { VersionUpdatePanel, describeOutcome, describeProgress } from './VersionUpdatePanel';
import { fetchUpdateStatus, isBackendUp, startSystemAction } from '../../services/system-control.service';
import { PENDING_ACTION_STORAGE_KEY, PROGRESS_POLL_MS } from '../../constants/system-control.constants';
import { SystemControlApiError, type SystemActionRecord, type UpdateStatus } from '../../types/system-control.types';

const mockFetchStatus = fetchUpdateStatus as unknown as ReturnType<typeof vi.fn>;
const mockStart = startSystemAction as unknown as ReturnType<typeof vi.fn>;
const mockIsUp = isBackendUp as unknown as ReturnType<typeof vi.fn>;

/**
 * A status body.
 *
 * @param patch - Fields to change
 * @returns Status
 */
function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
	return {
		currentVersion: '1.20.174',
		latestVersion: '1.20.175',
		updateAvailable: true,
		installKind: 'npm-global',
		packageRoot: '/usr/local/lib/node_modules/crewly',
		canUpgrade: true,
		upgradeBlockedReason: null,
		canRestart: true,
		restartBlockedReason: null,
		supervisor: { kind: 'crewly-start', outer: 'systemd', willRelaunch: 'yes', detail: 'crewly start restarts the backend when it exits.' },
		relaunch: 'supervisor',
		busyAgents: [],
		inProgress: false,
		action: null,
		bootId: 'boot-1',
		startedAt: '2026-10-01T10:00:00.000Z',
		...patch,
	};
}

/**
 * An action record.
 *
 * @param patch - Fields to change
 * @returns Record
 */
function action(patch: Partial<SystemActionRecord> = {}): SystemActionRecord {
	return {
		id: 'a1',
		kind: 'restart',
		when: 'idle',
		status: 'waiting-idle',
		requestedBy: 'dashboard from 127.0.0.1',
		requestedAt: '2026-10-01T10:00:00.000Z',
		updatedAt: '2026-10-01T10:00:00.000Z',
		fromVersion: '1.20.174',
		toVersion: null,
		pid: 1,
		relaunch: 'supervisor',
		message: '',
		...patch,
	};
}

describe('VersionUpdatePanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('up to date: shows the version, "Latest", a disabled Upgrade with the reason, and Restart', async () => {
		mockFetchStatus.mockResolvedValue(
			status({ latestVersion: '1.20.174', updateAvailable: false, canUpgrade: false, upgradeBlockedReason: 'Crewly is up to date (1.20.174).' }),
		);
		render(<VersionUpdatePanel />);
		expect(await screen.findByTestId('system-current-version')).toHaveTextContent('v1.20.174');
		expect(screen.getByTestId('system-uptodate-badge')).toHaveTextContent('Up to date');
		expect(screen.getByTestId('system-latest-version')).toHaveTextContent('Latest: 1.20.174');
		expect(screen.getByTestId('system-upgrade-button')).toBeDisabled();
		expect(screen.getByTestId('system-upgrade-reason')).toHaveTextContent('up to date');
		expect(screen.getByTestId('system-restart-button')).toBeEnabled();
	});

	it('update available: "Upgrade to x.y.z" opens a confirm dialog with the when-choice and sends it', async () => {
		mockFetchStatus.mockResolvedValue(status({ busyAgents: [{ session: 'crewly-orc' }] }));
		mockStart.mockResolvedValue(action({ kind: 'upgrade', status: 'waiting-idle', toVersion: '1.20.175' }));
		render(<VersionUpdatePanel />);
		const upgrade = await screen.findByTestId('system-upgrade-button');
		expect(upgrade).toHaveTextContent('Upgrade to 1.20.175');
		expect(screen.getByTestId('system-update-badge')).toHaveTextContent('Update available');

		fireEvent.click(upgrade);
		expect(screen.getByText('Upgrade Crewly to 1.20.175?')).toBeInTheDocument();
		expect(screen.getByTestId('system-action-dialog-busy')).toHaveTextContent('crewly-orc');
		// "When idle" is the default.
		expect(screen.getByTestId('system-action-when-idle')).toBeChecked();
		fireEvent.click(screen.getByTestId('system-action-when-now'));
		fireEvent.click(screen.getByTestId('system-action-confirm'));
		await waitFor(() => expect(mockStart).toHaveBeenCalledWith('upgrade', 'now'));
		expect(await screen.findByTestId('system-progress')).toBeInTheDocument();
	});

	it('cancel closes the dialog without sending anything', async () => {
		mockFetchStatus.mockResolvedValue(status());
		render(<VersionUpdatePanel />);
		fireEvent.click(await screen.findByTestId('system-restart-button'));
		expect(screen.getByText('Restart Crewly?')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('system-action-cancel'));
		expect(screen.queryByText('Restart Crewly?')).not.toBeInTheDocument();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it('source checkout: shows the git message instead of the Upgrade button, Restart still works', async () => {
		const msg = 'This machine runs Crewly from a source checkout — update it with git (git pull, npm run build), then restart.';
		mockFetchStatus.mockResolvedValue(
			status({ installKind: 'dev-checkout', canUpgrade: false, upgradeBlockedReason: msg, packageRoot: '/Users/me/crewly' }),
		);
		render(<VersionUpdatePanel />);
		expect(await screen.findByTestId('system-dev-checkout')).toHaveTextContent('update it with git');
		expect(screen.queryByTestId('system-upgrade-button')).not.toBeInTheDocument();
		expect(screen.getByTestId('system-restart-button')).toBeEnabled();
		expect(screen.getByText('Source checkout', { selector: 'span' })).toBeInTheDocument();
	});

	it('in progress (opened mid-wait): shows who it is waiting for and hides the buttons', async () => {
		mockFetchStatus.mockResolvedValue(
			status({
				inProgress: true,
				canRestart: false,
				canUpgrade: false,
				action: action({ status: 'waiting-idle', waitingFor: ['crewly-orc', 'dev-1'] }),
			}),
		);
		render(<VersionUpdatePanel />);
		const progress = await screen.findByTestId('system-progress');
		expect(progress).toHaveTextContent('Waiting for 2 agents to finish: crewly-orc, dev-1');
		expect(screen.queryByTestId('system-restart-button')).not.toBeInTheDocument();
	});

	it('reconnecting → done: keeps polling /health while the backend is away, then shows "Restarted"', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		mockFetchStatus.mockResolvedValueOnce(status());
		mockStart.mockResolvedValue(action({ status: 'restarting', when: 'now' }));
		render(<VersionUpdatePanel />);
		fireEvent.click(await screen.findByTestId('system-restart-button'));
		fireEvent.click(screen.getByTestId('system-action-confirm'));
		await waitFor(() => expect(mockStart).toHaveBeenCalledWith('restart', 'idle'));
		expect(JSON.parse(window.localStorage.getItem(PENDING_ACTION_STORAGE_KEY) as string)).toMatchObject({ bootId: 'boot-1' });

		// The backend goes away.
		mockFetchStatus.mockRejectedValue(new SystemControlApiError('Network error', 0));
		mockIsUp.mockResolvedValue(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS + 10);
		});
		expect(await screen.findByTestId('system-progress')).toHaveAttribute('data-phase', 'reconnecting');
		expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 3);
		});
		expect(mockIsUp).toHaveBeenCalled();
		expect(screen.getByTestId('system-progress')).toHaveAttribute('data-phase', 'reconnecting');

		// It is back, as a new process.
		mockIsUp.mockResolvedValue(true);
		mockFetchStatus.mockReset();
		mockFetchStatus.mockResolvedValue(
			status({
				bootId: 'boot-2',
				startedAt: '2026-10-01T10:05:00.000Z',
				action: action({ status: 'completed', completedAt: '2026-10-01T10:05:00.000Z', message: 'Restarted at …' }),
			}),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS + 10);
		});
		const done = await screen.findByTestId('system-done');
		expect(done).toHaveTextContent('Restarted at');
		expect(done).toHaveTextContent('running v1.20.174');
		expect(window.localStorage.getItem(PENDING_ACTION_STORAGE_KEY)).toBeNull();
	});

	it('a page reload during the restart still ends on the outcome (remembered bootId)', async () => {
		window.localStorage.setItem(
			PENDING_ACTION_STORAGE_KEY,
			JSON.stringify({ bootId: 'boot-1', kind: 'upgrade', actionId: 'a1', startedAt: Date.now() }),
		);
		mockFetchStatus.mockResolvedValue(
			status({
				bootId: 'boot-2',
				currentVersion: '1.20.175',
				latestVersion: '1.20.175',
				updateAvailable: false,
				action: action({ kind: 'upgrade', status: 'completed', toVersion: '1.20.175', completedAt: new Date().toISOString() }),
			}),
		);
		render(<VersionUpdatePanel />);
		expect(await screen.findByTestId('system-done')).toHaveTextContent('Upgraded to 1.20.175');
	});

	it('shows a refusal from the server (e.g. already in progress)', async () => {
		mockFetchStatus.mockResolvedValue(status());
		mockStart.mockRejectedValue(new SystemControlApiError('A restart is already in progress.', 409, 'in-progress'));
		render(<VersionUpdatePanel />);
		fireEvent.click(await screen.findByTestId('system-restart-button'));
		fireEvent.click(screen.getByTestId('system-action-confirm'));
		expect(await screen.findByTestId('system-control-error')).toHaveTextContent('already in progress');
	});

	it('shows a failed install', async () => {
		mockFetchStatus.mockResolvedValue(
			status({
				action: action({
					kind: 'upgrade',
					status: 'failed',
					message: 'Could not install 1.20.175: npm exited with 1: EACCES.',
					completedAt: new Date().toISOString(),
				}),
			}),
		);
		render(<VersionUpdatePanel />);
		expect(await screen.findByTestId('system-failed')).toHaveTextContent('EACCES');
	});
});

describe('describeProgress / describeOutcome', () => {
	it('describes each running step', () => {
		expect(describeProgress('working', action({ status: 'installing', kind: 'upgrade', toVersion: '1.2.3' }))).toBe('Installing 1.2.3…');
		expect(describeProgress('working', action({ status: 'restarting' }))).toContain('Restarting');
		expect(describeProgress('working', action({ status: 'waiting-idle', waitingFor: ['a'] }))).toBe('Waiting for 1 agent to finish: a');
		expect(describeProgress('reconnecting', action({ kind: 'upgrade', toVersion: '1.2.3' }))).toContain('restarting into 1.2.3');
	});

	it('describes the outcome', () => {
		expect(describeOutcome(action({ kind: 'upgrade', toVersion: '1.2.3', completedAt: '2026-10-01T10:00:00Z' }), status({ currentVersion: '1.2.3' }))).toContain(
			'Upgraded to 1.2.3',
		);
	});
});
