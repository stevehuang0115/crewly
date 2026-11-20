/**
 * Which connected Chrome an agent drives.
 *
 * One Crewly account can have several Chromes connected at once (one per
 * machine or Chrome profile), each signed in to different sites. Picking
 * one silently is how an upload nearly went to the wrong YouTube channel
 * (2026-11-20). The rules here, in order:
 *
 *   1. the browser the call names;
 *   2. the browser that holds the agent's bound tab;
 *   3. the browser the agent chose earlier (its pin), else this machine's
 *      default;
 *   4. the only connected browser;
 *   5. otherwise, for an agent, refuse and list the candidates.
 *
 * @module services/browser/browser-target
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { BROWSER_TARGET_CONSTANTS } from '../../constants.js';

/** The part of a connected browser this module needs. */
export interface BrowserCandidate {
	instanceId: string;
	instanceName: string;
	lastSeenAt: string;
}

/** Why a browser could not be chosen. */
export type BrowserTargetCode =
	| 'BROWSER_AMBIGUOUS'
	| 'BROWSER_NOT_CONNECTED'
	| 'BROWSER_BOUND_ELSEWHERE'
	| 'NO_BROWSER_CLIENT';

/** A refusal to choose, carrying the browsers the caller may pick from. */
export class BrowserTargetError extends Error {
	/**
	 * @param code - Machine code
	 * @param message - What happened and what to do next
	 * @param browsers - Connected browsers to choose from
	 */
	constructor(
		public readonly code: BrowserTargetCode,
		message: string,
		public readonly browsers: Array<{ id: string; name: string }> = [],
	) {
		super(message);
		this.name = 'BrowserTargetError';
	}
}

/**
 * A browser's name with enough of its id to tell same-named ones apart.
 *
 * @param b - The browser
 * @returns e.g. `Chrome (macOS) [id 1a2b3c4d]`
 */
export function labelBrowser(b: BrowserCandidate): string {
	return `${b.instanceName} [id ${b.instanceId.slice(0, BROWSER_TARGET_CONSTANTS.SHORT_ID_CHARS)}]`;
}

/**
 * Find the browsers a name or id refers to: the exact id, else an exact
 * name (case-insensitive), else an id prefix.
 *
 * @param instances - Connected browsers
 * @param wanted - Name, id or id prefix
 * @returns Every match (more than one = ambiguous)
 */
export function matchBrowsers<T extends BrowserCandidate>(instances: T[], wanted: string): T[] {
	const w = wanted.trim();
	if (!w) return [];
	const byId = instances.filter((i) => i.instanceId === w);
	if (byId.length > 0) return byId;
	const lower = w.toLowerCase();
	const byName = instances.filter((i) => i.instanceName.toLowerCase() === lower);
	if (byName.length > 0) return byName;
	if (w.length < BROWSER_TARGET_CONSTANTS.MIN_ID_PREFIX_CHARS) return [];
	return instances.filter((i) => i.instanceId.toLowerCase().startsWith(lower));
}

/** Inputs to {@link chooseBrowser}. */
export interface ChooseBrowserInput<T extends BrowserCandidate> {
	instances: T[];
	/** Browser the call named (name, id or id prefix) */
	explicit?: string;
	/** Browser holding the agent's bound tab */
	boundInstanceId?: string;
	/** Browser id the agent (or the machine default) pinned */
	pinnedInstanceId?: string;
	/** Refuse instead of guessing when several are connected (agent callers) */
	requireChoice?: boolean;
}

/**
 * Choose the browser a command goes to.
 *
 * @param input - Candidates and the caller's preferences
 * @returns The chosen browser
 * @throws BrowserTargetError when none fits or the choice is not safe to guess
 */
export function chooseBrowser<T extends BrowserCandidate>(input: ChooseBrowserInput<T>): T {
	const { instances, explicit, boundInstanceId, pinnedInstanceId, requireChoice } = input;
	const browsers = instances.map((i) => ({ id: i.instanceId, name: i.instanceName }));
	const listed = instances.map(labelBrowser).join(', ') || 'none';

	if (explicit) {
		const matches = matchBrowsers(instances, explicit);
		if (matches.length === 0) {
			throw new BrowserTargetError('BROWSER_NOT_CONNECTED', `Browser "${explicit}" is not connected. Connected: ${listed}`, browsers);
		}
		if (matches.length > 1) {
			throw new BrowserTargetError(
				'BROWSER_AMBIGUOUS',
				`${matches.length} connected browsers are named "${explicit}". Name one by id instead: ${matches.map(labelBrowser).join(', ')}`,
				browsers,
			);
		}
		if (boundInstanceId && matches[0].instanceId !== boundInstanceId) {
			throw new BrowserTargetError(
				'BROWSER_BOUND_ELSEWHERE',
				`Your tab is open in another browser. Finish there first (--action done), then start again with --browser "${explicit}".`,
				browsers,
			);
		}
		return matches[0];
	}

	if (boundInstanceId) {
		const bound = instances.find((i) => i.instanceId === boundInstanceId);
		if (bound) return bound;
		throw new BrowserTargetError(
			'BROWSER_NOT_CONNECTED',
			`The browser holding your tab is no longer connected. Release it (--action done) and start again. Connected: ${listed}`,
			browsers,
		);
	}

	if (pinnedInstanceId) {
		const pinned = instances.find((i) => i.instanceId === pinnedInstanceId);
		if (pinned) return pinned;
		throw new BrowserTargetError(
			'BROWSER_NOT_CONNECTED',
			`The browser chosen for this work is not connected right now. Do not use another one unless the owner says so. Connected: ${listed}`,
			browsers,
		);
	}

	if (instances.length === 0) {
		throw new BrowserTargetError('NO_BROWSER_CLIENT', 'No browser instances connected');
	}
	if (instances.length === 1) return instances[0];

	if (requireChoice) {
		throw new BrowserTargetError(
			'BROWSER_AMBIGUOUS',
			`${instances.length} browsers are connected and they may be signed in to different accounts: ${listed}. ` +
				'Say which one with --browser "<name or id>". If the task does not say which, ask the owner once, ' +
				'then remember the answer with --action use-browser --browser "<name or id>".',
			browsers,
		);
	}

	// A caller with no agent identity (owner tools, diagnostics): the browser
	// that answered most recently, as before.
	let freshest = instances[0];
	let freshestTs = -Infinity;
	for (const info of instances) {
		const ts = Date.parse(info.lastSeenAt);
		if (Number.isFinite(ts) && ts > freshestTs) {
			freshestTs = ts;
			freshest = info;
		}
	}
	return freshest;
}

