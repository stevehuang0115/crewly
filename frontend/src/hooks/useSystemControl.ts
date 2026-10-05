/**
 * useSystemControl — state machine behind the Upgrade / Restart panel.
 *
 * Phases:
 * - `loading` → first status read;
 * - `ready` → buttons usable (or disabled with a reason);
 * - `working` → an action is running and the backend still answers
 *   (waiting for idle, installing, shutting down);
 * - `reconnecting` → the backend went away; `/health` is polled until it is
 *   back, then the status is read again;
 * - `done` / `failed` → the new process answered (different `bootId`), or the
 *   action failed before restarting;
 * - `gave-up` → it did not come back within RECONNECT_GIVE_UP_MS;
 * - `shut-down` → the owner shut Crewly down and it stopped answering: final,
 *   no reconnect loop (it is checked now and then in case it was started again).
 *
 * The request's `bootId` is kept in localStorage (best-effort) so a page
 * reload in the middle still ends on "Restarted" instead of a blank panel.
 *
 * @module hooks/useSystemControl
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchUpdateStatus, isBackendUp, skipWindDown, startSystemAction } from '../services/system-control.service';
import {
	PENDING_ACTION_STORAGE_KEY,
	PROGRESS_POLL_MS,
	RECENT_OUTCOME_MS,
	RECONNECT_GIVE_UP_MS,
	SHUTDOWN_RECHECK_MS,
} from '../constants/system-control.constants';
import {
	SystemControlApiError,
	type SystemActionKind,
	type SystemActionRecord,
	type SystemActionWhen,
	type UpdateStatus,
} from '../types/system-control.types';

/** Panel phase. */
export type SystemControlPhase = 'loading' | 'ready' | 'working' | 'reconnecting' | 'done' | 'failed' | 'gave-up' | 'shut-down';

/** What the request is being tracked against. */
interface PendingAction {
	bootId: string;
	kind: SystemActionKind;
	actionId: string;
	startedAt: number;
}

/** Hook result. */
export interface UseSystemControlResult {
	phase: SystemControlPhase;
	status: UpdateStatus | null;
	/** Current / last action */
	action: SystemActionRecord | null;
	/** Kind of the tracked action */
	pendingKind: SystemActionKind | null;
	/** Load or request error */
	error: string | null;
	/** Re-read the status (`refresh` re-asks npm) */
	reload: (refresh?: boolean) => Promise<void>;
	/** Press a button */
	start: (kind: SystemActionKind, when: SystemActionWhen) => Promise<boolean>;
	/** Stop waiting for the agents during a wind-down */
	skip: () => Promise<void>;
	/** Dismiss a done/failed/gave-up result */
	dismiss: () => void;
}

const ACTIVE = new Set(['waiting-idle', 'winding-down', 'installing', 'restarting', 'stopping']);

/**
 * Read the remembered pending action.
 *
 * @returns It, or null
 */
function loadPending(): PendingAction | null {
	try {
		const raw = window.localStorage.getItem(PENDING_ACTION_STORAGE_KEY);
		return raw ? (JSON.parse(raw) as PendingAction) : null;
	} catch {
		return null;
	}
}

/**
 * Remember (or forget) the pending action.
 *
 * @param pending - Action or null
 */
function savePending(pending: PendingAction | null): void {
	try {
		if (pending) window.localStorage.setItem(PENDING_ACTION_STORAGE_KEY, JSON.stringify(pending));
		else window.localStorage.removeItem(PENDING_ACTION_STORAGE_KEY);
	} catch {
		// Private mode / blocked storage: progress just does not survive a reload
	}
}

/**
 * Whether an error means "the backend is not answering" (restart under way).
 *
 * @param error - Thrown value
 * @returns True for network failures and gateway errors
 */
function isUnreachable(error: unknown): boolean {
	return error instanceof SystemControlApiError ? error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504 : true;
}

/**
 * State machine for the Upgrade / Restart panel.
 *
 * @returns State and actions
 */
