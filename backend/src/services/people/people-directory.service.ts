/**
 * People directory — the humans who use this Crewly instance, keyed by their
 * Slack user id, with a role (issue #968).
 *
 * - **owner**: the instance owner. Their person id is always `owner` —
 *   what this backend stores and sends Cloud. Any Slack id known to be the
 *   owner maps to it: the Slack installer (Cloud's workspace config, i.e. the
 *   Cloud account's Slack identity), `SLACK_OWNER_USER_ID` (installs whose
 *   Slack credentials come from env), and Slack ids the owner marked as their
 *   own in Settings › People. Always shown, never removable.
 * - **member**: a person in the workspace. A Slack user who messages an agent
 *   is added as a member automatically.
 * - **guest**: someone the owner marked as a guest. Guests are not included
 *   when a connector is shared with "all members".
 *
 * Bots (the master bot, agent bots) are never people: they are not added,
 * and rows a bot left in `people.json` are removed when the file is loaded.
 *
 * Stored in `<CREWLY_HOME>/people.json`. Writes are atomic.
 *
 * specs/per-person-access.md
 *
 * @module services/people/people-directory.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { PEOPLE_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/** A person's role on this instance. */
export type PersonRole = 'owner' | 'member' | 'guest';

/** One person. */
export interface Person {
	/** Slack user id (`U0123…`), or `owner` for the instance owner */
	id: string;
	/** The owner's known Slack user ids (owner row only, for display) */
	slackUserIds?: string[];
	/** Display name */
	name?: string;
	role: PersonRole;
	/** `auto`: added when they first messaged an agent; `owner`: added or edited by the owner */
	source: 'auto' | 'owner';
	createdAt: string;
	updatedAt: string;
}

/** What is stored. */
interface PeopleFile {
	version: 1;
	people: Person[];
	/** Slack ids the owner marked as their own (Settings › People) */
	ownerSlackUserIds?: string[];
}

/** An invalid edit. */
export class PeopleDirectoryError extends Error {}

/** Injectable dependencies. */
export interface PeopleDirectoryDeps {
	/** Store file (default `<CREWLY_HOME>/people.json`) */
	filePath?: string;
	/** The instance owner's Slack user id, when known (the Slack installer) */
	getOwnerSlackUserId?: () => string | null | undefined;
	/** Whether a Slack user id is a bot (the master bot or an agent's bot) */
	isBot?: (slackUserId: string) => boolean;
	/** Environment (default `process.env`), for `SLACK_OWNER_USER_ID` */
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

/**
 * Whether a value is a valid role.
 *
 * @param value - Candidate
 * @returns True for owner / member / guest
 */
export function isPersonRole(value: unknown): value is PersonRole {
	return typeof value === 'string' && PEOPLE_CONSTANTS.ROLES.includes(value);
}

/**
 * Whether a value is a person id this directory accepts: a Slack user id, or
 * the owner placeholder.
 *
 * @param value - Candidate
 * @returns True when valid
 */
export function isPersonId(value: unknown): value is string {
	return typeof value === 'string' && (value === PEOPLE_CONSTANTS.OWNER_ID || PEOPLE_CONSTANTS.SLACK_USER_ID_PATTERN.test(value));
}

/** The people directory. */
export class PeopleDirectoryService {
	private readonly filePathOverride?: string;
	private readonly installerSlackUserId: () => string | null;
	private readonly botCheck: (slackUserId: string) => boolean;
	private readonly env: () => NodeJS.ProcessEnv;
	private readonly now: () => number;

	/**
	 * @param deps - Store path, owner and bot lookups, environment, clock
	 */
	constructor(deps: PeopleDirectoryDeps = {}) {
		this.filePathOverride = deps.filePath;
		this.installerSlackUserId = () => {
			try {
				const id = deps.getOwnerSlackUserId?.();
				return typeof id === 'string' && id.trim() ? id.trim() : null;
			} catch {
				return null;
			}
		};
		this.botCheck = (id) => {
			try {
				return !!deps.isBot?.(id);
			} catch {
				return false;
			}
		};
		this.env = () => deps.env ?? process.env;
		this.now = deps.now ?? (() => Date.now());
	}

	/** @returns Store path (resolved per call so CREWLY_HOME changes apply) */
	private filePath(): string {
		return this.filePathOverride ?? path.join(getCrewlyHomePath(), PEOPLE_CONSTANTS.STORE_FILE);
	}

