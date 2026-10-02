/**
 * People directory — the humans who use this Crewly instance, keyed by their
 * Slack user id, with a role (issue #968).
 *
 * - **owner**: the instance owner (the Slack user who installed Crewly's
 *   Slack app). Always shown, always `owner`, never removable. When their
 *   Slack id is not known the owner is the id `owner` (dashboard, terminal).
 * - **member**: a person in the workspace. A Slack user who messages an agent
 *   is added as a member automatically.
 * - **guest**: someone the owner marked as a guest. Guests are not included
 *   when a connector is shared with "all members".
 *
 * Stored in `<CREWLY_HOME>/people.json`. Writes are atomic.
 *
 * specs/2026-10-03-per-person-access.md
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
	/** Slack user id (`U0123…`), or `owner` for an owner whose Slack id is unknown */
	id: string;
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
}

/** An invalid edit. */
export class PeopleDirectoryError extends Error {}

/** Injectable dependencies. */
export interface PeopleDirectoryDeps {
	/** Store file (default `<CREWLY_HOME>/people.json`) */
	filePath?: string;
	/** The instance owner's Slack user id, when known */
	getOwnerSlackUserId?: () => string | null | undefined;
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
	private readonly ownerSlackUserId: () => string | null;
	private readonly now: () => number;

	/**
	 * @param deps - Store path, owner lookup, clock
	 */
	constructor(deps: PeopleDirectoryDeps = {}) {
		this.filePathOverride = deps.filePath;
		this.ownerSlackUserId = () => {
			try {
				const id = deps.getOwnerSlackUserId?.();
				return typeof id === 'string' && id.trim() ? id.trim() : null;
			} catch {
				return null;
			}
		};
		this.now = deps.now ?? (() => Date.now());
	}

	/** @returns Store path (resolved per call so CREWLY_HOME changes apply) */
	private filePath(): string {
		return this.filePathOverride ?? path.join(getCrewlyHomePath(), PEOPLE_CONSTANTS.STORE_FILE);
	}

	/**
	 * The owner's person id: their Slack user id when known, else `owner`.
	 *
	 * @returns Person id
	 */
	ownerId(): string {
		return this.ownerSlackUserId() ?? PEOPLE_CONSTANTS.OWNER_ID;
	}

	/**
	 * Whether a person id is the instance owner.
	 *
	 * @param id - Person id
	 * @returns True for the owner's Slack id or the `owner` placeholder
	 */
	isOwner(id: string | null | undefined): boolean {
		if (!id) return false;
		return id === PEOPLE_CONSTANTS.OWNER_ID || id === this.ownerSlackUserId();
	}

	/**
	 * Everyone, owner first, then by name.
	 *
	 * @returns People (copies)
	 */
	list(): Person[] {
		const stored = this.read().people;
		const ownerId = this.ownerId();
		const iso = new Date(this.now()).toISOString();
		const owner = stored.find((p) => p.id === ownerId) ?? stored.find((p) => p.id === PEOPLE_CONSTANTS.OWNER_ID);
		const out: Person[] = [{ ...(owner ?? { source: 'owner' as const, createdAt: iso, updatedAt: iso }), id: ownerId, role: 'owner' }];
		const others = stored
			.filter((p) => p.id !== ownerId && p.id !== PEOPLE_CONSTANTS.OWNER_ID)
			.map((p) => ({ ...p, role: p.role === 'owner' ? ('member' as const) : p.role }))
			.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
		return [...out, ...others];
	}

	/**
	 * One person.
	 *
	 * @param id - Person id
	 * @returns The person, or null when unknown
	 */
	get(id: string): Person | null {
		const ownerId = this.ownerId();
		const key = id === PEOPLE_CONSTANTS.OWNER_ID ? ownerId : id;
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
			role: this.isOwner(id) ? 'owner' : (PEOPLE_CONSTANTS.DEFAULT_ROLE as PersonRole),
			source: 'auto',
			createdAt: iso,
			updatedAt: iso,
		});
		this.write(file);
	}

	/**
	 * Add or edit a person (owner action).
	 *
	 * @param id - Slack user id
	 * @param patch - Name and/or role
	 * @returns The person
	 * @throws PeopleDirectoryError on an invalid id or role, or when changing the owner's role
	 */
	upsert(id: string, patch: { name?: unknown; role?: unknown }): Person {
		if (!isPersonId(id)) throw new PeopleDirectoryError('A person is a Slack user id like U0123ABCD');
		if (patch.role !== undefined && !isPersonRole(patch.role)) throw new PeopleDirectoryError('role must be owner, member or guest');
		const owner = this.isOwner(id);
		if (owner && patch.role !== undefined && patch.role !== 'owner') throw new PeopleDirectoryError("The instance owner's role can't be changed");
		if (!owner && patch.role === 'owner') throw new PeopleDirectoryError('There is one owner: the person who installed Crewly in Slack');
		if (patch.name !== undefined && patch.name !== null && typeof patch.name !== 'string') throw new PeopleDirectoryError('name must be text');
		const file = this.read();
		const key = owner ? this.ownerId() : id;
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

	/** @returns The stored file (empty when missing or unreadable) */
	private read(): PeopleFile {
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(this.filePath(), 'utf-8'));
			const people = raw && typeof raw === 'object' && Array.isArray((raw as PeopleFile).people) ? (raw as PeopleFile).people : [];
			return {
				version: 1,
				people: people.filter((p): p is Person => !!p && isPersonId(p.id) && isPersonRole(p.role)),
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

/**
 * Tell the directory how to find the owner's Slack id (wired once Slack is up).
 *
 * @param lookup - Lookup, or null
 */
export function setPeopleOwnerLookup(lookup: (() => string | null | undefined) | null): void {
	ownerLookup = lookup;
}

/**
 * The backend's people directory.
 *
 * @returns Singleton
 */
export function getPeopleDirectory(): PeopleDirectoryService {
	instance ??= new PeopleDirectoryService({ getOwnerSlackUserId: () => ownerLookup?.() ?? null });
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