export function useSystemControl(): UseSystemControlResult {
	const [phase, setPhase] = useState<SystemControlPhase>('loading');
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	const [action, setAction] = useState<SystemActionRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tick, setTick] = useState(0);
	const pendingRef = useRef<PendingAction | null>(null);
	const reconnectSinceRef = useRef<number | null>(null);
	const mountedRef = useRef(true);

	/**
	 * The backend answered from a new process: show the outcome.
	 *
	 * @param next - Fresh status
	 */
	const finish = useCallback((next: UpdateStatus) => {
		setStatus(next);
		setAction(next.action);
		pendingRef.current = null;
		savePending(null);
		reconnectSinceRef.current = null;
		setPhase(next.action && next.action.status !== 'completed' ? 'failed' : 'done');
	}, []);

	/**
	 * Apply a status read while an action is tracked.
	 *
	 * @param next - Fresh status
	 */
	const applyTracked = useCallback(
		(next: UpdateStatus) => {
			const pending = pendingRef.current;
			if (pending && next.bootId !== pending.bootId) {
				finish(next);
				return;
			}
			setStatus(next);
			setAction(next.action);
			reconnectSinceRef.current = null;
			if (next.action && (next.action.status === 'failed' || next.action.status === 'interrupted')) {
				pendingRef.current = null;
				savePending(null);
				setPhase('failed');
				return;
			}
			setPhase('working');
		},
		[finish],
	);

	const reload = useCallback(
		async (refresh = false) => {
			try {
				const next = await fetchUpdateStatus(refresh);
				if (!mountedRef.current) return;
				setError(null);
				const remembered = loadPending();
				if (remembered && remembered.bootId !== next.bootId) {
					pendingRef.current = remembered;
					finish(next);
					return;
				}
				setStatus(next);
				setAction(next.action);
				if (next.action && ACTIVE.has(next.action.status) && next.inProgress) {
					pendingRef.current = remembered ?? {
						bootId: next.bootId,
						kind: next.action.kind,
						actionId: next.action.id,
						startedAt: Date.now(),
					};
					setPhase('working');
					return;
				}
				const settledAt = next.action?.completedAt ? Date.parse(next.action.completedAt) : NaN;
				if (next.action && !ACTIVE.has(next.action.status) && Date.now() - settledAt < RECENT_OUTCOME_MS) {
					setPhase(next.action.status === 'completed' ? 'done' : 'failed');
					return;
				}
				setPhase('ready');
			} catch (err) {
				if (!mountedRef.current) return;
				// Reloaded after the owner shut Crewly down: nothing answers, and that is the outcome.
				if (isUnreachable(err) && loadPending()?.kind === 'shutdown') {
					pendingRef.current = loadPending();
					setPhase('shut-down');
					return;
				}
				setError(err instanceof Error ? err.message : String(err));
				setPhase((p) => (p === 'loading' ? 'ready' : p));
			}
		},
		[finish],
	);

	const start = useCallback(
		async (kind: SystemActionKind, when: SystemActionWhen): Promise<boolean> => {
			setError(null);
			try {
				const accepted = await startSystemAction(kind, when);
				const pending: PendingAction = {
					bootId: status?.bootId ?? '',
					kind,
					actionId: accepted.id,
					startedAt: Date.now(),
				};
				pendingRef.current = pending;
				savePending(pending);
				setAction(accepted);
				setPhase('working');
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				void reload();
				return false;
			}
		},
		[status, reload],
	);

	const skip = useCallback(async (): Promise<void> => {
		try {
			await skipWindDown();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	const dismiss = useCallback(() => {
		pendingRef.current = null;
		savePending(null);
		setError(null);
		setPhase('ready');
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		void reload();
		return () => {
			mountedRef.current = false;
		};
	}, [reload]);

	// Progress polling while working / reconnecting. Each round bumps `tick`
	// so the next round is scheduled even when nothing else changed.
	useEffect(() => {
		if (phase !== 'working' && phase !== 'reconnecting') return undefined;
		let cancelled = false;
		const round = async (): Promise<void> => {
			if (phase === 'working') {
				try {
					const next = await fetchUpdateStatus();
					if (!cancelled) applyTracked(next);
				} catch (err) {
					if (!cancelled && isUnreachable(err)) {
						if (pendingRef.current?.kind === 'shutdown') {
							// Shut down on purpose: it will not come back by itself.
							setPhase('shut-down');
						} else {
							reconnectSinceRef.current = Date.now();
							setPhase('reconnecting');
						}
					}
					// Anything else (e.g. 401): keep polling.
				}
				return;
			}
			const since = reconnectSinceRef.current ?? Date.now();
			if (reconnectSinceRef.current === null) reconnectSinceRef.current = since;
			if (Date.now() - since > RECONNECT_GIVE_UP_MS) {
				setPhase('gave-up');
				return;
			}
			if (await isBackendUp()) {
				try {
					const next = await fetchUpdateStatus();
					if (!cancelled) applyTracked(next);
				} catch {
					// Up but not ready yet
				}
			}
		};
		const timer = setTimeout(() => {
			void round().finally(() => {
				if (!cancelled) setTick((t) => t + 1);
			});
		}, PROGRESS_POLL_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [phase, tick, applyTracked]);

	// After a shutdown: look now and then in case Crewly was started again.
	useEffect(() => {
		if (phase !== 'shut-down') return undefined;
		let cancelled = false;
		const timer = setInterval(() => {
			void isBackendUp().then((up) => {
				if (up && !cancelled) void reload();
			});
		}, SHUTDOWN_RECHECK_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [phase, reload]);

	return {
		phase,
		status,
		action,
		pendingKind: pendingRef.current?.kind ?? action?.kind ?? null,
		error,
		reload,
		start,
		skip,
		dismiss,
	};
}

export default useSystemControl;
