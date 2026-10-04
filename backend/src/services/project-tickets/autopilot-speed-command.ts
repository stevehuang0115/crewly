/**
 * Switch a project's autopilot speed from the owner's DM with the orc
 * (specs/2026-10-04-autopilot-speed-modes.md §5). Handled by the backend as
 * an owner command — never by the orc's LLM — and only for the owner's own
 * messages in their DM with the orc (the team pause command's pattern):
 *
 * - `set <project> to rush` / `set <project> autopilot to chill`
 * - `switch <project> to normal` / `put <project> in rush mode`
 * - `<project> rush` / `<project> chill mode`
 * - Chinese: `<project> 切到 rush`, `把 <project> 切换到 chill`,
 *   `<project> 改成 正常`, `<project> 调成 冲刺模式`
 * - mode words: rush / normal / chill, and 冲刺·急速·快 / 正常·普通 / 慢·慢速·悠闲·佛系
 *
 * A message is consumed only when its target names a known project (or it
 * says `set project <x> to …` explicitly); anything else goes on to the orc.
 * Replies are English (harness text rule); switching to Rush carries a
 * one-line cost warning.
 *
 * @module services/project-tickets/autopilot-speed-command
 */

import type { SlackIncomingMessage } from '../../types/slack.types.js';
import { compactTokens } from '../usage/token-format.js';
import type { AutopilotSpeedMode } from '../../types/ticket-autopilot.types.js';
import type { TicketAutopilotStatus } from './ticket-autopilot.service.js';

/** A parsed command. `target` is the project as typed. */
export interface AutopilotSpeedCommand {
	target: string;
	mode: AutopilotSpeedMode;
	/** Said "project" explicitly: answered even when no project matches */
	explicitProject: boolean;
}

/** Mode words (lower-case) → mode. */
const MODE_WORDS: Readonly<Record<string, AutopilotSpeedMode>> = {
	rush: 'rush',
	normal: 'normal',
	chill: 'chill',
	冲刺: 'rush',
	急速: 'rush',
	快: 'rush',
	快速: 'rush',
	正常: 'normal',
	普通: 'normal',
	慢: 'chill',
	慢速: 'chill',
	悠闲: 'chill',
	佛系: 'chill',
};

/** Alternation of the mode words, longest first (regex source). */
const MODE_RE = Object.keys(MODE_WORDS)
	.sort((a, b) => b.length - a.length)
	.join('|');

/**
 * Normalise a message for matching.
 *
 * @param text - Raw text
 * @returns Mentions, emphasis and trailing punctuation removed; whitespace collapsed
 */
