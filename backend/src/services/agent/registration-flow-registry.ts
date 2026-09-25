/**
 * Registration flow registry: at most one live registration/kickoff flow per
 * agent session, bound to the PTY it was started for.
 *
 * Background (2026-09-25 startup-prompt loop): two launchers brought the same
 * agent up at boot. The second one killed the first one's PTY and built a new
 * one under the same session name, but the first one's background
 * registration flow was never cancelled. It kept polling the session by name,
 * found the replacement PTY, and typed its own kickoff into it, so the agent
 * saw two kickoffs in one resumed conversation.
 *
 * A flow is therefore cancelled when:
 * - a newer flow starts for the same session (it supersedes the old one),
 * - the session is killed or recreated ({@link RegistrationFlowRegistry.cancel}), or
 * - the PTY now registered under the session name is not the one the flow was
 *   started for. This catches kills from any code path, including ones that
 *   never call `cancel`.
 *
 * Senders must check {@link RegistrationFlowRegistry.isCancelled} right before
 * every write to the terminal.
 *
 * @module services/agent/registration-flow-registry
 */

/** A live registration flow for one session incarnation. */
export interface RegistrationFlow {
	/** Session name the flow delivers into. */
	readonly sessionName: string;
	/** Monotonic per-session generation; a newer flow has a higher number. */
	readonly generation: number;
	/** Aborted when the flow is superseded, cancelled or its PTY is replaced. */
	readonly signal: AbortSignal;
}

/** Internal record behind a {@link RegistrationFlow}. */
interface FlowRecord<TSession extends object> {
	flow: RegistrationFlow;
	controller: AbortController;
	/** PTY the flow was started for; undefined when the runtime has no PTY. */
	boundSession: TSession | undefined;
}

/** Why a flow was cancelled (logged by the caller). */
export type RegistrationFlowCancelReason =
	| 'superseded'
	| 'session-killed'
	| 'session-replaced'
	| 'runtime-exited';

/**
 * Tracks the single live registration flow per session.
 *
 * @typeParam TSession - Identity object of a live PTY (compared by reference)
 */
export class RegistrationFlowRegistry<TSession extends object = object> {
	private readonly current = new Map<string, FlowRecord<TSession>>();
	private readonly bySignal = new WeakMap<AbortSignal, FlowRecord<TSession>>();
	private readonly generations = new Map<string, number>();

	/**
	 * Start a flow for a session. Any earlier flow for the same session is
	 * aborted first: only the newest incarnation may deliver a kickoff.
	 *
	 * @param sessionName - Session the flow delivers into
	 * @param boundSession - The PTY currently registered under that name (undefined for in-process runtimes)
	 * @returns The new flow and whether an older one was superseded
	 */
	begin(sessionName: string, boundSession: TSession | undefined): { flow: RegistrationFlow; superseded: boolean } {
		const superseded = this.cancel(sessionName, 'superseded');
		const generation = (this.generations.get(sessionName) ?? 0) + 1;
		this.generations.set(sessionName, generation);
		const controller = new AbortController();
		const flow: RegistrationFlow = { sessionName, generation, signal: controller.signal };
		const record: FlowRecord<TSession> = { flow, controller, boundSession };
		this.current.set(sessionName, record);
		this.bySignal.set(controller.signal, record);
		return { flow, superseded };
	}

	/**
	 * Abort the live flow for a session, if any.
	 *
	 * @param sessionName - Session whose flow to abort
	 * @param reason - Why (recorded on the abort signal)
	 * @returns True when a live flow was aborted
	 */
	cancel(sessionName: string, reason: RegistrationFlowCancelReason): boolean {
		const record = this.current.get(sessionName);
		if (!record) return false;
		this.current.delete(sessionName);
		if (!record.controller.signal.aborted) record.controller.abort(reason);
		return true;
	}

	/**
	 * Decide whether a flow may still write to its session. Aborts the flow
	 * (and says so) when the session's PTY has been replaced or removed since
	 * the flow started, or a newer flow took over.
	 *
	 * Signals the registry does not know are judged by `aborted` alone, so
	 * callers can pass any AbortSignal.
	 *
	 * @param signal - The flow's abort signal (undefined = not a guarded flow)
	 * @param currentSession - The PTY registered under the session name right now
	 * @returns True when the flow must not write anything further
	 */
	isCancelled(signal: AbortSignal | undefined, currentSession: TSession | undefined): boolean {
		if (!signal) return false;
		if (signal.aborted) return true;
		const record = this.bySignal.get(signal);
		if (!record) return false;
		const { sessionName } = record.flow;
		if (this.current.get(sessionName) !== record) {
			record.controller.abort('superseded');
			return true;
		}
		if (record.boundSession !== undefined && currentSession !== record.boundSession) {
			this.current.delete(sessionName);
			record.controller.abort('session-replaced');
			return true;
		}
		return false;
	}

	/**
	 * Mark a flow finished. Only removes it while it is still the live flow,
	 * so a finishing old flow can never drop its successor's entry.
	 *
	 * @param flow - The finished flow
	 */
	end(flow: RegistrationFlow): void {
		const record = this.current.get(flow.sessionName);
		if (record && record.flow === flow) this.current.delete(flow.sessionName);
	}

	/**
	 * Whether a session has a live (not yet finished or aborted) flow.
	 *
	 * @param sessionName - Session to check
	 * @returns True when a flow is in progress
	 */
	has(sessionName: string): boolean {
		return this.current.has(sessionName);
	}
}
