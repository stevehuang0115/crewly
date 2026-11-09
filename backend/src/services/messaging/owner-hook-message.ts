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

import * as fs from 'fs';
import * as path from 'path';
import { OWNER_HOOK_MESSAGE_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { SubAgentMessageQueue, type SurfacedOwnerMessage } from './sub-agent-message-queue.service.js';
import { noteMidTurnDelivery } from '../trace/trace-recorder.js';

/**
 * Writes an owner message too long for the note to a file, returning its
 * path (null when it could not be written).
 */
export type OwnerMessageOverflowWriter = (fullText: string) => string | null;

/** Options of {@link buildOwnerHookNote}. */
export interface OwnerHookNoteOptions {
	/** Where an owner message too long for the note is written in full */
	overflow?: OwnerMessageOverflowWriter;
}

/**
 * The note for one surfaced owner message (English harness text). The queued
 * text already carries where the message came from and how to reply, as the
 * normal delivery would.
 *
 * @param message - The surfaced message
 * @param maxChars - Ceiling on the note's length
 * @param options - Overflow writer (default: a file under CREWLY_HOME)
 * @returns The note
 */
export function buildOwnerHookNote(
	message: SurfacedOwnerMessage,
	maxChars: number = OWNER_HOOK_MESSAGE_CONSTANTS.MAX_CONTEXT_CHARS,
	options: OwnerHookNoteOptions = {},
): string {
	const C = OWNER_HOOK_MESSAGE_CONSTANTS;
	// Drive mode (specs/2026-10-09-drive-mode-v3.md §4): the owner is listening
	// on the phone; a quick ack now beats a full answer later.
	const drive = /\[Drive mode · session (drv_[A-Za-z0-9_-]+)\]/.exec(message.data)?.[1];
	const head = drive
		? `${C.TAG} The owner is in Drive mode, LISTENING on the phone. Acknowledge NOW, before your next step: ` +
			`reply --drive ${drive} --ack "<one short sentence>". Then carry on, and send the result with reply --drive ${drive} "<conclusion first>" when done.`
		: message.surfaceCount > 1
			? `${C.TAG} Reminder: Crewly handed you this message from the owner a few minutes ago and you have not answered it yet. ` +
				'Answer it now, in the conversation it came from, before your next step of the current work; then carry on.'
			: `${C.TAG} Crewly delivered this message from the owner while you were working. ` +
				'Answer it now, in the conversation it came from, before your next step of the current work; then carry on with that work.';
	const sep = '\n\n';
	const room = maxChars - head.length - sep.length;
	return `${head}${sep}${fitKeepingNewest(message.data, room, options.overflow ?? defaultOverflowWriter('owner-message'))}`;
}

/**
 * Fit a queued owner message into `room` characters. The owner's own text
 * is never cut (message-routing audit 2026-10-18, R0): what gives way is,
 * in order, the reply instructions after the `---` line (down to their
 * start, which holds the reply command) and the older thread context (its
 * newest lines are kept). When the owner's text alone is still too long, it
 * is written in full to a file and the note quotes its start and points to
 * the file.
 *
 * History: the end used to be cut, and a 13.5k-char thread prompt lost its
 * newest posts and the owner's ping (2026-10-08, #content-team). Then the
 * middle was cut, and with long reply instructions the cut took the owner's
 * question just before them: the agent said the message arrived empty
 * (2026-10-18, #awesome-videos, I1–I5).
 *
 * @param data - The queued text
 * @param room - Characters available
 * @param overflow - Writes the full text when the owner's text cannot fit
 * @returns The text, whole or fitted
 */
export function fitKeepingNewest(data: string, room: number, overflow?: OwnerMessageOverflowWriter): string {
	if (data.length <= room) return data;
	const split = data.lastIndexOf(REPLY_TAIL_SEPARATOR);
	const body = split > 0 ? data.slice(0, split) : data;
	const fullTail = split > 0 ? data.slice(split) : '';
	const { lead, context, message } = splitOwnerMessage(body);

	// 1. The reply instructions: at most their share of the room, and less
	//    when the owner's text needs it (never below their opening).
	const minTail = Math.min(fullTail.length, MIN_TAIL_CHARS);
	const fixed = lead.length + message.length;
	const tailRoom = Math.max(minTail, Math.min(Math.floor(room * REPLY_TAIL_SHARE), room - fixed - CONTEXT_CUT_MARKER.length));
	const tail = cutTail(fullTail, tailRoom);

	// 2. The thread context: its newest lines, in whatever room is left.
	const contextRoom = room - fixed - tail.length;
	if (contextRoom >= 0) return `${lead}${fitContext(context, contextRoom)}${message}${tail}`;

	// 3. The owner's text alone does not fit: point to it in full.
	const file = overflow ? safeWrite(overflow, data) : null;
	if (file) {
		const open = `\n[The owner's message is ${message.trim().length} characters, too long to show here. Its start:]\n`;
		const close = `\n[… Read the whole message, with its thread, before you answer: ${file}]\n`;
		// The pointer always fits; the preview and the reply command share the rest.
		const spare = Math.max(0, room - lead.length - open.length - close.length);
		const previewChars = Math.min(OWNER_HOOK_MESSAGE_CONSTANTS.OVERFLOW_PREVIEW_CHARS, Math.max(0, spare - Math.min(fullTail.length, MIN_TAIL_CHARS)));
		const pointer = `${open}${message.trim().slice(0, previewChars)}${close}`;
		return `${lead}${pointer}${cutTail(fullTail, Math.max(0, room - lead.length - pointer.length))}`;
	}
	// No file: the old middle cut, and it says the owner's text was cut.
	return fitBody(data, room);
}

/** Line that opens the reply instructions in a queued chat message */
const REPLY_TAIL_SEPARATOR = '\n---\n';
/** Most of the room the reply instructions may take when the message is cut */
const REPLY_TAIL_SHARE = 0.35;
/** The opening of the reply instructions (the reply command) is kept at least this long */
const MIN_TAIL_CHARS = 400;
/** Said where the reply instructions were cut */
const TAIL_CUT_MARKER = '\n… (rest of the reply instructions cut to fit)';
/** Said where the older thread context was cut */
const CONTEXT_CUT_MARKER = '\n… (older thread lines cut here to fit; the newest ones and the owner\'s message follow in full)\n';
/** Lines that close the thread context; the owner's message follows them */
const CONTEXT_END_RE = /\n\[end of (?:Slack (?:thread|channel context)|context-only messages)[^\n]*\]/g;

/**
 * Split a queued text into its header (where it came from), the thread
 * context, and the owner's own message (after the last context-closing
 * line; the whole text after the header when there is none).
 *
 * @param body - The queued text without its reply instructions
 * @returns The three parts (concatenated, they are `body`)
 */
export function splitOwnerMessage(body: string): { lead: string; context: string; message: string } {
	let contextEnd = -1;
	for (const m of body.matchAll(CONTEXT_END_RE)) contextEnd = (m.index ?? 0) + m[0].length;
	const firstBreak = body.indexOf('\n\n');
	const leadEnd = firstBreak > 0 && (contextEnd < 0 || firstBreak < contextEnd) ? firstBreak : 0;
	if (contextEnd < 0) return { lead: body.slice(0, leadEnd), context: '', message: body.slice(leadEnd) };
	return { lead: body.slice(0, leadEnd), context: body.slice(leadEnd, contextEnd), message: body.slice(contextEnd) };
}

/**
 * The reply instructions within `room`: whole, or their start and a marker.
 *
 * @param tail - Instructions (from the `---` line)
 * @param room - Characters available
 * @returns The fitted instructions
 */
function cutTail(tail: string, room: number): string {
	if (tail.length <= room) return tail;
	return `${tail.slice(0, Math.max(0, room - TAIL_CUT_MARKER.length))}${TAIL_CUT_MARKER}`.slice(0, Math.max(0, room));
}

/**
 * The thread context within `room`: whole, or its newest lines after a marker.
 *
 * @param context - Thread context
 * @param room - Characters available
 * @returns The fitted context
 */
function fitContext(context: string, room: number): string {
	if (context.length <= room) return context;
	if (room <= CONTEXT_CUT_MARKER.length) return '';
	let start = context.length - (room - CONTEXT_CUT_MARKER.length);
	const nl = context.indexOf('\n', start);
	if (nl >= 0 && nl - start < 200 && nl + 1 < context.length) start = nl + 1;
	return `${CONTEXT_CUT_MARKER}${context.slice(start)}`;
}

/**
 * Run an overflow writer, never throwing.
 *
 * @param write - The writer
 * @param text - Full text
 * @returns Its path, or null
 */
function safeWrite(write: OwnerMessageOverflowWriter, text: string): string | null {
	try {
		return write(text);
	} catch {
		return null;
	}
}

/**
 * The default overflow writer: `<CREWLY_HOME>/runtime/owner-messages/<label>-<ts>.md`.
 *
 * @param label - File name prefix (the agent's session)
 * @returns The writer
 */
export function defaultOverflowWriter(label: string): OwnerMessageOverflowWriter {
	return (fullText: string) => {
		const dir = path.join(getCrewlyHomePath(), OWNER_HOOK_MESSAGE_CONSTANTS.OVERFLOW_DIR);
		fs.mkdirSync(dir, { recursive: true });
		const safe = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'owner-message';
		const file = path.join(dir, `${safe}-${Date.now()}.md`);
		fs.writeFileSync(file, fullText, 'utf8');
		return file;
	};
}

/**
 * Last resort when the full text cannot be written: cut the older middle,
 * keeping the first block and the end, and say the owner's text was cut.
 *
 * @param data - The text
 * @param room - Characters available
 * @returns The text, cut in the middle
 */
function fitBody(data: string, room: number): string {
	if (data.length <= room) return data;
	const marker = '\n… (cut here to fit — the owner\'s message may be incomplete; read it in full in its conversation before you answer)\n';
	if (room <= marker.length + 20) return data.slice(data.length - Math.max(0, room));
	const firstBreak = data.indexOf('\n\n');
	const lead = firstBreak > 0 && firstBreak <= Math.floor(room / 4) ? data.slice(0, firstBreak) : '';
	const keep = room - lead.length - marker.length;
	let start = data.length - keep;
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
 * @param maxChars - Room for the note (what the other notes of this hook call leave)
 * @param overflow - Where an owner message too long for the note is written in full
 * @param noteSurfaced - Records the handed-over text as the agent's latest
 *   input (turn-trigger tracker), so a later bare `reply` answers it and not
 *   the input the turn started with (crewly#1381 item 2)
 * @returns The note, or null
 */
export function ownerHookNoteFor(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
	queue: SubAgentMessageQueue = SubAgentMessageQueue.getInstance(),
	maxChars: number = OWNER_HOOK_MESSAGE_CONSTANTS.MAX_CONTEXT_CHARS,
	overflow: OwnerMessageOverflowWriter = defaultOverflowWriter(sessionName),
	noteSurfaced: (session: string, text: string) => void = noteMidTurnDelivery,
): string | null {
	const C = OWNER_HOOK_MESSAGE_CONSTANTS;
	if (env[C.KILL_SWITCH_ENV] === C.KILL_SWITCH_OFF_VALUE) return null;
	const message = queue.takeOwnerMessageForHook(sessionName);
	if (!message) return null;
	try {
		noteSurfaced(sessionName, message.data);
	} catch {
		// Bookkeeping only: the note still goes.
	}
	return buildOwnerHookNote(message, maxChars, { overflow });
}

/**
 * Join the notes for one hook response, in priority order, within the size
 * ceiling. Nothing goes silently (message-routing audit 2026-10-18): a note
 * that does not fit is dropped and the result says how many were, and a
 * first note longer than the ceiling is cut with a marker. Owner notes are
 * built to fit their room ({@link ownerHookNoteFor}'s `maxChars`), so they
 * are never cut here.
 *
 * @param notes - Notes in priority order (nulls skipped)
 * @param maxChars - Ceiling
 * @returns The joined text, or null when there is none
 */
export function joinHookNotes(notes: ReadonlyArray<string | null | undefined>, maxChars: number = OWNER_HOOK_MESSAGE_CONSTANTS.MAX_CONTEXT_CHARS): string | null {
	const present = notes.filter((n): n is string => !!n);
	const reserve = HOOK_NOTE_JOIN_RESERVE;
	let out = '';
	const dropped: string[] = [];
	for (const [i, note] of present.entries()) {
		const last = i === present.length - 1;
		// Keep room for the "dropped" line unless nothing can follow.
		const limit = last && dropped.length === 0 ? maxChars : maxChars - reserve;
		const next = out ? `${out}\n\n${note}` : note;
		if (next.length > limit) {
			if (!out) out = `${note.slice(0, Math.max(0, limit - NOTE_CUT_MARKER.length))}${NOTE_CUT_MARKER}`;
			else dropped.push(note);
			continue;
		}
		out = next;
	}
	if (dropped.length > 0) out = `${out}\n\n${droppedNotice(dropped)}`;
	return out || null;
}

/** Said at the end of a cut note */
const NOTE_CUT_MARKER = '\n… (note cut to fit)';
/** Room kept for the line that names the notes left out */
const DROPPED_NOTICE_ROOM = 200;

/**
 * Room {@link joinHookNotes} keeps after a note that is not the last, for
 * the line naming notes left out. A note built to go first takes at most
 * the ceiling less this.
 */
export const HOOK_NOTE_JOIN_RESERVE = DROPPED_NOTICE_ROOM + 2;

/**
 * The line that says which notes were left out (their openings).
 *
 * @param dropped - Notes left out
 * @returns The line, at most {@link DROPPED_NOTICE_ROOM} characters
 */
function droppedNotice(dropped: string[]): string {
	const n = dropped.length;
	const openings = dropped.map((d) => d.replace(/\s+/g, ' ').trim().slice(0, 60)).join(' | ');
	return `[Left out to fit: ${n} more Crewly note${n === 1 ? '' : 's'} — ${openings}]`.slice(0, DROPPED_NOTICE_ROOM);
}
