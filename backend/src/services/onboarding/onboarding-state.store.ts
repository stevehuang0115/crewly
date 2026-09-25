/**
 * Onboarding state store — `<crewlyHome>/onboarding.json`.
 *
 * Holds the few things the first-run checklist cannot read from the rest of
 * the system (specs/onboarding-harness-login.md, Phase 3):
 *
 * - `dismissedAt`: the owner hid the dashboard checklist card;
 * - `blankChosenAt`: the owner chose "Blank" (the orchestrator only), which
 *   completes the team step without a team;
 * - `firstTask`: a first task that was handed to the orchestrator;
 * - `pendingFirstTask`: a first task typed in `crewly onboard` while the
 *   backend was down, delivered when the backend starts.
 *
 * Everything else (harness login, teams, Cloud, Slack) is read live.
 * Writes are atomic (temp file + rename) and serialized per store.
 *
 * @module services/onboarding/onboarding-state.store
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { ONBOARDING_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/** A first task handed to the orchestrator. */
export interface SentFirstTask {
	/** ISO time it was handed over */
	sentAt: string;
	/** Team it was meant for (null = the orchestrator itself) */
	teamId: string | null;
	/** Chat conversation it was recorded in */
	conversationId: string | null;
}

/** A first task waiting for the backend to start. */
export interface PendingFirstTask {
	/** The owner's words */
	text: string;
	/** Team it is meant for (null = the orchestrator itself) */
	teamId: string | null;
	/** ISO time it was typed */
	createdAt: string;
}

/** Contents of `onboarding.json`. */
export interface OnboardingState {
	dismissedAt: string | null;
	blankChosenAt: string | null;
	firstTask: SentFirstTask | null;
	pendingFirstTask: PendingFirstTask | null;
}

/** State of a machine that never saw onboarding. */
export const EMPTY_ONBOARDING_STATE: OnboardingState = Object.freeze({
	dismissedAt: null,
	blankChosenAt: null,
	firstTask: null,
	pendingFirstTask: null,
});

/**
 * Read an ISO string field, or null.
 *
 * @param value - Candidate
 * @returns The string, or null
 */
function asString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Normalize parsed JSON into a complete state (unknown / malformed fields are dropped).
 *
 * @param raw - Parsed file contents
 * @returns A complete state
 */
export function normalizeOnboardingState(raw: unknown): OnboardingState {
	if (!raw || typeof raw !== 'object') return { ...EMPTY_ONBOARDING_STATE };
	const o = raw as Record<string, unknown>;
	const task = o.firstTask as Record<string, unknown> | null | undefined;
	const pending = o.pendingFirstTask as Record<string, unknown> | null | undefined;
	return {
		dismissedAt: asString(o.dismissedAt),
		blankChosenAt: asString(o.blankChosenAt),
		firstTask:
			task && typeof task === 'object' && asString(task.sentAt)
				? { sentAt: task.sentAt as string, teamId: asString(task.teamId), conversationId: asString(task.conversationId) }
				: null,
		pendingFirstTask:
			pending && typeof pending === 'object' && asString(pending.text) && asString(pending.createdAt)
				? { text: pending.text as string, teamId: asString(pending.teamId), createdAt: pending.createdAt as string }
				: null,
	};
}

/**
 * File-backed onboarding state.
 */
export class OnboardingStateStore {
	private readonly filePath: string;
	/** Serializes read-modify-write cycles */
	private chain: Promise<unknown> = Promise.resolve();

	/**
	 * @param crewlyHome - Crewly home dir (defaults to `CREWLY_HOME` / `~/.crewly`)
	 */
	constructor(crewlyHome: string = getCrewlyHomePath()) {
		this.filePath = path.join(crewlyHome, ONBOARDING_CONSTANTS.STATE_FILE);
	}

	/**
	 * Path of the state file.
	 *
	 * @returns Absolute path
	 */
	getFilePath(): string {
		return this.filePath;
	}

	/**
	 * Read the state. A missing or unreadable file reads as empty.
	 *
	 * @returns The state
	 */
	async read(): Promise<OnboardingState> {
		try {
			return normalizeOnboardingState(JSON.parse(await fs.readFile(this.filePath, 'utf-8')));
		} catch {
			return { ...EMPTY_ONBOARDING_STATE };
		}
	}

	/**
	 * Apply a change and write the result atomically.
	 *
	 * @param change - Returns the fields to change
	 * @returns The state after the change
	 *
	 * @example
	 * ```ts
	 * await store.update(() => ({ dismissedAt: new Date().toISOString() }));
	 * ```
	 */
	update(change: (current: OnboardingState) => Partial<OnboardingState>): Promise<OnboardingState> {
		const run = async (): Promise<OnboardingState> => {
			const current = await this.read();
			const next: OnboardingState = { ...current, ...change(current) };
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
			await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
			await fs.rename(tmp, this.filePath);
			return next;
		};
		const result = this.chain.then(run, run);
		this.chain = result.catch(() => undefined);
		return result;
	}
}
