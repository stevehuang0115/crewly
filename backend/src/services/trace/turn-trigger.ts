/**
 * What started an agent's turn — the "trigger" of everything it posts from
 * that turn (agent-provenance audit 2026-10-14).
 *
 * The harness writes every prompt into a turn (terminal `/write` and
 * `/deliver`, `sendMessageToAgent`). Each delivery is classified here into a
 * finer kind than {@link classifyDelivery} (which lumps restarts, reminders,
 * app changes and agent-to-agent messages into `system`), with the sending
 * agent when another agent wrote it. The last trigger of each session is kept
 * in memory, so a reply posted from that turn can say why it exists.
 *
 * Agent-to-agent sends are noted when the sender's request arrives
 * ({@link TurnTriggerTracker.noteSender}) and matched to the delivery by text,
 * so a message queued while the target was busy keeps its sender.
 *
 * @module services/trace/turn-trigger
 */

import { TURN_TRIGGER_CONSTANTS } from '../../constants.js';
import { parseInboundOrigin } from '../orc/orc-reply-route.service.js';
import { parseAgentMessageSender } from '../messaging/agent-message-envelope.js';
import { parseRouteToken, type MessageRoute } from '../orc/message-route.js';

const C = TURN_TRIGGER_CONSTANTS;

/** Fine-grained kinds of what started a turn. */
export const TURN_TRIGGER_KINDS = [
	'owner_message',
	'agent_message',
	'delegated_result',
	'dispatch',
	'redelivery',
	'follow_up',
	'owner_report_due',
	'follow_through',
	'stale_item',
	'decision',
	'restart',
	'scheduled',
	'app_change',
	'status',
	'system',
] as const;

/** What started a turn. */
export type TurnTriggerKind = (typeof TURN_TRIGGER_KINDS)[number];

/** A classified delivery. */
export interface ClassifiedTrigger {
	triggerKind: TurnTriggerKind;
	/** Work item the prompt names (`[CREWLY-DISPATCH] WorkItem <id>`, task recovery) */
	workItemId?: string;
	/** Ticket or decision label the prompt names (`TKT-12`, `D-4`) */
	ticket?: string;
	/** Chat conversation of an owner message (`[CHAT:<id>]`) */
	conversationId?: string;
	/** Slack thread key of an owner message (`[SLACK-THREAD:<key>]`), when it names one */
	thread?: string;
	/**
	 * The destination the message carries (message-route.ts): the route token
	 * of an agent message or a delegated result. The answer to the whole
	 * chain goes there.
	 */
	route?: MessageRoute;
	/** Sending agent named by the text itself (`[RESULT] From <session>`) */
	textSender?: string;
}

/** The trigger of a session's current turn. */
export interface TurnTrigger extends ClassifiedTrigger {
	/** Agent session that sent it, for `agent_message` */
	sender?: string;
	/** Run trace the delivery joined, if any */
	traceId?: string;
	/**
	 * What started the chain: the trigger kind of the first hop. For an
	 * agent message, the sender's own trigger kind (and so on up the chain).
	 */
	rootKind: TurnTriggerKind;
	/** The root's reference: conversation, work item or ticket id */
	rootRef?: string;
	/** Agents the request passed through before this one, oldest first */
	viaAgents: string[];
	/** When it was delivered (epoch ms) */
	at: number;
}

/** Provenance record stored on a chat row (`metadata.triggeredBy`). */
export interface TriggeredByMetadata {
	traceId?: string;
	rootKind: TurnTriggerKind;
	rootRef?: string;
	triggerKind: TurnTriggerKind;
	viaAgents: string[];
	/** The rendered line, without the markdown wrapper (empty when not shown) */
	label?: string;
}

/** Restart notice that wraps the interrupted message (SAFE_RESTART constants). */
const RESTART_RE = /^\s*Crewly restarted while you were working on\b/;
/** Header in a restart notice before the original message. */
const RESTART_ORIGINAL_RE = /\nThe message you were handling:\n([\s\S]*)$/;

/**
 * Classify a delivered prompt.
 *
 * @param text - Exactly what was written into the turn
 * @returns The trigger kind and the ids the prompt names
 */
