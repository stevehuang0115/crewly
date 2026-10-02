/**
 * Acting-for — the person each agent session is working for right now
 * (issue #968).
 *
 * Every human message delivered to an agent records its sender as the person
 * that agent acts for until the next human message: a Slack message records
 * the sender's Slack user id, a dashboard message records the owner. A
 * message one agent sends another passes the sender's person on, so work
 * delegated for Info stays Info's. Scheduled and system turns change nothing.
 *
 * The record is set only by the backend from what it delivered — never from
 * anything an agent sends — and connector credential requests carry it to
 * Cloud, which decides whether that person may use the grant.
 *
 * Kept in `<CREWLY_HOME>/acting-for.json` so a restart does not turn a
 * member's in-flight turn into the owner's.
 *
 * specs/per-person-access.md
 *
 * @module services/people/acting-for.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { PEOPLE_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { getPeopleDirectory, type PeopleDirectoryService, type PersonRole } from './people-directory.service.js';

/** Where an acting-for record came from. */
export type ActingForSource = 'slack' | 'dashboard' | 'agent';

/** One session's record. */
export interface ActingForEntry {
	/** Person id (Slack user id, or `owner`) */
	personId: string;
	source: ActingForSource;
	/** ISO time it was recorded */
	at: string;
}

/** The person a request acts for, as Cloud is told. */
export interface Actor {
	id: string;
	role: PersonRole;
	/** Display name, for messages */
	name: string;
}

/** Injectable dependencies. */
export interface ActingForDeps {
	filePath?: string;
	people?: () => PeopleDirectoryService;
	now?: () => number;
}

/** The acting-for record. */
export class ActingForService {
	private readonly filePathOverride?: string;
	private readonly people: () => PeopleDirectoryService;
	private readonly now: () => number;
	private cache: Record<string, ActingForEntry> | null = null;

	/**
	 * @param deps - Store path, people directory, clock
	 */
	constructor(deps: ActingForDeps = {}) {
		this.filePathOverride = deps.filePath;
		this.people = deps.people ?? getPeopleDirectory;
		this.now = deps.now ?? (() => Date.now());
	}

	/**
	 * Record that a session now acts for a person.
	 *
	 * @param session - Agent session name
	 * @param personId - Slack user id, or `owner`
	 * @param source - What delivered the message
	 */
	record(session: string, personId: string, source: ActingForSource): void {
		if (!session || !personId) return;
		const all = this.load();
		const current = all[session];
		if (current && current.personId === personId && current.source === source) return;
		all[session] = { personId, source, at: new Date(this.now()).toISOString() };
		this.save(all);
	}

	/**
	 * Record a human message delivered to a session: a Slack sender, or the
	 * owner when it carries no Slack sender (dashboard / terminal).
	 *
	 * @param session - Agent session name
	 * @param slackUserId - Sender's Slack user id, when the message came from Slack
	 */
	recordHumanMessage(session: string, slackUserId: string | null | undefined): void {
		if (slackUserId && PEOPLE_CONSTANTS.SLACK_USER_ID_PATTERN.test(slackUserId)) {
			this.record(session, slackUserId, 'slack');
			try {
				this.people().noteSeen(slackUserId);
			} catch {
				// the directory is best effort here
			}
			return;
		}
		this.record(session, PEOPLE_CONSTANTS.OWNER_ID, 'dashboard');
	}

	/**
	 * A message from one agent to another: the target acts for whoever the
	 * sender acts for (the owner when the sender has no record).
	 *
	 * @param target - Receiving session
	 * @param fromSession - Sending session
	 */
	inherit(target: string, fromSession: string): void {
		if (!target || !fromSession || target === fromSession) return;
		const from = this.load()[fromSession];
		this.record(target, from?.personId ?? PEOPLE_CONSTANTS.OWNER_ID, 'agent');
	}

