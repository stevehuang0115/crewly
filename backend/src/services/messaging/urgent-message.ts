/**
 * Urgent lead/delegator messages for a busy agent (CREW-844).
 *
 * A hold or a plan change sent to an agent that is mid-turn used to wait in
 * its queue until the turn ended (Nova rendered before "hold" arrived; Vera got
 * a video-5 addendum after shipping). Owner messages already reach a busy agent
 * at its next tool call through the PostToolUse hook; this module lets an
 * URGENT message from someone entitled to redirect the agent take the same
 * path.
 *
 * How it is marked: the sender passes `urgent: true` (`send-message --urgent`
 * on `POST /terminal/:session/write`). The flag is only a request: the server
 * honours it for the orchestrator, the target's team lead (or any ancestor in
 * its team hierarchy), and the agent that delegated one of the target's open
 * WorkItems ({@link isUrgentSender}). Anyone else's flag is ignored and the
 * message queues as usual, so the flag cannot be used to interrupt a colleague.
 *
 * @module services/messaging/urgent-message
 */

import { ORCHESTRATOR_SESSION_NAME, OWNER_HOOK_MESSAGE_CONSTANTS } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { SubAgentMessageQueue, type SurfacedOwnerMessage } from './sub-agent-message-queue.service.js';
import { noteMidTurnDelivery } from '../trace/trace-recorder.js';
import { defaultOverflowWriter, fitKeepingNewest, type OwnerMessageOverflowWriter } from './owner-hook-message.js';

/** WorkItem statuses in which the delegator still stands behind the work. */
const OPEN_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'blocked']);

/** What {@link isUrgentSender} needs to look up. */
export interface UrgentSenderLookups {
	/** The team member behind a session, with its team */
	findMember: (session: string) => Promise<{ team: Team; member: TeamMember } | null>;
	/** The WorkItems targeted at a session (any status) */
	workItemsFor: (session: string) => Promise<ReadonlyArray<Pick<WorkItem, 'status' | 'metadata'>>>;
}

/**
 * Whether `sender` may send an urgent message to `target`: the orchestrator;
 * a team member above the target in its team's hierarchy (its parent, or any
 * ancestor); or the agent that delegated one of the target's open WorkItems.
 * Never the target itself. Lookup failures answer false (the message then
 * queues normally).
 *
 * @param sender - Sending session
 * @param target - Receiving session
 * @param lookups - Team and WorkItem lookups
 * @returns True when the sender's urgent flag is honoured
 */
export async function isUrgentSender(sender: string, target: string, lookups: UrgentSenderLookups): Promise<boolean> {
	if (!sender || !target || sender === target) return false;
	if (sender === ORCHESTRATOR_SESSION_NAME) return true;
	try {
		const [from, to] = await Promise.all([lookups.findMember(sender), lookups.findMember(target)]);
		if (from && to && from.team.id === to.team.id && isAncestor(from.member, to.member, to.team.members ?? [])) return true;
		const items = await lookups.workItemsFor(target);
		return items.some((wi) => OPEN_WORK_ITEM_STATUSES.has(wi.status) && wi.metadata?.['delegatedBy'] === sender);
	} catch {
		return false;
	}
}

/**
 * Whether `above` is a parent or further ancestor of `member` in the team.
 *
 * @param above - The possible lead
 * @param member - The member below
 * @param members - All members of the team
 * @returns True when `above` leads `member`
 */
function isAncestor(above: TeamMember, member: TeamMember, members: ReadonlyArray<TeamMember>): boolean {
	const seen = new Set<string>();
	let parentId = member.parentMemberId;
	while (parentId && !seen.has(parentId)) {
		if (parentId === above.id) return true;
		seen.add(parentId);
		parentId = members.find((m) => m.id === parentId)?.parentMemberId;
	}
	return false;
}

/**
 * The note for one surfaced urgent message (English harness text). The queued
 * text already names the sender and how to reply.
 *
 * @param message - The surfaced message
 * @param maxChars - Ceiling on the note's length
 * @param overflow - Writes a message too long for the note to a file
 * @returns The note
 */
export function buildUrgentHookNote(
	message: SurfacedOwnerMessage,
	maxChars: number = OWNER_HOOK_MESSAGE_CONSTANTS.MAX_CONTEXT_CHARS,
	overflow?: OwnerMessageOverflowWriter,
): string {
	const head = `${OWNER_HOOK_MESSAGE_CONSTANTS.URGENT_TAG} ${OWNER_HOOK_MESSAGE_CONSTANTS.URGENT_NOTE_TEXT}`;
	const sep = '\n\n';
	return `${head}${sep}${fitKeepingNewest(message.data, maxChars - head.length - sep.length, overflow)}`;
}

/**
 * The urgent-message note for an agent's PostToolUse hook, or null. One
 * message at most per call; off with the same kill switch as owner notes.
 *
 * @param sessionName - The agent
 * @param env - Environment (kill switch)
 * @param queue - The message queue
 * @param maxChars - Room for the note
 * @param overflow - Where a message too long for the note is written in full
 * @param noteSurfaced - Records the handed-over text as the agent's latest input
 * @returns The note, or null
 */
export function urgentHookNoteFor(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
	queue: SubAgentMessageQueue = SubAgentMessageQueue.getInstance(),
	maxChars: number = OWNER_HOOK_MESSAGE_CONSTANTS.MAX_CONTEXT_CHARS,
	overflow: OwnerMessageOverflowWriter = defaultOverflowWriter(`${sessionName}-urgent`),
	noteSurfaced: (session: string, text: string) => void = noteMidTurnDelivery,
): string | null {
	const C = OWNER_HOOK_MESSAGE_CONSTANTS;
	if (env[C.KILL_SWITCH_ENV] === C.KILL_SWITCH_OFF_VALUE) return null;
	const message = queue.takeUrgentMessageForHook(sessionName);
	if (!message) return null;
	try {
		noteSurfaced(sessionName, message.data);
	} catch {
		// Bookkeeping only: the note still goes.
	}
	return buildUrgentHookNote(message, maxChars, overflow);
}
