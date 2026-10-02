import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStatusBar, runtimeUsageLines } from './AppStatusBar';

vi.mock('../OrchestratorStatusBanner', () => ({ useOrchestratorStatusItem: vi.fn(() => null) }));
vi.mock('../PendingLoginsBanner', () => ({ usePendingLoginsItem: vi.fn(() => null) }));
vi.mock('../UpdateBanner', () => ({ useUpdateStatusItem: vi.fn(() => null) }));
vi.mock('../../services/runtime-fallback.service', () => ({ runtimeFallbackService: { getState: vi.fn() } }));

import { useOrchestratorStatusItem } from '../OrchestratorStatusBanner';
import { usePendingLoginsItem } from '../PendingLoginsBanner';
import { useUpdateStatusItem } from '../UpdateBanner';
import { runtimeFallbackService } from '../../services/runtime-fallback.service';

const baseState = { settings: {} as never, runtimes: [{ runtime: 'claude-code', label: 'Claude Code', selectable: true, exhausted: true }], exhausted: [], overrides: [] };

function renderBar() {
	return render(
		<MemoryRouter>
			<AppStatusBar />
		</MemoryRouter>,
	);
}

describe('AppStatusBar', () => {
	beforeEach(() => {
		vi.mocked(runtimeFallbackService.getState).mockResolvedValue(baseState as never);
		vi.mocked(useOrchestratorStatusItem).mockReturnValue(null);
		vi.mocked(usePendingLoginsItem).mockReturnValue(null);
		vi.mocked(useUpdateStatusItem).mockReturnValue(null);
	});

	it('renders nothing when all is well', async () => {
		const { container } = renderBar();
		await waitFor(() => expect(runtimeFallbackService.getState).toHaveBeenCalled());
		expect(container.querySelector('[data-testid="system-status-bar"]')).toBeNull();
	});

	it('combines the sources into one bar, most severe first', async () => {
		vi.mocked(useUpdateStatusItem).mockReturnValue({ id: 'update', tone: 'primary', title: 'Update Available' });
		vi.mocked(usePendingLoginsItem).mockReturnValue({ id: 'pending-logins', tone: 'attention', title: '1 agent needs you to sign in' });
		vi.mocked(useOrchestratorStatusItem).mockReturnValue({ id: 'orchestrator', tone: 'danger', title: 'Orchestrator Not Running' });
		renderBar();
		expect(screen.getByRole('status')).toHaveTextContent('Orchestrator Not Running');
		expect(screen.getByTestId('system-status-more')).toHaveTextContent('+2 more');
		fireEvent.click(screen.getByTestId('system-status-more'));
		expect(screen.getByTestId('system-status-pending-logins')).toBeInTheDocument();
		expect(screen.getByTestId('system-status-update')).toBeInTheDocument();
	});

	it('shows a runtime that is out of usage, with a link to Runtimes, and can dismiss it', async () => {
		vi.mocked(runtimeFallbackService.getState).mockResolvedValue({
			...baseState,
			exhausted: [{ runtime: 'claude-code', since: '2026-10-02T10:00:00Z', ruleId: 'r', switched: [], switchedTo: [], notified: true }],
			overrides: [{ sessionName: 'a', runtime: 'codex', primary: 'claude-code', reason: 'usage_limit', since: '', badge: '', runtimeLabel: 'Codex', primaryLabel: 'Claude Code' }],
		} as never);
		renderBar();
		expect(await screen.findByText('Claude Code is out of usage')).toBeInTheDocument();
		expect(screen.getByText('1 agent on Codex until then.')).toBeInTheDocument();
		expect(screen.getByTestId('runtime-usage-link')).toHaveAttribute('href', '/settings?tab=runtimes');
		fireEvent.click(screen.getByRole('button', { name: 'Dismiss runtime usage notice' }));
		expect(screen.queryByText('Claude Code is out of usage')).not.toBeInTheDocument();
	});
});

describe('runtimeUsageLines', () => {
	it('matches the Settings › Runtimes wording', () => {
		const lines = runtimeUsageLines({
			runtimes: [{ runtime: 'deepseek', label: 'DeepSeek', selectable: false, exhausted: true }],
			exhausted: [
				{ runtime: 'deepseek', since: 's', ruleId: 'r', switched: [], switchedTo: [], notified: true, noFallback: true },
				{ runtime: 'gemini', since: 's', ruleId: 'r', switched: [], switchedTo: [], notified: true },
			],
			overrides: [],
		});
		expect(lines).toEqual([
			'DeepSeek is out of usage. No fallback runtime is available.',
			'gemini is out of usage. Agents switch when they next get work.',
		]);
	});

	it('says a second Claude Code account is signed out, not out of usage (#942)', () => {
		const lines = runtimeUsageLines({
			runtimes: [{ runtime: 'claude-code@b', label: 'Claude Code (b)', selectable: false, exhausted: true }],
			exhausted: [{ runtime: 'claude-code@b', since: 's', ruleId: 'login_expired', kind: 'login', switched: [], switchedTo: [], notified: true }],
			overrides: [],
		});
		expect(lines).toEqual(['Claude Code (b) is signed out. Agents switch when they next get work.']);
	});
});