	/**
	 * The owner's person id. Always `owner` — what is stored and sent Cloud.
	 *
	 * @returns `owner`
	 */
	ownerId(): string {
		return PEOPLE_CONSTANTS.OWNER_ID;
	}

	/**
	 * Every Slack id known to be the owner: the Slack installer,
	 * `SLACK_OWNER_USER_ID`, and ids the owner marked as their own.
	 *
	 * @returns Slack user ids (deduplicated, maybe empty)
	 */
	ownerSlackUserIds(): string[] {
		const ids: string[] = [];
		const add = (id: string | null | undefined): void => {
			const v = typeof id === 'string' ? id.trim() : '';
			if (PEOPLE_CONSTANTS.SLACK_USER_ID_PATTERN.test(v) && !ids.includes(v)) ids.push(v);
		};
		add(this.installerSlackUserId());
		for (const id of (this.env()[PEOPLE_CONSTANTS.OWNER_SLACK_USER_ID_ENV] ?? '').split(',')) add(id);
		for (const id of this.readRaw().ownerSlackUserIds ?? []) add(id);
		return ids;
	}

	/**
	 * Whether a person id is the instance owner.
	 *
	 * @param id - Person id
	 * @returns True for `owner` or any Slack id known to be the owner
	 */
	isOwner(id: string | null | undefined): boolean {
		if (!id) return false;
		return id === PEOPLE_CONSTANTS.OWNER_ID || this.ownerSlackUserIds().includes(id);
	}

	/**
	 * The id to store and send for a person: `owner` for the owner (by either
	 * spelling), else the id as given.
	 *
	 * @param id - Person id
	 * @returns Canonical person id
	 */
	canonicalId(id: string): string {
		return this.isOwner(id) ? PEOPLE_CONSTANTS.OWNER_ID : id;
	}

	/**
	 * Whether a Slack user id is a bot (never a person).
	 *
	 * @param id - Slack user id
	 * @returns True for the master bot or an agent's bot
	 */
	isBot(id: string | null | undefined): boolean {
		return !!id && id !== PEOPLE_CONSTANTS.OWNER_ID && this.botCheck(id);
	}

	/**
	 * Everyone, owner first, then by name.
	 *
	 * @returns People (copies)
	 */
	list(): Person[] {
		const stored = this.read().people;
		const slackIds = this.ownerSlackUserIds();
		const iso = new Date(this.now()).toISOString();
		// The owner's row: the `owner` entry, else a row from before the owner
		// was always `owner` (keyed by one of their Slack ids), for the name.
		const ownerRow = stored.find((p) => p.id === PEOPLE_CONSTANTS.OWNER_ID);
		const legacyRow = stored.find((p) => slackIds.includes(p.id) && p.name);
		const name = ownerRow?.name ?? legacyRow?.name;
		const owner: Person = {
			...(ownerRow ?? { source: 'owner' as const, createdAt: iso, updatedAt: iso }),
			...(name ? { name } : {}),
			id: PEOPLE_CONSTANTS.OWNER_ID,
			role: 'owner',
			...(slackIds.length > 0 ? { slackUserIds: slackIds } : {}),
		};
		const others = stored
			.filter((p) => p.id !== PEOPLE_CONSTANTS.OWNER_ID && !slackIds.includes(p.id))
			.map((p) => ({ ...p, role: p.role === 'owner' ? ('member' as const) : p.role }))
			.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
		return [owner, ...others];
	}

	/**
	 * One person.
	 *
	 * @param id - Person id
	 * @returns The person, or null when unknown
	 */
	get(id: string): Person | null {
		const key = this.canonicalId(id);
		return this.list().find((p) => p.id === key) ?? null;
	}

	/**
	 * A person's role. Unknown people are members (the default for a Slack
	 * user in the workspace).
	 *
	 * @param id - Person id
	 * @returns Role
	 */
	roleOf(id: string): PersonRole {
		if (this.isOwner(id)) return 'owner';
		const found = this.read().people.find((p) => p.id === id);
		if (!found) return PEOPLE_CONSTANTS.DEFAULT_ROLE as PersonRole;
		return found.role === 'owner' ? 'member' : found.role;
	}

	/**
	 * How to name a person to others.
	 *
	 * @param id - Person id
	 * @returns Their name, "the owner" for an owner without one, else the id
	 */
	displayName(id: string): string {
		const person = this.get(id);
		if (person?.name) return person.name;
		return this.isOwner(id) ? 'the owner' : id;
	}

