/**
 * Connector grant ownership and sharing (issue #968) — the shapes the
 * backend exchanges with Cloud, their validation, and the message an agent
 * gets when the person it acts for may not use a grant.
 *
 * Cloud holds each grant's `authorizedBy` (the person who connected it) and
 * `sharing`, and decides on every credential request. A grant with neither is
 * the owner's alone.
 *
 * specs/2026-10-03-per-person-access.md
 *
 * @module services/people/grant-sharing
 */

import { PEOPLE_CONSTANTS } from '../../constants.js';
import type { Actor } from './acting-for.service.js';
import { getPeopleDirectory, isPersonId } from './people-directory.service.js';

/** Who may use a grant besides the person who authorized it. */
export interface GrantSharing {
	/** `owner`: only the person who authorized it; `people`: also the named people; `members`: every member (not guests) */
	mode: 'owner' | 'people' | 'members';
	/** For `people`: person ids (Slack user ids) */
	people?: string[];
}

/** A grant's ownership, as Cloud reports it. */
export interface GrantOwnership {
	/** Person who authorized it (Slack user id, or `owner`); absent = the owner */
	authorizedBy?: string;
	/** Absent = owner only */
	sharing?: GrantSharing;
}

/** A sharing/ownership edit is invalid. */
export class GrantSharingError extends Error {}

/**
 * Validate a sharing setting from the dashboard.
 *
 * @param raw - Candidate (untrusted)
 * @returns Clean sharing
 * @throws GrantSharingError when invalid
 */
export function validateSharing(raw: unknown): GrantSharing {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GrantSharingError('sharing must be an object');
	const r = raw as { mode?: unknown; people?: unknown };
	if (typeof r.mode !== 'string' || !PEOPLE_CONSTANTS.SHARING_MODES.includes(r.mode)) {
		throw new GrantSharingError('sharing.mode must be owner, people or members');
	}
	if (r.mode !== 'people') return { mode: r.mode as GrantSharing['mode'] };
	if (!Array.isArray(r.people)) throw new GrantSharingError('sharing.people must be a list of people');
	const people: string[] = [];
	for (const id of r.people) {
		if (!isPersonId(id)) throw new GrantSharingError(`Not a person: ${String(id)}`);
		if (!people.includes(id)) people.push(id);
	}
	return { mode: 'people', people };
}

/**
 * Validate an owner change (a person id).
 *
 * @param raw - Candidate
 * @returns The person id
 * @throws GrantSharingError when invalid
 */
export function validateAuthorizedBy(raw: unknown): string {
	if (!isPersonId(raw)) throw new GrantSharingError('authorizedBy must be a person (a Slack user id, or owner)');
	return raw;
}

/**
 * Whether a person may use a grant — the same rule Cloud applies (used for
 * the dashboard's preview and tests).
 *
 * @param grant - Ownership (missing fields = the owner's alone)
 * @param actor - The person
 * @param isOwner - Whether a person id is the instance owner
 * @returns True when allowed
 */
export function mayUseGrant(grant: GrantOwnership, actor: Pick<Actor, 'id' | 'role'>, isOwner: (id: string) => boolean): boolean {
	const authorizedBy = grant.authorizedBy ?? PEOPLE_CONSTANTS.OWNER_ID;
	if (actor.id === authorizedBy) return true;
	if (isOwner(authorizedBy) && (actor.role === 'owner' || isOwner(actor.id))) return true;
	const sharing = grant.sharing ?? { mode: 'owner' };
	if (sharing.mode === 'members') return actor.role === 'owner' || actor.role === 'member';
	if (sharing.mode === 'people') return (sharing.people ?? []).includes(actor.id);
	return false;
}

/**
 * The message an agent gets when the person it acts for may not use a grant,
 * e.g. "Info's Google Calendar isn't shared with you. Ask Info for what you
 * need, or ask the Crewly owner to share it in Connections."
 *
 * @param what - What was asked for ("Google Calendar", "Canva")
 * @param authorizedBy - Person who owns the grant, when Cloud said
 * @returns English message
 */
export function notPermittedMessage(what: string, authorizedBy?: string | null): string {
	let name: string | null = null;
	let ownerGrant = false;
	if (authorizedBy) {
		try {
			const people = getPeopleDirectory();
			ownerGrant = people.isOwner(authorizedBy);
			const display = people.displayName(authorizedBy);
			name = display === 'the owner' ? null : display;
		} catch {
			name = null;
		}
	}
	if (ownerGrant) {
		const who = name ?? 'the owner';
		return `${name ? `${name}'s` : "The owner's"} ${what} isn't shared with you. Ask ${who} to share it in Connections.`;
	}
	if (name) return `${name}'s ${what} isn't shared with you. Ask ${name} for what you need, or ask the Crewly owner to share it in Connections.`;
	return `This ${what} isn't shared with you. Ask the Crewly owner to share it in Connections.`;
}

/** Display names of Google products, for refusals. */
export const GOOGLE_PRODUCT_LABELS: Readonly<Record<string, string>> = {
	gmail: 'Gmail',
	calendar: 'Google Calendar',
	drive: 'Google Drive',
	docs: 'Google Docs',
	sheets: 'Google Sheets',
	slides: 'Google Slides',
};

/**
 * Read Cloud's refusal from a failed response body.
 *
 * @param body - Parsed body (untrusted)
 * @returns `{ authorizedBy }` when it is a `not_permitted` refusal, else null
 */
export function readNotPermitted(body: unknown): { authorizedBy?: string } | null {
	if (!body || typeof body !== 'object') return null;
	const b = body as { code?: unknown; error?: unknown; details?: unknown };
	if (b.code !== PEOPLE_CONSTANTS.NOT_PERMITTED_CODE && b.error !== PEOPLE_CONSTANTS.NOT_PERMITTED_CODE) return null;
	const details = b.details && typeof b.details === 'object' ? (b.details as { authorizedBy?: unknown }) : {};
	return typeof details.authorizedBy === 'string' ? { authorizedBy: details.authorizedBy } : {};
}
