/**
 * Cross-machine mentions in a shared Slack room thread (CREW-860).
 *
 * Cloud drops a post by one of our agents that @-names no OTHER agent (the loop
 * guard in crewly-services `slack-routing.service.ts`), so a reply in a thread
 * where the agents it means run on another machine reaches none of them. This
 * module decides what to tell the author about one outgoing post.
 *
 * It never edits the post. Adding the thread's other-machine @names to a post
 * that named nobody tagged them on EVERY such post (CREW-1318): it woke agents
 * the text was not for, and each tag kept them "in the thread" for the next one.
 * Only the author tags someone.
 *
 * Addressing mirrors what Cloud counts as a mention: `<@botUser>`, `@Name`
 * anywhere, or the text opening with the name.
 *
 * @module services/slack/cross-machine-mention
 */

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
	/** Session of the other-machine agent that posted it, when one did */
	remoteSession?: string;
	/** Sessions @-mentioned in it */
	mentions?: readonly string[];
}

/** What to tell the author about the post. */
export interface CrossMachinePlan {
	/** Other-machine agents in the thread that this post reaches nobody of */
	unreached: RemoteRoomAgent[];
	/** One line for the author, or null when there is nothing to say */
	note: string | null;
}

const NO_PLAN = (): CrossMachinePlan => ({ unreached: [], note: null });

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
 * @param localNames - Display names of the agents with a bot on THIS machine: the linker weighs them
 *   with the other machines' when it decides whether a short name is unique
 * @returns True when Cloud will see the agent addressed
 */
export function addresses(
	text: string,
	agent: RemoteRoomAgent,
	room: readonly RemoteRoomAgent[] = [agent],
	localNames: readonly string[] = [],
): boolean {
	const body = text.trim();
	if (agent.botUserId) {
		if (new RegExp(`<@${escapeRegExp(agent.botUserId)}(?:\\|[^>]*)?>`).test(body)) return true;
		const short = namesOf(agent).at(-1) ?? '';
		const same = (n: string): boolean => n.toLowerCase() === short.toLowerCase();
		const shared =
			room.some((o) => o !== agent && namesOf(o).some(same)) ||
			localNames.some((n) => same(n.replace(/\s*\([^)]*\)\s*$/u, '').trim()));
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
 * Check one outgoing post.
 *
 * @param content - What the agent wrote
 * @param room - Other-machine agents in the room (empty: nothing to say)
 * @param turns - The thread's messages as this machine has them
 * @param localNames - Display names of this machine's agents with a bot (see {@link addresses})
 * @returns What to tell the author; the post itself is never changed
 */
export function planCrossMachineMention(
	content: string,
	room: readonly RemoteRoomAgent[],
	turns: readonly ThreadTurn[],
	localNames: readonly string[] = [],
): CrossMachinePlan {
	if (room.length === 0 || !content.trim()) return NO_PLAN();
	if (room.some((a) => addresses(content, a, room, localNames))) return NO_PLAN();
	const inThread = remoteAgentsInThread(room, turns);
	if (inThread.length === 0) return NO_PLAN();

	const where = [...new Set(inThread.map((a) => a.machine ?? 'another machine'))].join(', ');
	// A bot's id is the one tag that cannot land on a namesake.
	const how = inThread.map((a) => `${a.name}: ${a.botUserId ? `<@${a.botUserId}>` : `@${a.name}`}`).join('; ');
	return {
		unreached: inThread,
		note: `Posted as written. It tags nobody on ${where}, so these agents in the thread did not get it (a post to another machine is dropped without a tag). Nothing to do if it was not for them; otherwise tag them in your next post — ${how}.`,
	};
}
