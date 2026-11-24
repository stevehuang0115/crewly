/**
 * Cross-machine mentions in a shared Slack room thread (CREW-860).
 *
 * Cloud drops a post by one of our agents that @-names no OTHER agent (the loop
 * guard in crewly-services `slack-routing.service.ts`, kept as is), so a reply
 * in a thread where the agents it means run on another machine reached nobody
 * and the author was never told. This module decides, for one outgoing post:
 *
 * - it already addresses an other-machine agent: nothing to do or say;
 * - it addresses none, and other-machine agents are in the thread: their
 *   @names are added (those agents only, never anyone else), unless the thread
 *   is already a long run of agent turns, or the kill switch is set;
 * - otherwise (could not or must not add): the author is told who did not get it.
 *
 * Addressing mirrors what Cloud counts as a mention: `<@botUser>`, `@Name`
 * anywhere, or the text opening with the name.
 *
 * @module services/slack/cross-machine-mention
 */

import { CROSS_MACHINE_MENTION_CONSTANTS as C } from '../../constants.js';

/** An agent of this account that runs on another machine and is in the room. */
export interface RemoteRoomAgent {
	/** Display name, e.g. `Owen` or `Owen (CE)` */
	name: string;
	/** Crewly agent session, when known */
	agentSession: string | null;
	/** Slack bot user id, when the agent has an app of its own */
	botUserId: string | null;
	/** Device name of its machine */
	machine: string | null;
}

/** One message of the thread, as far as this machine has it. */
export interface ThreadTurn {
	/** `agent` = one of ours, `remote-agent` = an agent on another machine, `human` otherwise */
	by: 'agent' | 'remote-agent' | 'human';
	/** Session of the remote agent, when `by` is `remote-agent` */
	remoteSession?: string;
	/** Sessions @-mentioned in it */
	mentions?: readonly string[];
}

/** What to do with the post. */
export interface CrossMachinePlan {
	/** The text to post (the original, or with @names put in front) */
	content: string;
	/** Other-machine agents whose @name was added */
	added: RemoteRoomAgent[];
	/** Other-machine agents in the thread that this post reached nobody of (not added) */
	unreached: RemoteRoomAgent[];
	/** One line for the author, or null when there is nothing new to say */
	note: string | null;
}

const NO_PLAN = (content: string): CrossMachinePlan => ({ content, added: [], unreached: [], note: null });

