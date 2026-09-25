/**
 * Onboarding checklist — the first-run steps after the harness is ready
 * (specs/onboarding-harness-login.md, Phase 3):
 *
 *   harness → first team (starter template or Blank) → first task → Cloud → Slack
 *
 * Every step's `done` is read from the real system, not from UI flags:
 *
 * - `harness`: the orchestrator's harness is recorded, installed and not
 *   known to be logged out (the same rule as the web setup redirect);
 * - `team`: at least one team exists, or the owner chose Blank;
 * - `first_task`: the owner has sent at least one message on any surface
 *   (chat-v2 `user` rows an agent did not write), or a first task was handed
 *   to the orchestrator from setup;
 * - `cloud`: this instance is connected to Crewly Cloud;
 * - `slack`: Slack is connected (Cloud-installed app or self-hosted tokens).
 *
 * The only stored flags are the dashboard card's `dismissed`, the Blank
 * choice and the first-task record (`onboarding-state.store.ts`).
 *
 * Shared by the REST routes (`/api/onboarding/*`, also reachable from the
 * phone / portal over the relay) and `crewly onboard`.
 *
 * @module services/onboarding/onboarding-checklist.service
 */

import { ONBOARDING_CONSTANTS, HARNESS_CONSTANTS, CLOUD_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { TeamTemplate, TemplateOnboarding } from '../../types/team-template.types.js';
import type { CreateFromTemplateResult } from '../template/template.service.js';
import { OnboardingStateStore, type OnboardingState } from './onboarding-state.store.js';

// =============================================================================
// Types
// =============================================================================

/** Checklist step ids, in display order. */
export type ChecklistStepId = 'harness' | 'team' | 'first_task' | 'cloud' | 'slack';

/** Harness step detail. */
export interface HarnessStepDetail {
	/** The orchestrator's harness (null until chosen) */
	orcHarness: string | null;
	installed: boolean;
	loginState: 'logged_in' | 'logged_out' | 'unknown' | null;
	error?: string;
}

/** Team step detail. */
export interface TeamStepDetail {
	teams: Array<{ id: string; name: string; templateId: string | null }>;
	/** The owner chose Blank (the orchestrator only) */
	blank: boolean;
	error?: string;
}

/** First-task step detail. */
export interface FirstTaskStepDetail {
	/** When setup handed a first task to the orchestrator */
	sentAt: string | null;
	/** The owner has written to Crewly on some surface */
	ownerMessageSeen: boolean;
	/** A first task from `crewly onboard` waits for the backend */
	pending: boolean;
	error?: string;
}

/** Cloud step detail. */
export interface CloudStepDetail {
	connected: boolean;
	tier: string | null;
	/**
	 * Phone-friendly sign-in: Google sign-in on Crewly Cloud that ends on the
	 * portal's token page, whose token + refresh token are pasted back into
	 * setup (`POST /api/cloud/connect`).
	 */
	tokenPageSignInUrl: string;
	error?: string;
}

/** Slack step detail. */
export interface SlackStepDetail {
	connected: boolean;
	/** Slack is installed through Crewly Cloud, so Cloud comes first */
	cloudConnected: boolean;
	error?: string;
}

/** One checklist step. */
export type ChecklistStep =
	| { id: 'harness'; done: boolean; detail: HarnessStepDetail }
	| { id: 'team'; done: boolean; detail: TeamStepDetail }
	| { id: 'first_task'; done: boolean; detail: FirstTaskStepDetail }
	| { id: 'cloud'; done: boolean; detail: CloudStepDetail }
	| { id: 'slack'; done: boolean; detail: SlackStepDetail };

/** `GET /api/onboarding/checklist` payload. */
export interface OnboardingChecklist {
	steps: ChecklistStep[];
	doneCount: number;
	total: number;
	allDone: boolean;
	/** The owner hid the dashboard card */
	dismissed: boolean;
	dismissedAt: string | null;
}

/** A starter team the owner can pick (a template, or Blank). */
export interface OnboardingStarter {
	/** Template id, or `blank` */
	id: string;
	name: string;
	/** Short Chinese display name */
	label: string;
	tagline: string;
	description: string;
	recommended: boolean;
	members: Array<{ name: string; role: string }>;
	/** Example first tasks */
	suggestions: string[];
}

/** Result of creating the starter team. */
export interface StarterTeamResult {
	starterId: string;
	/** The team (null for Blank) */
	team: Team | null;
	/** False when a team from this starter already existed */
	created: boolean;
}

/** Result of handing over the first task. */
export interface FirstTaskResult {
	/** True when the orchestrator received it or it is queued for it */
	forwarded: boolean;
	/** Queued until the orchestrator is online */
	queued: boolean;
	conversationId: string | null;
	teamId: string | null;
	sentAt: string | null;
	/** Why it was not forwarded, or a note (e.g. orchestrator offline) */
	message: string | null;
}

/** Error codes of this service. */
export type OnboardingErrorCode = 'unknown_starter' | 'invalid_task' | 'unknown_team';

/** A request the checklist cannot fulfil. */
export class OnboardingError extends Error {
	/**
	 * @param code - Machine-readable code (mapped to an HTTP status by the controller)
	 * @param message - Human-readable message
	 */
	constructor(readonly code: OnboardingErrorCode, message: string) {
		super(message);
		this.name = 'OnboardingError';
	}
}

/** The template operations the checklist needs. */
export interface StarterTemplateSource {
	listOnboardingStarters(): TeamTemplate[];
	getTemplate(id: string): TeamTemplate | null;
	createTeamFromTemplate(templateId: string, teamName: string): CreateFromTemplateResult | null;
}

/** What handing a message to the orchestrator returns. */
export interface OrchestratorSendResult {
	conversationId: string | null;
	forwarded: boolean;
	queued: boolean;
	error: string | null;
}

/** Dependencies (all injectable for tests). */
export interface OnboardingChecklistDeps {
	store: OnboardingStateStore;
	/** Harness step */
	getHarnessState(): Promise<HarnessStepDetail>;
	listTeams(): Promise<Team[]>;
	saveTeam(team: Team): Promise<void>;
	templates(): StarterTemplateSource;
	/** The orchestrator's harness, used as the runtime of new starter members */
	getOrcHarness(): Promise<string | null>;
	/** Whether the owner has written on any surface */
	hasOwnerMessage(): boolean;
	getCloudState(): { connected: boolean; tier: string | null };
	isSlackConnected(): boolean;
	/** Record the owner's message and hand it to the orchestrator */
	sendToOrchestrator(content: string, metadata: Record<string, unknown>): Promise<OrchestratorSendResult>;
	now(): Date;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Lower-case slug of ASCII letters, digits and dashes.
 *
 * @param value - Any text
 * @returns Slug (may be empty for non-ASCII text)
 */
export function toSessionSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * The Crewly Cloud sign-in that works from any device: Google sign-in on
 * Cloud, ending on the portal's token page (token + refresh token to paste).
 *
 * @returns Absolute URL
 */
export function buildTokenPageSignInUrl(): string {
	const tokenPage = `${ONBOARDING_CONSTANTS.CLOUD.CONSOLE_URL}${ONBOARDING_CONSTANTS.CLOUD.CLI_TOKEN_PATH}`;
	return `${CLOUD_CONSTANTS.DEFAULT_CLOUD_URL}${ONBOARDING_CONSTANTS.CLOUD.GOOGLE_START_PATH}?redirect=${encodeURIComponent(tokenPage)}`;
}

/**
 * The message the orchestrator receives for a first task.
 *
 * @param text - The owner's words
 * @param team - Team it is meant for, or null for the orchestrator itself
 * @returns Message content
 */
export function buildFirstTaskMessage(text: string, team: Pick<Team, 'id' | 'name'> | null): string {
	const lines: string[] = [ONBOARDING_CONSTANTS.FIRST_TASK_HEADER];
	if (team) {
		lines.push(`请交给团队「${team.name}」(team id: ${team.id}) 来做；团队还没启动的话先启动它。`);
	}
	lines.push('', text.trim());
	return lines.join('\n');
}

/**
 * Starter DTO for a template.
 *
 * @param template - Template with onboarding metadata
 * @param onboarding - Its onboarding metadata
 * @returns Starter
 */
function templateToStarter(template: TeamTemplate, onboarding: TemplateOnboarding): OnboardingStarter {
	return {
		id: template.id,
		name: template.name,
		label: onboarding.label,
		tagline: onboarding.tagline,
		description: template.description,
		recommended: onboarding.recommended,
		members: template.roles.flatMap((role) =>
			Array.from({ length: Math.max(1, role.count) }, (_, i) => ({
				name: role.count > 1 ? `${role.defaultName}${i + 1}` : role.defaultName,
				role: role.role,
			})),
		),
		suggestions: [...onboarding.suggestions],
	};
}

/**
 * Error text for a failed step read.
 *
 * @param error - Thrown value
 * @returns Message
 */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// =============================================================================
// Service
// =============================================================================

/**
 * First-run checklist: step states, starter teams, the first task, dismissal.
 */
export class OnboardingChecklistService {
	/**
	 * @param deps - Dependencies
	 */
	constructor(private readonly deps: OnboardingChecklistDeps) {}

	/**
	 * Read every step from the live system.
	 *
	 * A step whose source fails reads as not done, with `detail.error` set;
	 * the rest of the checklist is still returned.
	 *
	 * @returns The checklist
	 */
	async getChecklist(): Promise<OnboardingChecklist> {
		const state = await this.deps.store.read();
		const steps: ChecklistStep[] = await Promise.all([
			this.harnessStep(),
			this.teamStep(state),
			this.firstTaskStep(state),
			this.cloudStep(),
			this.slackStep(),
		]);
		const doneCount = steps.filter((s) => s.done).length;
		return {
			steps,
			doneCount,
			total: steps.length,
			allDone: doneCount === steps.length,
			dismissed: state.dismissedAt !== null,
			dismissedAt: state.dismissedAt,
		};
	}

	/**
	 * The starter teams: templates marked `onboarding` (by `order`), then Blank.
	 *
	 * @returns Starters, recommended first
	 */
	listStarters(): OnboardingStarter[] {
		const starters = this.deps
			.templates()
			.listOnboardingStarters()
			.filter((t): t is TeamTemplate & { onboarding: TemplateOnboarding } => !!t.onboarding)
			.map((t) => templateToStarter(t, t.onboarding));
		const blank = ONBOARDING_CONSTANTS.BLANK_STARTER;
		starters.push({
			id: ONBOARDING_CONSTANTS.BLANK_STARTER_ID,
			name: blank.NAME,
			label: blank.LABEL,
			tagline: blank.TAGLINE,
			description: blank.TAGLINE,
			recommended: false,
			members: [],
			suggestions: [...blank.SUGGESTIONS],
		});
		return starters;
	}

	/**
	 * Create the first team from a starter, or record the Blank choice.
	 *
	 * Idempotent: a team already created from the same template is returned
	 * (a double tap on a phone must not make two teams). Members run on the
	 * orchestrator's harness, the only one first-time setup installs.
	 *
	 * @param starterId - Template id of a starter, or `blank`
	 * @returns The team (null for Blank) and whether it was created now
	 * @throws OnboardingError `unknown_starter`
	 */
	async createStarterTeam(starterId: string): Promise<StarterTeamResult> {
		if (starterId === ONBOARDING_CONSTANTS.BLANK_STARTER_ID) {
			const now = this.deps.now().toISOString();
			await this.deps.store.update((cur) => ({ blankChosenAt: cur.blankChosenAt ?? now }));
			return { starterId, team: null, created: false };
		}
		const source = this.deps.templates();
		const template = source.getTemplate(starterId);
		if (!template || !template.onboarding) {
			throw new OnboardingError('unknown_starter', `"${starterId}" is not a starter team`);
		}
		const existing = (await this.deps.listTeams()).find((t) => t.templateId === template.id);
		if (existing) return { starterId, team: existing, created: false };

		const result = source.createTeamFromTemplate(template.id, template.name);
		if (!result) throw new OnboardingError('unknown_starter', `"${starterId}" is not a starter team`);
		const runtime = (await this.deps.getOrcHarness()) ?? HARNESS_CONSTANTS.DEFAULT_ORC_HARNESS;
		const teamSlug = toSessionSlug(template.id);
		for (const member of result.team.members) {
			member.runtimeType = runtime as typeof member.runtimeType;
			member.sessionName = `${teamSlug}-${toSessionSlug(member.name) || 'member'}-${member.id.slice(0, 8)}`;
		}
		await this.deps.saveTeam(result.team);
		return { starterId, team: result.team, created: true };
	}

	/**
	 * Hand the owner's first task to the orchestrator (through the chat path,
	 * so it is a normal owner message: ticket intake, queue while offline).
	 *
	 * @param text - The owner's words
	 * @param teamId - Team it is meant for (omit for the orchestrator itself)
	 * @returns Delivery result
	 * @throws OnboardingError `invalid_task` | `unknown_team`
	 */
	async sendFirstTask(text: unknown, teamId?: unknown): Promise<FirstTaskResult> {
		if (typeof text !== 'string' || text.trim().length === 0) {
			throw new OnboardingError('invalid_task', 'Write what the team should do first');
		}
		if (text.length > ONBOARDING_CONSTANTS.FIRST_TASK_MAX_LENGTH) {
			throw new OnboardingError('invalid_task', `Keep the first task under ${ONBOARDING_CONSTANTS.FIRST_TASK_MAX_LENGTH} characters`);
		}
		let team: Team | null = null;
		if (teamId !== undefined && teamId !== null && teamId !== '') {
			team = (await this.deps.listTeams()).find((t) => t.id === teamId) ?? null;
			if (!team) throw new OnboardingError('unknown_team', `Team "${String(teamId)}" not found`);
		}
		const sent = await this.deps.sendToOrchestrator(buildFirstTaskMessage(text, team), {
			source: ONBOARDING_CONSTANTS.FIRST_TASK_SOURCE,
			...(team ? { teamId: team.id } : {}),
		});
		let sentAt: string | null = null;
		if (sent.forwarded) {
			sentAt = this.deps.now().toISOString();
			const record = { sentAt, teamId: team?.id ?? null, conversationId: sent.conversationId };
			await this.deps.store.update(() => ({ firstTask: record, pendingFirstTask: null }));
		}
		return {
			forwarded: sent.forwarded,
			queued: sent.queued,
			conversationId: sent.conversationId,
			teamId: team?.id ?? null,
			sentAt,
			message: sent.error,
		};
	}

	/**
	 * Keep a first task typed while the backend was down (`crewly onboard`).
	 *
	 * @param text - The owner's words
	 * @param teamId - Team it is meant for, or null
	 * @throws OnboardingError `invalid_task`
	 */
	async queuePendingFirstTask(text: string, teamId: string | null): Promise<void> {
		if (text.trim().length === 0 || text.length > ONBOARDING_CONSTANTS.FIRST_TASK_MAX_LENGTH) {
			throw new OnboardingError('invalid_task', 'Write what the team should do first');
		}
		const createdAt = this.deps.now().toISOString();
		await this.deps.store.update(() => ({ pendingFirstTask: { text: text.trim(), teamId, createdAt } }));
	}

	/**
	 * Deliver a pending first task (called when the backend starts). A team
	 * that no longer exists sends it to the orchestrator itself.
	 *
	 * @returns The delivery result, or null when nothing was pending
	 */
	async deliverPendingFirstTask(): Promise<FirstTaskResult | null> {
		const { pendingFirstTask } = await this.deps.store.read();
		if (!pendingFirstTask) return null;
		const teams = await this.deps.listTeams();
		const teamId = pendingFirstTask.teamId && teams.some((t) => t.id === pendingFirstTask.teamId) ? pendingFirstTask.teamId : undefined;
		return this.sendFirstTask(pendingFirstTask.text, teamId);
	}

	/**
	 * Hide or show the dashboard checklist card.
	 *
	 * @param dismissed - True to hide
	 * @returns The checklist after the change
	 */
	async setDismissed(dismissed: boolean): Promise<OnboardingChecklist> {
		const now = this.deps.now().toISOString();
		await this.deps.store.update((cur) => ({ dismissedAt: dismissed ? cur.dismissedAt ?? now : null }));
		return this.getChecklist();
	}

	// ---------------------------------------------------------------------------
	// Steps
	// ---------------------------------------------------------------------------

	/** @returns Harness step */
	private async harnessStep(): Promise<ChecklistStep> {
		try {
			const detail = await this.deps.getHarnessState();
			const done = detail.orcHarness !== null && detail.installed && detail.loginState !== 'logged_out';
			return { id: 'harness', done, detail };
		} catch (error) {
			return { id: 'harness', done: false, detail: { orcHarness: null, installed: false, loginState: null, error: errorText(error) } };
		}
	}

	/**
	 * @param state - Stored onboarding state
	 * @returns Team step
	 */
	private async teamStep(state: OnboardingState): Promise<ChecklistStep> {
		const blank = state.blankChosenAt !== null;
		try {
			const teams = (await this.deps.listTeams()).map((t) => ({ id: t.id, name: t.name, templateId: t.templateId ?? null }));
			return { id: 'team', done: teams.length > 0 || blank, detail: { teams, blank } };
		} catch (error) {
			return { id: 'team', done: blank, detail: { teams: [], blank, error: errorText(error) } };
		}
	}

	/**
	 * @param state - Stored onboarding state
	 * @returns First-task step
	 */
	private async firstTaskStep(state: OnboardingState): Promise<ChecklistStep> {
		const sentAt = state.firstTask?.sentAt ?? null;
		const pending = state.pendingFirstTask !== null;
		try {
			const ownerMessageSeen = this.deps.hasOwnerMessage();
			return { id: 'first_task', done: sentAt !== null || ownerMessageSeen, detail: { sentAt, ownerMessageSeen, pending } };
		} catch (error) {
			return { id: 'first_task', done: sentAt !== null, detail: { sentAt, ownerMessageSeen: false, pending, error: errorText(error) } };
		}
	}

	/** @returns Cloud step */
	private async cloudStep(): Promise<ChecklistStep> {
		const tokenPageSignInUrl = buildTokenPageSignInUrl();
		try {
			const { connected, tier } = this.deps.getCloudState();
			return { id: 'cloud', done: connected, detail: { connected, tier: connected ? tier : null, tokenPageSignInUrl } };
		} catch (error) {
			return { id: 'cloud', done: false, detail: { connected: false, tier: null, tokenPageSignInUrl, error: errorText(error) } };
		}
	}

	/** @returns Slack step */
	private async slackStep(): Promise<ChecklistStep> {
		let cloudConnected = false;
		try {
			cloudConnected = this.deps.getCloudState().connected;
		} catch {
			// Reported by the Cloud step.
		}
		try {
			const connected = this.deps.isSlackConnected();
			return { id: 'slack', done: connected, detail: { connected, cloudConnected } };
		} catch (error) {
			return { id: 'slack', done: false, detail: { connected: false, cloudConnected, error: errorText(error) } };
		}
	}
}
