/**
 * Owner messages at the next tool boundary.
 *
 * A busy Claude Code agent (the orc, a PA) runs turns of 10–30+ minutes; an
 * owner message sent meanwhile waited in the queue until the turn ended.
 * Claude Code's own queued input is unreliable for this: text typed while
 * tool calls remain is merged after the next tool result and the model may
 * ignore it (crewly#1118 notes). Crewly's agent-status PostToolUse hook can
 * already return `additionalContext`, so the next tool boundary hands the
 * agent the waiting owner message as a clearly framed note.
 *
 * The queue keeps the message until the agent posts in its conversation
 * ({@link SubAgentMessageQueue.takeOwnerMessageForHook}); if the agent does
 * not, the normal idle delivery still sends it.
 *
 * @module services/messaging/owner-hook-message
 */

import { OWNER_HOOK_MESSAGE_CONSTANTS } from '../../constants.js';
import { SubAgentMessageQueue, type SurfacedOwnerMessage } from './sub-agent-message-queue.service.js';

/**
 * The note for one surfaced owner message (English harness text). The queued
 * text already carries where the message came from and how to reply, as the
 * normal delivery would.
 *
 * @param message - The surfaced message
 * @param maxChars - Ceiling on the note's length
 * @returns The note
 */
export function buildOwnerHookNote(message: SurfacedOwnerMessage, maxChars: number = OWNER_HOOK_MESSAGE_CONSTANTS.MAX_CONTEXT_CHARS): string {
	const C = OWNER_HOOK_MESSAGE_CONSTANTS;
	const head =
		message.surfaceCount > 1
			? `${C.TAG} Reminder: Crewly handed you this message from the owner a few minutes ago and you have not answered it yet. ` +
				'Answer it now, in the conversation it came from, before your next step of the current work; then carry on.'
			: `${C.TAG} Crewly delivered this message from the owner while you were working. ` +
				'Answer it now, in the conversation it came from, before your next step of the current work; then carry on with that work.';
	const sep = '\n\n';
	const room = maxChars - head.length - sep.length;
	return `${head}${sep}${fitKeepingNewest(message.data, room)}`;
}

/**
 * Fit a queued message into `room` characters, keeping what the agent needs
 * to act on: its first block (`[CHAT:…]` header — where it came from) and
 * its end (the newest thread lines, the message itself, how to reply). The
 * older middle is cut and the cut is said.
 *
 * The end used to be cut instead. A 13.5k-char thread prompt lost its newest
 * posts and the owner's ping itself, so the agent saw only the thread's old
 * topics and answered something else (2026-10-08, #content-team).
 *
 * @param data - The queued text
 * @param room - Characters available
 * @returns The text, whole or cut in the middle
 */
export function fitKeepingNewest(data: string, room: number): string {
	if (data.length <= room) return data;
	const marker = '\n… (older part cut here to fit; the newest lines, the message itself and how to reply follow; read the full thread in its conversation before you answer)\n';
	if (room <= marker.length + 20) return data.slice(data.length - Math.max(0, room));
	const firstBreak = data.indexOf('\n\n');
	const lead = firstBreak > 0 && firstBreak <= Math.floor(room / 4) ? data.slice(0, firstBreak) : '';
	const keep = room - lead.length - marker.length;
	let start = data.length - keep;
	// Start the kept end on a whole line when one begins soon.
	const nl = data.indexOf('\n', start);
	if (nl >= 0 && nl - start < 200 && nl + 1 < data.length) start = nl + 1;
	return `${lead}${marker}${data.slice(start)}`;
}

/**
 * The owner-message note for an agent's PostToolUse hook, or null. One
 * message at most per call. Off when {@link OWNER_HOOK_MESSAGE_CONSTANTS.KILL_SWITCH_ENV}
 * is `off`.
 *
 * @param sessionName - The agent
 * @param env - Environment (kill switch)
 * @param queue - The message queue
 * @returns The note, or null
 */
export function ownerHookNoteFor(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
	queue: SubAgentMessageQueue = SubAgentMessageQueue.getInstance(),
): string | null {
	const C = OWNER_HOOK_MESSAGE_CONSTANTS;
	if (env[C.KILL_SWITCH_ENV] === C.KILL_SWITCH_OFF_VALUE) return null;
	const message = queue.takeOwnerMessageForHook(sessionName);
	return message ? buildOwnerHookNote(message) : null;
}

/**
 * Join the notes for one hook response, owner message first, within the
 * size ceiling (a later note that does not fit is dropped, not cut).
 *
 * @param notes - Notes in priority order (nulls skipped)
 * @param maxChars - Ceiling
 * @returns The joined text, or null when there is none
 */
export function joinHookNotes(notes: ReadonlyArray<string | null | undefined>, maxChars: number = OWNER_HOOK_MESSAGE_CONSTANTS.MAX_CONTEXT_CHARS): string | null {
	let out = '';
	for (const note of notes) {
		if (!note) continue;
		const next = out ? `${out}\n\n${note}` : note;
		if (next.length > maxChars) {
			if (!out) out = note.slice(0, maxChars);
			continue;
		}
		out = next;
	}
	return out || null;
}
