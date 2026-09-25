/**
 * Harness registry — static definitions of the agent CLIs Crewly can set up.
 *
 * One entry per harness: display name, binary, npm package, how to print the
 * version, and the login methods Crewly offers. A `broker` method names the
 * harness's own login command, which the login broker runs in a PTY; an
 * `api_key` method is a pasted key. Gemini CLI is detect-only (no methods).
 *
 * @module services/harness/harness-registry
 */

import { HARNESS_CONSTANTS } from '../../constants.js';
import type { HarnessId, HarnessLoginMethod, LoginMethodId, LoginMethodKind } from './harness.types.js';
import { isHarnessId } from './harness.types.js';

/** The command a broker login method runs. */
export interface BrokerCommand {
	/** Binary (resolved on the harness PATH) */
	command: string;
	args: readonly string[];
}

/** A login method definition (internal: includes the broker command). */
export interface LoginMethodDefinition {
	id: LoginMethodId;
	label: string;
	kind: LoginMethodKind;
	/** Command run by the login broker (kind `broker` only) */
	broker?: BrokerCommand;
}

/** Static facts about one harness. */
export interface HarnessDefinition {
	id: HarnessId;
	displayName: string;
	/** Binary name on PATH */
	command: string;
	npmPackage: string;
	/** Arguments that print the version */
	versionArgs: readonly string[];
	loginMethods: readonly LoginMethodDefinition[];
}

/** Every harness Crewly knows, in display order (default first). */
export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
	{
		id: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		displayName: 'Claude Code',
		command: 'claude',
		npmPackage: '@anthropic-ai/claude-code',
		versionArgs: ['--version'],
		loginMethods: [
			{
				id: 'subscription',
				label: 'Claude subscription (Pro / Max)',
				kind: 'broker',
				broker: { command: 'claude', args: ['setup-token'] },
			},
			{ id: 'api_key', label: 'Anthropic API key', kind: 'api_key' },
		],
	},
	{
		id: HARNESS_CONSTANTS.IDS.CODEX_CLI,
		displayName: 'Codex',
		command: 'codex',
		npmPackage: '@openai/codex',
		versionArgs: ['--version'],
		loginMethods: [
			{
				id: 'device',
				label: 'ChatGPT account (device code)',
				kind: 'broker',
				broker: { command: 'codex', args: ['login', '--device-auth'] },
			},
			{ id: 'api_key', label: 'OpenAI API key', kind: 'api_key' },
		],
	},
	{
		id: HARNESS_CONSTANTS.IDS.GEMINI_CLI,
		displayName: 'Gemini CLI',
		command: 'gemini',
		npmPackage: '@google/gemini-cli',
		versionArgs: ['--version'],
		loginMethods: [],
	},
];

/**
 * All harness definitions.
 *
 * @returns The registry, in display order
 */
export function listHarnessDefinitions(): readonly HarnessDefinition[] {
	return HARNESS_DEFINITIONS;
}

/**
 * Look up a harness definition.
 *
 * @param id - Harness id
 * @returns The definition, or undefined for an unknown id
 */
export function getHarnessDefinition(id: string): HarnessDefinition | undefined {
	return HARNESS_DEFINITIONS.find((def) => def.id === id);
}

/**
 * Look up one login method of a harness.
 *
 * @param harnessId - Harness id
 * @param methodId - Login method id
 * @returns The method, or undefined when the harness does not offer it
 */
export function getLoginMethod(harnessId: string, methodId: string): LoginMethodDefinition | undefined {
	return getHarnessDefinition(harnessId)?.loginMethods.find((method) => method.id === methodId);
}

/**
 * The broker login method of a harness (the first one), if any.
 *
 * @param harnessId - Harness id
 * @returns The method, or undefined when the harness has no broker login
 */
export function getBrokerLoginMethod(harnessId: string): LoginMethodDefinition | undefined {
	return getHarnessDefinition(harnessId)?.loginMethods.find((method) => method.kind === 'broker');
}

/**
 * Public view of a harness's login methods (no commands).
 *
 * @param def - Harness definition
 * @returns `{ id, label, kind }` per method
 */
export function toPublicLoginMethods(def: HarnessDefinition): HarnessLoginMethod[] {
	return def.loginMethods.map(({ id, label, kind }) => ({ id, label, kind }));
}

/**
 * Resolve a harness id from a full id or a short CLI alias.
 *
 * @param value - `claude-code`, `claude`, `codex-cli`, `codex`, `gemini-cli` or `gemini` (case-insensitive)
 * @returns The harness id, or null when unknown
 *
 * @example
 * ```ts
 * resolveHarnessAlias('codex'); // 'codex-cli'
 * ```
 */
export function resolveHarnessAlias(value: string | undefined | null): HarnessId | null {
	if (!value) return null;
	const key = value.trim().toLowerCase();
	if (isHarnessId(key)) return key;
	const aliases: Record<string, HarnessId> = HARNESS_CONSTANTS.CLI_ALIASES;
	return aliases[key] ?? null;
}