	/**
	 * Record a Slack user who messaged an agent (added as a member the first
	 * time; a missing name is filled in). Never changes a role.
	 *
	 * @param id - Slack user id
	 * @param name - Their display name, when known
	 */
	noteSeen(id: string, name?: string): void {
		if (!PEOPLE_CONSTANTS.SLACK_USER_ID_PATTERN.test(id)) return;
		// A bot is never a person.
		if (this.isBot(id)) return;
		// The owner is the `owner` row, never a member row of their own.
		if (this.isOwner(id)) {
			const cleanOwnerName = cleanPersonName(name);
			if (cleanOwnerName && !this.get(PEOPLE_CONSTANTS.OWNER_ID)?.name) this.upsert(PEOPLE_CONSTANTS.OWNER_ID, { name: cleanOwnerName });
			return;
		}
		const file = this.read();
		const existing = file.people.find((p) => p.id === id);
		const cleanName = cleanPersonName(name);
		if (existing) {
			if (cleanName && !existing.name) {
				existing.name = cleanName;
				existing.updatedAt = new Date(this.now()).toISOString();
				this.write(file);
			}
			return;
		}
		const iso = new Date(this.now()).toISOString();
		file.people.push({
			id,
			...(cleanName ? { name: cleanName } : {}),
			role: PEOPLE_CONSTANTS.DEFAULT_ROLE as PersonRole,
			source: 'auto',
			createdAt: iso,
			updatedAt: iso,
		});
		this.write(file);
	}

	/**
	 * Add or edit a person (owner action). Giving a Slack id the `owner` role
	 * marks it as the owner's own Slack account (for installs that cannot
	 * tell, e.g. Slack credentials from env): it then maps to `owner`.
	 *
	 * @param id - Slack user id
	 * @param patch - Name and/or role
	 * @returns The person
	 * @throws PeopleDirectoryError on an invalid id or role, a bot, or when changing the owner's role
	 */
	upsert(id: string, patch: { name?: unknown; role?: unknown }): Person {
		if (!isPersonId(id)) throw new PeopleDirectoryError('A person is a Slack user id like U0123ABCD');
		if (patch.role !== undefined && !isPersonRole(patch.role)) throw new PeopleDirectoryError('role must be owner, member or guest');
		if (this.isBot(id)) throw new PeopleDirectoryError("That Slack id is one of Crewly's bots, not a person");
		const owner = this.isOwner(id);
		if (owner && patch.role !== undefined && patch.role !== 'owner') throw new PeopleDirectoryError("The instance owner's role can't be changed");
		if (patch.name !== undefined && patch.name !== null && typeof patch.name !== 'string') throw new PeopleDirectoryError('name must be text');
		if (!owner && patch.role === 'owner') {
			this.markOwnerSlackId(id);
			return patch.name !== undefined ? this.upsert(PEOPLE_CONSTANTS.OWNER_ID, { name: patch.name }) : (this.get(PEOPLE_CONSTANTS.OWNER_ID) as Person);
		}
		const file = this.read();
		const key = owner ? PEOPLE_CONSTANTS.OWNER_ID : id;
		const iso = new Date(this.now()).toISOString();
		let person = file.people.find((p) => p.id === key);
		if (!person) {
			person = { id: key, role: owner ? 'owner' : (PEOPLE_CONSTANTS.DEFAULT_ROLE as PersonRole), source: 'owner', createdAt: iso, updatedAt: iso };
			file.people.push(person);
		}
		if (patch.name !== undefined) {
			const name = cleanPersonName(patch.name as string | null);
			if (name) person.name = name;
			else delete person.name;
		}
		if (patch.role !== undefined) person.role = patch.role as PersonRole;
		person.source = 'owner';
		person.updatedAt = iso;
		this.write(file);
		return this.get(key) as Person;
	}

	/**
	 * Remove a person (they come back as a member if they message an agent again).
	 *
	 * @param id - Person id
	 * @returns True when removed
	 * @throws PeopleDirectoryError for the owner
	 */
	remove(id: string): boolean {
		if (this.isOwner(id)) throw new PeopleDirectoryError("The instance owner can't be removed");
		const file = this.read();
		const before = file.people.length;
		file.people = file.people.filter((p) => p.id !== id);
		if (file.people.length === before) return false;
		this.write(file);
		return true;
	}