/** @param s - Text @returns The text escaped for a RegExp */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param agent - An agent @returns Its full and short (`Owen (CE)` -> `Owen`) names */
function namesOf(agent: RemoteRoomAgent): string[] {
	const full = agent.name.trim();
	const short = full.replace(/\s*\(.*$/, '').trim();
	return short && short !== full ? [full, short] : [full];
}

/**
 * Whether the text addresses the agent the way Cloud counts it. Cloud knows an
 * agent WITH its own Slack bot only by `<@BOTID>`; `linkAgentMentions` turns a
 * typed `@Name` into that mention, but only when the name is unambiguous in the
 * room, so a plain name counts for a bot agent only then. An app-less agent is
 * addressed by its plain name (`@Name` anywhere, or the text opening with it).
 *
 * @param text - The post
 * @param agent - The other-machine agent
 * @param room - Every other-machine agent in the room (decides whether a short name is unique)
 * @returns True when Cloud will see the agent addressed
 */
export function addresses(text: string, agent: RemoteRoomAgent, room: readonly RemoteRoomAgent[] = [agent]): boolean {
	const body = text.trim();
	if (agent.botUserId) {
		if (new RegExp(`<@${escapeRegExp(agent.botUserId)}(?:\\|[^>]*)?>`).test(body)) return true;
		const short = namesOf(agent).at(-1) ?? '';
		const shared = room.some((o) => o !== agent && namesOf(o).some((n) => n.toLowerCase() === short.toLowerCase()));
		if (shared) return false;
		// Only `@Name` is linked to the bot, never an opening bare name.
		return new RegExp(`(?:^|[^\\p{L}\\p{N}_<])@${escapeRegExp(short)}(?![\\p{L}\\p{N}_])`, 'iu').test(body);
	}
	for (const n of namesOf(agent)) {
		const e = escapeRegExp(n);
		if (new RegExp(`^${e}(?:[,，:：]|\\s|$)`, 'i').test(body)) return true;
		if (new RegExp(`(?:^|[^\\p{L}\\p{N}_])@${e}(?![\\p{L}\\p{N}_])`, 'iu').test(body)) return true;
	}
	return false;
}

/**
 * The other-machine agents already in a thread: those that posted in it or were
 * @-mentioned in it.
 *
 * @param room - Other-machine agents in the room
 * @param turns - The thread's messages
 * @returns The subset of `room` in the thread, in room order
 */
export function remoteAgentsInThread(room: readonly RemoteRoomAgent[], turns: readonly ThreadTurn[]): RemoteRoomAgent[] {
	const seen = new Set<string>();
	for (const t of turns) {
		if (t.remoteSession) seen.add(t.remoteSession);
		for (const m of t.mentions ?? []) seen.add(m);
	}
	return room.filter((a) => !!a.agentSession && seen.has(a.agentSession));
}

/**
 * Agent turns at the end of the thread with no human message between them.
 *
 * @param turns - The thread's messages, oldest first
 * @returns The run length
 */
export function trailingAgentTurns(turns: readonly ThreadTurn[]): number {
	let n = 0;
	for (let i = turns.length - 1; i >= 0 && turns[i].by !== 'human'; i--) n++;
	return n;
}

/**
 * Plan one outgoing post.
 *
 * @param content - What the agent wrote
 * @param room - Other-machine agents in the room (empty: nothing to do)
 * @param turns - The thread's messages as this machine has them
 * @param env - Environment (kill switch)
 * @returns What to post and what to tell the author
 */
export function planCrossMachineMention(
	content: string,
	room: readonly RemoteRoomAgent[],
	turns: readonly ThreadTurn[],
	env: NodeJS.ProcessEnv = process.env,
): CrossMachinePlan {
	if (room.length === 0 || !content.trim()) return NO_PLAN(content);
	if (room.some((a) => addresses(content, a, room))) return NO_PLAN(content);
	const inThread = remoteAgentsInThread(room, turns);
	if (inThread.length === 0) return NO_PLAN(content);

	const where = (agents: RemoteRoomAgent[]): string => [...new Set(agents.map((a) => a.machine ?? 'another machine'))].join(', ');
	const names = (agents: RemoteRoomAgent[]): string => agents.map((a) => a.name).join(', ');
	const autoAdd =
		env[C.AUTO_ADD_ENV] !== C.AUTO_ADD_OFF_VALUE && trailingAgentTurns(turns) < C.MAX_CONSECUTIVE_AGENT_TURNS;
	if (autoAdd) {
		// An agent with its own bot is reached only through `<@BOTID>`; an app-less one by name.
		const tags = inThread.map((a) => (a.botUserId ? `<@${a.botUserId}>` : `@${a.name.replace(/\s*\(.*$/, '').trim() || a.name}`)).join(' ');
		return {
			content: `${tags} ${content}`,
			added: inThread,
			unreached: [],
			note: `Added ${inThread.map((a) => `@${a.name.replace(/\s*\(.*$/, '').trim() || a.name}`).join(' ')} so this reaches ${names(inThread)} on ${where(inThread)}: a post to another machine is dropped unless it @-names someone there.`,
		};
	}
	return {
		content,
		added: [],
		unreached: inThread,
		note: `This post reached nobody on ${where(inThread)}: it @-names none of ${names(inThread)}, who are in this thread, and a post to another machine is dropped without an @name. Post again with @name if you mean them.`,
	};
}
