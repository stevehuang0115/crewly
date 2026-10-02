/**
 * Start the target of a targeted claim that was refused because the target
 * is not running (#929).
 *
 * The orchestrator's delegate-task skill claims the WorkItem it just created
 * on the worker's behalf. When the worker was down (a restart leaves idle
 * agents down), `claimSpecificItem` refused with "agent session not active"
 * and nothing else happened until the reconciler's wake pass, minutes later;
 * on 2026-10-01 the orchestrator restarted Dana by hand instead.
 *
 * The start goes through the normal member-start endpoint with the WorkItem
 * id, so every start gate still applies (the WorkItem is queued for that
 * member, and a dormant team still needs the owner). The claim itself stays
 * refused: the item stays queued and is dispatched once the agent registers.
 *
 * @module services/task-pool/claim-target-waker
 */

import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { AssigneeWaker, AssigneeWakeResult } from '../project-tickets/ticket-assignee-waker.js';

/** What {@link wakeRefusedClaimTarget} needs. */
export interface ClaimTargetWakerDeps {
	/** Current state of a WorkItem. */
	findWorkItem: (id: string) => Promise<Pick<WorkItem, 'id' | 'status' | 'target'> | null>;
	/** Whether the session has a live PTY (or in-process runtime). */
	sessionLive: (sessionName: string) => boolean;
	/** The team and member bound to a session. */
	findMember: (sessionName: string) => Promise<{ team: { id: string }; member: { id: string } } | null>;
	/** Starts the member through the member-start endpoint. */
	wake: AssigneeWaker;
}

/**
 * Start the agent a refused targeted claim was for, when it is simply down.
 *
 * @param input - The refused claim and who made it
 * @param deps - Lookups and the waker
 * @returns The start outcome, or null when no start applies (the item is not
 *   queued for that agent, the agent is running, or it is no team member)
 */
export async function wakeRefusedClaimTarget(
	input: { agentId: string; workItemId: string; callerSession?: string },
	deps: ClaimTargetWakerDeps,
): Promise<AssigneeWakeResult | null> {
	const wi = await deps.findWorkItem(input.workItemId).catch(() => null);
	if (!wi || wi.status !== 'queued' || wi.target !== input.agentId) return null;
	if (deps.sessionLive(input.agentId)) return null;
	const found = await deps.findMember(input.agentId).catch(() => null);
	if (!found) return null;
	return deps.wake({
		teamId: found.team.id,
		memberId: found.member.id,
		session: input.agentId,
		workItemId: wi.id,
		...(input.callerSession ? { callerSession: input.callerSession } : {}),
	});
}
