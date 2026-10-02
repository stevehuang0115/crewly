/**
 * AppStatusBar — the app's one system status line (specs/2026-10-02-ui-redesign.md
 * §SystemStatusBar). Replaces the separate stacked banners: it shows only
 * when something is wrong, the most severe item first, the rest behind
 * "+N more". Each source keeps its own wording, actions and dismiss:
 *
 * - orchestrator down / starting   (`useOrchestratorStatusItem`)
 * - an agent needs a sign-in       (`usePendingLoginsItem`, with the per-session chips)
 * - a runtime is out of usage      (`useRuntimeUsageItem`, below)
 * - a Crewly update is available   (`useUpdateStatusItem`)
 *
 * @module components/Layout/AppStatusBar
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import { SystemStatusBar, type SystemStatusItem } from '@crewly/ui';
import { useOrchestratorStatusItem } from '../OrchestratorStatusBanner';
import { usePendingLoginsItem } from '../PendingLoginsBanner';
import { useUpdateStatusItem } from '../UpdateBanner';
import { runtimeFallbackService, type RuntimeFallbackState } from '../../services/runtime-fallback.service';
import { exhaustedPhrase, formatResetTime } from '../Settings/RuntimeFallbackPanel';
import { LINKS } from '../../constants/routes.constants';

/** How often the runtime-usage state is re-read (ms). */
export const RUNTIME_USAGE_POLL_MS = 60_000;

/**
 * One sentence per exhausted runtime — same wording as Settings › Runtimes.
 *
 * @param state - Runtime fallback state
 * @returns Lines, one per runtime out of usage
 */
export function runtimeUsageLines(state: Pick<RuntimeFallbackState, 'exhausted' | 'overrides' | 'runtimes'>): string[] {
	const labelOf = (runtime: string): string => state.runtimes.find((r) => r.runtime === runtime)?.label ?? runtime;
	return state.exhausted.map((e) => {
		const on = state.overrides.filter((o) => o.primary === e.runtime);
		const head = `${labelOf(e.runtime)} ${exhaustedPhrase(e)}${e.until ? ` (resets ~${formatResetTime(e.until)})` : ''}.`;
		const tail =
			on.length > 0
				? `${on.length} agent${on.length === 1 ? '' : 's'} on ${[...new Set(on.map((o) => o.runtimeLabel))].join(' / ')} until then.`
				: e.noFallback
					? 'No fallback runtime is available.'
					: 'Agents switch when they next get work.';
		return `${head} ${tail}`;
	});
}

/**
 * The "runtime out of usage" item, or null when every runtime has usage
 * left (or the set shown was dismissed — it comes back when it changes).
 *
 * @param pollMs - Refresh interval
 * @returns Item for `SystemStatusBar`
 */
export function useRuntimeUsageItem(pollMs: number = RUNTIME_USAGE_POLL_MS): SystemStatusItem | null {
	const [state, setState] = useState<RuntimeFallbackState | null>(null);
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const next = await runtimeFallbackService.getState();
				if (!cancelled) setState(next);
			} catch {
				/* non-critical: keep the last known state */
			}
		};
		void load();
		const timer = setInterval(() => void load(), pollMs);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [pollMs]);

	const exhausted = state?.exhausted ?? [];
	const key = useMemo(() => exhausted.map((e) => `${e.runtime}|${e.since}`).sort().join(';'), [exhausted]);
	if (!state || exhausted.length === 0 || dismissedKey === key) return null;

	const lines = runtimeUsageLines(state);
	const labelOf = (runtime: string): string => state.runtimes.find((r) => r.runtime === runtime)?.label ?? runtime;
	return {
		id: 'runtime-usage',
		tone: 'attention',
		icon: Gauge,
		title: exhausted.length === 1 ? `${labelOf(exhausted[0].runtime)} ${exhaustedPhrase(exhausted[0])}` : `${exhausted.length} runtimes are out of usage`,
		// One runtime: the title already names it, so the message starts at the reset time / what happens next.
		message: exhausted.length === 1 ? lines[0].replace(`${labelOf(exhausted[0].runtime)} ${exhaustedPhrase(exhausted[0])}`, '').replace(/^\.\s*/, '').trim() : lines.join(' '),
		actions: (
			<Link to={LINKS.settingsTab('runtimes')} className="px-2 text-[13px] font-semibold text-primary-text hover:underline" data-testid="runtime-usage-link">
				Runtimes
			</Link>
		),
		onDismiss: () => setDismissedKey(key),
		dismissLabel: 'Dismiss runtime usage notice',
	};
}

/**
 * The system status bar for the app shell.
 *
 * @returns The bar, or nothing when all is well
 */
export const AppStatusBar: React.FC = () => {
	const orchestrator = useOrchestratorStatusItem();
	const logins = usePendingLoginsItem();
	const usage = useRuntimeUsageItem();
	const update = useUpdateStatusItem();
	const items = [orchestrator, logins, usage, update].filter((i): i is SystemStatusItem => i !== null);
	return <SystemStatusBar items={items} />;
};

export default AppStatusBar;