function norm(text: string): string {
	return text
		.replace(/<@[A-Z0-9]+>/g, '')
		.replace(/[`*_]/g, '')
		.replace(/[\s.。!！~～]+$/u, '')
		.replace(/^\s*(?:please|pls|请)\s*/iu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Clean the typed project: drop "project", "the", "'s autopilot", "speed", "mode".
 *
 * @param raw - Target as typed
 * @returns Project reference and whether "project" was said
 */
function cleanTarget(raw: string): { target: string; explicitProject: boolean } {
	let t = raw.trim();
	let explicitProject = false;
	const lead = /^(?:the\s+)?(?:project\s+|项目\s*)/iu.exec(t);
	if (lead) {
		explicitProject = /project|项目/iu.test(lead[0]);
		t = t.slice(lead[0].length);
	}
	t = t
		.replace(/^the\s+/i, '')
		.replace(/(?:'s)?\s+(?:autopilot|speed|pace|mode)(?:\s+(?:speed|mode|pace))?$/i, '')
		.replace(/\s*(?:的)?(?:自动驾驶|速度|模式)$/u, '')
		.replace(/\s+project$/i, '')
		.trim();
	return { target: t, explicitProject };
}

/**
 * Parse a speed-mode command.
 *
 * @param text - Message text
 * @returns The command, or null when the message is not one
 *
 * @example
 * parseAutopilotSpeedCommand('set CE to rush') // { target: 'CE', mode: 'rush', explicitProject: false }
 * parseAutopilotSpeedCommand('CE 切到 chill') // { target: 'CE', mode: 'chill', explicitProject: false }
 */
export function parseAutopilotSpeedCommand(text: string | undefined): AutopilotSpeedCommand | null {
	if (!text) return null;
	const t = norm(text);
	if (!t || t.includes('\n')) return null;
	const modeTail = `(${MODE_RE})(?:\\s*(?:mode|模式))?`;
	const patterns: RegExp[] = [
		// set / switch / put / change / turn … to|in|into <mode>
		new RegExp(`^(?:set|switch|put|change|turn|move)\\s+(.+?)\\s+(?:to|in|into|on)\\s+${modeTail}$`, 'iu'),
		// 把 <project> 切到 / 切换到 / 改成 / 调成 / 调到 / 设为 <mode>
		new RegExp(`^(?:把\\s*)?(.+?)\\s*(?:切到|切换到|切换成|切成|改成|改为|调成|调到|调为|设为|设成|设置为)\\s*${modeTail}$`, 'iu'),
		// <project> <mode> [mode]
		new RegExp(`^(.+?)\\s+${modeTail}$`, 'iu'),
	];
	for (const re of patterns) {
		const m = re.exec(t);
		if (!m) continue;
		const mode = MODE_WORDS[m[2].toLowerCase()];
		if (!mode) continue;
		const { target, explicitProject } = cleanTarget(m[1]);
		if (!target) return null;
		return { target, mode, explicitProject };
	}
	return null;
}

/** What each mode does, in one line (owner reply). */
const MODE_LINES: Readonly<Record<AutopilotSpeedMode, string>> = {
	rush: 'replans whenever the queue runs dry (at least 1 h apart, at most 12 a day), self-review every hour, and an empty replan is retried after 1 h',
	normal: 'replans when the queue runs dry (at least 3 h apart, at most 4 a day), self-review daily, and an empty replan is retried the next day',
	chill: 'at most 1 replan a day, self-review weekly, and an empty replan is retried the next week',
};

/** The one-line cost warning shown when Rush is switched on. */
export const RUSH_COST_WARNING =
	'Cost warning: Rush keeps the team busy all day and can use the whole daily budget every day; the budget brake still stops it.';

/**
 * Mode name for the owner.
 *
 * @param mode - Mode
 * @returns "Rush" / "Normal" / "Chill"
 */
export function modeLabel(mode: AutopilotSpeedMode): string {
	return mode.charAt(0).toUpperCase() + mode.slice(1);
}

/**
 * The owner's reply after a switch.
 *
 * @param status - The project's status after the change
 * @param previous - The mode before
 * @returns Reply text
 */
export function speedModeReply(status: TicketAutopilotStatus, previous: AutopilotSpeedMode): string {
	const s = status.settings;
	const name = status.project.name;
	const mode = s.speedMode;
	const parts = [
		previous === mode ? `${name} is already on ${modeLabel(mode)}: ${MODE_LINES[mode]}.` : `${name} is on ${modeLabel(mode)} now (was ${modeLabel(previous)}): ${MODE_LINES[mode]}.`,
		s.budgetSource === 'explicit'
			? `Daily budget: ${compactTokens(s.dailyBudgetTokens)} tokens (your setting, unchanged).`
			: `Daily budget: ${compactTokens(s.dailyBudgetTokens)} tokens (the ${modeLabel(mode)} default).`,
	];
	if (s.replansPerDaySource === 'explicit') parts.push(`Your replans-per-day setting (${s.replansPerDay}) still caps replans.`);
	if (!s.enabled) parts.push(`The autopilot is off on ${name}, so nothing runs until it is switched on.`);
	if (mode === 'rush' && previous !== 'rush') parts.push(RUSH_COST_WARNING);
	return parts.join(' ');
}

/** What the interceptor needs. */
export interface AutopilotSpeedCommandDeps {
	/** `orc` when the message is the owner writing in their DM with the orc (see SlackReloginDmService.ownerDmScope) */
	ownerDmScope: (message: SlackIncomingMessage) => 'orc' | 'agent' | null;
	/** Reply target for the message */
	replyTargetOf: (message: SlackIncomingMessage) => unknown;
	/** Send a reply to the owner */
	reply: (text: string, target: unknown) => Promise<unknown>;
	/** Known projects, synchronously (a cache the wiring refreshes) */
	knownProjects: () => Array<{ id: string; name: string }>;
	/** The project's current mode */
	currentMode: (projectId: string) => Promise<AutopilotSpeedMode>;
	/** Set the mode as the owner; resolves to the new status */
	setMode: (projectId: string, mode: AutopilotSpeedMode) => Promise<TicketAutopilotStatus>;
	onError?: (err: unknown) => void;
}

/**
 * Find a project by id or name (case-insensitive).
 *
 * @param projects - Known projects
 * @param ref - As typed
 * @returns The project, or null
 */
export function findProjectByRef(projects: Array<{ id: string; name: string }>, ref: string): { id: string; name: string } | null {
	const wanted = ref.trim().toLowerCase();
	if (!wanted) return null;
	return projects.find((p) => p.id === ref.trim()) ?? projects.find((p) => p.name.trim().toLowerCase() === wanted) ?? null;
}

/**
 * Run a parsed command and build the owner's reply.
 *
 * @param cmd - Command
 * @param projectId - Resolved project
 * @param deps - Collaborators
 * @returns Reply text
 */
export async function runAutopilotSpeedCommand(cmd: AutopilotSpeedCommand, projectId: string, deps: AutopilotSpeedCommandDeps): Promise<string> {
	const previous = await deps.currentMode(projectId);
	const status = await deps.setMode(projectId, cmd.mode);
	return speedModeReply(status, previous);
}

/**
 * The Slack bridge interceptor for the owner's orc DM.
 *
 * @param deps - Collaborators
 * @returns Interceptor: true when the message was a speed command (consumed)
 */
export function createAutopilotSpeedInterceptor(deps: AutopilotSpeedCommandDeps): (message: SlackIncomingMessage) => boolean {
	return (message) => {
		if (message.hasFiles) return false;
		if (deps.ownerDmScope(message) !== 'orc') return false;
		const cmd = parseAutopilotSpeedCommand(message.text);
		if (!cmd) return false;
		const projects = deps.knownProjects();
		const project = findProjectByRef(projects, cmd.target);
		const target = deps.replyTargetOf(message);
		if (!project) {
			// "set project X to rush" is unmistakably a command: answer it.
			// Anything else ("let's rush") is the orc's.
			if (!cmd.explicitProject) return false;
			void deps
				.reply(`No project named "${cmd.target}". Projects: ${projects.map((p) => p.name).join(', ') || 'none'}.`, target)
				.catch((err) => deps.onError?.(err));
			return true;
		}
		void runAutopilotSpeedCommand(cmd, project.id, deps)
			.then((text) => deps.reply(text, target))
			.catch((err) => {
				deps.onError?.(err);
				return deps.reply(`Couldn't switch ${project.name} to ${modeLabel(cmd.mode)}: ${err instanceof Error ? err.message : String(err)}`, target).catch(() => undefined);
			});
		return true;
	};
}