export function classifyTurnTrigger(text: string): ClassifiedTrigger {
	const t = typeof text === 'string' ? text : '';
	if (RESTART_RE.test(t) || /^\s*\[SYSTEM — TASK RECOVERY\]|\[RESTART_DRAIN\]|^\s*\[CHAT_RESUME\]/.test(t)) {
		// A restart that re-delivers an owner message is still that message.
		const original = RESTART_ORIGINAL_RE.exec(t)?.[1];
		if (original) {
			const inner = classifyTurnTrigger(original);
			if (inner.triggerKind === 'owner_message' || inner.triggerKind === 'agent_message') return inner;
		}
		return { triggerKind: 'restart', ...workItemOf(t) };
	}
	// Another agent's message opens with its sender header (crewly#1375),
	// and names the route it carries (message-routing audit 2026-10-18).
	if (parseAgentMessageSender(t)) {
		const route = parseRouteToken(firstLine(t));
		return { triggerKind: 'agent_message', ...(route ? { route } : {}) };
	}
	// A delegate's result for work this agent handed out: it names the work
	// item and the route the delegator was answering when it delegated.
	const result = RESULT_RE.exec(t);
	if (result) {
		const route = parseRouteToken(firstLine(t));
		const about = /about WorkItem ([A-Za-z0-9_-]{6,})/.exec(firstLine(t))?.[1];
		return { triggerKind: 'delegated_result', textSender: result[1], ...(about ? { workItemId: about } : {}), ...(route ? { route } : {}) };
	}
	// An owner's chat message opens with its routing prefix; checked before
	// the harness tags, which the owner's own text may quote.
	const chat = parseInboundOrigin(t);
	if (chat) return { triggerKind: 'owner_message', conversationId: chat.conversationId, ...(chat.slackThreadKey ? { thread: chat.slackThreadKey } : {}) };
	if (/^\s*\[(?:OWNER MESSAGE\]|SLACK[A-Z_-]*[:\]]|REMOTE:)/.test(t)) return { triggerKind: 'owner_message' };
	if (/\[TASK RE-DELIVERY\]|\[CREWLY-DISPATCH\] \d+ WorkItems? (?:is|are) still queued/.test(t)) return { triggerKind: 'redelivery', ...workItemOf(t) };
	if (/\[TRIGGER WAKE\]|\[SCHEDULED\]|\[SCHEDULED CHECK-IN/.test(t)) return { triggerKind: 'scheduled', ...workItemOf(t) };
	// A hand-off moves running work (and its origin) to this agent.
	if (/\[CREWLY-DISPATCH\]|\[TASK ASSIGNMENT\]|^\s*\[TASK\]|^\s*\[TASK HANDOFF\]/.test(t)) return { triggerKind: 'dispatch', ...workItemOf(t) };
	const followUp = /\[FOLLOW-UP\s+([A-Z][A-Z0-9]*-\d+)?/.exec(t);
	if (followUp) return { triggerKind: 'follow_up', ...(followUp[1] ? { ticket: followUp[1] } : {}) };
	if (/\[OWNER REPORT DUE\b/.test(t)) return { triggerKind: 'owner_report_due', ...workItemOf(t) };
	if (/\[FOLLOW-THROUGH\b/.test(t)) return { triggerKind: 'follow_through' };
	if (/\[STALE ITEM\]/.test(t)) return { triggerKind: 'stale_item' };
	const decision = /\[DECISIONS?\s*(D-\d+)?/.exec(t);
	if (decision) return { triggerKind: 'decision', ...(decision[1] ? { ticket: decision[1] } : {}) };
	if (/\[APP CHANGES\]/.test(t)) return { triggerKind: 'app_change' };
	if (/Agent status:|Status from \S+ \(reports to you\)|\[STATUS DIGEST\]|\[STATUS REPORT\]/.test(t)) return { triggerKind: 'status' };
	return { triggerKind: 'system' };
}

/**
 * The work item a prompt names.
 *
 * @param text - Prompt text
 * @returns `{ workItemId }` or nothing
 */
function workItemOf(text: string): { workItemId?: string } {
	const m = /WorkItem(?: ID)?:?\s+([A-Za-z0-9_-]{6,})/.exec(text);
	return m ? { workItemId: m[1] } : {};
}

/** `[RESULT] From <session>` — a delegate's result relayed to its delegator. */
const RESULT_RE = /^\s*\[RESULT\] From ([a-z0-9][a-z0-9_-]*)/;

/** The first line of a text (where harness headers live). */
function firstLine(text: string): string {
	const nl = text.indexOf('\n');
	return nl < 0 ? text : text.slice(0, nl);
}

/**
 * Trigger kinds that name what the agent is answering. A reminder, a status
 * digest or a system notice arriving later does not change what a bare
 * reply answers (message-routing audit 2026-10-18).
 */
const ROUTED_KINDS: ReadonlySet<TurnTriggerKind> = new Set<TurnTriggerKind>(['owner_message', 'agent_message', 'delegated_result', 'dispatch', 'scheduled']);

/** Recognisable start of a text (whitespace collapsed). */
function fingerprint(text: string): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, C.SENDER_MATCH_CHARS);
}

/** An agent-to-agent send waiting for its delivery. */
interface PendingSend {
	sender: string;
	key: string;
	at: number;
}

/**
 * Last trigger of each session. Singleton (see {@link getTurnTriggerTracker}).
 */
export class TurnTriggerTracker {
	private readonly current = new Map<string, TurnTrigger>();
	/** Per session: the latest trigger that names what the agent answers ({@link ROUTED_KINDS}) */
	private readonly routed = new Map<string, TurnTrigger>();
	private readonly sends = new Map<string, PendingSend[]>();
	/** Per session: conversation id → when the owner last wrote to it there */
	private readonly ownerAsks = new Map<string, Map<string, number>>();
	/** Per session: its routed agent message that it already answered with send-message (crewly#1381) */
	private readonly answered = new Map<string, TurnTrigger>();

	/**
	 * Note that `sender` asked to write `text` to `target` (the terminal write
	 * route, before delivery or queueing).
	 *
	 * @param target - Receiving session
	 * @param text - Message text
	 * @param sender - Sending agent session
	 * @param now - Clock (epoch ms)
	 */
	noteSender(target: string, text: string, sender: string, now: number = Date.now()): void {
		if (!target || !sender || sender === target || typeof text !== 'string') return;
		if (!C.AGENT_SESSION_PATTERN.test(sender)) return;
		const key = fingerprint(text);
		if (!key) return;
		const list = (this.sends.get(target) ?? []).filter((s) => now - s.at < C.SENDER_MATCH_MS);
		list.push({ sender, key, at: now });
		this.sends.set(target, list.slice(-C.MAX_SENDERS_PER_TARGET));
	}

	/**
	 * Record what started `session`'s turn.
	 *
	 * @param session - Agent session written to
	 * @param text - Exactly what was delivered
	 * @param opts - Trace the delivery joined; sender when the caller knows it
	 * @param now - Clock (epoch ms)
	 * @returns The recorded trigger
	 */
	noteDelivery(session: string, text: string, opts: { traceId?: string | null; sender?: string | null } = {}, now: number = Date.now()): TurnTrigger {
		const classified = classifyTurnTrigger(text);
		const { textSender, ...rest } = classified;
		// The sender header names it even when the send was not noted here (crewly#1375).
		const sender = opts.sender || this.takeSender(session, text, now) || parseAgentMessageSender(text) || textSender;
		const base: ClassifiedTrigger = sender && (rest.triggerKind === 'system' || rest.triggerKind === 'status')
			? { triggerKind: 'agent_message' }
			: rest;
		let trigger: TurnTrigger;
		if ((base.triggerKind === 'agent_message' || base.triggerKind === 'delegated_result') && sender) {
			// The sender's turn names the root only while it is recent (an old turn is likely unrelated).
			const latest = this.trigger(sender, now);
			const up = latest && now - latest.at <= C.CHAIN_LINK_MS ? latest : null;
			const via = [...(up?.viaAgents ?? []), sender].filter((s, i, a) => a.indexOf(s) === i).slice(-C.MAX_VIA_AGENTS);
			trigger = {
				...base,
				sender,
				rootKind: up ? up.rootKind : 'agent_message',
				...(up?.rootRef ? { rootRef: up.rootRef } : {}),
				viaAgents: via,
				at: now,
			};
		} else {
			const rootRef = base.conversationId ?? base.workItemId ?? base.ticket;
			trigger = { ...base, rootKind: base.triggerKind, ...(rootRef ? { rootRef } : {}), viaAgents: [], at: now };
		}
		if (opts.traceId) trigger.traceId = opts.traceId;
		if (session) this.current.set(session, trigger);
		if (session && ROUTED_KINDS.has(trigger.triggerKind)) this.routed.set(session, trigger);
		if (session && trigger.triggerKind === 'owner_message' && trigger.conversationId) {
			const asks = this.ownerAsks.get(session) ?? new Map<string, number>();
			asks.set(trigger.conversationId, now);
			this.ownerAsks.set(session, asks);
		}
		return trigger;
	}

	/**
	 * Whether the owner wrote to `session` in `conversationId` recently — a
	 * post there is then an answer to the owner, whatever came in since (a
	 * reminder delivered mid-turn must not relabel it).
	 *
	 * @param session - Agent session
	 * @param conversationId - Conversation posted to
	 * @param now - Clock (epoch ms)
	 * @returns True within {@link TURN_TRIGGER_CONSTANTS.OWNER_ANSWER_WINDOW_MS}
	 */
	ownerAskedRecently(session: string, conversationId: string, now: number = Date.now()): boolean {
		const at = this.ownerAsks.get(session)?.get(conversationId);
		return at !== undefined && now - at <= C.OWNER_ANSWER_WINDOW_MS;
	}

	/**
	 * Whether the owner wrote to `session` in `conversationId` within `windowMs`.
	 *
	 * @param session - Agent session
	 * @param conversationId - Conversation
	 * @param windowMs - How far back
	 * @param now - Clock (epoch ms)
	 * @returns True when the owner asked there within the window
	 */
	ownerAskedWithin(session: string, conversationId: string, windowMs: number, now: number = Date.now()): boolean {
		const at = this.ownerAsks.get(session)?.get(conversationId);
		return at !== undefined && now - at <= windowMs;
	}

	/**
	 * The latest trigger of `session` that names what it is answering (an
	 * owner message, an agent message, a delegated result, a dispatch), while
	 * fresh. Reminders and notices delivered since do not replace it.
	 *
	 * @param session - Agent session
	 * @param now - Clock (epoch ms)
	 * @returns The trigger, or null
	 */
	routedTrigger(session: string, now: number = Date.now()): TurnTrigger | null {
		const t = session ? this.routed.get(session) : undefined;
		if (!t) return null;
		if (now - t.at > C.FRESH_MS) {
			this.routed.delete(session);
			return null;
		}
		return t;
	}

	/**
	 * `session` wrote to `recipient` (send-message / deliver). When its routed
	 * input is `recipient`'s agent message, that message is answered: a later
	 * bare `reply` no longer goes back to `recipient` (crewly#1381 item 3).
	 * The route it carried still travels with the agent's messages
	 * ({@link routedTrigger} is unchanged).
	 *
	 * @param session - Agent that wrote
	 * @param recipient - Agent it wrote to
	 * @param now - Clock (epoch ms)
	 */
	noteAnsweredAgent(session: string, recipient: string, now: number = Date.now()): void {
		if (!session || !recipient || session === recipient) return;
		const t = this.routedTrigger(session, now);
		if (t?.triggerKind === 'agent_message' && t.sender === recipient) this.answered.set(session, t);
	}

	/**
	 * {@link routedTrigger}, unless it is an agent message the session already
	 * answered with send-message ({@link noteAnsweredAgent}): what a bare
	 * `reply` still answers.
	 *
	 * @param session - Agent session
	 * @param now - Clock (epoch ms)
	 * @returns The trigger, or null
	 */
	openRoutedTrigger(session: string, now: number = Date.now()): TurnTrigger | null {
		const t = this.routedTrigger(session, now);
		if (!t) {
			this.answered.delete(session);
			return null;
		}
		return this.answered.get(session) === t ? null : t;
	}

	/**
	 * The trigger of `session`'s current turn, while fresh.
	 *
	 * @param session - Agent session
	 * @param now - Clock (epoch ms)
	 * @returns The trigger, or null
	 */
	trigger(session: string, now: number = Date.now()): TurnTrigger | null {
		const t = session ? this.current.get(session) : undefined;
		if (!t) return null;
		if (now - t.at > C.FRESH_MS) {
			this.current.delete(session);
			return null;
		}
		return t;
	}

	/** Forget everything (tests). */
	reset(): void {
		this.current.clear();
		this.routed.clear();
		this.sends.clear();
		this.ownerAsks.clear();
		this.answered.clear();
	}

	/**
	 * The sender of a noted send whose text the delivery contains (consumed).
	 *
	 * @param target - Receiving session
	 * @param text - Delivered text
	 * @param now - Clock
	 * @returns Sender session, or undefined
	 */
	private takeSender(target: string, text: string, now: number): string | undefined {
		const list = this.sends.get(target);
		if (!list?.length) return undefined;
		const whole = text.replace(/\s+/g, ' ');
		for (let i = list.length - 1; i >= 0; i--) {
			const s = list[i];
			if (now - s.at >= C.SENDER_MATCH_MS) continue;
			if (whole.includes(s.key)) {
				list.splice(i, 1);
				return s.sender;
			}
		}
		return undefined;
	}
}

let instance: TurnTriggerTracker | null = null;

/**
 * The process-wide tracker.
 *
 * @returns The singleton
 */
export function getTurnTriggerTracker(): TurnTriggerTracker {
	if (!instance) instance = new TurnTriggerTracker();
	return instance;
}

/**
 * Replace the singleton (tests).
 *
 * @param tracker - Replacement, or null to drop it
 */
export function setTurnTriggerTrackerForTesting(tracker: TurnTriggerTracker | null): void {
	instance = tracker;
}