/** A remembered browser choice. */
export interface BrowserPin {
	instanceId: string;
	/** Name at the time of pinning (display only; the id decides) */
	instanceName: string;
	pinnedAt: string;
}

/** On-disk shape of the pin store. */
interface BrowserPinFile {
	version: 1;
	machineDefault?: BrowserPin;
	agents: Record<string, BrowserPin>;
}

/**
 * Remembered browser choices: one per agent session, plus a default for
 * every agent on this machine. A JSON file under CREWLY_HOME, so a choice
 * survives a restart.
 */
export class BrowserPinStore {
	private data: BrowserPinFile | null = null;

	/**
	 * @param filePath - JSON file
	 * @param now - Clock (tests)
	 */
	constructor(
		private readonly filePath: string,
		private readonly now: () => Date = () => new Date(),
	) {}

	/**
	 * Store under a CREWLY_HOME.
	 *
	 * @param crewlyHome - CREWLY_HOME
	 * @returns The store
	 */
	static inHome(crewlyHome: string): BrowserPinStore {
		return new BrowserPinStore(path.join(crewlyHome, BROWSER_TARGET_CONSTANTS.PIN_STORE_FILENAME));
	}

	/**
	 * The pin that applies to an agent: its own, else the machine default.
	 *
	 * @param agentSession - The agent, if known
	 * @returns The pin, or undefined
	 */
	pinFor(agentSession?: string): BrowserPin | undefined {
		const data = this.load();
		return (agentSession ? data.agents[agentSession] : undefined) ?? data.machineDefault;
	}

	/**
	 * Both layers, for display.
	 *
	 * @param agentSession - The agent, if known
	 * @returns The agent's own pin and the machine default
	 */
	describe(agentSession?: string): { agent?: BrowserPin; machineDefault?: BrowserPin } {
		const data = this.load();
		const agent = agentSession ? data.agents[agentSession] : undefined;
		return { ...(agent ? { agent } : {}), ...(data.machineDefault ? { machineDefault: data.machineDefault } : {}) };
	}

	/**
	 * Remember a browser for one agent, or as the machine default.
	 *
	 * @param browser - The chosen browser
	 * @param agentSession - The agent; omit to set the machine default
	 * @returns The stored pin
	 */
	set(browser: BrowserCandidate, agentSession?: string): BrowserPin {
		const data = this.load();
		const pin: BrowserPin = {
			instanceId: browser.instanceId,
			instanceName: browser.instanceName,
			pinnedAt: this.now().toISOString(),
		};
		if (agentSession) data.agents[agentSession] = pin;
		else data.machineDefault = pin;
		this.save(data);
		return pin;
	}

	/**
	 * Forget a choice.
	 *
	 * @param agentSession - The agent; omit to clear the machine default
	 * @returns True when something was removed
	 */
	clear(agentSession?: string): boolean {
		const data = this.load();
		const had = agentSession ? agentSession in data.agents : data.machineDefault !== undefined;
		if (agentSession) delete data.agents[agentSession];
		else delete data.machineDefault;
		if (had) this.save(data);
		return had;
	}

	/**
	 * Read the file once; a missing or unreadable file is an empty store.
	 *
	 * @returns The in-memory data
	 */
	private load(): BrowserPinFile {
		if (this.data) return this.data;
		let parsed: Partial<BrowserPinFile> = {};
		try {
			if (existsSync(this.filePath)) parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<BrowserPinFile>;
		} catch {
			parsed = {};
		}
		this.data = {
			version: 1,
			...(parsed.machineDefault ? { machineDefault: parsed.machineDefault } : {}),
			agents: parsed.agents && typeof parsed.agents === 'object' ? { ...parsed.agents } : {},
		};
		return this.data;
	}

	/**
	 * Write the file.
	 *
	 * @param data - Data to persist
	 */
	private save(data: BrowserPinFile): void {
		mkdirSync(path.dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
	}
}
