/**
 * Idle-at-prompt detection on real Claude Code 2.1.288 captures, including
 * the labelled top rule every live agent has (`──── crewly-orc ─`, from
 * `--agent`). 1.20.200: idle boxes show a faint placeholder/suggestion that
 * plain capture includes, so the text check read idle agents as "not at
 * prompt" and deliveries went through only on the final attempt.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentRegistrationService } from './agent-registration.service.js';
import { PtyTerminalBuffer } from '../session/pty/pty-terminal-buffer.js';
import { classifyTuiInput } from '../session/tui-input-guard.js';
import { RUNTIME_TYPES } from '../../constants.js';

const FIX = path.join(__dirname, '..', 'session', '__fixtures__', 'tui', 'claude-code-2.1.288');

interface Frame { screen: string; helper: { readInputBox: (s: string, m: string, st: 'recovery') => ReturnType<typeof classifyTuiInput> } }

/** Replay a capture; return its plain screen (faint text included, as captureOutput gives it) and a helper reading its box. */
async function frame(name: string): Promise<Frame> {
	const buffer = new PtyTerminalBuffer(100, 30);
	buffer.write(fs.readFileSync(path.join(FIX, `${name}.ansi`), 'utf8'));
	await buffer.flush();
	const screen = buffer.getContent(100);
	const view = buffer.getInputView();
	buffer.dispose();
	return { screen, helper: { readInputBox: (_s, m, st) => classifyTuiInput(view, m, st) } };
}

type Probe = {
	isClaudeAtPrompt(screen: string, runtimeType?: string): boolean;
	isAtIdlePrompt(helper: unknown, sessionName: string, screen: string, runtimeType?: string): boolean;
};
const svc = Object.create(AgentRegistrationService.prototype) as Probe & { logger: unknown };
svc.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const CC = RUNTIME_TYPES.CLAUDE_CODE;

describe('isAtIdlePrompt (Claude Code input box, labelled or bare top rule)', () => {
	it('an idle labelled-rule box with a faint placeholder is at the prompt (the text check says no)', async () => {
		const f = await frame('labelled-rule-empty');
		expect(f.screen).toMatch(/─ fixture-agent ─/);
		expect(f.screen).toMatch(/❯\s+Try "/); // ❯ + U+00A0, then the faint placeholder
		expect(svc.isClaudeAtPrompt(f.screen, CC)).toBe(false); // the 1.20.200 symptom
		expect(svc.isAtIdlePrompt(f.helper, 's', f.screen, CC)).toBe(true);
	});

	it('an idle bare-rule box with a placeholder is at the prompt too', async () => {
		const f = await frame('empty-placeholder');
		expect(svc.isAtIdlePrompt(f.helper, 's', f.screen, CC)).toBe(true);
		expect(svc.isAtIdlePrompt(f.helper, 's', f.screen, undefined)).toBe(true);
	});

	it('a busy agent with an empty box is not (the text check says yes: a bare ❯)', async () => {
		const f = await frame('busy-labelled-empty');
		expect(svc.isClaudeAtPrompt(f.screen, CC)).toBe(true);
		expect(svc.isAtIdlePrompt(f.helper, 's', f.screen, CC)).toBe(false);
	});

	it('a box holding text is not', async () => {
		for (const name of ['labelled-rule-pasted-marker', 'busy-labelled-pasted-marker', 'typed-single', 'accepted-suggestion']) {
			const f = await frame(name);
			expect([name, svc.isAtIdlePrompt(f.helper, 's', f.screen, CC)]).toEqual([name, false]);
		}
	});

	it('our own pending paste in an idle box counts as at the prompt (the delivery submits it)', async () => {
		const f = await frame('labelled-rule-pasted-marker');
		const helper = { readInputBox: (s: string, m: string, st: 'recovery') => ({ ...f.helper.readInputBox(s, m, st), ownPasteMarker: true }) };
		expect(svc.isAtIdlePrompt(helper, 's', f.screen, CC)).toBe(true);
	});

	it('falls back to the text check for other runtimes, unreadable boxes and helpers without a box reader', async () => {
		const f = await frame('labelled-rule-empty');
		expect(svc.isAtIdlePrompt(f.helper, 's', '› \n', RUNTIME_TYPES.CODEX_CLI)).toBe(true);
		expect(svc.isAtIdlePrompt({ readInputBox: () => ({ state: 'unknown', text: '', lineCount: 0 }) }, 's', '❯ \n', CC)).toBe(true);
		expect(svc.isAtIdlePrompt({}, 's', '❯ \n', CC)).toBe(true);
		expect(svc.isAtIdlePrompt(null, 's', f.screen, CC)).toBe(false);
	});
});