	/**
	 * A session's record.
	 *
	 * @param session - Agent session name
	 * @returns Entry, or null when the session never got a human message
	 */
	get(session: string): ActingForEntry | null {
		const entry = this.load()[session];
		return entry ? { ...entry } : null;
	}

	/**
	 * The person a request acts for: the owner for a request with no agent
	 * session (the owner's dashboard), else the session's record (the owner
	 * when it has none).
	 *
	 * @param session - Calling agent session, if any
	 * @returns Actor
	 */
	actorFor(session?: string | null): Actor {
		const people = this.people();
		const raw = session ? this.load()[session]?.personId : undefined;
		const id = !raw || people.isOwner(raw) ? people.ownerId() : raw;
		return { id, role: people.roleOf(id), name: people.displayName(id) };
	}

	/** Forget everything (tests). */
	clear(): void {
		this.save({});
	}

	/** @returns Store path */
	private filePath(): string {
		return this.filePathOverride ?? path.join(getCrewlyHomePath(), PEOPLE_CONSTANTS.ACTING_FOR_FILE);
	}

	/** @returns All records (read once, then cached) */
	private load(): Record<string, ActingForEntry> {
		if (this.cache) return this.cache;
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(this.filePath(), 'utf-8'));
			const sessions = raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : undefined;
			const out: Record<string, ActingForEntry> = {};
			if (sessions && typeof sessions === 'object') {
				for (const [name, e] of Object.entries(sessions as Record<string, Partial<ActingForEntry>>)) {
					if (e && typeof e.personId === 'string' && typeof e.at === 'string') {
						out[name] = { personId: e.personId, at: e.at, source: e.source === 'slack' || e.source === 'agent' ? e.source : 'dashboard' };
					}
				}
			}
			this.cache = out;
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	/**
	 * Save atomically (best effort: the in-memory record still applies).
	 *
	 * @param all - Records
	 */
	private save(all: Record<string, ActingForEntry>): void {
		this.cache = all;
		try {
			const target = this.filePath();
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: all }, null, 2)}\n`, 'utf-8');
			fs.renameSync(tmp, target);
		} catch {
			// kept in memory
		}
	}
}

let instance: ActingForService | null = null;

/**
 * The backend's acting-for record.
 *
 * @returns Singleton
 */
export function getActingFor(): ActingForService {
	instance ??= new ActingForService();
	return instance;
}

/**
 * Replace the singleton (tests).
 *
 * @param service - Instance, or null to reset
 */
export function setActingForForTesting(service: ActingForService | null): void {
	instance = service;
}

const actorStore = new AsyncLocalStorage<Actor>();

/**
 * Run work as a person: connector token requests made inside carry that
 * person to Cloud.
 *
 * @param actor - Person
 * @param fn - Work
 * @returns What `fn` returns
 */
export function runAsActor<T>(actor: Actor, fn: () => T): T {
	return actorStore.run(actor, fn);
}

/**
 * The person the current request acts for.
 *
 * @returns Actor, or null outside a connector request (backend-internal calls)
 */
export function currentActor(): Actor | null {
	return actorStore.getStore() ?? null;
}

/**
 * Headers that tell Cloud who a credential request is for.
 *
 * @param actor - Person (default: the current request's)
 * @returns Headers (empty outside a connector request)
 */
export function actingForHeaders(actor: Actor | null = currentActor()): Record<string, string> {
	if (!actor) return {};
	return { [PEOPLE_CONSTANTS.ACTING_FOR_HEADER]: actor.id, [PEOPLE_CONSTANTS.ACTING_FOR_ROLE_HEADER]: actor.role };
}

/**
 * Cache-key suffix for a token fetched for the current person, so one
 * person's cached token is never handed to another.
 *
 * @param actor - Person (default: the current request's)
 * @returns `''` outside a connector request, else `\0<person id>`
 */
export function actorCacheSuffix(actor: Actor | null = currentActor()): string {
	return actor ? `\0${actor.id}` : '';
}
