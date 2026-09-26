/**
 * Harness registry — static definitions of the agent CLIs Crewly can set up.
 *
 * One entry per harness: display name, binary, how it is installed (an npm
 * package, or the vendor's official install script), how to print the
 * version, and the login methods Crewly offers. A `broker` method names the
 * harness's own login command, which the login broker runs in a PTY; an
 * `api_key` method is a pasted key.
 *
 * - Antigravity CLI is **API key only**: Google does not allow third-party
 *   tools to use Antigravity product OAuth, so there is deliberately no
 *   broker method for it (specs/antigravity-runtime.md).
 * - Gemini CLI is detect-only (no methods) and retired: kept working for
 *   existing / enterprise users, not offered to new ones.
 *
 * @module services/harness/harness-registry
 */

import { ANTIGRAVITY_CONSTANTS, HARNESS_CONSTANTS } from '../../constants.js';
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

/** Installed with `npm install -g <package>@latest` (user-prefix fallback on EACCES). */
export interface NpmInstallSpec {
	kind: 'npm';
	npmPackage: string;
}

/**
 * Installed with the vendor's official shell installer, downloaded over
 * https from exactly `scriptUrl` and run with bash. An installed binary is
 * updated with `<binary> <updateArgs>` instead.
 */
export interface ScriptInstallSpec {
	kind: 'script';
	scriptUrl: string;
	updateArgs: readonly string[];
}

/** How a harness is installed. */
export type HarnessInstallSpec = NpmInstallSpec | ScriptInstallSpec;

/** Static facts about one harness. */
export interface HarnessDefinition {
	id: HarnessId;
	displayName: string;
	/** Binary name on PATH */
	command: string;
	install: HarnessInstallSpec;
	/** Arguments that print the version */
	versionArgs: readonly string[];
	loginMethods: readonly LoginMethodDefinition[];
	/** Not offered to new users (see HARNESS_CONSTANTS.RETIRED_IDS) */
	retired: boolean;
}

/** Every harness Crewly knows, in display order (default first). */
export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
	{
		id: HARNESS_CONSTANTS.IDS.CLAUDE_CODE,
		displayName: 'Claude Code',
		command: 'claude',
		install: { kind: 'npm', npmPackage: '@anthropic-ai/claude-code' },
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
		retired: false,
	},
	{
		id: HARNESS_CONSTANTS.IDS.CODEX_CLI,
		displayName: 'Codex',
		command: 'codex',
		install: { kind: 'npm', npmPackage: '@openai/codex' },
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
		retired: false,
	},
	{
		id: HARNESS_CONSTANTS.IDS.ANTIGRAVITY_CLI,
		displayName: 'Antigravity CLI',
		command: ANTIGRAVITY_CONSTANTS.BINARY,
		install: {
			kind: 'script',
			scriptUrl: ANTIGRAVITY_CONSTANTS.INSTALL_SCRIPT_URL,
			updateArgs: ANTIGRAVITY_CONSTANTS.UPDATE_ARGS,
		},
		versionArgs: ['--version'],
		// API key only — never a broker/OAuth login (Google policy).
		loginMethods: [{ id: 'api_key', label: 'Gemini API key', kind: 'api_key' }],
		retired: false,
	},
	{
		id: HARNESS_CONSTANTS.IDS.GEMINI_CLI,
		displayName: 'Gemini CLI',
		command: 'gemini',
		install: { kind: 'npm', npmPackage: '@google/gemini-cli' },
		versionArgs: ['--version'],
		loginMethods: [],
		retired: HARNESS_CONSTANTS.RETIRED_IDS.includes(HARNESS_CONSTANTS.IDS.GEMINI_CLI),
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
 * The install command a person would run by hand, for hints and prompts.
 *
 * @param def - Harness definition
 * @returns e.g. `npm install -g @openai/codex` or `curl -fsSL https://antigravity.google/cli/install.sh | bash`
 */
export function describeInstallCommand(def: HarnessDefinition): string {
	return def.install.kind === 'npm'
		? `npm install -g ${def.install.npmPackage}`
		: `curl -fsSL ${def.install.scriptUrl} | ${HARNESS_CONSTANTS.ANTIGRAVITY.INSTALL_SHELL}`;
}

/**
 * Whether a harness is retired (kept for existing users, hidden from new ones).
 *
 * @param id - Harness id
 * @returns True for a retired harness
 */
export function isRetiredHarness(id: string): boolean {
	return getHarnessDefinition(id)?.retired === true;
}

/**
 * Resolve a harness id from a full id or a short CLI alias.
 *
 * @param value - `claude-code`, `claude`, `codex-cli`, `codex`, `antigravity-cli`,
 *   `antigravity`, `agy`, `gemini-cli` or `gemini` (case-insensitive)
 * @returns The harness id, or null when unknown
 *
 * @example
 * ```ts
 * resolveHarnessAlias('agy'); // 'antigravity-cli'
 * ```
 */
export function resolveHarnessAlias(value: string | undefined | null): HarnessId | null {
	if (!value) return null;
	const key = value.trim().toLowerCase();
	if (isHarnessId(key)) return key;
	const aliases: Record<string, HarnessId> = HARNESS_CONSTANTS.CLI_ALIASES;
	return aliases[key] ?? null;
}