	/**
	 * Record a Slack id as the owner's own and drop any member row it had.
	 *
	 * @param id - Slack user id
	 */
	private markOwnerSlackId(id: string): void {
		const file = this.readRaw();
		const ids = new Set(file.ownerSlackUserIds ?? []);
		ids.add(id);
		const name = file.people.find((p) => p.id === id)?.name;
		file.people = file.people.filter((p) => p.id !== id);
		file.ownerSlackUserIds = [...ids];
		if (name && !file.people.some((p) => p.id === PEOPLE_CONSTANTS.OWNER_ID)) {
			const iso = new Date(this.now()).toISOString();
			file.people.push({ id: PEOPLE_CONSTANTS.OWNER_ID, name, role: 'owner', source: 'owner', createdAt: iso, updatedAt: iso });
		}
		this.write(file);
	}

	/**
	 * The stored file, without bots. Bot rows found on disk (written by an
	 * earlier version that recorded agent posts as people) are removed from
	 * the file here (best effort).
	 *
	 * @returns The stored file (empty when missing or unreadable)
	 */
	private read(): PeopleFile {
		const file = this.readRaw();
		const people = file.people.filter((p) => !this.isBot(p.id));
		if (people.length === file.people.length) return file;
		const cleaned = { ...file, people };
		try {
			this.write(cleaned);
		} catch {
			// cleaned in memory; retried on the next read
		}
		return cleaned;
	}

	/** @returns The stored file as on disk (valid rows only; empty when missing or unreadable) */
	private readRaw(): PeopleFile {
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(this.filePath(), 'utf-8'));
			const obj = raw && typeof raw === 'object' ? (raw as Partial<PeopleFile>) : {};
			const people = Array.isArray(obj.people) ? obj.people : [];
			const ownerIds = Array.isArray(obj.ownerSlackUserIds)
				? obj.ownerSlackUserIds.filter((id): id is string => typeof id === 'string' && PEOPLE_CONSTANTS.SLACK_USER_ID_PATTERN.test(id))
				: [];
			return {
				version: 1,
				people: people.filter((p): p is Person => !!p && isPersonId(p.id) && isPersonRole(p.role)),
				...(ownerIds.length > 0 ? { ownerSlackUserIds: ownerIds } : {}),
			};
		} catch {
			return { version: 1, people: [] };
		}
	}

	/**
	 * Write atomically.
	 *
	 * @param file - Contents
	 */
	private write(file: PeopleFile): void {
		const target = this.filePath();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
		fs.renameSync(tmp, target);
	}
}

/**
 * Trim and bound a display name.
 *
 * @param name - Raw name
 * @returns Clean name, or undefined when empty
 */
export function cleanPersonName(name: string | null | undefined): string | undefined {
	if (typeof name !== 'string') return undefined;
	const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, PEOPLE_CONSTANTS.MAX_NAME_LENGTH);
	return trimmed || undefined;
}

/**
 * Record a Slack user who messaged an agent, with their name (best effort,
 * never throws).
 *
 * @param slackUserId - Slack user id
 * @param name - Display name, when known
 */
export function notePerson(slackUserId: string, name?: string | null): void {
	try {
		getPeopleDirectory().noteSeen(slackUserId, name ?? undefined);
	} catch {
		// the directory is a convenience here
	}
}

let instance: PeopleDirectoryService | null = null;
let ownerLookup: (() => string | null | undefined) | null = null;
let botLookup: ((slackUserId: string) => boolean) | null = null;

/**
 * Tell the directory how to find the owner's Slack id (wired once Slack is up).
 *
 * @param lookup - Lookup, or null
 */
export function setPeopleOwnerLookup(lookup: (() => string | null | undefined) | null): void {
	ownerLookup = lookup;
}

/**
 * Tell the directory how to recognise Crewly's bots (wired once Slack is up).
 *
 * @param lookup - Whether a Slack user id is a bot, or null
 */
export function setPeopleBotLookup(lookup: ((slackUserId: string) => boolean) | null): void {
	botLookup = lookup;
}

/**
 * The backend's people directory.
 *
 * @returns Singleton
 */
export function getPeopleDirectory(): PeopleDirectoryService {
	instance ??= new PeopleDirectoryService({
		getOwnerSlackUserId: () => ownerLookup?.() ?? null,
		isBot: (id) => botLookup?.(id) ?? false,
	});
	return instance;
}

/**
 * Replace the singleton (tests).
 *
 * @param service - Instance, or null to reset
 */
export function setPeopleDirectoryForTesting(service: PeopleDirectoryService | null): void {
	instance = service;
}
