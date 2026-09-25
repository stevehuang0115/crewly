/**
 * Kickoff text for an agent whose runtime conversation was resumed
 * (Claude Code `--resume`, Codex `resume`) at a Crewly restart.
 *
 * The full kickoff ("Begin your work now… Step 1, Step 2, Step 3
 * (register-self)") typed into a resumed conversation reads, to the agent, as
 * being started over from scratch. Every release restart used to do that, and
 * agents re-announced themselves and redid their startup steps (2026-09-25
 * startup-prompt loop). A resumed agent only needs to register again, since
 * the backend's registration state did not survive the restart, and then carry on.
 *
 * @module services/agent/resumed-kickoff
 */

import path from 'path';
import { ORCHESTRATOR_ROLE } from '../../constants.js';

/** Where the register-self skill lives, relative to the Crewly project root. */
export const REGISTER_SELF_SKILL_PATHS = {
	/** Team members: config/skills/agent/core/register-self */
	AGENT: ['config', 'skills', 'agent', 'core', 'register-self', 'execute.sh'],
	/** Orchestrator: config/skills/orchestrator/register-self */
	ORCHESTRATOR: ['config', 'skills', 'orchestrator', 'register-self', 'execute.sh'],
} as const;

/** Fixed wording of the resumed kickoff. */
export const RESUMED_KICKOFF_TEXT = {
	OPENING: '[Crewly restarted — this is your same conversation, resumed.',
	REGISTER: 'Run register-self now (only that step):',
	CONTINUE: '— then continue exactly where you left off. Do not redo your startup steps or re-announce yourself.',
	/** Only for runtimes whose instructions are not loaded as a system prompt. */
	CONTEXT_REFRESH: 'If your instructions are no longer in your context, re-read',
	CLOSING: ']',
} as const;

/**
 * Marker that identifies a resumed kickoff, for tests and log checks.
 */
export const RESUMED_KICKOFF_MARKER = RESUMED_KICKOFF_TEXT.OPENING;

/**
 * Build the exact register-self command the agent's full prompt tells it to
 * run, so a resumed agent registers the same way a fresh one does.
 *
 * @param projectRoot - Crewly project root (where `config/skills` lives)
 * @param sessionName - The agent's session name
 * @param role - The agent's role
 * @returns A shell command line
 *
 * @example
 * ```typescript
 * buildRegisterSelfCommand('/opt/crewly', 'team-sam-1', 'developer');
 * // bash /opt/crewly/config/skills/agent/core/register-self/execute.sh '{"role":"developer","sessionName":"team-sam-1"}'
 * ```
 */
export function buildRegisterSelfCommand(projectRoot: string, sessionName: string, role: string): string {
	const segments = role === ORCHESTRATOR_ROLE ? REGISTER_SELF_SKILL_PATHS.ORCHESTRATOR : REGISTER_SELF_SKILL_PATHS.AGENT;
	const script = path.join(projectRoot, ...segments);
	return `bash ${script} '${JSON.stringify({ role, sessionName })}'`;
}

/**
 * Build the short kickoff for a resumed conversation.
 *
 * @param args.projectRoot - Crewly project root
 * @param args.sessionName - The agent's session name
 * @param args.role - The agent's role
 * @param args.promptFilePath - Init prompt file to point at for a context refresh.
 *   Omit for Claude Code, whose prompt is loaded as its agent definition.
 * @returns The single-line message to type into the runtime
 */
export function buildResumedKickoff(args: {
	projectRoot: string;
	sessionName: string;
	role: string;
	promptFilePath?: string;
}): string {
	const command = buildRegisterSelfCommand(args.projectRoot, args.sessionName, args.role);
	const refresh = args.promptFilePath ? ` ${RESUMED_KICKOFF_TEXT.CONTEXT_REFRESH} ${args.promptFilePath}.` : '';
	return (
		`${RESUMED_KICKOFF_TEXT.OPENING} ${RESUMED_KICKOFF_TEXT.REGISTER} ${command} ` +
		`${RESUMED_KICKOFF_TEXT.CONTINUE}${refresh}${RESUMED_KICKOFF_TEXT.CLOSING}`
	);
}
